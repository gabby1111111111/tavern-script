import type { ImageResource } from './image-api';
import type { InlineImagePrompt } from './marker';

export type ImageTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export type ImageTask = {
  chatId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
  prompt: string;
  status: ImageTaskStatus;
  image: ImageResource | null;
  error: string | null;
  abortController: AbortController;
  createdAt: number;
  paragraphIndex: number;
  anchorTextBefore: string;
  anchorTextAfter: string;
};

export function imageTaskKey(task: Pick<ImageTask, 'chatId' | 'messageId' | 'swipeId' | 'imageIndex'>): string {
  return `${task.chatId}::${task.messageId}::${task.swipeId}::${task.imageIndex}`;
}

export function createImageTask(
  prompt: InlineImagePrompt,
  target: { chatId: string; messageId: number; swipeId: number },
): ImageTask {
  return {
    chatId: target.chatId,
    messageId: target.messageId,
    swipeId: target.swipeId,
    imageIndex: prompt.index,
    prompt: prompt.prompt,
    status: 'pending',
    image: null,
    error: null,
    abortController: new AbortController(),
    createdAt: Date.now(),
    paragraphIndex: prompt.paragraphIndex,
    anchorTextBefore: prompt.anchorTextBefore,
    anchorTextAfter: prompt.anchorTextAfter,
  };
}

function releaseImage(image: ImageResource | null): void {
  image?.revoke?.();
}

export class ImageTaskCache {
  private readonly tasks = new Map<string, ImageTask>();

  get(key: string): ImageTask | undefined {
    return this.tasks.get(key);
  }

  getForMessage(chatId: string, messageId: number): ImageTask[] {
    return Array.from(this.tasks.values()).filter(task => task.chatId === chatId && task.messageId === messageId);
  }

  values(): ImageTask[] {
    return Array.from(this.tasks.values());
  }

  set(task: ImageTask): ImageTask {
    const key = imageTaskKey(task);
    const previous = this.tasks.get(key);
    if (previous && previous !== task && previous.image !== task.image) {
      previous.abortController.abort();
      releaseImage(previous.image);
    }
    this.tasks.set(key, task);
    return task;
  }

  remove(key: string): boolean {
    const task = this.tasks.get(key);
    if (!task) return false;
    task.abortController.abort();
    releaseImage(task.image);
    this.tasks.delete(key);
    return true;
  }

  removeMessage(chatId: string, messageId: number): number {
    const keys = this.getForMessage(chatId, messageId).map(imageTaskKey);
    keys.forEach(key => this.remove(key));
    return keys.length;
  }

  clear(): void {
    this.tasks.forEach(task => {
      task.abortController.abort();
      releaseImage(task.image);
    });
    this.tasks.clear();
  }
}
