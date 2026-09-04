import { ref, type Ref } from 'vue';
import { decideFloorTrigger } from './display-policy';
import { saveImageResourceToCharacterGallery } from './gallery-storage';
import { requestImage, type ImageResource } from './image-api';
import { ImagePlacementCache } from './image-placement';
import { ImagePresenter } from './image-presenter';
import { clearArtifactAssociations, type ImagePlacementTarget } from './image-system';
import {
  clearRenderedHosts,
  removeRenderedPlacementHost,
  removeRenderedTaskHost,
  renderImagePlacement,
  renderImageTask,
  renderMessagePlacements,
  type ImagePlacementRenderHandlers,
} from './message-renderer';
import { cleanInlineImageMessage, scanInlineImagePrompts, type InlineImagePrompt } from './marker';
import type { DisplayMode, DrawingPreset, FloorTriggerDecision, ImageOutputPreset } from './pipeline-types';
import { processDrawingPrompt } from './prompt-processor';
import { RecentImageCache, type RecentGeneratedImage } from './recent-image-cache';
import { isMatchingNormalAssistantReply, isSingleCharacterChat, shouldArmStoryImageGeneration } from './runtime-policy';
import {
  getActiveApiProfile,
  getCurrentDrawingPreset,
  getCurrentOutputPreset,
  type ImageApiProfile,
  type StoryImageSettings,
} from './settings';
import {
  createImageTask,
  deriveGenerationStatus,
  imageTaskKey,
  ImageTaskCache,
  type ImageTask,
  type ImageTaskStatus,
} from './task-cache';

type RuntimeStatus = 'idle' | 'generating' | 'ready' | 'error' | 'stopped';

type GenerationState = {
  id: string;
  messageId: number | null;
  chatId: string;
  nextFloorCount: number;
  decision: FloorTriggerDecision;
  preset: DrawingPreset;
  outputPreset: ImageOutputPreset;
  profile: ImageApiProfile;
  displayMode: DisplayMode;
};

type AuditTask = { status: string; message_id: number | null; swipe_id: number | null };

export type GiftArrivalNoticeAudit = {
  status: 'idle' | 'pending' | 'success' | 'fail' | 'skipped';
  shown: boolean;
};

export type GiftArrivalNoticeReadiness = {
  currentTask: boolean;
  artifactCached: boolean;
  giftSucceeded: boolean;
};

export function shouldProcessReceivedInlineMessage(enabled: boolean | undefined): boolean {
  return enabled === true;
}

export function runReceivedInlineMessageEffects(enabled: boolean | undefined, process: () => void): boolean {
  if (!shouldProcessReceivedInlineMessage(enabled)) return false;
  process();
  return true;
}

export function shouldRenderInlineTask(displayMode: DisplayMode, status: ImageTaskStatus): boolean {
  return displayMode === 'inline' && (status === 'pending' || status === 'running');
}

export type StoryImageAudit = {
  run_id: number;
  lifecycle: { status: 'idle' | 'running' | 'stopped' };
  injection: { status: 'pending' | 'success' | 'fail'; enabled: boolean };
  generation: { id: string | null; status: 'pending' | 'running' | 'success' | 'fail' };
  markers: { count: number; valid_count: number; truncated: boolean };
  tasks: [AuditTask, AuditTask];
  gift: {
    status: 'idle' | 'pending' | 'running' | 'success' | 'fail' | 'skipped';
    display_mode: DisplayMode;
    assistant_reply_count: number;
    last_trigger_message_id: number | null;
    skip_floors: number;
    last_skip_reason: FloorTriggerDecision['reason'] | 'no-markers' | null;
  };
  arrival_notice: GiftArrivalNoticeAudit;
  cache: {
    mode: 'memory-only';
    persisted: false;
    artifact_count: number;
    placement_count: number;
    prediction_status: 'disabled';
  };
  last_error: string | null;
};

export type StoryImageRuntime = {
  status: Readonly<Ref<RuntimeStatus>>;
  audit: StoryImageAudit;
  recentImages: Readonly<Ref<RecentGeneratedImage[]>>;
  removeRecentImage: (id: string) => boolean;
  saveRecentImageToGallery: (artifactId: string) => Promise<void>;
  start: () => void;
  stop: () => void;
  updateSettings: (nextSettings: StoryImageSettings) => void;
};

const PROMPT_INJECTION_ID = 'story-image-drawing-preset';
const LEGACY_PROMPT_INJECTION_ID = 'story-image-inline-prompt';
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
      display_mode: 'inline',
      assistant_reply_count: 0,
      last_trigger_message_id: null,
      skip_floors: 0,
      last_skip_reason: null,
    },
    arrival_notice: { status: 'idle', shown: false },
    cache: {
      mode: 'memory-only',
      persisted: false,
      artifact_count: 0,
      placement_count: 0,
      prediction_status: 'disabled',
    },
    last_error: null,
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return '未知错误';
}

export function clearLastErrorIfUnchanged(
  audit: Pick<StoryImageAudit, 'last_error'>,
  expectedErrorRevision: number,
  currentErrorRevision: number,
): boolean {
  if (currentErrorRevision !== expectedErrorRevision) return false;
  audit.last_error = null;
  return true;
}

export function notifyGiftArrivalOnce<T extends object>(
  task: T,
  readiness: Readonly<GiftArrivalNoticeReadiness>,
  attemptedTasks: WeakSet<T>,
  audit: GiftArrivalNoticeAudit,
  notify: () => void,
): boolean {
  if (attemptedTasks.has(task)) return false;
  if (!readiness.currentTask || !readiness.artifactCached || !readiness.giftSucceeded) {
    audit.status = 'skipped';
    audit.shown = false;
    return false;
  }
  attemptedTasks.add(task);
  try {
    notify();
    audit.status = 'success';
    audit.shown = true;
  } catch {
    audit.status = 'fail';
    audit.shown = false;
  }
  return true;
}

function currentSwipeId(messageId: number): number {
  const message = getChatMessages(messageId, { include_swipes: true })[0];
  return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}

function cloneProfile(profile: ImageApiProfile): ImageApiProfile {
  return { ...profile, extraBody: { ...profile.extraBody } };
}

function assignImageResource(task: ImageTask, resource: ImageResource): void {
  task.image = resource;
  task.status = 'success';
  task.error = null;
}

export function createStoryImageRuntime(): StoryImageRuntime {
  const status = ref<RuntimeStatus>('idle');
  const audit = createEmptyAudit();
  (globalThis as typeof globalThis & { __storyImageAudit?: StoryImageAudit }).__storyImageAudit = audit;
  const inlineTaskKeys = new Set<string>();
  const cache = new ImageTaskCache({
    onRemove: task => {
      inlineTaskKeys.delete(imageTaskKey(task));
      removeRenderedTaskHost(task);
    },
  });
  const placementCacheRef: { current: ImagePlacementCache | null } = { current: null };
  const recentCache = new RecentImageCache({
    onRemove: artifact => {
      clearArtifactAssociations(artifact.id, cache.values());
      placementCacheRef.current?.placements.value
        .filter(placement => placement.artifactId === artifact.id)
        .forEach(placement => placementCacheRef.current?.remove(placement.id));
    },
  });
  const placementCache = new ImagePlacementCache(artifactId => recentCache.cloneResource(artifactId), {
    onRemove: placement => removeRenderedPlacementHost(placement.id),
  });
  placementCacheRef.current = placementCache;
  const presenter = new ImagePresenter({ recentCache, placementCache });
  let settings: StoryImageSettings | null = null;
  let activeGeneration: GenerationState | null = null;
  let memoryChatId = SillyTavern.getCurrentChatId();
  let normalAssistantFloorCount = 0;
  let errorRevision = 0;
  let started = false;
  let stopped = false;
  let promptUninject: (() => void) | null = null;
  const giftArrivalNoticeAttempts = new WeakSet<ImageTask>();
  const giftArrivalNoticeGenerations = new Set<string>();
  const sourceCleanupInFlight = new Set<string>();
  const stopListeners: Array<() => void> = [];

  const syncCacheAudit = (): void => {
    audit.cache.artifact_count = recentCache.artifacts.value.length;
    audit.cache.placement_count = placementCache.placements.value.length;
  };

  const syncRuntimeStatus = (): void => {
    if (stopped) {
      status.value = 'stopped';
      return;
    }
    const tasks = cache.values();
    if (tasks.some(task => task.status === 'pending' || task.status === 'running')) status.value = 'generating';
    else if (audit.last_error) status.value = 'error';
    else if (tasks.length > 0 || recentCache.artifacts.value.length > 0 || audit.generation.status === 'success')
      status.value = 'ready';
    else status.value = 'idle';
  };

  const setError = (error: unknown): void => {
    const message = errorText(error);
    errorRevision += 1;
    audit.last_error = message;
    status.value = 'error';
    console.warn(LOG_PREFIX, message);
  };

  const clearPrompt = (): void => {
    promptUninject?.();
    promptUninject = null;
    uninjectPrompts([LEGACY_PROMPT_INJECTION_ID, PROMPT_INJECTION_ID]);
  };

  const installPrompt = (instructionText: string | null): void => {
    try {
      clearPrompt();
      const content = instructionText?.trim() ?? '';
      if (!content) {
        audit.injection = { status: 'success', enabled: false };
        return;
      }
      promptUninject = injectPrompts([
        {
          id: PROMPT_INJECTION_ID,
          position: 'in_chat',
          depth: 0,
          role: 'system',
          should_scan: false,
          content: `<杠杠の生图机>\n${content}\n</杠杠の生图机>`,
        },
      ]).uninject;
      audit.injection = { status: 'success', enabled: true };
    } catch (error) {
      audit.injection = { status: 'fail', enabled: Boolean(instructionText?.trim()) };
      setError(error);
    }
  };

  const updateTaskAudit = (messageId: number | null, swipeIdOverride?: number): void => {
    const swipeId = messageId === null ? null : (swipeIdOverride ?? currentSwipeId(messageId));
    const tasks =
      messageId === null
        ? []
        : cache
            .getForMessage(SillyTavern.getCurrentChatId(), messageId)
            .filter(task => task.swipeId === swipeId)
            .sort((left, right) => left.imageIndex - right.imageIndex);
    audit.tasks = [0, 1].map(index => {
      const task = tasks.find(candidate => candidate.imageIndex === index);
      return {
        status: task?.status ?? 'idle',
        message_id: task?.messageId ?? null,
        swipe_id: task?.swipeId ?? null,
      };
    }) as [AuditTask, AuditTask];
  };

  const updateGenerationStatus = (generationId: string, messageId: number): void => {
    if (audit.generation.id !== generationId) return;
    const tasks = cache.values().filter(task => task.generationId === generationId);
    const generationStatus = tasks.length > 0 ? deriveGenerationStatus(tasks) : 'success';
    audit.generation.status = generationStatus;
    if (audit.gift.display_mode === 'gift') {
      audit.gift.status =
        tasks.length === 0
          ? 'skipped'
          : generationStatus === 'running'
            ? 'running'
            : generationStatus === 'fail'
              ? 'fail'
              : 'success';
      if (tasks.length === 0) audit.gift.last_skip_reason = 'no-markers';
    }
    updateTaskAudit(messageId);
    syncRuntimeStatus();
  };

  const isStoredTask = (task: ImageTask): boolean =>
    cache.get(imageTaskKey(task)) === task &&
    SillyTavern.getCurrentChatId() === task.chatId &&
    currentSwipeId(task.messageId) === task.swipeId;

  const placementRenderHandlers: ImagePlacementRenderHandlers = {
    onImageError: placement => {
      placementCache.remove(placement.id);
      syncCacheAudit();
      toastr.warning('图片加载失败，这次先不显示。');
    },
  };

  const taskRenderHandlers = {
    onImageError: (task: ImageTask): boolean => {
      removeRenderedTaskHost(task);
      return false;
    },
  };

  const renderInlineTasksForMessage = (messageId: number, swipeIdOverride?: number): number => {
    const activeSwipeId = swipeIdOverride ?? currentSwipeId(messageId);
    const tasks = cache.getForMessage(memoryChatId, messageId);
    return tasks.filter(task => {
      if (
        task.swipeId !== activeSwipeId ||
        !inlineTaskKeys.has(imageTaskKey(task)) ||
        !shouldRenderInlineTask('inline', task.status)
      ) {
        removeRenderedTaskHost(task);
        return false;
      }
      return renderImageTask(task, taskRenderHandlers, activeSwipeId);
    }).length;
  };

  const renderPlacementsForMessage = (messageId: number, swipeIdOverride?: number): number =>
    renderMessagePlacements(placementCache.placements.value, messageId, placementRenderHandlers, swipeIdOverride);

  const renderAllPlacements = (): void => {
    const messageIds = new Set([
      ...placementCache.placements.value.map(placement => placement.target.messageId),
      ...cache
        .values()
        .filter(task => inlineTaskKeys.has(imageTaskKey(task)) && shouldRenderInlineTask('inline', task.status))
        .map(task => task.messageId),
    ]);
    messageIds.forEach(messageId => {
      renderInlineTasksForMessage(messageId);
      renderPlacementsForMessage(messageId);
    });
  };

  async function runTask(
    task: ImageTask,
    outputPreset: ImageOutputPreset,
    profile: ImageApiProfile,
    displayMode: DisplayMode,
  ): Promise<void> {
    const errorRevisionAtStart = errorRevision;
    if (!isStoredTask(task)) {
      removeRenderedTaskHost(task);
      return;
    }
    task.status = 'running';
    status.value = 'generating';
    if (shouldRenderInlineTask(displayMode, task.status)) renderImageTask(task, taskRenderHandlers, task.swipeId);
    if (displayMode === 'gift') audit.gift.status = 'running';
    updateGenerationStatus(task.generationId, task.messageId);
    try {
      const input = await processDrawingPrompt(outputPreset, task.intent.prompt);
      if (!isStoredTask(task)) {
        removeRenderedTaskHost(task);
        return;
      }
      const resource = await requestImage(profile, input, task.abortController.signal);
      if (!isStoredTask(task)) {
        resource.revoke?.();
        removeRenderedTaskHost(task);
        return;
      }
      assignImageResource(task, resource);
      const target: ImagePlacementTarget = {
        kind: 'inline-anchor',
        messageId: task.messageId,
        swipeId: task.swipeId,
        imageIndex: task.imageIndex,
        paragraphIndex: task.paragraphIndex,
        anchorTextBefore: task.anchorTextBefore,
        anchorTextAfter: task.anchorTextAfter,
      };
      const presentation = presenter.present({
        resource,
        chatId: task.chatId,
        sourceIntentId: task.intent.id,
        displayMode,
        placementTarget: displayMode === 'inline' ? target : undefined,
        artifactTarget: { messageId: task.messageId, swipeId: task.swipeId, imageIndex: task.imageIndex },
      });
      if (!presentation) throw new Error('图片无法加入页面内存缓存');
      if (displayMode === 'inline') removeRenderedTaskHost(task);
      task.artifactId = presentation.artifact.id;
      syncCacheAudit();
      if (presentation.placement) {
        renderImagePlacement(presentation.placement, placementRenderHandlers, task.swipeId);
      } else {
        audit.gift.status = 'success';
        if (!giftArrivalNoticeGenerations.has(task.generationId)) {
          giftArrivalNoticeGenerations.add(task.generationId);
          audit.arrival_notice = { status: 'pending', shown: false };
          notifyGiftArrivalOnce(
            task,
            { currentTask: isStoredTask(task), artifactCached: true, giftSucceeded: true },
            giftArrivalNoticeAttempts,
            audit.arrival_notice,
            () => toastr.info('礼物 CG 已送达，可在「最近生成」中查看。'),
          );
        }
      }
      clearLastErrorIfUnchanged(audit, errorRevisionAtStart, errorRevision);
      console.info(LOG_PREFIX, '图片任务完成', {
        display_mode: displayMode,
        image_index: task.imageIndex,
        message_id: task.messageId,
        swipe_id: task.swipeId,
      });
    } catch (error) {
      removeRenderedTaskHost(task);
      if (!isStoredTask(task)) return;
      if (task.abortController.signal.aborted) task.status = 'cancelled';
      else {
        task.status = 'failed';
        task.error = errorText(error);
        if (displayMode === 'gift') audit.gift.status = 'fail';
        setError(error);
      }
    } finally {
      if (cache.get(imageTaskKey(task)) === task) updateGenerationStatus(task.generationId, task.messageId);
      syncRuntimeStatus();
    }
  }

  const persistCleanedMessage = (messageId: number, swipeId: number, originalMessage: string): void => {
    const cleanedMessage = cleanInlineImageMessage(originalMessage);
    if (cleanedMessage === originalMessage) return;
    const cleanupKey = `${SillyTavern.getCurrentChatId()}::${messageId}::${swipeId}`;
    if (sourceCleanupInFlight.has(cleanupKey)) return;
    sourceCleanupInFlight.add(cleanupKey);
    void setChatMessages([{ message_id: messageId, swipe_id: swipeId, message: cleanedMessage }], {
      refresh: 'affected',
    })
      .catch(error => setError(error))
      .finally(() => sourceCleanupInFlight.delete(cleanupKey));
  };

  const startMarkerTasks = (generation: GenerationState, messageId: number, message: string): void => {
    const scan = scanInlineImagePrompts(message);
    audit.markers = { count: scan.totalValid, valid_count: scan.markers.length, truncated: scan.truncated };
    if (scan.truncated) console.warn(LOG_PREFIX, '回复中的生图标记超过两条，只处理前两条');
    const swipeId = currentSwipeId(messageId);
    scan.markers.forEach((marker: InlineImagePrompt) => {
      const task = createImageTask(marker, {
        chatId: generation.chatId,
        messageId,
        swipeId,
        generationId: generation.id,
      });
      cache.set(task);
      if (generation.displayMode === 'inline') {
        inlineTaskKeys.add(imageTaskKey(task));
        renderImageTask(task, taskRenderHandlers, swipeId);
      }
      void runTask(task, generation.outputPreset, generation.profile, generation.displayMode);
    });
    updateTaskAudit(messageId, swipeId);
    updateGenerationStatus(generation.id, messageId);
    persistCleanedMessage(messageId, swipeId, message);
  };

  const prepareGeneration = (type: string, _option: unknown, dryRun: boolean): void => {
    const currentSettings = settings;
    const groupId = SillyTavern.groupId;
    if (
      !currentSettings ||
      !shouldArmStoryImageGeneration({ enabled: currentSettings.enabled, type, dryRun, groupId })
    ) {
      activeGeneration = null;
      installPrompt(null);
      audit.gift.last_skip_reason = !currentSettings?.enabled
        ? 'disabled'
        : !isSingleCharacterChat(groupId)
          ? 'group-chat'
          : 'non-normal-generation';
      return;
    }

    const nextFloorCount = normalAssistantFloorCount + 1;
    const decision = decideFloorTrigger({
      enabled: currentSettings.enabled,
      isNormalGeneration: true,
      isGroupChat: false,
      normalAssistantFloorCount: nextFloorCount,
      displaySettings: currentSettings.displaySettings,
    });
    audit.run_id += 1;
    const generation: GenerationState = {
      id: `story-image-${Date.now()}-${audit.run_id}`,
      messageId: null,
      chatId: memoryChatId,
      nextFloorCount,
      decision,
      preset: { ...getCurrentDrawingPreset(currentSettings) },
      outputPreset: { ...getCurrentOutputPreset(currentSettings) },
      profile: cloneProfile(getActiveApiProfile(currentSettings)),
      displayMode: currentSettings.displaySettings.displayMode,
    };
    activeGeneration = generation;
    audit.generation = { id: generation.id, status: 'running' };
    audit.gift = {
      ...audit.gift,
      status: decision.shouldTrigger && generation.displayMode === 'gift' ? 'pending' : 'idle',
      display_mode: generation.displayMode,
      skip_floors: currentSettings.displaySettings.skipFloors,
      last_skip_reason: decision.shouldTrigger ? null : decision.reason,
    };
    audit.arrival_notice = { status: 'idle', shown: false };
    audit.markers = { count: 0, valid_count: 0, truncated: false };
    audit.tasks = [
      { status: 'idle', message_id: null, swipe_id: null },
      { status: 'idle', message_id: null, swipe_id: null },
    ];
    audit.last_error = null;
    installPrompt(decision.shouldTrigger ? generation.preset.instructionText : null);
  };

  const onMessageReceived = (messageId: number, type: string): void => {
    const generation = activeGeneration;
    const message = getChatMessages(messageId)[0];
    if (
      !generation ||
      generation.chatId !== SillyTavern.getCurrentChatId() ||
      !isMatchingNormalAssistantReply({
        type,
        role: message?.role,
        expectedMessageId: generation.messageId,
        receivedMessageId: messageId,
      })
    )
      return;

    generation.messageId = messageId;
    activeGeneration = null;
    normalAssistantFloorCount = generation.nextFloorCount;
    audit.gift.assistant_reply_count = normalAssistantFloorCount;
    installPrompt(null);
    if (!generation.decision.shouldTrigger) {
      audit.generation.status = 'success';
      syncRuntimeStatus();
      return;
    }
    audit.gift.last_trigger_message_id = messageId;
    startMarkerTasks(generation, messageId, message.message);
  };

  const resetMemory = (): void => {
    activeGeneration = null;
    cache.clear();
    inlineTaskKeys.clear();
    placementCache.clear();
    recentCache.clear();
    clearRenderedHosts();
    sourceCleanupInFlight.clear();
    giftArrivalNoticeGenerations.clear();
    normalAssistantFloorCount = 0;
    audit.generation = { id: null, status: 'pending' };
    audit.markers = { count: 0, valid_count: 0, truncated: false };
    audit.tasks = [
      { status: 'idle', message_id: null, swipe_id: null },
      { status: 'idle', message_id: null, swipe_id: null },
    ];
    audit.gift = {
      ...audit.gift,
      status: 'idle',
      assistant_reply_count: 0,
      last_trigger_message_id: null,
      last_skip_reason: null,
    };
    audit.arrival_notice = { status: 'idle', shown: false };
    audit.last_error = null;
    syncCacheAudit();
  };

  const listen = <T extends EventType>(event: T, listener: ListenerType[T]): void => {
    const wrapped = ((...args: any[]) => {
      try {
        (listener as (...listenerArgs: any[]) => void)(...args);
      } catch (error) {
        setError(error);
      }
    }) as ListenerType[T];
    stopListeners.push(eventOn(event, wrapped).stop);
  };

  return {
    status,
    audit,
    recentImages: recentCache.images,
    saveRecentImageToGallery: async artifactId => {
      const resource = recentCache.cloneResource(artifactId);
      if (!resource) throw new Error('图片已不在页面内存中');
      try {
        const artifact = recentCache.getArtifact(artifactId);
        const imageIndex = artifact?.target.imageIndex ?? 0;
        await saveImageResourceToCharacterGallery(resource, {
          characterName: SillyTavern.name2,
          filename: `story-image-${artifact?.target.messageId ?? 'unknown'}-${imageIndex + 1}.png`,
        });
      } finally {
        resource.revoke?.();
      }
    },
    removeRecentImage: id => {
      const removed = recentCache.remove(id);
      syncCacheAudit();
      return removed;
    },
    start: () => {
      if (started || stopped) return;
      started = true;
      audit.lifecycle.status = 'running';
      clearRenderedHosts();
      listen(tavern_events.GENERATION_STARTED, prepareGeneration);
      listen(tavern_events.MESSAGE_RECEIVED, onMessageReceived);
      listen(tavern_events.GENERATION_ENDED, messageId => {
        if (Number.isInteger(messageId)) {
          renderInlineTasksForMessage(messageId);
          renderPlacementsForMessage(messageId);
        }
      });
      listen(tavern_events.CHARACTER_MESSAGE_RENDERED, messageId => {
        renderInlineTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_SWIPED, messageId => {
        const swipeId = currentSwipeId(messageId);
        cache
          .getForMessage(memoryChatId, messageId)
          .filter(task => task.swipeId !== swipeId)
          .forEach(task => cache.remove(imageTaskKey(task)));
        renderInlineTasksForMessage(messageId, swipeId);
        renderPlacementsForMessage(messageId, swipeId);
        updateTaskAudit(messageId, swipeId);
      });
      listen(tavern_events.MESSAGE_SWIPE_DELETED, eventData => {
        cache.removeMessage(memoryChatId, eventData.messageId);
        placementCache.placements.value
          .filter(placement => placement.target.messageId === eventData.messageId)
          .forEach(placement => placementCache.remove(placement.id));
        renderInlineTasksForMessage(eventData.messageId, eventData.newSwipeId);
        renderPlacementsForMessage(eventData.messageId, eventData.newSwipeId);
        updateTaskAudit(eventData.messageId, eventData.newSwipeId);
        syncCacheAudit();
      });
      listen(tavern_events.CHAT_CHANGED, newChatId => {
        if (newChatId === memoryChatId) {
          installPrompt(null);
          setTimeout(renderAllPlacements, 0);
          return;
        }
        memoryChatId = newChatId;
        clearPrompt();
        resetMemory();
        status.value = 'idle';
      });
      listen(tavern_events.MESSAGE_EDITED, messageId => {
        cache.removeMessage(memoryChatId, messageId);
        placementCache.placements.value
          .filter(placement => placement.target.messageId === messageId)
          .forEach(placement => placementCache.remove(placement.id));
        syncCacheAudit();
      });
      listen(tavern_events.MESSAGE_UPDATED, messageId => {
        renderInlineTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_DELETED, () => {
        clearPrompt();
        resetMemory();
        status.value = 'idle';
      });
      listen(tavern_events.MORE_MESSAGES_LOADED, renderAllPlacements);
      installPrompt(null);
      renderAllPlacements();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopListeners.splice(0).forEach(stop => stop());
      try {
        clearPrompt();
      } catch {
        // Host teardown may already have removed the injection runtime.
      }
      resetMemory();
      audit.lifecycle.status = 'stopped';
      status.value = 'stopped';
    },
    updateSettings: nextSettings => {
      settings = nextSettings;
      recentCache.setLimit(nextSettings.recentImageLimit);
      syncCacheAudit();
      audit.gift.display_mode = nextSettings.displaySettings.displayMode;
      audit.gift.skip_floors = nextSettings.displaySettings.skipFloors;
      if (!nextSettings.enabled) {
        activeGeneration = null;
        installPrompt(null);
        cache
          .values()
          .filter(task => task.status === 'pending' || task.status === 'running')
          .forEach(task => cache.remove(imageTaskKey(task)));
        audit.generation = { id: null, status: 'pending' };
        audit.gift.status = 'idle';
        status.value = 'idle';
      }
    },
  };
}
