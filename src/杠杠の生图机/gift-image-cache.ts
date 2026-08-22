import { ref, type Ref } from 'vue';
import type { ImageResource, GiftImageRequestMode } from './image-api';

export const MAX_GIFT_IMAGE_TASKS = 10;

export type GiftImageTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export type GiftImageTask = {
  id: string;
  status: GiftImageTaskStatus;
  image: ImageResource | null;
  error: string | null;
  createdAt: number;
  chatId: string;
  messageId: number | null;
  swipeId: number | null;
  characterReferenceName: string;
  templateImageName: string;
  requestMode: GiftImageRequestMode;
  referenceCount: number;
  abortController: AbortController;
};

export type GiftImageTarget = Pick<
  GiftImageTask,
  'chatId' | 'messageId' | 'swipeId' | 'characterReferenceName' | 'templateImageName' | 'requestMode' | 'referenceCount'
>;

export function giftImageTaskKey(task: Pick<GiftImageTask, 'chatId' | 'messageId' | 'swipeId' | 'id'>): string {
  return `${task.chatId}::${task.messageId ?? 'none'}::${task.swipeId ?? 'none'}::${task.id}`;
}

function releaseImage(image: ImageResource | null): void {
  image?.revoke?.();
}

export class GiftImageCache {
  readonly tasks: Ref<GiftImageTask[]> = ref([]);
  private sequence = 0;

  createPending(target: GiftImageTarget): GiftImageTask {
    const task: GiftImageTask = {
      id: `gift-${Date.now()}-${this.sequence++}`,
      status: 'pending',
      image: null,
      error: null,
      createdAt: Date.now(),
      abortController: new AbortController(),
      ...target,
    };
    const next = [task, ...this.tasks.value];
    const overflow = next.splice(MAX_GIFT_IMAGE_TASKS);
    overflow.forEach(item => this.release(item));
    this.tasks.value = next;
    return task;
  }

  clear(): void {
    this.tasks.value.forEach(task => this.release(task));
    this.tasks.value = [];
  }

  has(task: GiftImageTask): boolean {
    const key = giftImageTaskKey(task);
    return this.tasks.value.some(item => giftImageTaskKey(item) === key);
  }

  private release(task: GiftImageTask): void {
    task.abortController.abort();
    task.status = task.status === 'pending' || task.status === 'running' ? 'cancelled' : task.status;
    releaseImage(task.image);
    task.image = null;
  }
}
