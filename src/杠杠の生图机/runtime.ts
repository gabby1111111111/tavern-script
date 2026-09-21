import { ref, type Ref } from 'vue';
import { ShotWorkflow, groupWorkbenchPlacements } from './shot-workflow';
import type { WorkbenchShot } from './workbench-types';
import { readCurrentAvatarReferences, type AvatarReferenceReadResult } from './avatar-references';
import { GenerationEligibilityLedger, type GenerationEligibilityPlan } from './generation-eligibility';
import { decideFloorTrigger } from './display-policy';
import { saveImageResourceToCharacterGallery } from './gallery-storage';
import { requestImages, type ImageResource } from './image-api';
import { ImagePlacementCache, type ImagePlacement } from './image-placement';
import { ImagePresenter } from './image-presenter';
import { clearArtifactAssociations, type ImagePlacementTarget } from './image-system';
import {
  clearRenderedHosts,
  getSelectedImagePlacements,
  pruneImagePlacementSelections,
  selectImagePlacement,
  removeRenderedPlacementHost,
  removeRenderedTaskHost,
  renderImageTask,
  renderMessagePlacements,
  type ImagePlacementRenderHandlers,
} from './message-renderer';
import {
  ImageRetention,
  imageRetentionScopeForPlacement,
  imageRetentionScopeKey,
  type ImageRetentionScope,
} from './image-retention';
import { cleanInlineImageMessage, scanInlineImagePrompts, type InlineImagePrompt } from './marker';
import { MessageAdvanceGate } from './message-advance';
import type {
  DisplayMode,
  DrawingPreset,
  FloorTriggerDecision,
  ImageOutputPreset,
  ImageReferenceKind,
  ImageRequestInput,
  ResolvedReferenceSource,
} from './pipeline-types';
import { applyDrawingPromptTemplate, processDrawingPrompt, resolveReferenceSources } from './prompt-processor';
import { materializeReferenceSources } from './reference-resolution';
import {
  createStoryContinuitySnapshot,
  isStoryContinuitySnapshotValid,
  releaseStoryContinuitySnapshot,
  type StoryContinuitySnapshot,
} from './story-continuity';
import { RecentImageCache, type RecentGeneratedImage, type RecentImageRemovalReason } from './recent-image-cache';
import {
  buildPromptEditorReferenceCandidates,
  openImagePromptEditor,
  selectPromptEditorReferenceSources,
  type PromptEditorAvatarReferenceStatus,
  type PromptEditorReferenceSelection,
} from './prompt-editor';
import { openRegionRedrawEditor } from './region-redraw-editor';
import {
  isMatchingAssistantReply,
  isSingleCharacterChat,
  isSwipeGeneration,
  shouldArmStoryImageGeneration,
} from './runtime-policy';
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

export type RuntimeStatus = 'idle' | 'generating' | 'ready' | 'error' | 'stopped';

type GenerationState = {
  id: string;
  type: 'normal' | 'swipe' | 'regenerate';
  eligibility: GenerationEligibilityPlan<FloorTriggerDecision>;
  messageId: number | null;
  chatId: string;
  startChatLength: number;
  startTailRef: object | null;
  nextFloorCount: number;
  decision: FloorTriggerDecision;
  preset: DrawingPreset;
  outputPreset: ImageOutputPreset;
  profile: ImageApiProfile;
  displayMode: DisplayMode;
  continuity: StoryContinuitySnapshot | null;
  avatarReferences: Promise<AvatarReferenceReadResult>;
};

type PendingSwipeTarget = {
  chatId: string;
  messageId: number;
  messageRef: object;
};

type PromptProcessingSnapshot = {
  outputPreset: ImageOutputPreset;
  avatarReferences: AvatarReferenceReadResult;
  resolvedReferenceSources: ResolvedReferenceSource[];
  referenceKinds?: ImageReferenceKind[];
  profile: ImageApiProfile;
  continuity?: StoryContinuitySnapshot;
  continuityShotPrompt?: string;
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
  swipe: {
    enabled: boolean;
    message_id: number | null;
    eligible: boolean | null;
    started: boolean;
    skipped: boolean;
  };
  gift: {
    status: 'idle' | 'pending' | 'running' | 'success' | 'fail' | 'skipped';
    display_mode: DisplayMode;
    assistant_reply_count: number;
    last_trigger_message_id: number | null;
    skip_floors: number;
    last_skip_reason: FloorTriggerDecision['reason'] | 'no-markers' | 'stale-reply' | null;
  };
  arrival_notice: GiftArrivalNoticeAudit;
  cache: {
    mode: 'memory-only';
    persisted: false;
    artifact_count: number;
    placement_count: number;
    prediction_status: 'disabled';
  };
  continuity: {
    active_snapshots: number;
    status: 'idle' | 'locked' | 'empty' | 'released' | 'invalidated';
    source: StoryContinuitySnapshot['source'];
    drawing_preset_id: string | null;
    output_preset_id: string | null;
    reference_count: number;
    reference_kinds: string[];
  };
  workflow: { confirmed_count: number; unconfirmed_count: number; pending_count: number };
  last_error: string | null;
};

export type StoryImageRuntime = {
  status: Readonly<Ref<RuntimeStatus>>;
  audit: StoryImageAudit;
  recentImages: Readonly<Ref<RecentGeneratedImage[]>>;
  workbenchShots: Readonly<Ref<WorkbenchShot[]>>;
  confirmWorkbenchImage: (placementId: string) => void;
  abandonWorkbenchShot: (shotId: string) => void;
  editWorkbenchImage: (placementId: string) => Promise<void>;
  redrawWorkbenchImage: (placementId: string) => Promise<void>;
  removeWorkbenchImage: (placementId: string) => void;
  jumpToWorkbenchShot: (shotId: string) => void;
  removeRecentImage: (id: string) => boolean;
  saveRecentImageToGallery: (artifactId: string) => Promise<void>;
  start: () => void;
  stop: () => void;
  updateSettings: (nextSettings: StoryImageSettings) => void;
};

const PROMPT_INJECTION_ID = 'story-image-drawing-preset';
const LEGACY_PROMPT_INJECTION_ID = 'story-image-inline-prompt';
const LOG_PREFIX = '<杠杠の生图机>';

export function createEmptyAudit(): StoryImageAudit {
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
    swipe: { enabled: true, message_id: null, eligible: null, started: false, skipped: false },
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
    continuity: {
      active_snapshots: 0,
      status: 'idle',
      source: null,
      drawing_preset_id: null,
      output_preset_id: null,
      reference_count: 0,
      reference_kinds: [],
    },
    workflow: { confirmed_count: 0, unconfirmed_count: 0, pending_count: 0 },
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

export function settleManualRevisionAudit(
  audit: Pick<StoryImageAudit, 'generation' | 'last_error'>,
  generationId: string,
  outcome: 'success' | 'fail' | 'cancelled',
  expectedErrorRevision: number,
  currentErrorRevision: number,
): boolean {
  if (audit.generation.id !== generationId) return false;
  if (outcome === 'cancelled') audit.generation = { id: null, status: 'pending' };
  else audit.generation.status = outcome;
  if (outcome === 'success') clearLastErrorIfUnchanged(audit, expectedErrorRevision, currentErrorRevision);
  return true;
}

export function commitManualRevisionFailure(
  audit: Pick<StoryImageAudit, 'generation'>,
  generationId: string,
  commitError: () => void,
): boolean {
  if (audit.generation.id !== generationId) return false;
  commitError();
  audit.generation.status = 'fail';
  return true;
}

export function deriveRuntimeStatusState(input: {
  stopped: boolean;
  activeTask: boolean;
  activeManualRevisions: number;
  hasError: boolean;
  hasReadyContent: boolean;
}): RuntimeStatus {
  if (input.stopped) return 'stopped';
  if (input.activeTask || input.activeManualRevisions > 0) return 'generating';
  if (input.hasError) return 'error';
  return input.hasReadyContent ? 'ready' : 'idle';
}

export function shouldRemovePlacementForRecentReason(reason: RecentImageRemovalReason): boolean {
  return reason === 'explicit';
}

type NormalizedRegion = { x: number; y: number; width: number; height: number };

function normalizedCoordinate(value: number): string {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return Number(clamped.toFixed(4)).toString();
}

export function buildRegionRedrawPrompt(description: string, region: NormalizedRegion): string {
  const coordinates = `x=${normalizedCoordinate(region.x)}, y=${normalizedCoordinate(region.y)}, width=${normalizedCoordinate(region.width)}, height=${normalizedCoordinate(region.height)}`;
  return [
    '请参考图1重新生成一张完整新图，并重点按照临时描述修改图2标记的位置；区域外的构图、人物身份、姿势、服装与背景尽量与图1保持一致。',
    '图2中的洋红高亮仅用于指示修改位置，不是新图中需要生成的颜色或内容。',
    `标记区域的归一化坐标：${coordinates}。`,
    `局部修改要求：${description.trim()}`,
  ].join('\n');
}

export function buildRegionRedrawInput(
  sourceImage: string,
  markedImage: string,
  description: string,
  region: NormalizedRegion,
): ImageRequestInput {
  return {
    prompt: buildRegionRedrawPrompt(description, region),
    referenceImages: [sourceImage, markedImage],
  };
}

export function buildWholeImageRedrawInput(sourceImage: string, description: string): ImageRequestInput {
  return {
    prompt: description.trim(),
    referenceImages: [sourceImage],
  };
}

export function buildRegionRedrawRevision(
  sourceImage: string,
  markedImage: string,
  sourcePrompt: string,
  description: string,
  region: NormalizedRegion,
): { storedPrompt: string; input: ImageRequestInput } {
  return {
    storedPrompt: sourcePrompt.trim(),
    input: buildRegionRedrawInput(sourceImage, markedImage, description, region),
  };
}

export function forceSingleImageCount<T extends { imageCount: number }>(profile: T): T {
  return { ...profile, imageCount: 1 };
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

function rawMessageRef(messageId: number): object | null {
  const message = SillyTavern.chat[messageId];
  return typeof message === 'object' && message !== null ? message : null;
}

function emptyAvatarReferenceReadResult(): AvatarReferenceReadResult {
  return { references: [], failedSources: [] };
}

function cloneAvatarReferenceReadResult(result: AvatarReferenceReadResult): AvatarReferenceReadResult {
  return {
    references: result.references.map(reference => ({ ...reference })),
    failedSources: [...result.failedSources],
  };
}

function promptEditorAvatarReferenceStatus(
  enabled: boolean,
  result: AvatarReferenceReadResult,
): PromptEditorAvatarReferenceStatus {
  return {
    enabled,
    availableSources: result.references.map(reference => reference.source),
    failedSources: [...result.failedSources],
  };
}

async function readAvatarReferencesForPromptEditor(): Promise<AvatarReferenceReadResult> {
  try {
    return cloneAvatarReferenceReadResult(await readCurrentAvatarReferences());
  } catch {
    return { references: [], failedSources: ['persona', 'character'] };
  }
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
  const continuityOwners = new Map<StoryContinuitySnapshot, Set<AbortController>>();
  let auditedSnapshot: StoryContinuitySnapshot | null = null;
  const retiringSources = new Set<string>();
  const retiredSnapshots = new WeakSet<StoryContinuitySnapshot>();
  const snapshotMessageRefs = new WeakMap<StoryContinuitySnapshot, object>();
  const snapshotSwipeIds = new WeakMap<StoryContinuitySnapshot, number>();
  const releaseContinuity = (snapshot: StoryContinuitySnapshot | null | undefined, invalidated = false): void => {
    if (!snapshot || snapshot.released) return;
    if (invalidated) continuityOwners.get(snapshot)?.forEach(controller => controller.abort());
    continuityOwners.delete(snapshot);
    audit.continuity.active_snapshots = continuityOwners.size;
    releaseStoryContinuitySnapshot(snapshot);
    if (auditedSnapshot === snapshot) audit.continuity.status = invalidated ? 'invalidated' : 'released';
  };
  const invalidateContinuitySource = (placementId: string): void => {
    for (const snapshot of continuityOwners.keys()) {
      if (snapshot.source?.placementId !== placementId) continue;
      if (retiringSources.has(placementId)) retiredSnapshots.add(snapshot);
      else releaseContinuity(snapshot, true);
    }
  };
  const clearContinuity = (): void => {
    for (const snapshot of continuityOwners.keys()) releaseContinuity(snapshot, true);
  };
  const retention = new ImageRetention();
  const workflow = new ShotWorkflow();
  const workbenchShots = ref<WorkbenchShot[]>([]);
  const cache = new ImageTaskCache({
    onRemove: task => {
      retention.forgetScope({
        chatId: task.chatId,
        messageId: task.messageId,
        swipeId: task.swipeId,
        imageIndex: task.imageIndex,
      });
      inlineTaskKeys.delete(imageTaskKey(task));
      removeRenderedTaskHost(task);
    },
  });
  const placementCacheRef: { current: ImagePlacementCache | null } = { current: null };
  const prunePlacementSelectionMemory = (): void => {
    const placements = placementCacheRef.current?.placements.value;
    if (placements) pruneImagePlacementSelections(placements);
  };
  const recentCache = new RecentImageCache({
    onRemove: (artifact, reason) => {
      clearArtifactAssociations(artifact.id, cache.values());
      if (shouldRemovePlacementForRecentReason(reason)) {
        placementCacheRef.current?.placements.value
          .filter(placement => placement.artifactId === artifact.id)
          .forEach(placement => placementCacheRef.current?.remove(placement.id));
      }
      prunePlacementSelectionMemory();
    },
  });
  const placementCache = new ImagePlacementCache(artifactId => recentCache.cloneResource(artifactId), {
    onRemove: placement => {
      invalidateContinuitySource(placement.id);
      retention.forgetPlacement(placement.id);
      workflow.forget(placement.id);
      removeRenderedPlacementHost(placement.id);
      prunePlacementSelectionMemory();
    },
  });
  placementCacheRef.current = placementCache;
  const presenter = new ImagePresenter({ recentCache, placementCache });
  let settings: StoryImageSettings | null = null;
  let activeGeneration: GenerationState | null = null;
  let memoryChatId = SillyTavern.getCurrentChatId();
  const messageAdvance = new MessageAdvanceGate();
  messageAdvance.seed(SillyTavern.chat);
  let pendingSwipeTarget: PendingSwipeTarget | null = null;
  let normalAssistantFloorCount = 0;
  const floorDecisions = new GenerationEligibilityLedger<FloorTriggerDecision>();
  floorDecisions.sync(SillyTavern.chat);
  let errorRevision = 0;
  let started = false;
  let stopped = false;
  let promptUninject: (() => void) | null = null;
  const giftArrivalNoticeAttempts = new WeakSet<ImageTask>();
  const giftArrivalNoticeGenerations = new Set<string>();
  const sourceCleanupInFlight = new Set<string>();
  const manualRevisionControllers = new Set<AbortController>();
  const manualRevisionControllerByPlacement = new Map<string, Set<AbortController>>();
  const manualRevisionGenerationByController = new Map<AbortController, string>();
  const taskRetentionToken = new WeakMap<ImageTask, number>();
  const taskMessageRefs = new WeakMap<ImageTask, object>();
  let promptEditorController: AbortController | null = null;
  let regionEditorController: AbortController | null = null;
  const stopListeners: Array<() => void> = [];

  const captureContinuity = (
    beforeMessageId: number,
    drawingPresetId: string,
    outputPresetId: string,
    consume = true,
  ): StoryContinuitySnapshot => {
    const snapshot = createStoryContinuitySnapshot({
      chatId: memoryChatId,
      beforeMessageId,
      drawingPresetId,
      outputPresetId,
      selectedPlacements: consume
        ? placementCache.placements.value.filter(placement => workflow.isConfirmed(placement.id))
        : [],
      activeSwipeId: messageId => (rawMessageRef(messageId) ? currentSwipeId(messageId) : null),
      cloneResource: placementId => placementCache.cloneResource(placementId),
    });
    continuityOwners.set(snapshot, new Set());
    const sourceMessage = snapshot.source ? rawMessageRef(snapshot.source.messageId) : null;
    if (sourceMessage) snapshotMessageRefs.set(snapshot, sourceMessage);
    if (snapshot.source) snapshotSwipeIds.set(snapshot, snapshot.source.swipeId);
    auditedSnapshot = snapshot;
    audit.continuity = {
      active_snapshots: continuityOwners.size,
      status: snapshot.source ? 'locked' : 'empty',
      source: snapshot.source ? { ...snapshot.source } : null,
      drawing_preset_id: drawingPresetId.slice(0, 120),
      output_preset_id: outputPresetId.slice(0, 120),
      reference_count: 0,
      reference_kinds: [],
    };
    return snapshot;
  };
  const validContinuity = (snapshot: StoryContinuitySnapshot | null | undefined): boolean => {
    if (!snapshot) return true;
    const retiredRef = snapshotMessageRefs.get(snapshot);
    const valid = retiredSnapshots.has(snapshot)
      ? !snapshot.released &&
        snapshot.chatId === SillyTavern.getCurrentChatId() &&
        !!retiredRef &&
        SillyTavern.chat.includes(retiredRef as SillyTavern.ChatMessage)
      : isStoryContinuitySnapshotValid(snapshot, {
          chatId: SillyTavern.getCurrentChatId(),
          getPlacement: id => placementCache.get(id),
          activeSwipeId: messageId => (rawMessageRef(messageId) ? currentSwipeId(messageId) : null),
        });
    if (!valid) releaseContinuity(snapshot, true);
    return valid;
  };
  const checkContinuity = (): void => {
    for (const snapshot of continuityOwners.keys()) validContinuity(snapshot);
  };

  const abortRegionEditor = (): void => {
    regionEditorController?.abort();
    regionEditorController = null;
  };

  const abortPromptEditor = (): void => {
    promptEditorController?.abort();
    promptEditorController = null;
  };

  const abortManualRevisions = (): void => {
    manualRevisionControllers.forEach(controller => controller.abort());
    manualRevisionControllers.clear();
    manualRevisionControllerByPlacement.clear();
    manualRevisionGenerationByController.clear();
  };

  const trackManualRevision = (placementId: string, controller: AbortController, generationId: string): void => {
    manualRevisionControllers.add(controller);
    manualRevisionGenerationByController.set(controller, generationId);
    const controllers = manualRevisionControllerByPlacement.get(placementId) ?? new Set<AbortController>();
    controllers.add(controller);
    manualRevisionControllerByPlacement.set(placementId, controllers);
  };

  const untrackManualRevision = (placementId: string, controller: AbortController): void => {
    manualRevisionControllers.delete(controller);
    manualRevisionGenerationByController.delete(controller);
    const controllers = manualRevisionControllerByPlacement.get(placementId);
    controllers?.delete(controller);
    if (controllers?.size === 0) manualRevisionControllerByPlacement.delete(placementId);
  };

  const abortManualRevisionsForPlacement = (placementId: string): void => {
    const controllers = manualRevisionControllerByPlacement.get(placementId);
    if (!controllers) return;
    controllers.forEach(controller => {
      controller.abort();
      manualRevisionControllers.delete(controller);
      const generationId = manualRevisionGenerationByController.get(controller);
      if (generationId) settleManualRevisionAudit(audit, generationId, 'cancelled', errorRevision, errorRevision);
      manualRevisionGenerationByController.delete(controller);
    });
    manualRevisionControllerByPlacement.delete(placementId);
  };

  const abortManualRevisionsForMessage = (messageId: number): void => {
    placementCache.placements.value
      .filter(placement => placement.target.messageId === messageId)
      .forEach(placement => abortManualRevisionsForPlacement(placement.id));
  };

  const abortManualRevisionsForSwipeDeletion = (messageId: number, deletedSwipeId: number): void => {
    placementCache.placements.value
      .filter(placement => placement.target.messageId === messageId && placement.target.swipeId === deletedSwipeId)
      .forEach(placement => abortManualRevisionsForPlacement(placement.id));
  };

  const placementScope = (placement: ImagePlacement): ImageRetentionScope =>
    imageRetentionScopeForPlacement(memoryChatId, placement);

  const taskScope = (task: ImageTask): ImageRetentionScope => ({
    chatId: task.chatId,
    messageId: task.messageId,
    swipeId: task.swipeId,
    imageIndex: task.imageIndex,
  });

  const isInlineTask = (task: ImageTask): boolean => inlineTaskKeys.has(imageTaskKey(task));

  const isSameImagePosition = (left: ImageRetentionScope, right: ImageRetentionScope): boolean =>
    left.chatId === right.chatId && left.messageId === right.messageId && left.imageIndex === right.imageIndex;

  const isSameScope = (left: ImageRetentionScope, right: ImageRetentionScope): boolean =>
    isSameImagePosition(left, right) && left.swipeId === right.swipeId;

  const abortManualRevisionsForScope = (scope: ImageRetentionScope): void => {
    placementCache.placements.value
      .filter(placement => isSameScope(placementScope(placement), scope))
      .forEach(placement => abortManualRevisionsForPlacement(placement.id));
  };

  const removeTargetedCurrentArtifacts = (
    scope: Pick<ImageRetentionScope, 'chatId' | 'messageId' | 'imageIndex'>,
    retainedArtifactId: string | null,
    swipeId?: number,
  ): void => {
    recentCache.artifacts.value
      .filter(artifact => {
        if (artifact.purpose !== 'current' || artifact.chatId !== scope.chatId) return false;
        if (artifact.target.messageId !== scope.messageId || artifact.target.imageIndex !== scope.imageIndex)
          return false;
        return swipeId === undefined || artifact.target.swipeId === swipeId;
      })
      .filter(artifact => artifact.id !== retainedArtifactId)
      .forEach(artifact => recentCache.remove(artifact.id));
  };

  const removePlacementAndArtifact = (placement: ImagePlacement, invalidate = false): void => {
    const scope = placementScope(placement);
    if (invalidate) retention.invalidate(scope);
    abortManualRevisionsForPlacement(placement.id);
    const removedArtifact = recentCache.remove(placement.artifactId);
    const removedPlacement = placementCache.remove(placement.id);
    if (!removedArtifact && !removedPlacement) retention.forgetPlacement(placement.id);
    if (invalidate) retention.forgetScope(scope);
  };

  const removeTask = (task: ImageTask): void => {
    cache.remove(imageTaskKey(task));
  };

  const removeExactScopeTasks = (scope: ImageRetentionScope, keepTask?: ImageTask): void => {
    cache
      .values()
      .filter(task => isInlineTask(task) && isSameScope(taskScope(task), scope) && task !== keepTask)
      .forEach(removeTask);
  };

  const isCurrentRetentionToken = (scope: ImageRetentionScope, token: number): boolean =>
    retention.token(scope) === token;

  const pruneExactScope = (scope: ImageRetentionScope, retainedId: string | null): void => {
    if (retainedId === null) {
      const messageRef = rawMessageRef(scope.messageId);
      for (const snapshot of continuityOwners.keys()) {
        if (
          messageRef &&
          snapshotMessageRefs.get(snapshot) === messageRef &&
          snapshotSwipeIds.get(snapshot) === scope.swipeId &&
          snapshot.source?.imageIndex === scope.imageIndex
        ) {
          releaseContinuity(snapshot, true);
        }
      }
    }
    retention.invalidate(scope);
    abortManualRevisionsForScope(scope);
    removeExactScopeTasks(scope);
    placementCache.placements.value
      .filter(placement => isSameScope(placementScope(placement), scope) && placement.id !== retainedId)
      .forEach(placement => {
        if (retainedId) retiringSources.add(placement.id);
        try {
          removePlacementAndArtifact(placement, false);
        } finally {
          retiringSources.delete(placement.id);
        }
      });
    const retainedArtifactId = retainedId ? (placementCache.get(retainedId)?.artifactId ?? null) : null;
    removeTargetedCurrentArtifacts(scope, retainedArtifactId, scope.swipeId);
    retention.forgetScope(scope);
    prunePlacementSelectionMemory();
  };

  const isCurrentManualRevision = (
    placement: ImagePlacement,
    chatId: string,
    messageRef: object,
    controller?: AbortController,
    retentionToken?: number,
  ): boolean => {
    const currentSettings = settings;
    // Swipe deletion remaps an immutable placement object. Resolve its live
    // location by stable image identity instead of rejecting that new object.
    const currentPlacement = placementCache.get(placement.id);
    return (
      !!currentPlacement &&
      currentPlacement.artifactId === placement.artifactId &&
      currentPlacement.variantIndex === placement.variantIndex &&
      currentPlacement.revisionIndex === placement.revisionIndex &&
      currentPlacement.target.imageIndex === placement.target.imageIndex &&
      placementCache.messageRef(placement.id) === messageRef &&
      currentSettings?.enabled === true &&
      !stopped &&
      !controller?.signal.aborted &&
      memoryChatId === chatId &&
      SillyTavern.getCurrentChatId() === chatId &&
      rawMessageRef(currentPlacement.target.messageId) === messageRef &&
      (retentionToken === undefined || isCurrentRetentionToken(placementScope(currentPlacement), retentionToken))
    );
  };

  const syncWorkbench = (): void => {
    const groups = groupWorkbenchPlacements(memoryChatId, placementCache.placements.value);
    const shots = new Map<string, WorkbenchShot>();
    groups.forEach((placements, id) => {
      const base = workflow.base(placements);
      if (
        !base ||
        !rawMessageRef(base.target.messageId) ||
        currentSwipeId(base.target.messageId) !== base.target.swipeId
      )
        return;
      const confirmed = placements.find(placement => workflow.isConfirmed(placement.id));
      shots.set(id, {
        id,
        chatId: memoryChatId,
        ...base.target,
        basePlacementId: base.id,
        confirmedPlacementId: confirmed?.id ?? null,
        shotPrompt: base.continuity?.shotPrompt ?? base.prompt,
        images: [...placements]
          .sort((a, b) => a.variantIndex - b.variantIndex || a.revisionIndex - b.revisionIndex)
          .map(placement => ({
            id: placement.id,
            url: placement.url,
            prompt: placement.continuity?.shotPrompt ?? placement.prompt,
            variantIndex: placement.variantIndex,
            revisionIndex: placement.revisionIndex,
            referenceSource: placement.referenceSource,
          })),
        pendingCount: placements.reduce(
          (count, placement) => count + (manualRevisionControllerByPlacement.get(placement.id)?.size ?? 0),
          0,
        ),
        status: confirmed ? 'confirmed' : 'unconfirmed',
      });
    });
    cache
      .values()
      .filter(
        task => isInlineTask(task) && rawMessageRef(task.messageId) && currentSwipeId(task.messageId) === task.swipeId,
      )
      .forEach(task => {
        const id = imageRetentionScopeKey(taskScope(task));
        let shot = shots.get(id);
        if (!shot) {
          shot = {
            id,
            ...taskScope(task),
            basePlacementId: null,
            confirmedPlacementId: null,
            shotPrompt: task.intent.prompt,
            images: [],
            pendingCount: 0,
            status: task.status === 'failed' ? 'failed' : 'pending',
          };
          shots.set(id, shot);
        }
        if (task.status === 'pending' || task.status === 'running') shot.pendingCount += 1;
      });
    audit.workflow = {
      confirmed_count: [...shots.values()].filter(shot => shot.confirmedPlacementId !== null).length,
      unconfirmed_count: [...shots.values()].filter(
        shot => shot.confirmedPlacementId === null && shot.images.length > 0,
      ).length,
      pending_count: [...shots.values()].reduce((count, shot) => count + shot.pendingCount, 0),
    };
    workbenchShots.value = [...shots.values()].sort((a, b) => a.messageId - b.messageId || a.imageIndex - b.imageIndex);
  };

  const syncCacheAudit = (): void => {
    syncWorkbench();
    audit.cache.artifact_count = recentCache.artifacts.value.length;
    audit.cache.placement_count = placementCache.placements.value.length;
  };

  const syncRuntimeStatus = (): void => {
    syncWorkbench();
    const tasks = cache.values();
    status.value = deriveRuntimeStatusState({
      stopped,
      activeTask: tasks.some(task => task.status === 'pending' || task.status === 'running'),
      activeManualRevisions: manualRevisionControllers.size,
      hasError: Boolean(audit.last_error),
      hasReadyContent:
        tasks.length > 0 || recentCache.artifacts.value.length > 0 || audit.generation.status === 'success',
    });
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

  const isStoredTask = (task: ImageTask): boolean => {
    if (cache.get(imageTaskKey(task)) !== task || SillyTavern.getCurrentChatId() !== task.chatId) return false;
    const expectedToken = taskRetentionToken.get(task);
    return expectedToken === undefined || retention.token(taskScope(task)) === expectedToken;
  };

  const canBeginManualRevision = (placement: ImagePlacement, prompt: string): boolean => {
    const currentSettings = settings;
    const messageRef = rawMessageRef(placement.target.messageId);
    return Boolean(
      currentSettings?.enabled === true &&
      prompt.trim() &&
      messageRef &&
      !stopped &&
      memoryChatId === SillyTavern.getCurrentChatId() &&
      currentSwipeId(placement.target.messageId) === placement.target.swipeId &&
      placementCache.get(placement.id) === placement,
    );
  };

  const placementRenderHandlers: ImagePlacementRenderHandlers = {
    onImageError: placement => {
      removePlacementAndArtifact(placement);
      prunePlacementSelectionMemory();
      syncCacheAudit();
      toastr.warning('图片加载失败，这次先不显示。');
    },
    onEditPrompt: async (placement, onSubmitted?: () => void) => {
      abortPromptEditor();
      const controller = new AbortController();
      promptEditorController = controller;
      const currentSettings = settings;
      const outputPreset = currentSettings ? { ...getCurrentOutputPreset(currentSettings) } : null;
      if (!outputPreset || !currentSettings) return;
      const profile = forceSingleImageCount(cloneProfile(getActiveApiProfile(currentSettings)));
      const combination = placement.continuity;
      const recordedReferenceKinds = placement.referenceKinds;
      const referenceSelection: PromptEditorReferenceSelection = {
        known: recordedReferenceKinds !== undefined,
        useAvatarReferences:
          recordedReferenceKinds?.some(kind => kind === 'user-avatar' || kind === 'character-avatar') ?? false,
        usePreviousStoryImage: recordedReferenceKinds?.includes('previous-story-image') ?? false,
      };
      const continuity = captureContinuity(
        placement.target.messageId,
        combination?.drawingPresetId ?? getCurrentDrawingPreset(currentSettings).id,
        combination?.outputPresetId ?? outputPreset.id,
        true,
      );
      try {
        const referenceAvailability = {
          // Availability is resolved only when the user has selected avatars;
          // opening a text editor must not wait for avatar/image GETs.
          avatarReferences: true,
          previousStoryImage: Boolean(continuity.resource?.url?.trim()),
        };
        const referenceCandidates = buildPromptEditorReferenceCandidates(recordedReferenceKinds, referenceAvailability);
        const editorResult = await openImagePromptEditor({
          prompt: placement.prompt,
          finalPrompt: placement.finalPrompt,
          outputPreset,
          avatarReferences: promptEditorAvatarReferenceStatus(
            outputPreset.useAvatarReferences,
            emptyAvatarReferenceReadResult(),
          ),
          previousShotPrompt: continuity.shotPrompt,
          referenceSources: referenceCandidates,
          referenceSelection,
          referenceAvailability,
          prepareReferenceSources: async (selection, signal) => {
            if (selection.usePreviousStoryImage) {
              continuityOwners.get(continuity)?.add(controller);
            } else {
              continuityOwners.get(continuity)?.delete(controller);
            }
            try {
              const avatarReferences = selection.useAvatarReferences
                ? await readAvatarReferencesForPromptEditor()
                : emptyAvatarReferenceReadResult();
              if (signal.aborted) throw new DOMException('图片请求已取消', 'AbortError');
              // A previous source may have been removed before this option was
              // selected. Treat it as unavailable instead of cancelling a
              // text-only redraw or pretending that an empty candidate was sent.
              if (selection.usePreviousStoryImage && !validContinuity(continuity)) return [];
              return await materializeReferenceSources(
                resolveReferenceSources(
                  avatarReferences,
                  selection.usePreviousStoryImage ? continuity.resource?.url : undefined,
                ),
                profile,
                signal,
              );
            } finally {
              // Once materialization has finished, the request owns the
              // resolved bytes/URLs. Removing the old placement must not
              // cancel an editor that no longer depends on that source.
              continuityOwners.get(continuity)?.delete(controller);
            }
          },
          signal: controller.signal,
        });
        const finalPrompt = editorResult?.prompt ?? '';
        const normalizedPrompt = finalPrompt.trim();
        if (!editorResult || controller.signal.aborted || !canBeginManualRevision(placement, normalizedPrompt)) return;
        const selectedReferenceSources = (
          editorResult.referenceSources ?? selectPromptEditorReferenceSources(referenceCandidates, referenceSelection)
        ).filter(source => source.value.trim());
        const usesPreviousStoryImage = selectedReferenceSources.some(source => source.kind === 'previous-story-image');
        // The editor already owns the materialized reference list. Keep the
        // continuity lock only while a previous-image source is still being
        // prepared; a text/avatar-only redraw must survive removal of an
        // unused previous placement.
        const revisionContinuity = usesPreviousStoryImage && validContinuity(continuity) ? continuity : undefined;
        if (auditedSnapshot === continuity) {
          audit.continuity.reference_count = selectedReferenceSources.length;
          audit.continuity.reference_kinds = selectedReferenceSources.map(source => source.kind);
        }
        const storedScenePrompt = editorResult.scenePrompt?.trim() || normalizedPrompt;
        onSubmitted?.();
        await regeneratePlacement(
          placement,
          storedScenePrompt,
          {
            // The editor's final text is already expanded and user-editable;
            // passing it directly prevents a second template expansion.
            prompt: finalPrompt,
            ...(selectedReferenceSources.length > 0
              ? { referenceImages: selectedReferenceSources.map(source => source.value) }
              : {}),
          },
          {
            outputPreset: { ...editorResult.outputPreset },
            avatarReferences: emptyAvatarReferenceReadResult(),
            continuity: revisionContinuity,
            resolvedReferenceSources: selectedReferenceSources,
            referenceKinds: selectedReferenceSources.map(source => source.kind),
            continuityShotPrompt: storedScenePrompt,
            profile,
          },
        );
      } catch (error) {
        if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
          setError(new Error('参考图准备失败，请稍后再试。'));
          toastr.error('参考图准备失败，请稍后再试。');
        }
      } finally {
        if (promptEditorController === controller) promptEditorController = null;
        releaseContinuity(continuity);
      }
    },
    onRegionRedraw: async (placement: ImagePlacement, onSubmitted?: () => void) => {
      abortRegionEditor();
      const controller = new AbortController();
      regionEditorController = controller;
      const selection = await openRegionRedrawEditor({ imageUrl: placement.url, signal: controller.signal }).finally(
        () => {
          if (regionEditorController === controller) regionEditorController = null;
        },
      );
      if (!selection) return;
      if (selection.wholeImage) {
        const wholeImagePrompt = selection.prompt.trim();
        if (controller.signal.aborted || !canBeginManualRevision(placement, wholeImagePrompt)) return;
        onSubmitted?.();
        await regeneratePlacement(
          placement,
          wholeImagePrompt,
          buildWholeImageRedrawInput(placement.url, wholeImagePrompt),
        );
        return;
      }
      if (!selection.region) return;
      const revision = buildRegionRedrawRevision(
        placement.url,
        selection.markedImage,
        placement.prompt,
        selection.prompt,
        selection.region,
      );
      if (controller.signal.aborted || !canBeginManualRevision(placement, revision.storedPrompt)) return;
      onSubmitted?.();
      await regeneratePlacement(placement, revision.storedPrompt, revision.input);
    },
    onPin: placement => {
      if (placementCache.get(placement.id) !== placement) return;
      const scope = placementScope(placement);
      const siblings = placementCache.placements.value.filter(item => isSameScope(placementScope(item), scope));
      workflow.confirm(placement, siblings);
      selectImagePlacement(placement);
      retention.pin(scope, placement.id);
      pruneExactScope(scope, placement.id);
      prunePlacementSelectionMemory();
      syncCacheAudit();
      syncRuntimeStatus();
      renderPlacementsForMessage(placement.target.messageId);
    },
    isPinned: placement => workflow.isConfirmed(placement.id),
    onDelete: placement => {
      abortPromptEditor();
      removePlacementAndArtifact(placement);
      prunePlacementSelectionMemory();
      syncCacheAudit();
      syncRuntimeStatus();
      renderPlacementsForMessage(placement.target.messageId);
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

  const renderPlacementsForMessage = (messageId: number, swipeIdOverride?: number): number => {
    groupWorkbenchPlacements(
      memoryChatId,
      placementCache.placements.value.filter(placement => placement.target.messageId === messageId),
    ).forEach(placements => {
      const base = workflow.base(placements);
      if (base) selectImagePlacement(base, true);
    });
    return renderMessagePlacements(
      placementCache.placements.value,
      messageId,
      placementRenderHandlers,
      swipeIdOverride,
    );
  };

  const pruneImageMemoryAfterNewTail = (messageId: number): void => {
    const messageRef = rawMessageRef(messageId);
    if (!messageRef || !workflow.advance(messageRef)) return;
    const groups = groupWorkbenchPlacements(
      memoryChatId,
      placementCache.placements.value.filter(placement => placement.target.messageId === messageId),
    );
    groups.forEach(placements => {
      // Viewing a candidate does not confirm it, but it may be kept as the working base.
      const selected =
        placements.find(placement => workflow.isConfirmed(placement.id)) ??
        getSelectedImagePlacements(placements)[0] ??
        workflow.base(placements);
      if (!selected) return;
      workflow.keepBase(selected, placements);
      // A source of an in-flight redraw must survive this first housekeeping pass.
      placements
        .filter(placement => placement.id !== selected.id && !manualRevisionControllerByPlacement.has(placement.id))
        .forEach(placement => removePlacementAndArtifact(placement));
    });
    prunePlacementSelectionMemory();
    syncCacheAudit();
    syncRuntimeStatus();
    renderPlacementsForMessage(messageId);
  };

  const observeNewTail = (kind: 'user' | 'assistant', messageId: number, eventType?: string): void => {
    const previousMessageId = messageAdvance.observeMessage(kind, messageId, SillyTavern.chat, eventType);
    if (previousMessageId !== null) pruneImageMemoryAfterNewTail(previousMessageId);
  };

  async function regeneratePlacement(
    placement: ImagePlacement,
    prompt: string,
    directInput?: ImageRequestInput,
    promptSnapshot?: PromptProcessingSnapshot,
  ): Promise<void> {
    const currentSettings = settings;
    const chatId = SillyTavern.getCurrentChatId();
    const messageRef = rawMessageRef(placement.target.messageId);
    const normalizedPrompt = prompt.trim();
    if (
      !currentSettings ||
      !currentSettings.enabled ||
      !normalizedPrompt ||
      !messageRef ||
      stopped ||
      chatId !== memoryChatId ||
      currentSwipeId(placement.target.messageId) !== placement.target.swipeId ||
      placementCache.get(placement.id) !== placement
    )
      return;

    const controller = new AbortController();
    const revisionScope = placementScope(placement);
    const revisionRetentionToken = retention.token(revisionScope);
    audit.run_id += 1;
    const generationId = `story-image-revision-${Date.now()}-${audit.run_id}`;
    const errorRevisionAtStart = errorRevision;
    trackManualRevision(placement.id, controller, generationId);
    if (promptSnapshot?.continuity) continuityOwners.get(promptSnapshot.continuity)?.add(controller);
    audit.generation = { id: generationId, status: 'running' };
    status.value = 'generating';
    syncWorkbench();
    try {
      const outputPreset = promptSnapshot?.outputPreset ?? getCurrentOutputPreset(currentSettings);
      const profile =
        promptSnapshot?.profile ?? forceSingleImageCount(cloneProfile(getActiveApiProfile(currentSettings)));
      const input =
        directInput ??
        (await processDrawingPrompt(
          { ...outputPreset },
          normalizedPrompt,
          promptSnapshot
            ? {
                readReferences: async () => cloneAvatarReferenceReadResult(promptSnapshot.avatarReferences),
                previousShotPrompt: promptSnapshot.continuity?.shotPrompt,
                previousStoryImage: promptSnapshot.continuity?.resource?.url,
                resolvedReferenceSources: promptSnapshot.resolvedReferenceSources,
                referenceContext: { profile, signal: controller.signal },
              }
            : undefined,
        ));
      if (
        !validContinuity(promptSnapshot?.continuity) ||
        !isCurrentManualRevision(placement, chatId, messageRef, controller, revisionRetentionToken)
      )
        return;
      const resources = await requestImages(profile, input, controller.signal);
      try {
        const resource = resources[0];
        if (!resource) throw new Error('图片 API 响应中没有可显示的图片');

        const nextMessageId = SillyTavern.chat.indexOf(messageRef as SillyTavern.ChatMessage);
        const currentPlacement = placementCache.get(placement.id);
        if (
          !currentPlacement ||
          nextMessageId < 0 ||
          !validContinuity(promptSnapshot?.continuity) ||
          !isCurrentManualRevision(placement, chatId, messageRef, controller, revisionRetentionToken)
        )
          return;
        const revisionIndex =
          Math.max(
            -1,
            ...placementCache.placements.value
              .filter(
                item =>
                  item.target.messageId === nextMessageId &&
                  item.target.swipeId === currentPlacement.target.swipeId &&
                  item.target.imageIndex === currentPlacement.target.imageIndex &&
                  item.variantIndex === currentPlacement.variantIndex,
              )
              .map(item => item.revisionIndex),
          ) + 1;
        const siblingsBeforeRevision = placementCache.placements.value.filter(item =>
          isSameScope(placementScope(item), placementScope(currentPlacement)),
        );
        const workingBase = workflow.base(siblingsBeforeRevision) ?? currentPlacement;
        workflow.keepBase(workingBase, siblingsBeforeRevision);
        selectImagePlacement(workingBase);
        const presentation = presenter.present({
          resource,
          chatId,
          sourceIntentId: null,
          displayMode: 'inline',
          placementTarget: {
            ...currentPlacement.target,
            messageId: nextMessageId,
          },
          artifactTarget: {
            messageId: nextMessageId,
            swipeId: currentPlacement.target.swipeId,
            imageIndex: currentPlacement.target.imageIndex,
          },
          messageRef,
          variantIndex: currentPlacement.variantIndex,
          revisionIndex,
          prompt: normalizedPrompt,
          finalPrompt: directInput?.prompt ?? normalizedPrompt,
          continuity: currentPlacement.continuity
            ? {
                ...currentPlacement.continuity,
                shotPrompt:
                  promptSnapshot?.continuityShotPrompt ??
                  (directInput ? currentPlacement.continuity.shotPrompt : normalizedPrompt),
              }
            : undefined,
          // Direct redraw inputs (currently the region editor) contain only
          // their explicit image input, so they are known to use no avatar or
          // previous-story source. Keep old placements without metadata
          // distinguishable by leaving the non-direct path undefined.
          referenceKinds: promptSnapshot?.referenceKinds ?? (directInput ? [] : undefined),
          referenceSource: promptSnapshot?.referenceKinds?.includes('previous-story-image')
            ? (promptSnapshot.continuity?.source ?? null)
            : null,
        });
        if (!presentation) throw new Error('重绘图片无法加入页面内存缓存');
        if (
          !validContinuity(promptSnapshot?.continuity) ||
          !isCurrentManualRevision(placement, chatId, messageRef, controller, revisionRetentionToken)
        ) {
          if (presentation.placement) removePlacementAndArtifact(presentation.placement);
          else recentCache.remove(presentation.artifact.id);
          syncCacheAudit();
          return;
        }
        settleManualRevisionAudit(audit, generationId, 'success', errorRevisionAtStart, errorRevision);
        syncCacheAudit();
        renderPlacementsForMessage(nextMessageId);
      } finally {
        // The presenter clones accepted resources into independent page-memory
        // owners. The request results themselves must always be released,
        // including provider over-delivery and exceptional render paths.
        resources.forEach(resource => resource.revoke?.());
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (commitManualRevisionFailure(audit, generationId, () => setError(error))) {
          toastr.error('图片重新生成失败，原版本仍然保留。');
        }
      } else settleManualRevisionAudit(audit, generationId, 'cancelled', errorRevisionAtStart, errorRevision);
    } finally {
      if (audit.generation.status === 'running') {
        settleManualRevisionAudit(audit, generationId, 'cancelled', errorRevisionAtStart, errorRevision);
      }
      if (promptSnapshot?.continuity) continuityOwners.get(promptSnapshot.continuity)?.delete(controller);
      untrackManualRevision(placement.id, controller);
      syncRuntimeStatus();
    }
  }

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
    continuity: StoryContinuitySnapshot | null,
    avatarReferences: Promise<AvatarReferenceReadResult>,
  ): Promise<void> {
    const errorRevisionAtStart = errorRevision;
    if (continuity) continuityOwners.get(continuity)?.add(task.abortController);
    const currentTask = (): boolean => {
      if (!isStoredTask(task)) return false;
      if (validContinuity(continuity) && !task.abortController.signal.aborted) return true;
      task.status = 'cancelled';
      return false;
    };
    if (!currentTask()) {
      removeRenderedTaskHost(task);
      return;
    }
    task.status = 'running';
    status.value = 'generating';
    if (shouldRenderInlineTask(displayMode, task.status)) renderInlineTasksForMessage(task.messageId);
    if (displayMode === 'gift') audit.gift.status = 'running';
    updateGenerationStatus(task.generationId, task.messageId);
    try {
      const input = await processDrawingPrompt(outputPreset, task.intent.prompt, {
        referenceContext: { profile, signal: task.abortController.signal },
        readReferences: () => avatarReferences,
        previousShotPrompt: continuity?.shotPrompt,
        previousStoryImage: continuity?.resource?.url,
      });
      if (auditedSnapshot === continuity) {
        audit.continuity.reference_count = input.referenceImages?.length ?? 0;
        audit.continuity.reference_kinds = input.referenceSources?.map(source => source.kind) ?? [];
      }
      if (!currentTask()) {
        removeRenderedTaskHost(task);
        return;
      }
      const resources = await requestImages(profile, input, task.abortController.signal);
      let presentations: NonNullable<ReturnType<ImagePresenter['present']>>[] = [];
      try {
        if (!currentTask()) {
          removeRenderedTaskHost(task);
          return;
        }
        const primaryResource = resources[0];
        if (!primaryResource) throw new Error('图片 API 响应中没有可显示的图片');
        assignImageResource(task, primaryResource);
        const target: ImagePlacementTarget = {
          kind: 'inline-anchor',
          messageId: task.messageId,
          swipeId: task.swipeId,
          imageIndex: task.imageIndex,
          paragraphIndex: task.paragraphIndex,
          anchorTextBefore: task.anchorTextBefore,
          anchorTextAfter: task.anchorTextAfter,
        };
        presentations = resources
          .map((resource, variantIndex) =>
            presenter.present({
              resource,
              chatId: task.chatId,
              sourceIntentId: task.intent.id,
              displayMode,
              placementTarget: displayMode === 'inline' ? target : undefined,
              artifactTarget: { messageId: task.messageId, swipeId: task.swipeId, imageIndex: task.imageIndex },
              messageRef: rawMessageRef(task.messageId),
              variantIndex,
              revisionIndex: 0,
              prompt: task.intent.prompt,
              finalPrompt: input.prompt,
              continuity: continuity
                ? {
                    chatId: task.chatId,
                    drawingPresetId: continuity.drawingPresetId,
                    outputPresetId: continuity.outputPresetId,
                    shotPrompt: task.intent.prompt,
                  }
                : undefined,
              referenceKinds: input.referenceSources?.map(source => source.kind) ?? [],
              referenceSource: input.referenceSources?.some(source => source.kind === 'previous-story-image')
                ? (continuity?.source ?? null)
                : null,
            }),
          )
          .filter(presentation => presentation !== null);
      } finally {
        // Accepted results have independent recent/placement clones. Request
        // results are temporary owners and must not duplicate page-memory use.
        resources.forEach(resource => resource.revoke?.());
        task.image = null;
      }
      // Presenting can evict the locked source at the bounded placement limit.
      // Roll back this round if synchronous cache cleanup invalidated its snapshot.
      if (!currentTask()) {
        removeRenderedTaskHost(task);
        presentations.forEach(presentation => {
          if (presentation.placement) removePlacementAndArtifact(presentation.placement);
          else recentCache.remove(presentation.artifact.id);
        });
        syncCacheAudit();
        return;
      }
      const retainedPresentation = presentations.find(presentation =>
        recentCache.getArtifact(presentation.artifact.id),
      );
      if (!retainedPresentation) throw new Error('图片无法加入页面内存缓存');
      if (displayMode === 'inline' && retainedPresentation.placement) {
        const siblings = placementCache.placements.value.filter(item =>
          isSameScope(placementScope(item), taskScope(task)),
        );
        workflow.keepBase(workflow.base(siblings) ?? retainedPresentation.placement, siblings);
      }
      if (displayMode === 'inline') removeRenderedTaskHost(task);
      task.artifactId = retainedPresentation.artifact.id;
      syncCacheAudit();
      if (displayMode === 'inline') {
        renderPlacementsForMessage(task.messageId);
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
      if (!currentTask()) return;
      if (task.abortController.signal.aborted) task.status = 'cancelled';
      else {
        task.status = 'failed';
        task.error = errorText(error);
        if (displayMode === 'gift') audit.gift.status = 'fail';
        setError(error);
      }
    } finally {
      if (continuity) continuityOwners.get(continuity)?.delete(task.abortController);
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
    const pending = scan.markers.map((marker: InlineImagePrompt) => {
      const task = createImageTask(marker, {
        chatId: generation.chatId,
        messageId,
        swipeId,
        generationId: generation.id,
      });
      taskRetentionToken.set(task, retention.token(taskScope(task)));
      const messageRef = rawMessageRef(messageId);
      if (messageRef) taskMessageRefs.set(task, messageRef);
      cache.set(task);
      if (generation.displayMode === 'inline') {
        inlineTaskKeys.add(imageTaskKey(task));
        renderImageTask(task, taskRenderHandlers, swipeId);
      }
      return runTask(
        task,
        generation.outputPreset,
        generation.profile,
        generation.displayMode,
        generation.continuity,
        generation.avatarReferences,
      );
    });
    void Promise.allSettled(pending).finally(() => {
      releaseContinuity(generation.continuity);
    });
    updateTaskAudit(messageId, swipeId);
    updateGenerationStatus(generation.id, messageId);
    persistCleanedMessage(messageId, swipeId, message);
  };

  const prepareGeneration = (type: string, _option: unknown, dryRun: boolean): void => {
    releaseContinuity(activeGeneration?.continuity, true);
    messageAdvance.onGenerationStarted(type, dryRun, SillyTavern.chat);
    const currentSettings = settings;
    const groupId = SillyTavern.groupId;
    const isSwipe = isSwipeGeneration(type, dryRun);
    const isRegenerate = type === 'regenerate' && !dryRun;
    floorDecisions.sync(SillyTavern.chat);
    const pendingSwipe = pendingSwipeTarget;
    pendingSwipeTarget = null;
    const pendingSwipeMessage = isSwipe && pendingSwipe ? getChatMessages(-1, { include_swipes: true })[0] : undefined;
    const pendingSwipeMessageId =
      isSwipe &&
      pendingSwipe &&
      pendingSwipe.chatId === memoryChatId &&
      pendingSwipe.chatId === SillyTavern.getCurrentChatId() &&
      rawMessageRef(pendingSwipe.messageId) === pendingSwipe.messageRef &&
      pendingSwipeMessage?.message_id === pendingSwipe.messageId &&
      pendingSwipeMessage.role === 'assistant'
        ? pendingSwipe.messageId
        : null;
    const swipeMessageId = isSwipe ? (pendingSwipeMessageId ?? getLastMessageId()) : null;
    const swipeDecision = swipeMessageId === null ? undefined : floorDecisions.get(rawMessageRef(swipeMessageId));
    const generateOnSwipe = currentSettings?.displaySettings.generateOnSwipe !== false;
    if (isSwipe) {
      audit.swipe = {
        enabled: generateOnSwipe,
        message_id: swipeMessageId,
        eligible: swipeDecision?.shouldTrigger ?? false,
        started: false,
        skipped: true,
      };
    }
    if (
      !currentSettings ||
      !shouldArmStoryImageGeneration({
        enabled: currentSettings.enabled,
        type,
        dryRun,
        groupId,
        generateOnSwipe,
        swipeFloorEligible: swipeDecision?.shouldTrigger,
      })
    ) {
      activeGeneration = null;
      installPrompt(null);
      audit.gift.last_skip_reason = !currentSettings?.enabled
        ? 'disabled'
        : !isSingleCharacterChat(groupId)
          ? 'group-chat'
          : isSwipe && swipeDecision && !swipeDecision.shouldTrigger
            ? 'skipped-by-frequency'
            : 'non-normal-generation';
      return;
    }

    const regenerationTarget =
      isRegenerate && getChatMessages(-1)[0]?.role === 'assistant' ? getLastMessageId() : undefined;
    const eligibility = floorDecisions.prepare({
      type: isSwipe ? 'swipe' : isRegenerate ? 'regenerate' : 'normal',
      chat: SillyTavern.chat,
      freshUserInput: type === 'normal' && String($('#send_textarea').val?.() ?? '').trim().length > 0,
      targetMessageId: isSwipe ? swipeMessageId! : regenerationTarget,
      decide: nextFloorCount =>
        decideFloorTrigger({
          enabled: currentSettings.enabled,
          isNormalGeneration: true,
          isGroupChat: false,
          normalAssistantFloorCount: nextFloorCount,
          displaySettings: currentSettings.displaySettings,
        }),
    });
    if (!eligibility) {
      activeGeneration = null;
      installPrompt(null);
      return;
    }
    const { nextFloorCount, decision } = eligibility;
    audit.run_id += 1;
    const generation: GenerationState = {
      id: `story-image-${Date.now()}-${audit.run_id}`,
      type: isSwipe ? 'swipe' : isRegenerate ? 'regenerate' : 'normal',
      eligibility,
      messageId: isSwipe ? swipeMessageId : (regenerationTarget ?? null),
      chatId: memoryChatId,
      startChatLength: regenerationTarget ?? SillyTavern.chat.length,
      startTailRef: (() => {
        const tailId = getLastMessageId();
        return tailId >= 0 ? rawMessageRef(tailId) : null;
      })(),
      nextFloorCount,
      decision,
      preset: { ...getCurrentDrawingPreset(currentSettings) },
      outputPreset: { ...getCurrentOutputPreset(currentSettings) },
      profile: cloneProfile(getActiveApiProfile(currentSettings)),
      displayMode: currentSettings.displaySettings.displayMode,
      continuity: null,
      avatarReferences:
        decision.shouldTrigger && getCurrentOutputPreset(currentSettings).useAvatarReferences
          ? readAvatarReferencesForPromptEditor()
          : Promise.resolve(emptyAvatarReferenceReadResult()),
    };
    if (decision.shouldTrigger && generation.displayMode === 'inline') {
      generation.continuity = captureContinuity(
        isSwipe ? swipeMessageId! : (regenerationTarget ?? SillyTavern.chat.length),
        generation.preset.id,
        generation.outputPreset.id,
        generation.outputPreset.usePreviousStoryImage === true,
      );
      if (generation.outputPreset.usePreviousStoryImage) {
        const latest = placementCache.placements.value
          .filter(
            placement =>
              placement.continuity?.drawingPresetId === generation.preset.id &&
              placement.continuity?.outputPresetId === generation.outputPreset.id &&
              placement.target.messageId < (isSwipe ? swipeMessageId! : generation.startChatLength) &&
              currentSwipeId(placement.target.messageId) === placement.target.swipeId,
          )
          .sort((a, b) => b.target.messageId - a.target.messageId || b.target.imageIndex - a.target.imageIndex)[0];
        const source = generation.continuity.source;
        if (!source) toastr.info('暂无已确认镜头，本次不使用剧情图参考。');
        else if (
          latest &&
          (latest.target.messageId > source.messageId ||
            (latest.target.messageId === source.messageId && latest.target.imageIndex > source.imageIndex))
        ) {
          toastr.info(`上一镜头尚未确认，本次沿用第 ${source.messageId} 楼已确认镜头。`);
        }
      }
    }
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
    if (isSwipe) audit.swipe.skipped = false;
    installPrompt(
      decision.shouldTrigger
        ? applyDrawingPromptTemplate(generation.preset.instructionText, generation.continuity?.shotPrompt)
        : null,
    );
  };

  const generationEndedMessageId = (generation: GenerationState, eventMessageId: number): number | null => {
    const candidates = [
      eventMessageId,
      generation.type === 'swipe' ? generation.messageId : null,
      generation.type !== 'swipe' ? getLastMessageId() : null,
      generation.type !== 'swipe' ? SillyTavern.chat.length - 1 : null,
    ];
    const seen = new Set<number>();
    for (const candidate of candidates) {
      if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0 || seen.has(candidate))
        continue;
      seen.add(candidate);
      if (generation.type !== 'swipe' && candidate < generation.startChatLength) continue;
      const rawMessage = rawMessageRef(candidate);
      const message = getChatMessages(candidate)[0];
      if (
        message?.role !== 'assistant' ||
        !rawMessage ||
        (generation.type !== 'swipe' && rawMessage === generation.startTailRef)
      )
        continue;
      if (generation.type === 'swipe' && generation.messageId !== null && candidate !== generation.messageId) continue;
      return candidate;
    }
    return null;
  };

  const onMessageReceived = (messageId: number, type: string): void => {
    const generation = activeGeneration;
    const message = getChatMessages(messageId)[0];
    if (
      !generation ||
      generation.chatId !== SillyTavern.getCurrentChatId() ||
      !isMatchingAssistantReply({
        generationType: generation.type,
        receivedType: type,
        role: message?.role,
        expectedMessageId: generation.messageId,
        receivedMessageId: messageId,
      })
    )
      return;

    generation.messageId = messageId;
    activeGeneration = null;
    const receivedRef = rawMessageRef(messageId);
    const predecessor = rawMessageRef(messageId - 1);
    const committed =
      receivedRef &&
      floorDecisions.commit(
        generation.eligibility,
        receivedRef,
        SillyTavern.chat,
        predecessor && SillyTavern.chat[messageId - 1]?.is_user ? predecessor : undefined,
      );
    if (!committed) {
      // This text generation no longer owns the reply position. Do not parse or
      // clean its body, launch image tasks, or touch another generation's work.
      installPrompt(null);
      releaseContinuity(generation.continuity, true);
      if (audit.generation.id === generation.id) {
        audit.generation.status = 'success';
        audit.gift.status = generation.displayMode === 'gift' ? 'skipped' : 'idle';
        audit.gift.last_skip_reason = 'stale-reply';
      }
      if (generation.type === 'swipe') audit.swipe = { ...audit.swipe, started: false, skipped: true };
      syncRuntimeStatus();
      return;
    }
    normalAssistantFloorCount = floorDecisions.count;
    if (generation.type === 'swipe') {
      audit.swipe = { ...audit.swipe, message_id: messageId, started: true, skipped: false };
    }
    audit.gift.assistant_reply_count = normalAssistantFloorCount;
    installPrompt(null);
    if (!generation.decision.shouldTrigger) {
      audit.generation.status = 'success';
      syncRuntimeStatus();
      return;
    }
    if (!validContinuity(generation.continuity)) {
      persistCleanedMessage(messageId, currentSwipeId(messageId), message.message);
      releaseContinuity(generation.continuity, true);
      audit.generation.status = 'success';
      syncRuntimeStatus();
      return;
    }
    audit.gift.last_trigger_message_id = messageId;
    startMarkerTasks(generation, messageId, message.message);
  };

  const resetMemory = (): void => {
    clearContinuity();
    abortPromptEditor();
    abortRegionEditor();
    abortManualRevisions();
    activeGeneration = null;
    pendingSwipeTarget = null;
    cache.clear();
    inlineTaskKeys.clear();
    placementCache.clear();
    recentCache.clear();
    clearRenderedHosts();
    sourceCleanupInFlight.clear();
    giftArrivalNoticeGenerations.clear();
    normalAssistantFloorCount = 0;
    floorDecisions.reset();
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
    retention.clear();
    workflow.clear();
    messageAdvance.seed(SillyTavern.chat);
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
    workbenchShots,
    confirmWorkbenchImage: placementId => {
      const placement = placementCache.get(placementId);
      if (placement) void placementRenderHandlers.onPin?.(placement);
    },
    abandonWorkbenchShot: shotId => {
      const shot = workbenchShots.value.find(item => item.id === shotId);
      if (!shot) return;
      pruneExactScope(shot, null);
      syncCacheAudit();
      syncRuntimeStatus();
      renderPlacementsForMessage(shot.messageId);
    },
    editWorkbenchImage: async placementId => {
      const placement = placementCache.get(placementId);
      if (placement && canBeginManualRevision(placement, placement.prompt))
        await placementRenderHandlers.onEditPrompt?.(placement);
    },
    redrawWorkbenchImage: async placementId => {
      const placement = placementCache.get(placementId);
      if (placement && canBeginManualRevision(placement, placement.prompt))
        await placementRenderHandlers.onRegionRedraw?.(placement);
    },
    removeWorkbenchImage: placementId => {
      const placement = placementCache.get(placementId);
      if (placement) void placementRenderHandlers.onDelete?.(placement);
    },
    jumpToWorkbenchShot: shotId => {
      const shot = workbenchShots.value.find(item => item.id === shotId);
      if (!shot || !rawMessageRef(shot.messageId)) return;
      const element = retrieveDisplayedMessage(shot.messageId)[0];
      if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else toastr.info('该楼层尚未加载，请先在聊天中加载较早消息。');
    },
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
      placementCache.placements.value
        .filter(placement => placement.artifactId === id)
        .forEach(placement => abortManualRevisionsForPlacement(placement.id));
      const removed = recentCache.remove(id);
      prunePlacementSelectionMemory();
      syncCacheAudit();
      syncRuntimeStatus();
      return removed;
    },
    start: () => {
      if (started || stopped) return;
      started = true;
      audit.lifecycle.status = 'running';
      clearRenderedHosts();
      listen(tavern_events.GENERATION_STARTED, prepareGeneration);
      listen(tavern_events.GENERATION_STOPPED, () => {
        releaseContinuity(activeGeneration?.continuity, true);
        activeGeneration = null;
        installPrompt(null);
        messageAdvance.onGenerationEnded();
      });
      listen(tavern_events.STREAM_TOKEN_RECEIVED, _text => {
        const tailMessageId = SillyTavern.chat.length - 1;
        if (tailMessageId >= 0) observeNewTail('assistant', tailMessageId);
      });
      listen(tavern_events.MESSAGE_SENT, messageId => {
        observeNewTail('user', messageId);
      });
      listen(tavern_events.USER_MESSAGE_RENDERED, messageId => {
        observeNewTail('user', messageId);
      });
      listen(tavern_events.MESSAGE_RECEIVED, (messageId, type) => {
        observeNewTail('assistant', messageId, type);
        onMessageReceived(messageId, type);
      });
      listen(tavern_events.GENERATION_ENDED, messageId => {
        const generation = activeGeneration;
        if (generation) {
          const endedMessageId = generationEndedMessageId(generation, messageId);
          if (endedMessageId !== null) onMessageReceived(endedMessageId, generation.type);
          if (activeGeneration === generation) {
            releaseContinuity(generation.continuity);
            activeGeneration = null;
            installPrompt(null);
          }
        } else {
          installPrompt(null);
        }
        messageAdvance.onGenerationEnded();
        if (Number.isInteger(messageId)) {
          renderInlineTasksForMessage(messageId);
          renderPlacementsForMessage(messageId);
        }
      });
      listen(tavern_events.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
        observeNewTail('assistant', messageId, type);
        renderInlineTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_SWIPED, messageId => {
        const messageRef = rawMessageRef(messageId);
        pendingSwipeTarget =
          Number.isInteger(messageId) && messageRef ? { chatId: memoryChatId, messageId, messageRef } : null;
        abortPromptEditor();
        abortRegionEditor();
        const swipeId = currentSwipeId(messageId);
        renderInlineTasksForMessage(messageId, swipeId);
        renderPlacementsForMessage(messageId, swipeId);
        updateTaskAudit(messageId, swipeId);
        syncWorkbench();
      });
      listen(tavern_events.MESSAGE_SWIPE_DELETED, eventData => {
        const sourceMessageRef = rawMessageRef(eventData.messageId);
        for (const snapshot of continuityOwners.keys()) {
          if (!sourceMessageRef || snapshotMessageRefs.get(snapshot) !== sourceMessageRef) continue;
          const sourceSwipe = snapshotSwipeIds.get(snapshot);
          if (sourceSwipe === eventData.swipeId) releaseContinuity(snapshot, true);
          else if (sourceSwipe !== undefined && sourceSwipe > eventData.swipeId)
            snapshotSwipeIds.set(snapshot, sourceSwipe - 1);
        }
        pendingSwipeTarget = null;
        abortPromptEditor();
        abortRegionEditor();
        abortManualRevisionsForSwipeDeletion(eventData.messageId, eventData.swipeId);
        const shiftedTasks = cache
          .getForMessage(memoryChatId, eventData.messageId)
          .filter(task => task.swipeId > eventData.swipeId)
          .map(task => ({
            task,
            oldKey: imageTaskKey(task),
            oldScope: taskScope(task),
            inline: inlineTaskKeys.has(imageTaskKey(task)),
          }))
          .sort((left, right) => left.oldScope.swipeId - right.oldScope.swipeId);
        const affectedScopes = new Map<string, ImageRetentionScope>();
        placementCache.placements.value
          .filter(
            placement =>
              placement.target.messageId === eventData.messageId && placement.target.swipeId >= eventData.swipeId,
          )
          .forEach(placement => {
            const scope = placementScope(placement);
            affectedScopes.set(imageRetentionScopeKey(scope), scope);
          });
        shiftedTasks.forEach(({ oldScope }) => affectedScopes.set(imageRetentionScopeKey(oldScope), oldScope));
        shiftedTasks.forEach(({ task }) => removeRenderedTaskHost(task));
        cache.removeSwipe(memoryChatId, eventData.messageId, eventData.swipeId);
        placementCache.removeSwipe(eventData.messageId, eventData.swipeId);
        recentCache.artifacts.value
          .filter(
            artifact =>
              artifact.purpose === 'current' &&
              artifact.chatId === memoryChatId &&
              artifact.target.messageId === eventData.messageId &&
              artifact.target.swipeId === eventData.swipeId,
          )
          .forEach(artifact => recentCache.remove(artifact.id));
        [...affectedScopes.values()]
          .sort((left, right) => left.swipeId - right.swipeId)
          .forEach(scope => {
            if (scope.swipeId === eventData.swipeId) retention.forgetScope(scope);
            else {
              const targetScope = { ...scope, swipeId: scope.swipeId - 1 };
              // Ascending migration has already vacated this position. Its old
              // token must not invalidate the surviving reply's manual request.
              retention.forgetScope(targetScope);
              retention.moveScope(scope, targetScope);
            }
          });
        cache.shiftSwipeIdsAfterDeletion(memoryChatId, eventData.messageId, eventData.swipeId);
        shiftedTasks.forEach(({ task, oldKey, inline }) => {
          inlineTaskKeys.delete(oldKey);
          if (inline) inlineTaskKeys.add(imageTaskKey(task));
          taskRetentionToken.set(task, retention.token(taskScope(task)));
        });
        placementCache.shiftSwipeIdsAfterDeletion(eventData.messageId, eventData.swipeId);
        checkContinuity();
        recentCache.reconcileDeletedSwipe(memoryChatId, eventData.messageId, eventData.swipeId);
        recentCache.artifacts.value
          .filter(
            artifact =>
              artifact.purpose === 'current' &&
              artifact.chatId === memoryChatId &&
              artifact.target.messageId === eventData.messageId &&
              artifact.target.swipeId === null,
          )
          .forEach(artifact => recentCache.remove(artifact.id));
        prunePlacementSelectionMemory();
        renderInlineTasksForMessage(eventData.messageId, eventData.newSwipeId);
        renderPlacementsForMessage(eventData.messageId, eventData.newSwipeId);
        updateTaskAudit(eventData.messageId, eventData.newSwipeId);
        syncCacheAudit();
        syncRuntimeStatus();
      });
      listen(tavern_events.CHAT_CHANGED, newChatId => {
        if (newChatId === memoryChatId) {
          installPrompt(null);
          setTimeout(renderAllPlacements, 0);
          return;
        }
        memoryChatId = newChatId;
        pendingSwipeTarget = null;
        clearPrompt();
        resetMemory();
        messageAdvance.seed(SillyTavern.chat);
        status.value = 'idle';
      });
      listen(tavern_events.MESSAGE_EDITED, messageId => {
        abortPromptEditor();
        abortRegionEditor();
        abortManualRevisionsForMessage(messageId);
        cache.removeMessage(memoryChatId, messageId);
        recentCache.artifacts.value
          .filter(
            artifact =>
              artifact.purpose === 'current' &&
              artifact.chatId === memoryChatId &&
              artifact.target.messageId === messageId,
          )
          .forEach(artifact => recentCache.remove(artifact.id));
        placementCache.placements.value
          .filter(placement => placement.target.messageId === messageId)
          .forEach(placement => placementCache.remove(placement.id));
        prunePlacementSelectionMemory();
        syncCacheAudit();
        syncRuntimeStatus();
      });
      listen(tavern_events.MESSAGE_UPDATED, messageId => {
        renderInlineTasksForMessage(messageId);
        renderPlacementsForMessage(messageId);
      });
      listen(tavern_events.MESSAGE_DELETED, () => {
        floorDecisions.sync(SillyTavern.chat);
        abortPromptEditor();
        abortRegionEditor();
        placementCache.placements.value
          .filter(placement => {
            const messageRef = placementCache.messageRef(placement.id);
            return !messageRef || rawMessageRef(placement.target.messageId) !== messageRef;
          })
          .forEach(placement => abortManualRevisionsForPlacement(placement.id));
        if (activeGeneration?.type !== 'regenerate') {
          clearPrompt();
          releaseContinuity(activeGeneration?.continuity, true);
          activeGeneration = null;
        }
        recentCache.reconcileMessageIndexes(memoryChatId, SillyTavern.chat);
        recentCache.artifacts.value
          .filter(
            artifact =>
              artifact.purpose === 'current' && artifact.chatId === memoryChatId && artifact.target.messageId === null,
          )
          .forEach(artifact => recentCache.remove(artifact.id));
        cache
          .values()
          .filter(task => rawMessageRef(task.messageId) !== taskMessageRefs.get(task))
          .forEach(removeTask);
        placementCache.reconcileMessageIndexes(SillyTavern.chat);
        checkContinuity();
        prunePlacementSelectionMemory();
        clearRenderedHosts();
        sourceCleanupInFlight.clear();
        giftArrivalNoticeGenerations.clear();
        if (!activeGeneration && manualRevisionControllers.size === 0)
          audit.generation = { id: null, status: 'pending' };
        pendingSwipeTarget = null;
        audit.markers = { count: 0, valid_count: 0, truncated: false };
        audit.tasks = [
          { status: 'idle', message_id: null, swipe_id: null },
          { status: 'idle', message_id: null, swipe_id: null },
        ];
        audit.gift = {
          ...audit.gift,
          status: 'idle',
          last_trigger_message_id: null,
          last_skip_reason: null,
        };
        audit.arrival_notice = { status: 'idle', shown: false };
        audit.swipe = { ...audit.swipe, message_id: null, eligible: null, started: false, skipped: false };
        messageAdvance.reseed(SillyTavern.chat);
        syncCacheAudit();
        syncRuntimeStatus();
        setTimeout(renderAllPlacements, 0);
      });
      listen(tavern_events.MORE_MESSAGES_LOADED, () => {
        renderAllPlacements();
      });
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
      audit.swipe.enabled = nextSettings.displaySettings.generateOnSwipe;
      if (!nextSettings.enabled) {
        clearContinuity();
        abortPromptEditor();
        abortRegionEditor();
        abortManualRevisions();
        activeGeneration = null;
        pendingSwipeTarget = null;
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
