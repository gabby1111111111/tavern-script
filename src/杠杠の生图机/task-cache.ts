import type { ImageResource } from './image-api';
import { createImageIntent, type ImageIntent } from './image-system';
import type { InlineImagePrompt } from './marker';

export type ImageTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export const MAX_IMAGE_TASKS = 10;

export type ImageTask = {
  chatId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
  generationId: string;
  intent: ImageIntent;
  artifactId: string | null;
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

export function isCurrentImageTaskForGeneration(
  task: ImageTask,
  cachedTask: ImageTask | undefined,
  activeGenerationId: string | null,
  currentChatId: string,
): boolean {
  return cachedTask === task && activeGenerationId === task.generationId && currentChatId === task.chatId;
}

export function createImageTask(
  prompt: InlineImagePrompt,
  target: { chatId: string; messageId: number; swipeId: number; generationId: string },
): ImageTask {
  const intent = createImageIntent({
    purpose: 'current',
    chatId: target.chatId,
    prompt: prompt.prompt,
    requestedTarget: {
      kind: 'inline-anchor',
      messageId: target.messageId,
      swipeId: target.swipeId,
      imageIndex: prompt.index,
      paragraphIndex: prompt.paragraphIndex,
      anchorTextBefore: prompt.anchorTextBefore,
      anchorTextAfter: prompt.anchorTextAfter,
    },
  });
  return {
    chatId: target.chatId,
    messageId: target.messageId,
    swipeId: target.swipeId,
    imageIndex: prompt.index,
    generationId: target.generationId,
    intent,
    artifactId: null,
    status: 'pending',
    image: null,
    error: null,
    abortController: new AbortController(),
    createdAt: intent.createdAt,
    paragraphIndex: prompt.paragraphIndex,
    anchorTextBefore: prompt.anchorTextBefore,
    anchorTextAfter: prompt.anchorTextAfter,
  };
}

export type ImageTaskCacheOptions = {
  onRemove?: (task: ImageTask) => void;
};

export function deriveGenerationStatus(
  tasks: ReadonlyArray<Pick<ImageTask, 'status'>>,
): 'running' | 'success' | 'fail' {
  if (tasks.some(task => task.status === 'failed')) return 'fail';
  if (tasks.some(task => task.status === 'pending' || task.status === 'running')) return 'running';
  return 'success';
}

export class ImageTaskCache {
  private readonly tasks = new Map<string, ImageTask>();

  constructor(private readonly options: ImageTaskCacheOptions = {}) {}

  get(key: string): ImageTask | undefined {
    return this.tasks.get(key);
  }

  getForMessage(chatId: string, messageId: number): ImageTask[] {
    return Array.from(this.tasks.values()).filter(task => task.chatId === chatId && task.messageId === messageId);
  }

  values(): ImageTask[] {
    return Array.from(this.tasks.values());
  }

  cancelActiveOutsideGeneration(activeGenerationId: string): number {
    const keys = this.values()
      .filter(
        task => task.generationId !== activeGenerationId && (task.status === 'pending' || task.status === 'running'),
      )
      .map(imageTaskKey);
    keys.forEach(key => this.remove(key));
    return keys.length;
  }

  set(task: ImageTask): ImageTask {
    const key = imageTaskKey(task);
    const previous = this.tasks.get(key);
    if (previous && previous !== task) this.remove(key);
    this.tasks.set(key, task);
    if (this.tasks.size > MAX_IMAGE_TASKS) {
      let oldest: [string, ImageTask] | undefined;
      this.tasks.forEach((item, itemKey) => {
        if (!oldest || item.createdAt < oldest[1].createdAt) oldest = [itemKey, item];
      });
      if (oldest) this.remove(oldest[0]);
    }
    return task;
  }

  remove(key: string): boolean {
    const task = this.tasks.get(key);
    if (!task) return false;
    task.abortController.abort();
    if (task.status === 'pending' || task.status === 'running') task.status = 'cancelled';
    task.image?.revoke?.();
    task.image = null;
    this.tasks.delete(key);
    this.options.onRemove?.(task);
    return true;
  }

  removeMessage(chatId: string, messageId: number): number {
    const keys = this.getForMessage(chatId, messageId).map(imageTaskKey);
    keys.forEach(key => this.remove(key));
    return keys.length;
  }

  removeSwipe(chatId: string, messageId: number, swipeId: number): number {
    const keys = this.getForMessage(chatId, messageId)
      .filter(task => task.swipeId === swipeId)
      .map(imageTaskKey);
    keys.forEach(key => this.remove(key));
    return keys.length;
  }

  shiftSwipeIdsAfterDeletion(chatId: string, messageId: number, deletedSwipeId: number): number {
    const shifted = this.getForMessage(chatId, messageId).filter(task => task.swipeId > deletedSwipeId);
    shifted.forEach(task => this.tasks.delete(imageTaskKey(task)));
    shifted.forEach(task => {
      task.swipeId -= 1;
      if (task.intent.requestedTarget) task.intent.requestedTarget.swipeId = task.swipeId;
      this.tasks.set(imageTaskKey(task), task);
    });
    return shifted.length;
  }

  clear(): void {
    Array.from(this.tasks.keys()).forEach(key => this.remove(key));
  }
}
