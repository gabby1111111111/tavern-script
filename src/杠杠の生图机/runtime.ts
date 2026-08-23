import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { requestGiftImage, requestImage, resolveGiftRequestMode, type ImageResource } from './image-api';
import { collectGiftContext } from './gift-context';
import { GiftImageCache, type GiftImageTask } from './gift-image-cache';
import { composeGiftImagePrompt } from './gift-prompt';
import { GiftScheduler, type GiftTriggerInterval } from './gift-scheduler';
import { ImagePlacementCache, type ImagePlacement } from './image-placement';
import {
  clearArtifactAssociations,
  createImageIntent,
  toSafeImageArtifactDescriptors,
  type ImageIntent,
  type ImagePlacementTarget,
  type SafeImageArtifactDescriptor,
} from './image-system';
import {
  clearRenderedHosts,
  removeRenderedPlacementHost,
  removeRenderedTaskHost,
  renderImageTask,
  renderImagePlacement,
  renderMessagePlacements,
  type ImagePlacementRenderHandlers,
  type ImageTaskRenderHandlers,
} from './message-renderer';
import { cleanInlineImageMessage, scanInlineImagePrompts, type InlineImagePrompt } from './marker';
import { RecentImageCache, type RecentGeneratedImage } from './recent-image-cache';
import {
  canReplacePrediction,
  isPredictionArtifactOwnedBy,
  isPredictionContextCurrent,
  PredictionSlot,
  type PredictionArtifactOwner,
  type PredictionCandidate,
  type PredictionContext,
  type PredictionSlotStatus,
  type PredictionTicket,
} from './prediction-slot';
import {
  composeInlinePrompt,
  getGiftApiProfile,
  getStoryApiProfile,
  type GiftReferenceSlot,
  type GiftSettings,
  type ImageApiProfile,
  type StoryImageSettings,
} from './settings';
import { ReferenceImageMemory, type GiftImageReference } from './reference-image-memory';
import {
  createImageTask,
  deriveGenerationStatus,
  imageTaskKey,
  ImageTaskCache,
  isCurrentImageTaskForGeneration,
  type ImageTask,
} from './task-cache';

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

export type GiftArrivalNoticeAudit = {
  status: 'idle' | 'pending' | 'success' | 'fail' | 'skipped';
  shown: boolean;
};

export type GiftArrivalNoticeReadiness = {
  currentTask: boolean;
  artifactCached: boolean;
  giftSucceeded: boolean;
};

export type ReuseArtifactFailureReason = 'artifact_missing' | 'no_assistant_message' | 'target_unavailable';

export type ReuseArtifactResult = { ok: true; placementId: string } | { ok: false; reason: ReuseArtifactFailureReason };

type AssistantSwipeSummary = Pick<ChatMessageSwiped, 'message_id' | 'swipe_id'>;

export const MAX_REUSE_ANCHOR_TEXT_LENGTH = 72;

export function selectLatestAssistantSwipe(
  messages: ReadonlyArray<AssistantSwipeSummary>,
): AssistantSwipeSummary | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (Number.isInteger(message.message_id) && Number.isInteger(message.swipe_id)) {
      return { message_id: message.message_id, swipe_id: message.swipe_id };
    }
  }
  return null;
}

export function nextAvailableImageIndex(usedIndices: Iterable<number>): number {
  const used = new Set(Array.from(usedIndices).filter(index => Number.isInteger(index) && index >= 0));
  let candidate = 0;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

export function boundedReuseAnchorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(-MAX_REUSE_ANCHOR_TEXT_LENGTH);
}

export function shouldProcessReceivedInlineMessage(enabled: boolean | undefined): boolean {
  return enabled === true;
}

export function runReceivedInlineMessageEffects(enabled: boolean | undefined, process: () => void): boolean {
  if (!shouldProcessReceivedInlineMessage(enabled)) return false;
  process();
  return true;
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
    request_mode: string;
    reference_count: number;
    assistant_reply_count: number;
    last_trigger_message_id: number | null;
    trigger_interval: GiftTriggerInterval;
    last_skip_reason: 'missing_references' | 'busy' | 'duplicate_message' | null;
  };
  arrival_notice: GiftArrivalNoticeAudit;
  cache: {
    mode: 'memory-only';
    persisted: false;
    artifact_count: number;
    placement_count: number;
    prediction_status: PredictionSlotStatus;
  };
  reuse: {
    status: 'idle' | 'success' | 'fail' | 'undone';
    message_id: number | null;
    swipe_id: number | null;
    has_caption: boolean;
    rendered: boolean;
    reason: ReuseArtifactFailureReason | 'nothing_to_undo' | null;
  };
  last_error: string | null;
};

export type StoryImageSystemPort = {
  artifactDescriptors: ComputedRef<ReadonlyArray<SafeImageArtifactDescriptor>>;
  placements: ComputedRef<ReadonlyArray<ImagePlacement>>;
  placeArtifact: (artifactId: string, target: ImagePlacementTarget, caption?: string) => ImagePlacement | null;
  removePlacement: (placementId: string) => boolean;
  prediction: {
    context: () => PredictionContext;
    status: () => PredictionSlotStatus;
    replace: (intent: ImageIntent, expected: PredictionContext, artifactId?: string | null) => PredictionTicket | null;
    attach: (ticket: PredictionTicket, artifactId: string) => PredictionCandidate | null;
    peek: () => PredictionCandidate | null;
    consume: (ticket: PredictionTicket) => PredictionCandidate | null;
    drop: (ticket: PredictionTicket) => boolean;
  };
};

export type StoryImageRuntime = {
  status: Readonly<Ref<RuntimeStatus>>;
  audit: StoryImageAudit;
  imageSystem: StoryImageSystemPort;
  recentImages: Readonly<Ref<RecentGeneratedImage[]>>;
  removeRecentImage: (id: string) => boolean;
  reuseArtifactToLatestAssistant: (artifactId: string, caption?: string) => ReuseArtifactResult;
  undoLastReuse: () => boolean;
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
      trigger_interval: 'manual',
      last_skip_reason: null,
    },
    arrival_notice: { status: 'idle', shown: false },
    cache: {
      mode: 'memory-only',
      persisted: false,
      artifact_count: 0,
      placement_count: 0,
      prediction_status: 'empty',
    },
    reuse: {
      status: 'idle',
      message_id: null,
      swipe_id: null,
      has_caption: false,
      rendered: false,
      reason: null,
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

  // Mark the task before invoking external UI code so even a re-entrant or throwing notifier is attempted only once.
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
  let lastReusePlacementId: string | null = null;
  const status = ref<RuntimeStatus>('idle');
  const audit = createEmptyAudit();
  const globalWithAudit = globalThis as typeof globalThis & { __storyImageAudit?: StoryImageAudit };
  globalWithAudit.__storyImageAudit = audit;
  const cache = new ImageTaskCache({ onRemove: removeRenderedTaskHost });
  const giftCache = new GiftImageCache();
  let discardPredictionArtifact: (artifactId: string, owner: PredictionArtifactOwner) => void = () => undefined;
  const predictionSlot = new PredictionSlot({
    onDiscardArtifact: (artifactId, owner) => discardPredictionArtifact(artifactId, owner),
  });
  const recentCache = new RecentImageCache({
    onRemove: artifact => {
      clearArtifactAssociations(artifact.id, cache.values());
      clearArtifactAssociations(artifact.id, giftCache.tasks.value);
      predictionSlot.invalidateArtifact(artifact.id);
    },
  });
  discardPredictionArtifact = (artifactId, owner) => {
    const artifact = recentCache.getArtifact(artifactId);
    if (isPredictionArtifactOwnedBy(artifact, owner)) recentCache.remove(artifactId);
  };
  const placementCache = new ImagePlacementCache(artifactId => recentCache.cloneResource(artifactId), {
    onRemove: placement => {
      removeRenderedPlacementHost(placement.id);
      if (lastReusePlacementId !== placement.id) return;
      lastReusePlacementId = null;
      if (recentCache.pinnedArtifactId === placement.artifactId) recentCache.clearPinnedArtifact();
      audit.reuse = {
        status: 'idle',
        message_id: null,
        swipe_id: null,
        has_caption: false,
        rendered: false,
        reason: null,
      };
    },
  });
  const artifactDescriptors = computed<ReadonlyArray<SafeImageArtifactDescriptor>>(() =>
    toSafeImageArtifactDescriptors(recentCache.artifacts.value),
  );
  const placements = computed<ReadonlyArray<ImagePlacement>>(() => Object.freeze([...placementCache.placements.value]));
  const giftScheduler = new GiftScheduler();
  const giftArrivalNoticeAttempts = new WeakSet<GiftImageTask>();
  const referenceMemory = new ReferenceImageMemory();

  let settings: StoryImageSettings | null = null;
  let activeGeneration: GenerationState | null = null;
  let auditMessageId: number | null = null;
  let memoryChatId = SillyTavern.getCurrentChatId();
  let imageSystemEpoch = 0;
  let errorRevision = 0;
  let stopped = false;
  let promptUninject: (() => void) | null = null;
  let lastGiftTriggerMessageId: number | null = null;
  const sourceCleanupInFlight = new Set<string>();
  const stopListeners: Array<() => void> = [];

  const syncImageSystemAudit = (): void => {
    audit.cache.artifact_count = recentCache.artifacts.value.length;
    audit.cache.placement_count = placementCache.placements.value.length;
    audit.cache.prediction_status = predictionSlot.status;
  };

  const getPredictionContext = (): PredictionContext =>
    Object.freeze({
      epoch: imageSystemEpoch,
      revision: predictionSlot.revision,
      chatId: memoryChatId,
    });

  const isCurrentPredictionContextForRuntime = (expected: PredictionContext): boolean =>
    !stopped &&
    SillyTavern.getCurrentChatId() === memoryChatId &&
    isPredictionContextCurrent(expected, getPredictionContext());

  const resetImageSystemMemory = (): void => {
    imageSystemEpoch += 1;
    predictionSlot.drop();
    placementCache.clear();
    recentCache.clear();
    lastReusePlacementId = null;
    audit.reuse = {
      status: 'idle',
      message_id: null,
      swipe_id: null,
      has_caption: false,
      rendered: false,
      reason: null,
    };
    syncImageSystemAudit();
  };

  const setError = (error: unknown) => {
    const message = errorText(error);
    errorRevision += 1;
    audit.last_error = message;
    status.value = 'error';
    console.warn(LOG_PREFIX, message);
  };

  const updateTaskAudit = (messageId: number | null = auditMessageId, swipeIdOverride?: number) => {
    const currentMessageId = messageId;
    const currentChatId = SillyTavern.getCurrentChatId();
    const activeSwipeId = currentMessageId === null ? null : (swipeIdOverride ?? currentSwipeId(currentMessageId));
    const tasks =
      currentMessageId === null
        ? []
        : cache
            .getForMessage(currentChatId, currentMessageId)
            .filter(task => task.swipeId === activeSwipeId)
            .sort((lhs, rhs) => lhs.imageIndex - rhs.imageIndex);
    audit.tasks = [0, 1].map(index => {
      const task = tasks.find(item => item.imageIndex === index);
      return {
        status: task?.status ?? 'idle',
        message_id: task?.messageId ?? null,
        swipe_id: task?.swipeId ?? null,
      };
    }) as [AuditTask, AuditTask];
  };

  const isStoredInlineTask = (task: ImageTask, key: string): boolean =>
    cache.get(key) === task && SillyTavern.getCurrentChatId() === task.chatId;

  const isCurrentInlineTask = (task: ImageTask, key: string): boolean =>
    isCurrentImageTaskForGeneration(task, cache.get(key), activeGeneration?.id ?? null, SillyTavern.getCurrentChatId());

  const isCurrentGiftTask = (task: GiftImageTask): boolean => {
    return giftCache.has(task) && SillyTavern.getCurrentChatId() === task.chatId;
  };

  const updateGenerationStatus = (generation: GenerationState, terminalIfEmpty = false): void => {
    if (audit.generation.id !== generation.id) return;
    const tasks = cache.values().filter(task => task.generationId === generation.id);
    if (tasks.length === 0 && !terminalIfEmpty) {
      audit.generation.status = 'running';
      status.value = 'generating';
      return;
    }
    const generationStatus = deriveGenerationStatus(tasks);
    audit.generation.status = generationStatus;
    if (generationStatus === 'fail') status.value = 'error';
    else if (generationStatus === 'running') status.value = 'generating';
    else status.value = 'ready';
  };

  const handleImageError = (task: ImageTask): boolean => {
    const key = imageTaskKey(task);
    if (!isStoredInlineTask(task, key) || currentSwipeId(task.messageId) !== task.swipeId) return false;
    task.image?.revoke?.();
    task.image = null;
    task.status = 'failed';
    task.error = '图片加载失败';
    if (audit.generation.id === task.generationId && auditMessageId === task.messageId) {
      setError(task.error);
      const generation = activeGeneration;
      if (generation) updateGenerationStatus(generation);
      updateTaskAudit();
    }
    return true;
  };

  const imageRenderHandlers: ImageTaskRenderHandlers = { onImageError: handleImageError };

  const renderTask = (task: ImageTask, swipeIdOverride?: number) => {
    renderImageTask(task, imageRenderHandlers, swipeIdOverride);
    updateTaskAudit();
    const generation = activeGeneration;
    const visibleSwipeId = swipeIdOverride ?? currentSwipeId(task.messageId);
    if (generation?.id === task.generationId && auditMessageId === task.messageId && visibleSwipeId === task.swipeId)
      updateGenerationStatus(generation);
  };

  async function runTask(task: ImageTask): Promise<void> {
    const key = imageTaskKey(task);
    const generationId = task.generationId;
    const currentSettings = settings;
    if (!currentSettings) {
      if (cache.get(key) === task) cache.remove(key);
      return;
    }
    if (!isCurrentInlineTask(task, key)) return;

    task.status = 'running';
    status.value = 'generating';
    renderTask(task);
    try {
      const resource = await requestImage(
        task.intent.prompt,
        getStoryApiProfile(currentSettings),
        task.abortController.signal,
      );
      if (!isCurrentInlineTask(task, key)) {
        resource.revoke?.();
        return;
      }
      assignImageResource(task, resource);
      const artifact = recentCache.add(
        {
          sourceIntentId: task.intent.id,
          purpose: task.intent.purpose,
          origin: 'generated',
          chatId: task.chatId,
          target: {
            messageId: task.messageId,
            swipeId: task.swipeId,
            imageIndex: task.imageIndex,
          },
        },
        resource,
      );
      task.artifactId = artifact?.id ?? null;
      syncImageSystemAudit();
      renderTask(task);
      console.info(LOG_PREFIX, '图片任务完成', {
        image_index: task.imageIndex,
        message_id: task.messageId,
        swipe_id: task.swipeId,
      });
    } catch (error) {
      if (!isCurrentInlineTask(task, key)) return;
      if (task.abortController.signal.aborted) {
        task.status = 'cancelled';
        renderTask(task);
        return;
      }
      task.status = 'failed';
      task.error = errorText(error);
      if (audit.generation.id === generationId && currentSwipeId(task.messageId) === task.swipeId) {
        setError(error);
        const generation = activeGeneration;
        if (generation) updateGenerationStatus(generation);
      }
      renderTask(task);
    }
  }

  async function runGiftTask(
    task: GiftImageTask,
    references: GiftImageReference[],
    profile: ImageApiProfile,
    giftSettings: GiftSettings,
    resolvedMode: GiftImageTask['requestMode'],
  ): Promise<void> {
    if (stopped) {
      task.status = 'cancelled';
      return;
    }

    const errorRevisionAtStart = errorRevision;
    task.status = 'running';
    status.value = 'generating';
    audit.gift.status = 'running';
    try {
      const context = collectGiftContext();
      task.messageId = context.messageId ?? task.messageId;
      task.swipeId = context.swipeId ?? task.swipeId;
      lastGiftTriggerMessageId = task.messageId;
      audit.gift.last_trigger_message_id = lastGiftTriggerMessageId;
      const prompt = composeGiftImagePrompt(giftSettings, context);
      task.intent.prompt = prompt;
      const resource = await requestGiftImage({
        prompt: task.intent.prompt,
        references,
        profile,
        requestMode: giftSettings.requestMode,
        multipartImageField: giftSettings.multipartImageField,
        jsonReferenceField: giftSettings.jsonReferenceField,
        signal: task.abortController.signal,
      });
      if (!isCurrentGiftTask(task)) {
        resource.revoke?.();
        task.status = 'cancelled';
        return;
      }
      task.image = resource;
      task.status = 'success';
      task.error = null;
      const artifact = recentCache.add(
        {
          sourceIntentId: task.intent.id,
          purpose: task.intent.purpose,
          origin: 'generated',
          chatId: task.chatId,
          target: {
            messageId: task.messageId,
            swipeId: task.swipeId,
            imageIndex: null,
            giftTaskId: task.id,
          },
        },
        resource,
      );
      task.artifactId = artifact?.id ?? null;
      const artifactCached = artifact !== null && recentCache.getArtifact(artifact.id) === artifact;
      syncImageSystemAudit();
      audit.gift.status = 'success';
      audit.gift.request_mode = resolvedMode;
      clearLastErrorIfUnchanged(audit, errorRevisionAtStart, errorRevision);
      if (audit.generation.status !== 'running') status.value = 'ready';
      notifyGiftArrivalOnce(
        task,
        {
          currentTask: isCurrentGiftTask(task),
          artifactCached,
          giftSucceeded: audit.gift.status === 'success',
        },
        giftArrivalNoticeAttempts,
        audit.arrival_notice,
        () => toastr.info('礼物 CG 已送达，可在「最近生成」中查看。'),
      );
      console.info(LOG_PREFIX, '礼物 CG 任务完成', {
        task_id: task.id,
        message_id: task.messageId,
        swipe_id: task.swipeId,
      });
    } catch (error) {
      if (!isCurrentGiftTask(task)) {
        task.status = 'cancelled';
        return;
      }
      if (task.abortController.signal.aborted) {
        task.status = 'cancelled';
        audit.gift.status = 'idle';
        audit.arrival_notice = { status: 'skipped', shown: false };
        return;
      }
      task.status = 'failed';
      task.error = errorText(error);
      audit.gift.status = 'fail';
      audit.arrival_notice = { status: 'skipped', shown: false };
      setError(error);
    }
  }

  const recordGiftSkip = (reason: 'missing_references' | 'busy'): void => {
    audit.gift.last_skip_reason = reason;
    if (audit.gift.status !== 'pending' && audit.gift.status !== 'running') audit.gift.status = 'skipped';
  };

  const startGiftTask = (messageId: number | null = null): GiftImageTask | null => {
    const currentSettings = settings;
    if (stopped || !currentSettings?.gift.enabled) return null;
    const references = referenceMemory.getRequired();
    audit.gift.reference_count = references.length;
    if (references.length < 3) {
      recordGiftSkip('missing_references');
      return null;
    }
    const targetMessageId = messageId ?? currentAssistantMessageId();
    const hasMessageId = Number.isFinite(targetMessageId);
    if (giftCache.hasActive()) {
      recordGiftSkip('busy');
      return null;
    }
    const selectedProfile = getGiftApiProfile(currentSettings);
    const profile = { ...selectedProfile, extraBody: { ...selectedProfile.extraBody } };
    const giftSettings = { ...currentSettings.gift };
    const resolvedMode = resolveGiftRequestMode(profile.serviceUrl, giftSettings.requestMode);
    const chatId = SillyTavern.getCurrentChatId();
    const task = giftCache.createPending({
      chatId,
      messageId: hasMessageId ? targetMessageId : null,
      swipeId: hasMessageId ? currentSwipeId(targetMessageId) : null,
      characterReferenceName: references
        .filter(reference => reference.kind === 'character')
        .map(reference => reference.name)
        .join('、'),
      templateImageName: references.find(reference => reference.kind === 'template')?.name ?? '模板图',
      requestMode: resolvedMode,
      referenceCount: references.length,
      intent: createImageIntent({
        purpose: 'gift',
        chatId,
        prompt: '',
        requestedTarget: null,
      }),
    });
    audit.gift = {
      ...audit.gift,
      status: 'pending',
      request_mode: resolvedMode,
      reference_count: references.length,
      last_skip_reason: null,
    };
    audit.arrival_notice = { status: 'pending', shown: false };
    void runGiftTask(task, references, profile, giftSettings, resolvedMode);
    return task;
  };

  const generateGift = (messageId: number | null = null): GiftImageTask | null => startGiftTask(messageId);

  const ensureGeneration = (messageId: number, forceNew = false): GenerationState => {
    const chatId = SillyTavern.getCurrentChatId();
    if (!forceNew && activeGeneration && activeGeneration.chatId === chatId) {
      activeGeneration.messageId = messageId;
      auditMessageId = messageId;
      return activeGeneration;
    }

    audit.run_id += 1;
    const generation: GenerationState = {
      id: `story-image-${Date.now()}-${audit.run_id}`,
      messageId,
      chatId,
      streamText: '',
      startedIndices: new Set(),
    };
    activeGeneration = generation;
    cache.cancelActiveOutsideGeneration(generation.id);
    auditMessageId = messageId;
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
    if (task.status === 'pending') {
      task.intent.prompt = marker.prompt;
      const target = task.intent.requestedTarget;
      if (target) {
        target.paragraphIndex = marker.paragraphIndex;
        target.anchorTextBefore = marker.anchorTextBefore;
        target.anchorTextAfter = marker.anchorTextAfter;
      }
    }
  };

  const startMarkerTasks = (generation: GenerationState, text: string, final: boolean) => {
    if (!settings?.enabled) return;
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
      if (existing?.generationId === generation.id) {
        generation.startedIndices.add(marker.index);
        bindMarkerToTask(existing, marker);
        renderTask(existing);
        return;
      }

      if (existing) cache.remove(imageTaskKey(existing));

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
        generationId: generation.id,
      });
      cache.set(task);
      renderTask(task);
      void runTask(task);
    });

    if (final) audit.lifecycle.status = 'running';
    updateTaskAudit(generation.messageId);
    updateGenerationStatus(generation, final);
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

  const renderTasksForMessage = (messageId: number, swipeIdOverride?: number) => {
    const chatId = SillyTavern.getCurrentChatId();
    cache.getForMessage(chatId, messageId).forEach(task => renderTask(task, swipeIdOverride));
  };

  const placementRenderHandlers: ImagePlacementRenderHandlers = {
    onImageError: placement => {
      const wasLatestReuse = lastReusePlacementId === placement.id;
      if (!placementCache.remove(placement.id)) return;
      syncImageSystemAudit();
      toastr.warning('复用图片加载失败，这次先不放图。');
      if (!wasLatestReuse) return;
      audit.reuse = {
        status: 'fail',
        message_id: placement.target.messageId,
        swipe_id: placement.target.swipeId,
        has_caption: placement.caption.length > 0,
        rendered: false,
        reason: 'target_unavailable',
      };
    },
  };

  const renderPlacementsForMessage = (messageId: number, swipeIdOverride?: number): number =>
    renderMessagePlacements(placementCache.placements.value, messageId, placementRenderHandlers, swipeIdOverride);

  const renderAllPlacements = (): void => {
    const messageIds = new Set(placementCache.placements.value.map(placement => placement.target.messageId));
    messageIds.forEach(messageId => renderPlacementsForMessage(messageId));
  };

  const recordReuse = (
    status: StoryImageAudit['reuse']['status'],
    target: { messageId: number; swipeId: number } | null,
    hasCaption: boolean,
    rendered: boolean,
    reason: StoryImageAudit['reuse']['reason'],
  ): void => {
    audit.reuse = {
      status,
      message_id: target?.messageId ?? null,
      swipe_id: target?.swipeId ?? null,
      has_caption: hasCaption,
      rendered,
      reason,
    };
  };

  const failReuse = (
    reason: ReuseArtifactFailureReason,
    target: { messageId: number; swipeId: number } | null,
    hasCaption: boolean,
  ): ReuseArtifactResult => {
    recordReuse('fail', target, hasCaption, false, reason);
    return { ok: false, reason };
  };

  const reuseArtifactToLatestAssistant = (artifactId: string, caption = ''): ReuseArtifactResult => {
    const hasCaption = caption.trim().length > 0;
    const artifact = recentCache.getArtifact(artifactId);
    if (!artifact || artifact.chatId !== SillyTavern.getCurrentChatId()) {
      return failReuse('artifact_missing', null, hasCaption);
    }
    if (stopped || SillyTavern.getCurrentChatId() !== memoryChatId) {
      return failReuse('target_unavailable', null, hasCaption);
    }

    const latest = selectLatestAssistantSwipe(
      getChatMessages('0-{{lastMessageId}}', {
        role: 'assistant',
        hide_state: 'unhidden',
        include_swipes: true,
      }),
    );
    if (!latest) return failReuse('no_assistant_message', null, hasCaption);

    const targetSummary = { messageId: latest.message_id, swipeId: latest.swipe_id };
    const $displayed = retrieveDisplayedMessage(latest.message_id) as unknown as JQuery<HTMLElement>;
    if ($displayed.length === 0) return failReuse('target_unavailable', targetSummary, hasCaption);
    const $mesText = $displayed.is('.mes_text')
      ? ($displayed.first() as JQuery<HTMLElement>)
      : ($displayed.find('.mes_text').first() as JQuery<HTMLElement>).length > 0
        ? ($displayed.find('.mes_text').first() as JQuery<HTMLElement>)
        : ($displayed.first() as JQuery<HTMLElement>);
    if ($mesText.length === 0) return failReuse('target_unavailable', targetSummary, hasCaption);

    const $paragraphs = $mesText.find('p, li, blockquote, pre, h1, h2, h3').filter((_index, element) => {
      return $(element).closest('[data-story-image-host], [data-story-image-placement-host]').length === 0;
    });
    const paragraphIndex = $paragraphs.length > 0 ? $paragraphs.length - 1 : 0;
    const anchorTextBefore = boundedReuseAnchorText(($paragraphs.length > 0 ? $paragraphs.last() : $mesText).text());
    const usedIndices = [
      ...cache
        .getForMessage(memoryChatId, latest.message_id)
        .filter(task => task.swipeId === latest.swipe_id)
        .map(task => task.imageIndex),
      ...placementCache.placements.value
        .filter(
          placement => placement.target.messageId === latest.message_id && placement.target.swipeId === latest.swipe_id,
        )
        .map(placement => placement.target.imageIndex),
    ];
    const target: ImagePlacementTarget = {
      kind: 'inline-anchor',
      messageId: latest.message_id,
      swipeId: latest.swipe_id,
      imageIndex: nextAvailableImageIndex(usedIndices),
      paragraphIndex,
      anchorTextBefore,
      anchorTextAfter: '',
    };
    const placement = placementCache.place({ artifactId, target, caption });
    if (!placement) {
      syncImageSystemAudit();
      return failReuse('artifact_missing', targetSummary, hasCaption);
    }
    if (!renderImagePlacement(placement, placementRenderHandlers, latest.swipe_id)) {
      placementCache.remove(placement.id);
      syncImageSystemAudit();
      return failReuse('target_unavailable', targetSummary, hasCaption);
    }

    recentCache.pinArtifact(artifactId);
    lastReusePlacementId = placement.id;
    syncImageSystemAudit();
    recordReuse('success', targetSummary, placement.caption.length > 0, true, null);
    return { ok: true, placementId: placement.id };
  };

  const undoLastReuse = (): boolean => {
    const placementId = lastReusePlacementId;
    const placement = placementId
      ? placementCache.placements.value.find(candidate => candidate.id === placementId)
      : undefined;
    if (!placementId || !placement) {
      lastReusePlacementId = null;
      recordReuse('fail', null, false, false, 'nothing_to_undo');
      return false;
    }
    const removed = placementCache.remove(placementId);
    syncImageSystemAudit();
    if (!removed) {
      recordReuse('fail', null, false, false, 'nothing_to_undo');
      return false;
    }
    recordReuse(
      'undone',
      { messageId: placement.target.messageId, swipeId: placement.target.swipeId },
      placement.caption.length > 0,
      false,
      null,
    );
    return true;
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
    if (!currentSettings?.enabled || !hasPromptSection) {
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
    if (stopped || dryRun || isIgnoredMessageType(type) || !settings?.enabled) return;
    const generation = ensureGeneration(currentAssistantMessageId(), true);
    generation.streamText = '';
    generation.startedIndices.clear();
    console.info(LOG_PREFIX, '开始监听随文插图标记', { generation_id: generation.id });
  };

  const onStreamToken = (text: string) => {
    if (stopped || !settings?.enabled || typeof text !== 'string') return;
    const generation = activeGeneration ?? ensureGeneration(currentAssistantMessageId());
    const nextText = text.startsWith(generation.streamText) ? text : `${generation.streamText}${text}`;
    generation.streamText = nextText;
    generation.messageId = currentAssistantMessageId();
    auditMessageId = generation.messageId;
    startMarkerTasks(generation, nextText, false);
  };

  const onMessageReceived = (messageId: number, type: string) => {
    if (stopped || isIgnoredMessageType(type)) return;
    const message = getChatMessages(messageId)[0];
    if (!message || message.role !== 'assistant') return;
    const chatId = SillyTavern.getCurrentChatId();
    const triggerInterval = settings?.gift.triggerInterval ?? 'manual';
    const giftDecision = giftScheduler.registerAssistantReply(chatId, messageId, triggerInterval);
    if (giftDecision.skipReason !== 'duplicate_message') {
      audit.gift.assistant_reply_count = giftDecision.assistantReplyCount;
      audit.gift.trigger_interval = triggerInterval;
      if (giftDecision.shouldAttempt && settings?.gift.enabled) {
        lastGiftTriggerMessageId = messageId;
        audit.gift.last_trigger_message_id = messageId;
        startGiftTask(messageId);
      }
    }
    runReceivedInlineMessageEffects(settings?.enabled, () => {
      const swipeId = currentSwipeId(messageId);
      const generation = activeGeneration ?? ensureGeneration(messageId);
      generation.messageId = messageId;
      auditMessageId = messageId;
      startMarkerTasks(generation, message.message, true);
      audit.lifecycle.status = 'running';
      setTimeout(() => {
        if (activeGeneration === generation) {
          audit.lifecycle.status = 'idle';
          updateGenerationStatus(generation, true);
        }
      }, 5_000);
      persistCleanedMessage(messageId, swipeId, message.message);
    });
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

  const imageSystem: StoryImageSystemPort = {
    artifactDescriptors,
    placements,
    placeArtifact: (artifactId, target, caption) => {
      const placement = placementCache.place({ artifactId, target, caption });
      syncImageSystemAudit();
      return placement;
    },
    removePlacement: placementId => {
      const removed = placementCache.remove(placementId);
      syncImageSystemAudit();
      return removed;
    },
    prediction: {
      context: getPredictionContext,
      status: () => predictionSlot.status,
      replace: (intent, expected, artifactId = null) => {
        const owner = { intentId: intent.id, chatId: intent.chatId };
        const canReplace =
          !stopped &&
          SillyTavern.getCurrentChatId() === memoryChatId &&
          canReplacePrediction(intent, expected, getPredictionContext());
        if (!canReplace) {
          if (artifactId && intent.purpose === 'prediction') discardPredictionArtifact(artifactId, owner);
          syncImageSystemAudit();
          return null;
        }
        if (artifactId && !isPredictionArtifactOwnedBy(recentCache.getArtifact(artifactId), owner)) return null;
        const candidate = predictionSlot.replace(intent, imageSystemEpoch, artifactId);
        syncImageSystemAudit();
        return candidate.ticket;
      },
      attach: (ticket, artifactId) => {
        const artifact = recentCache.getArtifact(artifactId);
        if (!isCurrentPredictionContextForRuntime(ticket) || !predictionSlot.matches(ticket)) {
          discardPredictionArtifact(artifactId, ticket);
          syncImageSystemAudit();
          return null;
        }
        if (!isPredictionArtifactOwnedBy(artifact, ticket)) return null;
        const candidate = predictionSlot.attach(ticket, artifactId);
        syncImageSystemAudit();
        return candidate;
      },
      peek: () => {
        const candidate = predictionSlot.peek();
        return candidate && isCurrentPredictionContextForRuntime(candidate.ticket) ? candidate : null;
      },
      consume: ticket => {
        if (!isCurrentPredictionContextForRuntime(ticket)) return null;
        const candidate = predictionSlot.consume(ticket);
        syncImageSystemAudit();
        return candidate;
      },
      drop: ticket => {
        if (!isCurrentPredictionContextForRuntime(ticket)) return false;
        const dropped = predictionSlot.drop(ticket);
        syncImageSystemAudit();
        return dropped;
      },
    },
  };

  const runtime: StoryImageRuntime = {
    status,
    audit,
    imageSystem,
    recentImages: recentCache.images,
    reuseArtifactToLatestAssistant,
    undoLastReuse,
    referenceImages: referenceMemory.images,
    setGiftReferenceFile: (slot, file, name) => referenceMemory.setLocal(slot, file, name),
    setGiftReferenceUrl: (slot, url, name) => referenceMemory.setUrl(slot, url, name),
    renameGiftReference: (slot, name) => referenceMemory.rename(slot, name),
    removeGiftReference: slot => referenceMemory.remove(slot),
    giftImages: giftCache.tasks,
    generateGift,
    clearGiftImages: () => {
      giftCache.clear();
      audit.arrival_notice = { status: 'idle', shown: false };
    },
    start: () => {
      if (stopped) return;
      clearRenderedHosts();
      stopped = false;
      audit.lifecycle.status = 'idle';
      listen(tavern_events.GENERATION_STARTED, onGenerationStarted);
      listen(tavern_events.STREAM_TOKEN_RECEIVED, onStreamToken);
      listen(tavern_events.MESSAGE_RECEIVED, onMessageReceived);
      listen(tavern_events.GENERATION_ENDED, messageId => {
        const generation = activeGeneration;
        if (generation) updateGenerationStatus(generation, true);
        if (messageId !== null && messageId !== undefined) {
          renderTasksForMessage(messageId);
          renderPlacementsForMessage(messageId);
        }
      });
      listen(tavern_events.CHARACTER_MESSAGE_RENDERED, messageId => {
        renderTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_SWIPED, messageId => {
        renderTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
        updateTaskAudit(messageId);
      });
      listen(tavern_events.MESSAGE_SWIPE_DELETED, eventData => {
        const chatId = SillyTavern.getCurrentChatId();
        cache.removeMessage(chatId, eventData.messageId);
        placementCache.placements.value
          .filter(placement => placement.target.messageId === eventData.messageId)
          .forEach(placement => placementCache.remove(placement.id));
        syncImageSystemAudit();
        renderTasksForMessage(eventData.messageId, eventData.newSwipeId);
        renderPlacementsForMessage(eventData.messageId, eventData.newSwipeId);
        updateTaskAudit(eventData.messageId, eventData.newSwipeId);
      });
      listen(tavern_events.CHAT_CHANGED, newChatId => {
        if (newChatId === memoryChatId) {
          installPrompt();
          setTimeout(() => {
            cache.values().forEach(renderTask);
            renderAllPlacements();
          }, 0);
          return;
        }
        memoryChatId = newChatId;
        activeGeneration = null;
        resetImageSystemMemory();
        cache.clear();
        giftCache.clear();
        referenceMemory.clear();
        clearRenderedHosts();
        auditMessageId = null;
        giftScheduler.reset();
        lastGiftTriggerMessageId = null;
        sourceCleanupInFlight.clear();
        audit.run_id += 1;
        audit.generation = { id: null, status: 'pending' };
        audit.markers = { count: 0, valid_count: 0, truncated: false };
        audit.gift = {
          ...audit.gift,
          status: 'idle',
          reference_count: referenceMemory.getRequired().length,
          assistant_reply_count: 0,
          last_trigger_message_id: null,
          trigger_interval: settings?.gift.triggerInterval ?? 'manual',
          last_skip_reason: null,
        };
        audit.arrival_notice = { status: 'idle', shown: false };
        audit.tasks = [
          { status: 'idle', message_id: null, swipe_id: null },
          { status: 'idle', message_id: null, swipe_id: null },
        ];
        audit.last_error = null;
        audit.lifecycle.status = 'idle';
        status.value = 'idle';
        installPrompt();
      });
      listen(tavern_events.MESSAGE_EDITED, messageId => {
        cache.removeMessage(SillyTavern.getCurrentChatId(), messageId);
        renderTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
        updateTaskAudit(messageId);
      });
      listen(tavern_events.MESSAGE_UPDATED, messageId => {
        renderTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_DELETED, () => {
        activeGeneration = null;
        resetImageSystemMemory();
        cache.clear();
        giftCache.clear();
        auditMessageId = null;
        // 删除会让 ST 重编号并复用 messageId；不回扫历史，下一条新回复从 1 重新计数。
        giftScheduler.reset();
        lastGiftTriggerMessageId = null;
        sourceCleanupInFlight.clear();
        audit.generation = { id: null, status: 'pending' };
        audit.markers = { count: 0, valid_count: 0, truncated: false };
        audit.gift.status = 'idle';
        audit.gift.assistant_reply_count = 0;
        audit.gift.last_trigger_message_id = null;
        audit.gift.trigger_interval = settings?.gift.triggerInterval ?? 'manual';
        audit.gift.last_skip_reason = null;
        audit.arrival_notice = { status: 'idle', shown: false };
        audit.tasks = [
          { status: 'idle', message_id: null, swipe_id: null },
          { status: 'idle', message_id: null, swipe_id: null },
        ];
        audit.lifecycle.status = 'idle';
        status.value = 'idle';
      });
      listen(tavern_events.MORE_MESSAGES_LOADED, () => {
        cache.values().forEach(renderTask);
        renderAllPlacements();
      });
      installPrompt();
      cache.values().forEach(renderTask);
      renderAllPlacements();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopListeners.splice(0).forEach(stop => stop());
      promptUninject?.();
      promptUninject = null;
      uninjectPrompts([PROMPT_INJECTION_ID]);
      activeGeneration = null;
      resetImageSystemMemory();
      cache.clear();
      giftCache.clear();
      referenceMemory.clear();
      clearRenderedHosts();
      auditMessageId = null;
      audit.arrival_notice = { status: 'idle', shown: false };
      audit.lifecycle.status = 'stopped';
      status.value = 'stopped';
    },
    removeRecentImage: id => {
      const removed = recentCache.remove(id);
      syncImageSystemAudit();
      return removed;
    },
    updateSettings: nextSettings => {
      settings = nextSettings;
      audit.gift.trigger_interval = settings.gift.triggerInterval;
      installPrompt();
      if (!settings.gift.enabled) {
        audit.gift.status = 'idle';
      }
      if (!settings.enabled) {
        activeGeneration = null;
        auditMessageId = null;
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
