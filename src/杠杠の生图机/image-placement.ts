import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { ImageResource } from './image-api';
import type { ImagePlacementTarget } from './image-system';
import type { ImageReferenceKind } from './pipeline-types';
import { normalizeStoryContinuityMetadata, type StoryContinuityMetadata } from './story-continuity';

// Keep the inline projection large enough to mirror the configurable recent
// image cache. Each generated variant/revision owns one placement.
export const MAX_IMAGE_PLACEMENTS = 50;
export const MAX_IMAGE_PLACEMENT_CAPTION_LENGTH = 240;

export type ImagePlacement = Readonly<{
  id: string;
  artifactId: string;
  target: Readonly<ImagePlacementTarget>;
  caption: string;
  variantIndex: number;
  revisionIndex: number;
  /** Exact final prompt sent for this variant/revision, kept in page memory. */
  finalPrompt?: string;
  prompt: string;
  url: string;
  createdAt: number;
  continuity?: StoryContinuityMetadata;
  /** Known reference provenance for this exact variant/revision. */
  referenceKinds?: ReadonlyArray<ImageReferenceKind>;
}>;

export type ImagePlacementInput = Pick<ImagePlacement, 'artifactId' | 'target'> & {
  caption?: string;
  variantIndex?: number;
  revisionIndex?: number;
  finalPrompt?: string;
  prompt?: string;
  messageRef?: object | null;
  continuity?: StoryContinuityMetadata;
  referenceKinds?: ReadonlyArray<ImageReferenceKind>;
};
export type ImagePlacementCloneProvider = (artifactId: string) => ImageResource | null;
export type ImagePlacementCacheOptions = {
  onRemove?: (placement: ImagePlacement) => void;
};

function normalizeCaption(caption = ''): string {
  return caption.trim().slice(0, MAX_IMAGE_PLACEMENT_CAPTION_LENGTH);
}

function normalizeReferenceKinds(
  kinds?: ReadonlyArray<ImageReferenceKind>,
): ReadonlyArray<ImageReferenceKind> | undefined {
  if (!kinds) return undefined;
  return Object.freeze([...new Set(kinds)]);
}

export class ImagePlacementCache {
  private readonly items: Ref<ImagePlacement[]> = ref([]);
  readonly placements: ComputedRef<ReadonlyArray<ImagePlacement>> = computed(() =>
    Object.freeze([...this.items.value]),
  );
  private readonly resources = new Map<string, ImageResource>();
  private readonly ownerKeys = new Map<string, string>();
  private readonly messageRefs = new Map<string, object>();
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
      variantIndex: Math.max(0, Math.trunc(input.variantIndex ?? 0)),
      revisionIndex: Math.max(0, Math.trunc(input.revisionIndex ?? 0)),
      prompt: (input.prompt ?? '').trim(),
      ...(input.finalPrompt?.trim() ? { finalPrompt: input.finalPrompt } : {}),
      url: resource.url,
      createdAt: Date.now(),
      ...(input.continuity ? { continuity: normalizeStoryContinuityMetadata(input.continuity) } : {}),
      ...(input.referenceKinds ? { referenceKinds: normalizeReferenceKinds(input.referenceKinds) } : {}),
    });
    const ownerKey = `image-placement-owner-${sequence}`;
    this.resources.set(ownerKey, resource);
    this.ownerKeys.set(placement.id, ownerKey);
    if (input.messageRef) this.messageRefs.set(placement.id, input.messageRef);
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

  get(id: string): ImagePlacement | undefined {
    return this.items.value.find(item => item.id === id);
  }

  /** A request owns its clone independently from the displayed placement. */
  cloneResource(id: string): ImageResource | null {
    const ownerKey = this.ownerKeys.get(id);
    const resource = ownerKey ? this.resources.get(ownerKey) : undefined;
    if (!resource) return null;
    if (resource.clone) return resource.clone();
    // An object URL without cloning cannot outlive its current owner safely.
    return resource.kind === 'remote-url' ? { url: resource.url, kind: resource.kind } : null;
  }

  removeSwipe(messageId: number, swipeId: number): number {
    const ids = this.items.value
      .filter(item => item.target.messageId === messageId && item.target.swipeId === swipeId)
      .map(item => item.id);
    ids.forEach(id => this.remove(id));
    return ids.length;
  }

  shiftSwipeIdsAfterDeletion(messageId: number, deletedSwipeId: number): number {
    let shifted = 0;
    this.items.value = this.items.value.map(item => {
      if (item.target.messageId !== messageId || item.target.swipeId <= deletedSwipeId) return item;
      shifted += 1;
      return Object.freeze({
        ...item,
        target: Object.freeze({ ...item.target, swipeId: item.target.swipeId - 1 }),
      });
    });
    return shifted;
  }

  reconcileMessageIndexes(currentChat: ReadonlyArray<object>): { removed: number; shifted: number } {
    const removed: ImagePlacement[] = [];
    let shifted = 0;
    this.items.value = this.items.value.flatMap(item => {
      const messageRef = this.messageRefs.get(item.id);
      const messageId = messageRef ? currentChat.indexOf(messageRef) : -1;
      if (messageId < 0) {
        removed.push(item);
        return [];
      }
      if (messageId === item.target.messageId) return [item];
      shifted += 1;
      return [
        Object.freeze({
          ...item,
          target: Object.freeze({ ...item.target, messageId }),
        }),
      ];
    });
    removed.forEach(item => this.release(item));
    return { removed: removed.length, shifted };
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
    this.messageRefs.delete(placement.id);
    this.options.onRemove?.(placement);
  }
}
