import { ref, type Ref } from 'vue';
import { requestGiftImage, requestImage, resolveGiftRequestMode, type ImageResource } from './image-api';
import { collectGiftContext } from './gift-context';
import { GiftImageCache, type GiftImageTask } from './gift-image-cache';
import { composeGiftImagePrompt } from './gift-prompt';
import { clearRenderedHosts, renderImageTask } from './message-renderer';
import { cleanInlineImageMessage, scanInlineImagePrompts, type InlineImagePrompt } from './marker';
import { RecentImageCache, type RecentGeneratedImage } from './recent-image-cache';
import { composeInlinePrompt, getActiveApiProfile, type GiftReferenceSlot, type StoryImageSettings } from './settings';
import { ReferenceImageMemory, type GiftImageReference } from './reference-image-memory';
import { createImageTask, imageTaskKey, ImageTaskCache, type ImageTask } from './task-cache';

type RuntimeStatus = 'idle' | 'generating' | 'ready' | 'error' | 'stopped';

type GenerationState = {
  id: string;
  messageId: number | null;
  chatId: string;
  streamText: string;
  startedIndices: Set<number>;
};

type AuditTask = {
  status: string;
  message_id: number | null;
  swipe_id: number | null;
};

export type StoryImageAudit = {
  run_id: number;
  lifecycle: { status: 'idle' | 'running' | 'stopped' };
  injection: { status: 'pending' | 'success' | 'fail'; enabled: boolean };
  generation: { id: string | null; status: 'pending' | 'running' | 'success' | 'fail' };
  markers: { count: number; valid_count: number; truncated: boolean };
  tasks: [AuditTask, AuditTask];
  gift: {
    status: 'idle' | 'pending' | 'running' | 'success' | 'fail' | 'skipped';
    request_mode: string;
    reference_count: number;
    assistant_reply_count: number;
    last_trigger_message_id: number | null;
  };
  cache: { mode: 'memory-only'; persisted: false };
  last_error: string | null;
};

export type StoryImageRuntime = {
  status: Readonly<Ref<RuntimeStatus>>;
  audit: StoryImageAudit;
  recentImages: Readonly<Ref<RecentGeneratedImage[]>>;
  giftImages: Readonly<Ref<GiftImageTask[]>>;
  referenceImages: Readonly<Ref<GiftImageReference[]>>;
  setGiftReferenceFile: (slot: GiftReferenceSlot, file: File, name?: string) => Promise<GiftImageReference>;
  setGiftReferenceUrl: (slot: GiftReferenceSlot, url: string, name?: string) => GiftImageReference;
  renameGiftReference: (slot: GiftReferenceSlot, name: string) => void;
  removeGiftReference: (slot: GiftReferenceSlot) => void;
  generateGift: (messageId?: number | null) => GiftImageTask | null;
  clearGiftImages: () => void;
  start: () => void;
  stop: () => void;
  updateSettings: (nextSettings: StoryImageSettings) => void;
};

const PROMPT_INJECTION_ID = 'story-image-inline-prompt';
const LOG_PREFIX = '<杠杠の生图机>';

function createEmptyAudit(): StoryImageAudit {
  return {
    run_id: 0,
    lifecycle: { status: 'idle' },
    injection: { status: 'pending', enabled: false },
    generation: { id: null, status: 'pending' },
    markers: { count: 0, valid_count: 0, truncated: false },
    tasks: [
      { status: 'idle', message_id: null, swipe_id: null },
      { status: 'idle', message_id: null, swipe_id: null },
    ],
    gift: {
      status: 'idle',
      request_mode: 'auto',
      reference_count: 0,
      assistant_reply_count: 0,
      last_trigger_message_id: null,
    },
    cache: { mode: 'memory-only', persisted: false },
    last_error: null,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return '未知错误';
}

function currentSwipeId(messageId: number): number {
  const message = getChatMessages(messageId, { include_swipes: true })[0];
  return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}

function currentAssistantMessageId(): number {
  const lastMessageId = getLastMessageId();
  const lastElementId = Number($('#chat > .mes.last_mes').attr('mesid'));
  return Number.isFinite(lastElementId) ? lastElementId : lastMessageId;
}

function isIgnoredMessageType(type: string): boolean {
  return type === 'quiet' || type === 'command' || type === 'extension';
}

function assignImageResource(task: ImageTask, resource: ImageResource): void {
  task.image = resource;
  task.status = 'success';
  task.error = null;
}

export function createStoryImageRuntime(): StoryImageRuntime {
  const cache = new ImageTaskCache();
  const recentCache = new RecentImageCache();
  const giftCache = new GiftImageCache();
  const referenceMemory = new ReferenceImageMemory();
  const status = ref<RuntimeStatus>('idle');
  const audit = createEmptyAudit();
  const globalWithAudit = globalThis as typeof globalThis & { __storyImageAudit?: StoryImageAudit };
  globalWithAudit.__storyImageAudit = audit;

  let settings: StoryImageSettings | null = null;
  let activeGeneration: GenerationState | null = null;
  let stopped = false;
  let promptUninject: (() => void) | null = null;
  let assistantReplyCount = 0;
  let lastGiftTriggerMessageId: number | null = null;
  const countedAssistantMessages = new Set<string>();
  const sourceCleanupInFlight = new Set<string>();
  const stopListeners: Array<() => void> = [];

  const setError = (error: unknown) => {
    const message = errorText(error);
    audit.last_error = message;
    status.value = 'error';
    console.warn(LOG_PREFIX, message);
  };

  const updateTaskAudit = () => {
    const currentMessageId = activeGeneration?.messageId;
    const currentChatId = activeGeneration?.chatId ?? SillyTavern.getCurrentChatId();
    const tasks =
      currentMessageId === null || currentMessageId === undefined
        ? []
        : cache.getForMessage(currentChatId, currentMessageId).sort((lhs, rhs) => lhs.imageIndex - rhs.imageIndex);
    audit.tasks = [0, 1].map(index => {
      const task = tasks.find(item => item.imageIndex === index);
      return {
        status: task?.status ?? 'idle',
        message_id: task?.messageId ?? null,
        swipe_id: task?.swipeId ?? null,
      };
    }) as [AuditTask, AuditTask];
  };

  const renderTask = (task: ImageTask) => {
    renderImageTask(task);
    updateTaskAudit();
  };

  async function runTask(task: ImageTask): Promise<void> {
    const key = imageTaskKey(task);
    const currentSettings = settings;
    if (!currentSettings || currentSettings.mode !== 'inline' || !currentSettings.enabled) {
      cache.remove(key);
      return;
    }

    task.status = 'running';
    status.value = 'generating';
    renderTask(task);
    try {
      const resource = await requestImage(
        task.prompt,
        getActiveApiProfile(currentSettings),
        task.abortController.signal,
      );
      if (cache.get(key) !== task) {
        resource.revoke?.();
        return;
      }
      assignImageResource(task, resource);
      recentCache.add(task, resource);
      audit.generation.status = 'success';
      status.value = 'ready';
      renderTask(task);
      console.info(LOG_PREFIX, '图片任务完成', {
        image_index: task.imageIndex,
        message_id: task.messageId,
        swipe_id: task.swipeId,
      });
    } catch (error) {
      if (cache.get(key) !== task) return;
      if (task.abortController.signal.aborted) {
        task.status = 'cancelled';
        renderTask(task);
        return;
      }
      task.status = 'failed';
      task.error = errorText(error);
      audit.generation.status = 'fail';
      setError(error);
      renderTask(task);
    }
  }

  async function runGiftTask(task: GiftImageTask, references: GiftImageReference[]): Promise<void> {
    const currentSettings = settings;
    if (!currentSettings?.gift.enabled) {
      task.status = 'cancelled';
      return;
    }

    task.status = 'running';
    status.value = 'generating';
    audit.gift.status = 'running';
    try {
      const context = collectGiftContext();
      task.messageId = context.messageId ?? task.messageId;
      task.swipeId = context.swipeId ?? task.swipeId;
      lastGiftTriggerMessageId = task.messageId;
      lastGiftTriggerMessageId = task.messageId;
      audit.gift.last_trigger_message_id = lastGiftTriggerMessageId;
      const prompt = composeGiftImagePrompt(currentSettings.gift, context);
      const resource = await requestGiftImage({
        prompt,
        references,
        profile: getActiveApiProfile(currentSettings),
        requestMode: currentSettings.gift.requestMode,
        jsonReferenceField: currentSettings.gift.jsonReferenceField,
        signal: task.abortController.signal,
      });
      if (!giftCache.has(task)) {
        resource.revoke?.();
        return;
      }
      task.image = resource;
      task.status = 'success';
      task.error = null;
      recentCache.add(
        {
          source: '礼物 CG',
          chatId: task.chatId,
          messageId: task.messageId,
          swipeId: task.swipeId,
          imageIndex: null,
          giftTaskId: task.id,
        },
        resource,
      );
      audit.gift.status = 'success';
      audit.gift.request_mode = resolveGiftRequestMode(
        getActiveApiProfile(currentSettings).serviceUrl,
        currentSettings.gift.requestMode,
      );
      status.value = 'ready';
      console.info(LOG_PREFIX, '礼物 CG 任务完成', {
        task_id: task.id,
        message_id: task.messageId,
        swipe_id: task.swipeId,
      });
    } catch (error) {
      if (!giftCache.has(task)) return;
      if (task.abortController.signal.aborted) {
        task.status = 'cancelled';
        audit.gift.status = 'idle';
        return;
      }
      task.status = 'failed';
      task.error = errorText(error);
      audit.gift.status = 'fail';
      setError(error);
    }
  }

  const generateGift = (messageId: number | null = null): GiftImageTask | null => {
    const currentSettings = settings;
    if (stopped || !currentSettings?.gift.enabled) return null;
    const references = referenceMemory.getRequired();
    if (references.length < 3) {
      audit.gift.status = 'skipped';
      audit.gift.reference_count = references.length;
      return null;
    }
    const targetMessageId = messageId ?? currentAssistantMessageId();
    const hasMessageId = Number.isFinite(targetMessageId);
    const resolvedMode = resolveGiftRequestMode(
      getActiveApiProfile(currentSettings).serviceUrl,
      currentSettings.gift.requestMode,
    );
    const task = giftCache.createPending({
      chatId: SillyTavern.getCurrentChatId(),
      messageId: hasMessageId ? targetMessageId : null,
      swipeId: hasMessageId ? currentSwipeId(targetMessageId) : null,
      characterReferenceName: references
        .filter(reference => reference.kind === 'character')
        .map(reference => reference.name)
        .join('、'),
      templateImageName: references.find(reference => reference.kind === 'template')?.name ?? '模板图',
      requestMode: resolvedMode,
      referenceCount: references.length,
    });
    audit.gift = {
      ...audit.gift,
      status: 'pending',
      request_mode: resolvedMode,
      reference_count: references.length,
    };
    void runGiftTask(task, references);
    return task;
  };

  const ensureGeneration = (messageId: number): GenerationState => {
    const chatId = SillyTavern.getCurrentChatId();
    if (activeGeneration && activeGeneration.chatId === chatId) {
      activeGeneration.messageId = messageId;
      return activeGeneration;
    }

    const generation: GenerationState = {
      id: `story-image-${Date.now()}-${audit.run_id}`,
      messageId,
      chatId,
      streamText: '',
      startedIndices: new Set(),
    };
    activeGeneration = generation;
    audit.run_id += 1;
    audit.generation = { id: generation.id, status: 'running' };
    audit.last_error = null;
    audit.lifecycle.status = 'running';
    status.value = 'generating';
    return generation;
  };

  const bindMarkerToTask = (task: ImageTask, marker: InlineImagePrompt) => {
    task.paragraphIndex = marker.paragraphIndex;
    task.anchorTextBefore = marker.anchorTextBefore;
    task.anchorTextAfter = marker.anchorTextAfter;
    if (task.status === 'pending') task.prompt = marker.prompt;
  };

  const startMarkerTasks = (generation: GenerationState, text: string, final: boolean) => {
    if (!settings?.enabled || settings.mode !== 'inline') return;
    const scan = scanInlineImagePrompts(text);
    audit.markers = {
      count: scan.totalValid,
      valid_count: scan.markers.length,
      truncated: scan.truncated,
    };
    if (scan.truncated) console.warn(LOG_PREFIX, '回复中的随文插图标记超过两条，只处理前两条');

    const messageId = generation.messageId ?? currentAssistantMessageId();
    const swipeId = currentSwipeId(messageId);
    scan.markers.forEach(marker => {
      const taskTarget = {
        chatId: generation.chatId,
        messageId,
        swipeId,
        imageIndex: marker.index,
      };
      const existing = cache.get(imageTaskKey(taskTarget));
      if (existing) {
        generation.startedIndices.add(marker.index);
        bindMarkerToTask(existing, marker);
        renderTask(existing);
        return;
      }

      if (generation.startedIndices.has(marker.index)) {
        cache
          .getForMessage(generation.chatId, messageId)
          .filter(task => task.imageIndex === marker.index)
          .forEach(task => cache.remove(imageTaskKey(task)));
        generation.startedIndices.delete(marker.index);
      }

      generation.startedIndices.add(marker.index);
      const task = createImageTask(marker, {
        chatId: generation.chatId,
        messageId,
        swipeId,
      });
      cache.set(task);
      renderTask(task);
      void runTask(task);
    });

    if (final) {
      audit.generation.status = 'success';
      audit.lifecycle.status = 'running';
    }
    updateTaskAudit();
  };

  const persistCleanedMessage = (messageId: number, swipeId: number, originalMessage: string): void => {
    const cleanedMessage = cleanInlineImageMessage(originalMessage);
    if (cleanedMessage === originalMessage) return;

    const cleanupKey = String(SillyTavern.getCurrentChatId()) + '::' + String(messageId) + '::' + String(swipeId);
    if (sourceCleanupInFlight.has(cleanupKey)) return;
    sourceCleanupInFlight.add(cleanupKey);
    void setChatMessages([{ message_id: messageId, swipe_id: swipeId, message: cleanedMessage }], {
      refresh: 'affected',
    })
      .catch(error => setError(error))
      .finally(() => sourceCleanupInFlight.delete(cleanupKey));
  };

  const renderTasksForMessage = (messageId: number) => {
    const chatId = SillyTavern.getCurrentChatId();
    cache.getForMessage(chatId, messageId).forEach(renderTask);
  };

  const installPrompt = () => {
    promptUninject?.();
    promptUninject = null;
    uninjectPrompts([PROMPT_INJECTION_ID]);
    const currentSettings = settings;
    const promptContent = currentSettings ? composeInlinePrompt(currentSettings) : '';
    const hasPromptSection = currentSettings
      ? [
          currentSettings.basePrompt,
          currentSettings.scenePrompt,
          currentSettings.stylePrompt,
          currentSettings.safetyPrompt,
        ].some(section => section.trim())
      : false;
    if (!currentSettings?.enabled || currentSettings.mode !== 'inline' || !hasPromptSection) {
      audit.injection = { status: 'success', enabled: false };
      return;
    }

    try {
      promptUninject = injectPrompts([
        {
          id: PROMPT_INJECTION_ID,
          position: 'in_chat',
          depth: 0,
          role: 'system',
          should_scan: false,
          content: promptContent,
        },
      ]).uninject;
      audit.injection = { status: 'success', enabled: true };
    } catch (error) {
      audit.injection = { status: 'fail', enabled: true };
      setError(error);
    }
  };

  const onGenerationStarted = (type: string, _option: any, dryRun: boolean) => {
    if (stopped || dryRun || isIgnoredMessageType(type) || !settings?.enabled || settings.mode !== 'inline') return;
    const generation = ensureGeneration(currentAssistantMessageId());
    generation.streamText = '';
    generation.startedIndices.clear();
    console.info(LOG_PREFIX, '开始监听随文插图标记', { generation_id: generation.id });
  };

  const onStreamToken = (text: string) => {
    if (stopped || !settings?.enabled || settings.mode !== 'inline' || typeof text !== 'string') return;
    const generation = activeGeneration ?? ensureGeneration(currentAssistantMessageId());
    const nextText = text.startsWith(generation.streamText) ? text : `${generation.streamText}${text}`;
    generation.streamText = nextText;
    generation.messageId = currentAssistantMessageId();
    startMarkerTasks(generation, nextText, false);
  };

  const onMessageReceived = (messageId: number, type: string) => {
    if (stopped || isIgnoredMessageType(type)) return;
    const message = getChatMessages(messageId)[0];
    if (!message || message.role !== 'assistant') return;
    const countKey = `${SillyTavern.getCurrentChatId()}::${messageId}`;
    if (!countedAssistantMessages.has(countKey)) {
      countedAssistantMessages.add(countKey);
      assistantReplyCount += 1;
      audit.gift.assistant_reply_count = assistantReplyCount;
    }
    const swipeId = currentSwipeId(messageId);
    if (settings?.enabled && settings.mode === 'inline') {
      const generation = activeGeneration ?? ensureGeneration(messageId);
      generation.messageId = messageId;
      startMarkerTasks(generation, message.message, true);
      audit.lifecycle.status = 'running';
      setTimeout(() => {
        if (activeGeneration === generation) {
          activeGeneration = null;
          audit.lifecycle.status = 'idle';
          status.value = 'ready';
        }
      }, 5_000);
    }
    persistCleanedMessage(messageId, swipeId, message.message);
  };

  const listen = <T extends EventType>(event: T, listener: ListenerType[T]) => {
    const wrapped = ((...args: any[]) => {
      try {
        (listener as (...listenerArgs: any[]) => void)(...args);
      } catch (error) {
        setError(error);
      }
    }) as ListenerType[T];
    stopListeners.push(eventOn(event, wrapped).stop);
  };

  const runtime: StoryImageRuntime = {
    status,
    audit,
    recentImages: recentCache.images,
    referenceImages: referenceMemory.images,
    setGiftReferenceFile: (slot, file, name) => referenceMemory.setLocal(slot, file, name),
    setGiftReferenceUrl: (slot, url, name) => referenceMemory.setUrl(slot, url, name),
    renameGiftReference: (slot, name) => referenceMemory.rename(slot, name),
    removeGiftReference: slot => referenceMemory.remove(slot),
    giftImages: giftCache.tasks,
    generateGift,
    clearGiftImages: () => giftCache.clear(),
    start: () => {
      if (stopped) return;
      clearRenderedHosts();
      stopped = false;
      audit.lifecycle.status = 'idle';
      listen(tavern_events.GENERATION_STARTED, onGenerationStarted);
      listen(tavern_events.STREAM_TOKEN_RECEIVED, onStreamToken);
      listen(tavern_events.MESSAGE_RECEIVED, onMessageReceived);
      listen(tavern_events.GENERATION_ENDED, messageId => {
        audit.generation.status = audit.tasks.some(task => task.status === 'failed') ? 'fail' : 'success';
        if (messageId !== null && messageId !== undefined) renderTasksForMessage(messageId);
      });
      listen(tavern_events.CHARACTER_MESSAGE_RENDERED, messageId => renderTasksForMessage(messageId));
      listen(tavern_events.MESSAGE_SWIPED, messageId => renderTasksForMessage(messageId));
      listen(tavern_events.MESSAGE_SWIPE_DELETED, eventData => {
        cache.removeMessage(SillyTavern.getCurrentChatId(), eventData.messageId);
      });
      listen(tavern_events.CHAT_CHANGED, () => {
        cache.clear();
        activeGeneration = null;
        assistantReplyCount = 0;
        lastGiftTriggerMessageId = null;
        countedAssistantMessages.clear();
        audit.gift = {
          ...audit.gift,
          status: 'idle',
          assistant_reply_count: 0,
          last_trigger_message_id: null,
        };
        audit.tasks = [
          { status: 'idle', message_id: null, swipe_id: null },
          { status: 'idle', message_id: null, swipe_id: null },
        ];
        audit.lifecycle.status = 'idle';
        status.value = 'idle';
        installPrompt();
      });
      listen(tavern_events.MESSAGE_EDITED, messageId => {
        cache.removeMessage(SillyTavern.getCurrentChatId(), messageId);
        renderTasksForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_UPDATED, messageId => renderTasksForMessage(messageId));
      listen(tavern_events.MESSAGE_DELETED, () => {
        cache.clear();
        audit.tasks = [
          { status: 'idle', message_id: null, swipe_id: null },
          { status: 'idle', message_id: null, swipe_id: null },
        ];
      });
      listen(tavern_events.MORE_MESSAGES_LOADED, () => cache.values().forEach(renderTask));
      installPrompt();
      cache.values().forEach(renderTask);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopListeners.splice(0).forEach(stop => stop());
      promptUninject?.();
      promptUninject = null;
      uninjectPrompts([PROMPT_INJECTION_ID]);
      cache.clear();
      giftCache.clear();
      referenceMemory.clear();
      clearRenderedHosts();
      recentCache.clear();
      activeGeneration = null;
      audit.lifecycle.status = 'stopped';
      status.value = 'stopped';
    },
    updateSettings: nextSettings => {
      settings = nextSettings;
      installPrompt();
      if (!settings.gift.enabled) {
        giftCache.clear();
        audit.gift.status = 'idle';
      }
      if (!settings.enabled || settings.mode !== 'inline') {
        cache.clear();
        clearRenderedHosts();
        activeGeneration = null;
        audit.tasks = [
          { status: 'idle', message_id: null, swipe_id: null },
          { status: 'idle', message_id: null, swipe_id: null },
        ];
        status.value = 'idle';
      }
    },
  };

  return runtime;
}
