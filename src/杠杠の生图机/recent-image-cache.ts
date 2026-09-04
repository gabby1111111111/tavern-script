import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { ImageResource } from './image-api';
import { createImageArtifact, type ImageArtifact, type ImageArtifactInput } from './image-system';

export const MIN_RECENT_IMAGE_LIMIT = 1;
export const MAX_RECENT_IMAGE_LIMIT = 50;
export const DEFAULT_RECENT_IMAGE_LIMIT = 10;

/**
 * Historical name kept for callers that used the default recent-image cap.
 * The hard upper bound is MAX_RECENT_IMAGE_LIMIT; this constant represents
 * the default cache size, now ten images.
 */
export const MAX_RECENT_GENERATED_IMAGES = DEFAULT_RECENT_IMAGE_LIMIT;

export type RecentGeneratedImage = ImageArtifact & {
  source: '随文插图' | '礼物 CG';
  messageId: number | null;
  swipeId: number | null;
  imageIndex: number | null;
  giftTaskId?: string;
};

export type RecentImageCacheOptions = {
  onRemove?: (artifact: ImageArtifact) => void;
};

function cloneResource(resource: ImageResource): ImageResource | null {
  return resource.clone?.() ?? (resource.kind === 'remote-url' ? { url: resource.url, kind: 'remote-url' } : null);
}

export function normalizeRecentImageLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECENT_IMAGE_LIMIT;
  return Math.min(MAX_RECENT_IMAGE_LIMIT, Math.max(MIN_RECENT_IMAGE_LIMIT, Math.trunc(value)));
}

export class RecentImageCache {
  readonly artifacts: Ref<ImageArtifact[]> = ref([]);
  readonly images: ComputedRef<RecentGeneratedImage[]> = computed(() =>
    this.artifacts.value.map(artifact => ({
      ...artifact,
      source: artifact.purpose === 'gift' ? '礼物 CG' : '随文插图',
      messageId: artifact.target.messageId,
      swipeId: artifact.target.swipeId,
      imageIndex: artifact.target.imageIndex,
      giftTaskId: artifact.target.giftTaskId,
    })),
  );
  private readonly resources = new Map<string, ImageResource>();
  private currentLimit = DEFAULT_RECENT_IMAGE_LIMIT;

  constructor(private readonly options: RecentImageCacheOptions = {}) {}

  get limit(): number {
    return this.currentLimit;
  }

  /**
   * Change the bounded recent-image capacity.  Shrinking the limit releases
   * every evicted owner immediately, so the existing placement cleanup hook
   * observes the same lifecycle as normal FIFO eviction.
   */
  setLimit(limit: number): number {
    const nextLimit = normalizeRecentImageLimit(limit);
    this.currentLimit = nextLimit;
    if (this.artifacts.value.length <= nextLimit) return nextLimit;

    const retained = this.artifacts.value.slice(0, nextLimit);
    const overflow = this.artifacts.value.slice(nextLimit);
    this.artifacts.value = retained;
    overflow.forEach(item => this.release(item));
    return nextLimit;
  }

  add(input: ImageArtifactInput, resource: ImageResource): ImageArtifact | null {
    const ownedResource = cloneResource(resource);
    if (!ownedResource) return null;

    const artifact = createImageArtifact(input, ownedResource.url);
    this.resources.set(artifact.id, ownedResource);

    const next = [artifact, ...this.artifacts.value];
    const overflow = next.splice(this.currentLimit);
    this.artifacts.value = next;
    overflow.forEach(item => this.release(item));
    return this.artifacts.value.find(item => item.id === artifact.id)!;
  }

  cloneResource(artifactId: string): ImageResource | null {
    const resource = this.resources.get(artifactId);
    return resource ? cloneResource(resource) : null;
  }

  getArtifact(artifactId: string): ImageArtifact | undefined {
    return this.artifacts.value.find(artifact => artifact.id === artifactId);
  }

  clear(): void {
    const removed = this.artifacts.value;
    this.artifacts.value = [];
    removed.forEach(item => this.release(item));
  }

  remove(id: string): boolean {
    const artifact = this.artifacts.value.find(item => item.id === id);
    if (!artifact) return false;
    this.artifacts.value = this.artifacts.value.filter(item => item.id !== id);
    this.release(artifact);
    return true;
  }

  private release(artifact: ImageArtifact): void {
    this.resources.get(artifact.id)?.revoke?.();
    this.resources.delete(artifact.id);
    this.options.onRemove?.(artifact);
  }
}
