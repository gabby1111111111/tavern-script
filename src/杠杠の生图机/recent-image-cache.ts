import { ref, type Ref } from 'vue';
import type { ImageResource } from './image-api';

export const MAX_RECENT_GENERATED_IMAGES = 10;

export type RecentGeneratedImage = {
  id: string;
  url: string;
  source: '随文插图' | '礼物 CG';
  chatId: string;
  messageId: number | null;
  swipeId: number | null;
  imageIndex: number | null;
  giftTaskId?: string;
  createdAt: number;
};

type RecentImageTarget = Pick<RecentGeneratedImage, 'chatId' | 'messageId' | 'swipeId' | 'imageIndex'> & {
  source?: RecentGeneratedImage['source'];
  giftTaskId?: string;
};

function releaseResource(release: (() => void) | undefined): void {
  release?.();
}

export class RecentImageCache {
  readonly images: Ref<RecentGeneratedImage[]> = ref([]);
  private readonly releases = new Map<string, () => void>();
  private sequence = 0;

  add(target: RecentImageTarget, resource: ImageResource): RecentGeneratedImage | null {
    const ownedResource = resource.clone?.() ?? (resource.kind === 'remote-url' ? resource : null);
    if (!ownedResource) return null;

    const entry: RecentGeneratedImage = {
      id: `recent-${Date.now()}-${this.sequence++}`,
      url: ownedResource.url,
      source: target.source ?? '随文插图',
      chatId: target.chatId,
      messageId: target.messageId,
      swipeId: target.swipeId,
      imageIndex: target.imageIndex,
      giftTaskId: target.giftTaskId,
      createdAt: Date.now(),
    };
    this.releases.set(entry.id, () => ownedResource.revoke?.());

    const next = [entry, ...this.images.value];
    const overflow = next.splice(MAX_RECENT_GENERATED_IMAGES);
    overflow.forEach(item => this.release(item.id));
    this.images.value = next;
    return entry;
  }

  clear(): void {
    this.images.value.forEach(item => this.release(item.id));
    this.images.value = [];
  }

  private release(id: string): void {
    const release = this.releases.get(id);
    releaseResource(release);
    this.releases.delete(id);
  }
}
