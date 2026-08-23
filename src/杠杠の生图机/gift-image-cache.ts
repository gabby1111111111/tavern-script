import { ref, type Ref } from 'vue';
import type { ImageResource, GiftImageRequestMode } from './image-api';
import type { ImageIntent } from './image-system';

export const MAX_GIFT_IMAGE_TASKS = 5;

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
  intent: ImageIntent;
  artifactId: string | null;
  abortController: AbortController;
};

export type GiftImageTarget = Pick<
  GiftImageTask,
  | 'chatId'
  | 'messageId'
  | 'swipeId'
  | 'characterReferenceName'
  | 'templateImageName'
  | 'requestMode'
  | 'referenceCount'
  | 'intent'
>;

export function giftImageTaskKey(task: Pick<GiftImageTask, 'chatId' | 'messageId' | 'swipeId' | 'id'>): string {
  return `${task.chatId}::${task.messageId ?? 'none'}::${task.swipeId ?? 'none'}::${task.id}`;
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
      artifactId: null,
      abortController: new AbortController(),
      ...target,
    };
    const next = [task, ...this.tasks.value];
    const overflow = next.splice(MAX_GIFT_IMAGE_TASKS);
    overflow.forEach(item => this.release(item));
    this.tasks.value = next;
    return this.tasks.value.find(item => item.id === task.id)!;
  }

  clear(): void {
    this.tasks.value.forEach(task => this.release(task));
    this.tasks.value = [];
  }

  has(task: GiftImageTask): boolean {
    const key = giftImageTaskKey(task);
    return this.tasks.value.some(item => giftImageTaskKey(item) === key);
  }

  hasActive(): boolean {
    return this.tasks.value.some(task => task.status === 'pending' || task.status === 'running');
  }

  private release(task: GiftImageTask): void {
    task.abortController.abort();
    task.status = task.status === 'pending' || task.status === 'running' ? 'cancelled' : task.status;
    task.image?.revoke?.();
    task.image = null;
  }
}
