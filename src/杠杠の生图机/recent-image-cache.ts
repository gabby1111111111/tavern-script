import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { ImageResource } from './image-api';
import { createImageArtifact, type ImageArtifact, type ImageArtifactInput } from './image-system';

export const MAX_RECENT_GENERATED_IMAGES = 5;

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
  private pinnedId: string | null = null;

  constructor(private readonly options: RecentImageCacheOptions = {}) {}

  get pinnedArtifactId(): string | null {
    return this.pinnedId;
  }

  add(input: ImageArtifactInput, resource: ImageResource): ImageArtifact | null {
    const ownedResource = cloneResource(resource);
    if (!ownedResource) return null;

    const artifact = createImageArtifact(input, ownedResource.url);
    this.resources.set(artifact.id, ownedResource);

    const next = [artifact, ...this.artifacts.value];
    const overflow: ImageArtifact[] = [];
    while (next.length > MAX_RECENT_GENERATED_IMAGES) {
      let evictionIndex = next.length - 1;
      while (evictionIndex >= 0 && next[evictionIndex].id === this.pinnedId) evictionIndex -= 1;
      if (evictionIndex < 0) break;
      overflow.push(...next.splice(evictionIndex, 1));
    }
    this.artifacts.value = next;
    overflow.forEach(item => this.release(item));
    return this.artifacts.value.find(item => item.id === artifact.id)!;
  }

  pinArtifact(artifactId: string): boolean {
    if (!this.artifacts.value.some(artifact => artifact.id === artifactId)) return false;
    this.pinnedId = artifactId;
    return true;
  }

  clearPinnedArtifact(): void {
    this.pinnedId = null;
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
    this.clearPinnedArtifact();
    removed.forEach(item => this.release(item));
  }

  remove(id: string): boolean {
    const artifact = this.artifacts.value.find(item => item.id === id);
    if (!artifact) return false;
    this.artifacts.value = this.artifacts.value.filter(item => item.id !== id);
    if (this.pinnedId === id) this.clearPinnedArtifact();
    this.release(artifact);
    return true;
  }

  private release(artifact: ImageArtifact): void {
    this.resources.get(artifact.id)?.revoke?.();
    this.resources.delete(artifact.id);
    this.options.onRemove?.(artifact);
  }
}
