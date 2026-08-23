import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { ImageResource } from './image-api';
import type { ImagePlacementTarget } from './image-system';

export const MAX_IMAGE_PLACEMENTS = 10;
export const MAX_IMAGE_PLACEMENT_CAPTION_LENGTH = 240;

export type ImagePlacement = Readonly<{
  id: string;
  artifactId: string;
  target: Readonly<ImagePlacementTarget>;
  caption: string;
  url: string;
  createdAt: number;
}>;

export type ImagePlacementInput = Pick<ImagePlacement, 'artifactId' | 'target'> & { caption?: string };
export type ImagePlacementCloneProvider = (artifactId: string) => ImageResource | null;
export type ImagePlacementCacheOptions = {
  onRemove?: (placement: ImagePlacement) => void;
};

function normalizeCaption(caption = ''): string {
  return caption.trim().slice(0, MAX_IMAGE_PLACEMENT_CAPTION_LENGTH);
}

export class ImagePlacementCache {
  private readonly items: Ref<ImagePlacement[]> = ref([]);
  readonly placements: ComputedRef<ReadonlyArray<ImagePlacement>> = computed(() =>
    Object.freeze([...this.items.value]),
  );
  private readonly resources = new Map<string, ImageResource>();
  private readonly ownerKeys = new Map<string, string>();
  private sequence = 0;

  constructor(
    private readonly cloneArtifact: ImagePlacementCloneProvider,
    private readonly options: ImagePlacementCacheOptions = {},
  ) {}

  place(input: ImagePlacementInput): ImagePlacement | null {
    const resource = this.cloneArtifact(input.artifactId);
    if (!resource) return null;
    const sequence = this.sequence++;
    const placement: ImagePlacement = Object.freeze({
      id: `image-placement-${Date.now()}-${sequence}`,
      artifactId: input.artifactId,
      target: Object.freeze({ ...input.target }),
      caption: normalizeCaption(input.caption),
      url: resource.url,
      createdAt: Date.now(),
    });
    const ownerKey = `image-placement-owner-${sequence}`;
    this.resources.set(ownerKey, resource);
    this.ownerKeys.set(placement.id, ownerKey);
    const next = [placement, ...this.items.value];
    const overflow = next.splice(MAX_IMAGE_PLACEMENTS);
    this.items.value = next;
    overflow.forEach(item => this.release(item));
    return placement;
  }

  remove(id: string): boolean {
    const placement = this.items.value.find(item => item.id === id);
    if (!placement) return false;
    this.items.value = this.items.value.filter(item => item.id !== id);
    this.release(placement);
    return true;
  }

  clear(): void {
    const removed = this.items.value;
    this.items.value = [];
    removed.forEach(placement => this.release(placement));
  }

  private release(placement: ImagePlacement): void {
    const ownerKey = this.ownerKeys.get(placement.id);
    if (!ownerKey) return;
    this.resources.get(ownerKey)?.revoke?.();
    this.resources.delete(ownerKey);
    this.ownerKeys.delete(placement.id);
    this.options.onRemove?.(placement);
  }
}
