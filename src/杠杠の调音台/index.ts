import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import { resolveBilibiliAmbientAudio } from './ambient-audio';
import BgmSettings from './BgmSettings.vue';
import {
  getNeteaseCandidatesForGeneration,
  type NeteasePlaylistTrack,
} from './bgm-playlist';
import {
  createBgmPromptCadenceState,
  createBgmPromptGenerationLifecycle,
  createBgmPromptSkippedSwipeLifecycle,
  decideBgmPromptCadenceAtFloor,
  decideBgmPromptCadence,
  advanceBgmPromptSkippedSwipeLifecycle,
  markBgmPromptGenerationAborted,
  markBgmPromptAfterCommandsAccepted,
  markBgmPromptGenerationStarted,
  markBgmPromptGenerationSettled,
  mergeBgmPromptSwipeAudit,
  normalizeBgmPromptInterval,
  isBgmPromptGenerationReady,
  shouldArmBgmPromptGeneration,
  shouldHandleBgmGeneration,
  shouldTrackAudioGeneration,
  settleBgmPromptCadence,
  updateBgmPromptCadenceInterval,
  BgmMessageIdentityStore,
  type BgmPromptCadenceDecision,
  type BgmPromptFloorDecision,
  type BgmPromptGenerationLifecycle,
  type BgmPromptSkippedSwipeEvent,
  type BgmPromptSkippedSwipeLifecycle,
  type BgmPromptSwipeAudit,
  type BgmPromptCadenceState,
  type BgmSourceMode,
  useBgmSettingsStore,
} from './bgm-settings';

const bgmPinia = createPinia();
const bgmSettingsStore = useBgmSettingsStore(bgmPinia);

function debugInfo(...args: unknown[]) {
  if (bgmSettingsStore.settings.debug_mode) console.info(...args);
}

function debugWarn(...args: unknown[]) {
  if (bgmSettingsStore.settings.debug_mode) console.warn(...args);
}

type BgmAction = { type: 'play' | 'stop' | 'none'; song?: string; singer?: string };
type MarkerScanner = {
  pushSnapshot: (fullText: string) => BgmAction | null;
  finish: () => BgmAction;
  getState: () => { generationId: number; resolved: boolean; action: BgmAction | null };
};

type AmbientAction = { title: string; location: string };
type AmbientMarkerScanner = {
  pushSnapshot: (fullText: string) => AmbientAction | null;
  finish: () => AmbientAction | null;
  getState: () => { generationId: number; resolved: boolean; action: AmbientAction | null };
};

const markerPattern = /<杠杠-BGM=([^<>\r\n]+)>/i;
const ambientMarkerPattern = /<杠杠-环境音=([^<>\r\n]+)>/i;

function parseBgmMarkerBody(body: string): BgmAction | null {
  const content = body.trim();

  const separatorIndex = content.lastIndexOf('-');
  if (separatorIndex <= 0 || separatorIndex >= content.length - 1) return null;

  const song = content.slice(0, separatorIndex).trim();
  const singer = content.slice(separatorIndex + 1).trim();
  if (!song || !singer) return null;
  if (song.toLowerCase() === 'none') return { type: 'none' };
  if (song.toLowerCase() === 'stop') return { type: 'stop' };
  return { type: 'play', song, singer };
}

function createMarkerScanner(generationId: number, onAction: (action: BgmAction) => void): MarkerScanner {
  let latestText = '';
  let resolved = false;
  let action: BgmAction | null = null;

  const resolve = (next: BgmAction) => {
    resolved = true;
    action = next;
    if (next.type !== 'none') onAction(next);
    return next;
  };

  return {
    pushSnapshot(fullText) {
      if (resolved || typeof fullText !== 'string') return null;
      latestText = fullText;

      const prefix = latestText.slice(0, 96);
      if (/^\s*<杠杠-BGM=/i.test(prefix) && !prefix.includes('>')) return null;

      const match = latestText.match(markerPattern);
      if (!match) return null;

      const parsed = parseBgmMarkerBody(match[1]);
      if (!parsed) return null;
      return resolve(parsed);
    },
    finish() {
      return action ?? resolve({ type: 'none' });
    },
    getState() {
      void latestText;
      return { generationId, resolved, action };
    },
  };
}

function parseAmbientMarkerBody(body: string): AmbientAction | null {
  const title = body.trim();
  const prefix = '白噪音-';
  if (!title.startsWith(prefix)) return null;

  const location = title.slice(prefix.length).trim();
  if (!location) return null;
  return { title, location };
}

function createAmbientMarkerScanner(
  generationId: number,
  onAction: (action: AmbientAction) => void,
): AmbientMarkerScanner {
  let latestText = '';
  let resolved = false;
  let action: AmbientAction | null = null;

  const resolve = (next: AmbientAction) => {
    resolved = true;
    action = next;
    onAction(next);
    return next;
  };

  return {
    pushSnapshot(fullText) {
      if (resolved || typeof fullText !== 'string') return null;
      latestText = fullText;

      const prefix = latestText.slice(0, 128);
      if (/^\s*<杠杠-环境音=/i.test(prefix) && !prefix.includes('>')) return null;

      const match = latestText.match(ambientMarkerPattern);
      if (!match) return null;

      const parsed = parseAmbientMarkerBody(match[1]);
      if (!parsed) return null;
      return resolve(parsed);
    },
    finish() {
      return action;
    },
    getState() {
      void latestText;
      return { generationId, resolved, action };
    },
  };
}

function createMusicSearchQuery(song: string, singer: string) {
  return `${singer} ${song}`.trim();
}

type BgmSourceContext = {
  mode: BgmSourceMode;
  playlistId: string | null;
  candidates: NeteasePlaylistTrack[];
};

type BgmPlaylistPlan = {
  retained: Audio[];
  removedCount: number;
};

function planBgmPlaylist(audioList: Audio[], playlistLimit: number): BgmPlaylistPlan {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(playlistLimit)));
  const retained = audioList.length >= safeLimit ? (safeLimit > 1 ? audioList.slice(-(safeLimit - 1)) : []) : audioList.slice();
  return { retained, removedCount: audioList.length - retained.length };
}

function maintainBgmPlaylist(audio: Audio) {
  const currentList = getAudioList('bgm');
  const rawPlaylistLimit = Math.floor(Number(bgmSettingsStore.settings.playlist_limit));
  const playlistLimit = Number.isFinite(rawPlaylistLimit) ? Math.max(1, Math.min(20, rawPlaylistLimit)) : 5;
  const plan = planBgmPlaylist(currentList, playlistLimit);
  if (plan.removedCount > 0) replaceAudioList('bgm', plan.retained);
  appendAudioList('bgm', [audio]);

  const nextList = getAudioList('bgm');
  const newAudioAdded = nextList.some(item => item.title === audio.title && item.url === audio.url);
  if (!newAudioAdded) throw new Error('最新 BGM 未成功加入播放列表');
  if (nextList.length > playlistLimit) {
    throw new Error(`BGM 播放列表仍有 ${nextList.length} 首，超过设置的 ${playlistLimit} 首上限`);
  }

  return {
    beforeCount: currentList.length,
    removedCount: plan.removedCount,
    afterCount: nextList.length,
  };
}

const bgmPromptId = 'ganggang-console-bgm-marker-persistent';
const bgmPlaylistPromptId = 'ganggang-console-bgm-playlist-dynamic';

function getCurrentBgmTitles() {
  return getAudioList('bgm')
    .map(audio => (typeof audio.title === 'string' ? audio.title.trim() : ''))
    .filter(Boolean);
}

function getCurrentAmbientTitle() {
  const currentAudio = getCurrentAudio('ambient');
  return typeof currentAudio.title === 'string' ? currentAudio.title.trim() : '';
}

function getAmbientLocationFromTitle(title: string) {
  const prefix = '白噪音-';
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() : '';
}

type PromptTemplateValues = {
  current_bgm_playlist: string;
  required_candidates: string;
  playlist_id: string;
  current_ambient_location: string;
  current_ambient_title: string;
};

function renderPromptTemplate(template: string, values: PromptTemplateValues) {
  return Object.entries(values).reduce(
    (content, [key, value]) => content.split(`{{${key}}}`).join(value),
    template,
  );
}

function renderDynamicPromptSection(
  template: string,
  placeholder: keyof Pick<PromptTemplateValues, 'current_bgm_playlist' | 'required_candidates' | 'playlist_id'>,
  value: string,
  values: PromptTemplateValues,
) {
  const token = '{{' + placeholder + '}}';
  const rendered = renderPromptTemplate(template, { ...values, [placeholder]: value }).trim();
  return template.includes(token) ? rendered : [rendered, value].filter(Boolean).join('\n');
}

function createAudioPromptContent(
  titles: string[],
  sourceContext: BgmSourceContext,
  sourceError: string | null,
  currentAmbientTitle: string,
  includeBgmPrompt = isBgmEnabled(),
) {
  const currentPlaylist = titles.length
    ? titles.map(title => '《' + title + '》').join('、')
    : '（当前歌单为空）';
  const requiredCandidates = sourceError
    ? '（' + sourceError + '。本轮不要输出 BGM 标记，继续正常生成正文。）'
    : sourceContext.mode === 'netease_playlist' && sourceContext.playlistId
      ? sourceContext.candidates.length
        ? [
            '本轮只能从网易云歌单 ' + sourceContext.playlistId + ' 的以下候选歌曲中选择：',
            ...sourceContext.candidates.map(
              track => '- ' + track.name + '-' + track.artist.join('、'),
            ),
          ].join('\n')
        : '（指定歌单中没有可用候选歌曲。）'
      : '';
  const values: PromptTemplateValues = {
    current_bgm_playlist: currentPlaylist,
    required_candidates: requiredCandidates,
    playlist_id: sourceContext.playlistId ?? '（无）',
    current_ambient_location: getAmbientLocationFromTitle(currentAmbientTitle) || '（无）',
    current_ambient_title: currentAmbientTitle || '（当前没有正在播放的环境音）',
  };
  const promptContent = ['<杠杠の调音台>'];

  if (includeBgmPrompt) {
    const bgmSections: Array<[string, string]> = [
      ['注入位置', renderPromptTemplate(bgmSettingsStore.settings.bgm_injection_location, values)],
      ['选曲要求', renderPromptTemplate(bgmSettingsStore.settings.bgm_prompt_content, values)],
      [
        '禁选列表',
        renderDynamicPromptSection(
          bgmSettingsStore.settings.bgm_forbidden_list_prompt,
          'current_bgm_playlist',
          currentPlaylist,
          values,
        ),
      ],
      [
        '必选列表',
        renderDynamicPromptSection(
          bgmSettingsStore.settings.bgm_required_list_prompt,
          'required_candidates',
          requiredCandidates,
          values,
        ),
      ],
    ];
    promptContent.push('【模块一：BGM】');
    for (const [title, section] of bgmSections) {
      promptContent.push('【' + title + '】', section.trim());
    }
  }

  if (isAmbientEnabled()) {
    promptContent.push(
      '【模块二：环境音】',
      '【环境音要求】',
      renderPromptTemplate(bgmSettingsStore.settings.ambient_prompt_content, values).trim(),
    );
  }

  promptContent.push('</杠杠の调音台>');
  return promptContent.join('\n');
}

function getConfiguredBgmSourceContext(): BgmSourceContext {
  const mode = bgmSettingsStore.settings.source_mode;
  if (mode === 'random') return { mode, playlistId: null, candidates: [] };

  const playlistId = bgmSettingsStore.settings.playlist_id.trim() || null;
  return {
    mode,
    playlistId,
    candidates: playlistId
      ? getNeteaseCandidatesForGeneration(playlistId, bgmSettingsStore.settings.playlist_sample_count)
      : [],
  };
}

let generationId = 0;
let activeScanner: MarkerScanner | null = null;
let activeMusicGenerationId = 0;
let activeGenerationSourceContext: BgmSourceContext | null = null;
let ambientGenerationId = 0;
let activeAmbientScanner: AmbientMarkerScanner | null = null;
let activeAmbientGenerationId = 0;
let activeAmbientRequestController: AbortController | null = null;
let bgmPromptCadenceState: BgmPromptCadenceState = createBgmPromptCadenceState(
  bgmSettingsStore.settings.bgm_prompt_interval,
);
let normalAssistantFloorCount = bgmPromptCadenceState.completedCount;

type PendingSwipeTarget = {
  chatId: string;
  messageId: number;
  messageRef: object;
};

let pendingSwipeTarget: PendingSwipeTarget | null = null;
const floorDecisions = new BgmMessageIdentityStore<BgmPromptFloorDecision>();

type PendingBgmPromptDecision = BgmPromptFloorDecision & BgmPromptGenerationLifecycle & {
  runtimeStarted: boolean;
  sourceError: string | null;
  injectionSucceeded: boolean;
  generationType: 'normal' | 'swipe';
  expectedMessageId: number | null;
  startChatLength: number;
  startTailRef: object | null;
  abortSignal?: AbortSignal;
};

let pendingBgmPromptDecision: PendingBgmPromptDecision | null = null;
let lastSettledBgmGeneration: { generationType: 'normal' | 'swipe'; messageId: number } | null = null;
type SkippedSwipeLifecycle = BgmPromptSkippedSwipeLifecycle & { audit: BgmPromptSwipeAudit };
let skippedSwipeLifecycle: SkippedSwipeLifecycle | null = null;

type RuntimeAudit = {
  run_id: number;
  generation: {
    status: 'pending' | 'success' | 'fail';
    id: number;
    source_mode: BgmSourceMode;
    playlist_id: string | null;
  };
  marker: {
    status: 'pending' | 'success' | 'fail';
    matched: boolean;
    song: string | null;
    singer: string | null;
    error: string | null;
  };
  stream_finished: { status: 'pending' | 'success' | 'fail'; message_id: number | null; error: string | null };
  music_lookup: {
    status: 'pending' | 'success' | 'fail';
    source: 'joox' | null;
    query: string | null;
    track_id: string | null;
    error: string | null;
  };
  playlist: {
    status: 'pending' | 'success' | 'fail';
    before_count: number;
    removed_count: number;
    after_count: number;
    error: string | null;
  };
  playlist_prompt: {
    status: 'pending' | 'success' | 'fail';
    id: string;
    count: number;
    titles: string[];
    source_mode: BgmSourceMode;
    playlist_id: string | null;
    candidate_count: number;
    reason: 'generation_after_commands' | 'settings_changed' | null;
    interval: number;
    bgm_prompt_included: boolean;
    skipped_count: number;
    completed_count: number;
    assistant_floor_count: number;
    swipe_enabled: boolean;
    swipe_message_id: number | null;
    swipe_eligible: boolean | null;
    swipe_started: boolean;
    swipe_skipped: boolean;
    decision: 'inject' | 'skip' | 'disabled' | 'error' | null;
    cadence_reason: string | null;
    error: string | null;
  };
  ambient: {
    status: 'pending' | 'success' | 'fail' | 'skipped';
    matched: boolean;
    location: string | null;
    current_location: string | null;
    search_attempts: number;
    source: 'search' | 'fallback' | null;
    bvid: string | null;
    error: string | null;
  };
  audio_played: { status: 'pending' | 'success' | 'fail'; error: string | null };
  prompt_injection: {
    status: 'pending' | 'success' | 'fail';
    id: string;
    scope: 'current_chat';
    reason: 'script_loaded' | 'chat_changed' | 'settings_changed' | 'generation_after_commands' | null;
    error: string | null;
  };
  last_error: string | null;
};

const runtimeAudit: RuntimeAudit = {
  run_id: 0,
  generation: { status: 'pending', id: 0, source_mode: 'random', playlist_id: null },
  marker: { status: 'pending', matched: false, song: null, singer: null, error: null },
  stream_finished: { status: 'pending', message_id: null, error: null },
  music_lookup: { status: 'pending', source: null, query: null, track_id: null, error: null },
  playlist: { status: 'pending', before_count: 0, removed_count: 0, after_count: 0, error: null },
  playlist_prompt: {
    status: 'pending',
    id: bgmPlaylistPromptId,
    count: 0,
    titles: [],
    source_mode: 'random',
    playlist_id: null,
    candidate_count: 0,
    reason: null,
    interval: normalizeBgmPromptInterval(bgmSettingsStore.settings.bgm_prompt_interval),
    bgm_prompt_included: false,
    skipped_count: 0,
    completed_count: 0,
    assistant_floor_count: 0,
    swipe_enabled: bgmSettingsStore.settings.generate_on_swipe,
    swipe_message_id: null,
    swipe_eligible: null,
    swipe_started: false,
    swipe_skipped: false,
    decision: null,
    cadence_reason: null,
    error: null,
  },
  ambient: {
    status: 'skipped',
    matched: false,
    location: null,
    current_location: null,
    search_attempts: 0,
    source: null,
    bvid: null,
    error: null,
  },
  audio_played: { status: 'pending', error: null },
  prompt_injection: {
    status: 'pending',
    id: bgmPlaylistPromptId,
    scope: 'current_chat',
    reason: null,
    error: null,
  },
  last_error: null,
};
(globalThis as typeof globalThis & { __ganggangConsoleAudit?: RuntimeAudit }).__ganggangConsoleAudit = runtimeAudit;

type BgmPromptRuntimeState = { uninject?: () => void; uninjectPlaylist?: () => void };
const bgmPromptRuntime = ((
  globalThis as typeof globalThis & { __ganggangConsolePromptRuntime?: BgmPromptRuntimeState }
).__ganggangConsolePromptRuntime ??= {});

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rawMessageRef(messageId: number): object | null {
  const message = SillyTavern.chat[messageId];
  return typeof message === 'object' && message !== null ? message : null;
}

function currentChatId(): string {
  return SillyTavern.getCurrentChatId();
}

function updateSwipePromptAudit(patch: Partial<Pick<RuntimeAudit['playlist_prompt'],
  'swipe_enabled' | 'swipe_message_id' | 'swipe_eligible' | 'swipe_started' | 'swipe_skipped'>>) {
  runtimeAudit.playlist_prompt = {
    ...runtimeAudit.playlist_prompt,
    ...patch,
  };
}

function snapshotSwipePromptAudit(): BgmPromptSwipeAudit {
  const { swipe_enabled, swipe_message_id, swipe_eligible, swipe_started, swipe_skipped } = runtimeAudit.playlist_prompt;
  return { swipe_enabled, swipe_message_id, swipe_eligible, swipe_started, swipe_skipped };
}

function clearSkippedSwipeLifecycle() {
  skippedSwipeLifecycle = null;
}

function rememberSkippedSwipeLifecycle(
  firstEvent: BgmPromptSkippedSwipeEvent,
  messageId: number | null = runtimeAudit.playlist_prompt.swipe_message_id,
) {
  skippedSwipeLifecycle = {
    ...createBgmPromptSkippedSwipeLifecycle(firstEvent, messageId),
    audit: snapshotSwipePromptAudit(),
  };
}

function updatePlaylistPromptAudit(patch: Partial<RuntimeAudit['playlist_prompt']>) {
  runtimeAudit.playlist_prompt = { ...runtimeAudit.playlist_prompt, ...patch };
}

function isBgmEnabled() {
  return bgmSettingsStore.settings.module_enabled.bgm;
}

function isAmbientEnabled() {
  return bgmSettingsStore.settings.module_enabled.ambient;
}

function isAnyAudioEnabled() {
  return isBgmEnabled() || isAmbientEnabled();
}

function clearBgmPromptInjections() {
  bgmPromptRuntime.uninject?.();
  bgmPromptRuntime.uninjectPlaylist?.();
  uninjectPrompts([bgmPromptId, bgmPlaylistPromptId]);
  bgmPromptRuntime.uninject = undefined;
  bgmPromptRuntime.uninjectPlaylist = undefined;
}

type BgmPlaylistPromptInstallResult = {
  bgmPromptIncluded: boolean;
  sourceError: string | null;
  injectionSucceeded: boolean;
};

function installCurrentBgmPlaylistPrompt(
  cadenceDecision: BgmPromptCadenceDecision = decideBgmPromptCadence(bgmPromptCadenceState),
  allowBgmPrompt = true,
  preservedSwipeAudit?: Partial<BgmPromptSwipeAudit>,
): BgmPlaylistPromptInstallResult {
  let titles: string[] = [];
  const bgmPromptIncluded = isBgmEnabled() && allowBgmPrompt && cadenceDecision.bgmPromptIncluded;
  const sourceMode = activeGenerationSourceContext?.mode ?? bgmSettingsStore.settings.source_mode;
  let sourceContext: BgmSourceContext = {
    mode: sourceMode,
    playlistId: null,
    candidates: [],
  };
  let sourceError: string | null = null;
  runtimeAudit.playlist_prompt = mergeBgmPromptSwipeAudit({
    status: 'pending',
    id: bgmPlaylistPromptId,
    count: 0,
    titles: [],
    source_mode: sourceMode,
    playlist_id: null,
    candidate_count: 0,
    reason: 'generation_after_commands',
    interval: cadenceDecision.interval,
    bgm_prompt_included: bgmPromptIncluded,
    skipped_count: cadenceDecision.skippedCount,
    completed_count: cadenceDecision.completedCount,
    assistant_floor_count: normalAssistantFloorCount,
    swipe_enabled: bgmSettingsStore.settings.generate_on_swipe,
    swipe_message_id: null,
    swipe_eligible: null,
    swipe_started: false,
    swipe_skipped: false,
    decision: !isBgmEnabled() ? 'disabled' : allowBgmPrompt ? cadenceDecision.decision : 'skip',
    cadence_reason: !isBgmEnabled()
      ? 'bgm_disabled'
      : allowBgmPrompt
        ? cadenceDecision.reason
        : 'non_bgm_generation',
    error: null,
  }, preservedSwipeAudit);

  if (!isAnyAudioEnabled()) {
    clearBgmPromptInjections();
    updatePlaylistPromptAudit({ status: 'success', count: 0, titles: [], error: null });
    return { bgmPromptIncluded: false, sourceError: null, injectionSucceeded: true };
  }

  try {
    clearBgmPromptInjections();
    titles = bgmPromptIncluded ? getCurrentBgmTitles() : [];
    if (bgmPromptIncluded) {
      sourceContext = activeGenerationSourceContext ?? getConfiguredBgmSourceContext();
      activeGenerationSourceContext = sourceContext;
      if (sourceContext.mode === 'netease_playlist' && sourceContext.candidates.length === 0) {
        sourceError = sourceContext.playlistId
          ? `网易云歌单 ${sourceContext.playlistId} 尚未加载成功`
          : '尚未指定网易云歌单 ID';
      }
    }
    const currentAmbientTitle = isAmbientEnabled() ? getCurrentAmbientTitle() : '';
    const content = createAudioPromptContent(
      titles,
      sourceContext,
      sourceError,
      currentAmbientTitle,
      bgmPromptIncluded,
    );
    bgmPromptRuntime.uninjectPlaylist = injectPrompts(
      [
        {
          id: bgmPlaylistPromptId,
          position: 'in_chat',
          depth: 0,
          role: 'system',
          should_scan: false,
          content,
        },
      ],
      { once: true },
    ).uninject;
    runtimeAudit.prompt_injection = {
      status: sourceError ? 'fail' : 'success',
      id: bgmPlaylistPromptId,
      scope: 'current_chat',
      reason: 'generation_after_commands',
      error: sourceError,
    };
    updatePlaylistPromptAudit({
      status: sourceError ? 'fail' : 'success',
      count: titles.length,
      titles,
      source_mode: sourceContext.mode,
      playlist_id: sourceContext.playlistId,
      candidate_count: sourceContext.candidates.length,
      cadence_reason: sourceError ? 'source_error' : runtimeAudit.playlist_prompt.cadence_reason,
      error: sourceError,
    });
    if (sourceError) {
      runtimeAudit.last_error = sourceError;
      debugWarn('<杠杠-BGM> 指定网易云歌单不可用，本轮不会回退到完全随机', {
        playlistId: sourceContext.playlistId,
        sourceError,
      });
    } else {
      debugInfo('<杠杠-BGM> 已注入调音台四段 BGM 提示', {
        count: titles.length,
        titles,
        sourceMode: sourceContext.mode,
        playlistId: sourceContext.playlistId,
        candidateCount: sourceContext.candidates.length,
      });
    }
    return { bgmPromptIncluded, sourceError, injectionSucceeded: true };
  } catch (error) {
    const message = errorText(error);
    updatePlaylistPromptAudit({
      status: 'fail',
      count: titles.length,
      titles,
      source_mode: sourceContext.mode,
      playlist_id: sourceContext.playlistId,
      candidate_count: sourceContext.candidates.length,
      decision: 'error',
      cadence_reason: 'injection_error',
      error: message,
    });
    runtimeAudit.prompt_injection = {
      status: 'fail',
      id: bgmPlaylistPromptId,
      scope: 'current_chat',
      reason: 'generation_after_commands',
      error: message,
    };
    runtimeAudit.last_error = message;
    debugWarn('<杠杠-BGM> 当前歌单排重提示注入失败', { message });
    return { bgmPromptIncluded, sourceError: null, injectionSucceeded: false };
  }
}

function isCurrentMusicGeneration(runId: number) {
  return runId === activeMusicGenerationId;
}

const BGM_FADE_DURATION_MS = 1_000;
const BGM_FADE_STEP_MS = 100;
const AUDIO_PLAYBACK_CHECK_INTERVAL_MS = 100;
const AUDIO_PLAYBACK_CHECK_TIMEOUT_MS = 2_000;
const JOOX_REQUEST_TIMEOUT_MS = 8_000;
let bgmTransitionId = 0;
let bgmTransitionTargetVolume: number | null = null;

function clampAudioVolume(volume: number) {
  return Math.max(0, Math.min(100, Math.round(volume)));
}

function cancelBgmTransition() {
  bgmTransitionId += 1;
  const targetVolume = bgmTransitionTargetVolume;
  bgmTransitionTargetVolume = null;
  if (targetVolume === null) return;
  try {
    setAudioSettings('bgm', { volume: targetVolume });
  } catch (error) {
    debugWarn('<杠杠-BGM> 恢复 BGM 音量失败', { message: errorText(error) });
  }
}

function resetBgmPromptCadence() {
  bgmPromptCadenceState = createBgmPromptCadenceState(bgmSettingsStore.settings.bgm_prompt_interval);
  normalAssistantFloorCount = 0;
  floorDecisions.reset();
  updatePlaylistPromptAudit({
    interval: bgmPromptCadenceState.interval,
    skipped_count: 0,
    completed_count: 0,
    assistant_floor_count: 0,
  });
}

function resetBgmGeneration(preservePending = false) {
  activeMusicGenerationId = 0;
  activeScanner = null;
  activeGenerationSourceContext = null;
  if (!preservePending && pendingBgmPromptDecision) {
    Object.assign(pendingBgmPromptDecision, markBgmPromptGenerationAborted(pendingBgmPromptDecision));
  }
  if (!preservePending) pendingBgmPromptDecision = null;
  if (!preservePending) lastSettledBgmGeneration = null;
  if (!preservePending) clearSkippedSwipeLifecycle();
  cancelBgmTransition();
}

function abortActiveAmbientRequest() {
  activeAmbientRequestController?.abort();
  activeAmbientRequestController = null;
}

function resetAmbientGeneration() {
  activeAmbientGenerationId = 0;
  activeAmbientScanner = null;
  abortActiveAmbientRequest();
}

function resetAudioGenerationState() {
  resetBgmGeneration();
  resetAmbientGeneration();
}

function waitForBgmFadeStep() {
  return new Promise<void>(resolve => window.setTimeout(resolve, BGM_FADE_STEP_MS));
}

function waitForAudioPlaybackCheckStep() {
  return new Promise<void>(resolve => window.setTimeout(resolve, AUDIO_PLAYBACK_CHECK_INTERVAL_MS));
}

function assertBgmPlayback(audio: Audio) {
  const current = getCurrentAudio('bgm');
  const isTargetAudio = current.src === audio.url || current.title === audio.title;
  if (current.playing && isTargetAudio) return current;

  throw new Error('BGM 未确认开始播放');
}

async function waitForBgmPlaybackCheck(runId: number, audio: Audio) {
  const deadline = Date.now() + AUDIO_PLAYBACK_CHECK_TIMEOUT_MS;
  while (isCurrentMusicGeneration(runId) && Date.now() < deadline) {
    try {
      return assertBgmPlayback(audio);
    } catch {
      await waitForAudioPlaybackCheckStep();
    }
  }
  if (!isCurrentMusicGeneration(runId)) return null;
  return assertBgmPlayback(audio);
}

async function fetchJooxJson(endpoint: string, errorLabel: string): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, JOOX_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) throw new Error(`${errorLabel}请求失败 (${response.status})`);
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error(`${errorLabel}请求超时（8 秒）`, { cause: error });
    throw new Error(errorText(error), { cause: error });
  } finally {
    window.clearTimeout(timer);
  }
}

async function fadeBgmVolume(runId: number, transitionId: number, from: number, to: number) {
  const steps = Math.max(1, Math.ceil(BGM_FADE_DURATION_MS / BGM_FADE_STEP_MS));
  for (let step = 0; step <= steps; step += 1) {
    if (!isCurrentMusicGeneration(runId) || transitionId !== bgmTransitionId) return false;
    const progress = step / steps;
    const volume = clampAudioVolume(from + (to - from) * progress);
    setAudioSettings('bgm', { volume });
    if (step < steps) await waitForBgmFadeStep();
  }
  return true;
}

async function playBgmAudioWithFade(runId: number, audio: Audio) {
  cancelBgmTransition();
  if (!isCurrentMusicGeneration(runId)) return null;

  const currentAudio = getCurrentAudio('bgm');
  const targetVolume = clampAudioVolume(getAudioSettings('bgm').volume);
  if (!currentAudio.playing) {
    const playlist = maintainBgmPlaylist(audio);
    playAudio('bgm', audio);
    const playback = await waitForBgmPlaybackCheck(runId, audio);
    if (!playback || !isCurrentMusicGeneration(runId)) return null;
    return playlist;
  }

  const transitionId = bgmTransitionId;
  bgmTransitionTargetVolume = targetVolume;
  try {
    const fadedOut = await fadeBgmVolume(runId, transitionId, targetVolume, 0);
    if (!fadedOut || !isCurrentMusicGeneration(runId)) return null;

    const playlist = maintainBgmPlaylist(audio);
    setAudioSettings('bgm', { volume: targetVolume });
    playAudio('bgm', audio);
    const playback = await waitForBgmPlaybackCheck(runId, audio);
    if (!playback || !isCurrentMusicGeneration(runId)) return null;
    return playlist;
  } finally {
    if (transitionId === bgmTransitionId) {
      bgmTransitionTargetVolume = null;
      setAudioSettings('bgm', { volume: targetVolume });
    }
  }
}

function pauseAudioSafely(type: 'bgm' | 'ambient') {
  try {
    pauseAudio(type);
  } catch (error) {
    const moduleName = type === 'bgm' ? 'BGM' : '环境音';
    debugWarn(`<杠杠-${moduleName}> 暂停失败音频时出错`, { message: errorText(error) });
  }
}

function pauseFailedBgmPlayback() {
  pauseAudioSafely('bgm');
  cancelBgmTransition();
}

async function searchAndPlayBgm(runId: number, song: string, singer: string, sourceContext: BgmSourceContext) {
  const musicSource = 'joox' as const;
  const query = createMusicSearchQuery(song, singer);
  if (isCurrentMusicGeneration(runId)) {
    runtimeAudit.music_lookup = { status: 'pending', source: musicSource, query, track_id: null, error: null };
    runtimeAudit.audio_played = { status: 'pending', error: null };
  }

  let trackId: string | null = null;
  let urlResolved = false;
  let playlistState = { before_count: 0, removed_count: 0, after_count: 0 };

  try {
    const searchData = await fetchJooxJson(
      'https://music-api.gdstudio.xyz/api.php?types=search&source=joox&name=' + encodeURIComponent(query) + '&count=5',
      'JOOX 搜歌',
    );

    const firstTrack = Array.isArray(searchData) ? searchData[0] : undefined;
    const rawTrackId = firstTrack && typeof firstTrack === 'object' ? (firstTrack as { id?: unknown }).id : undefined;
    if (typeof rawTrackId !== 'string' && typeof rawTrackId !== 'number') {
      throw new Error('没有搜到可播放的歌曲');
    }
    trackId = String(rawTrackId);

    if (!isCurrentMusicGeneration(runId)) return;
    if (!trackId) throw new Error('没有可用的 JOOX 歌曲 id');

    const urlData = await fetchJooxJson(
      `https://music-api.gdstudio.xyz/api.php?types=url&source=${musicSource}&id=${encodeURIComponent(trackId)}&br=320`,
      'JOOX 歌曲 URL',
    );
    const audioUrl =
      urlData && typeof urlData === 'object' && typeof (urlData as { url?: unknown }).url === 'string'
        ? (urlData as { url: string }).url
        : '';
    if (!audioUrl) throw new Error('歌曲没有可用 URL');
    urlResolved = true;

    if (!isCurrentMusicGeneration(runId)) return;
    runtimeAudit.music_lookup = { status: 'success', source: musicSource, query, track_id: trackId, error: null };

    const title = `${song} - ${singer}`;
    const playlist = await playBgmAudioWithFade(runId, { title, url: audioUrl });
    if (!playlist || !isCurrentMusicGeneration(runId)) return;
    playlistState = {
      before_count: playlist.beforeCount,
      removed_count: playlist.removedCount,
      after_count: playlist.afterCount,
    };
    runtimeAudit.playlist = { status: 'success', ...playlistState, error: null };
    runtimeAudit.music_lookup = { status: 'success', source: musicSource, query, track_id: trackId, error: null };
    runtimeAudit.audio_played = { status: 'success', error: null };
    debugInfo('<杠杠-BGM> 匹配 JOOX 音源并开始播放', {
      generationId: runId,
      source: musicSource,
      playlistId: sourceContext.playlistId,
      song,
      singer,
      trackId,
    });
  } catch (error) {
    if (!isCurrentMusicGeneration(runId)) return;

    const message = errorText(error);
    pauseFailedBgmPlayback();
    if (!urlResolved) {
      runtimeAudit.music_lookup = { status: 'fail', source: musicSource, query, track_id: trackId, error: message };
    }
    runtimeAudit.playlist = { status: 'fail', ...playlistState, error: message };
    runtimeAudit.audio_played = { status: 'fail', error: message };
    runtimeAudit.last_error = message;
    debugWarn('<杠杠-BGM> 搜歌或播放失败，跳过本轮 BGM', { generationId: runId, message });
  }
}

function isCurrentAmbientGeneration(runId: number) {
  return runId === activeAmbientGenerationId;
}

function getCurrentAmbientState() {
  const currentAudio = getCurrentAudio('ambient');
  const title = typeof currentAudio.title === 'string' ? currentAudio.title.trim() : '';
  return {
    title,
    src: typeof currentAudio.src === 'string' ? currentAudio.src : '',
    playing: currentAudio.playing === true,
    location: getAmbientLocationFromTitle(title),
  };
}

function normalizeAmbientLocation(location: string) {
  return location.trim().replace(/\s+/g, ' ');
}

function markAmbientReused(runId: number, action: AmbientAction, current: ReturnType<typeof getCurrentAmbientState>) {
  runtimeAudit.ambient = {
    ...runtimeAudit.ambient,
    status: 'success',
    matched: true,
    location: action.location,
    current_location: current.location || null,
    error: null,
  };
  debugInfo('<杠杠-环境音> 地点未变化，沿用当前环境音', {
    generationId: runId,
    location: action.location,
  });
}

function assertAmbientPlayback(audio: Audio) {
  const current = getCurrentAmbientState();
  const isTargetAudio = current.src === audio.url || current.title === audio.title;
  if (current.playing && isTargetAudio) return current;

  const settings = getAudioSettings('ambient');
  throw new Error(
    `环境音未开始播放（enabled=${settings.enabled}, muted=${settings.muted}, volume=${settings.volume}）`,
  );
}

async function waitForAmbientPlaybackCheck(runId: number, audio: Audio) {
  const deadline = Date.now() + AUDIO_PLAYBACK_CHECK_TIMEOUT_MS;
  while (isCurrentAmbientGeneration(runId) && Date.now() < deadline) {
    try {
      return assertAmbientPlayback(audio);
    } catch {
      await waitForAudioPlaybackCheckStep();
    }
  }
  if (!isCurrentAmbientGeneration(runId)) return null;
  return assertAmbientPlayback(audio);
}

async function resumeCurrentAmbient(
  runId: number,
  action: AmbientAction,
  current: ReturnType<typeof getCurrentAmbientState>,
) {
  if (!current.src || !isCurrentAmbientGeneration(runId)) return false;

  try {
    playAudio('ambient', { title: current.title || action.title, url: current.src });
    const resumed = await waitForAmbientPlaybackCheck(runId, {
      title: current.title || action.title,
      url: current.src,
    });
    if (!resumed || !isCurrentAmbientGeneration(runId)) return true;
    markAmbientReused(runId, action, resumed);
    return true;
  } catch (error) {
    if (isCurrentAmbientGeneration(runId)) {
      pauseAudioSafely('ambient');
      debugWarn('<杠杠-环境音> 当前音频恢复播放失败，将重新搜索', {
        generationId: runId,
        location: action.location,
        message: errorText(error),
      });
    }
    return false;
  }
}

async function searchAndPlayAmbient(runId: number, action: AmbientAction) {
  if (!isCurrentAmbientGeneration(runId)) return;

  const fallbackBvids = bgmSettingsStore.settings.ambient_fallback_bv_ids;
  abortActiveAmbientRequest();
  const requestController = new AbortController();
  activeAmbientRequestController = requestController;
  const isActiveRequest = () =>
    isCurrentAmbientGeneration(runId) &&
    activeAmbientRequestController === requestController &&
    !requestController.signal.aborted;

  try {
    const resolveOptions = {
      signal: requestController.signal,
      shouldContinue: isActiveRequest,
      onSearchAttempt: (attempt: number, query: string) => {
        if (!isActiveRequest()) return;
        runtimeAudit.ambient.search_attempts = attempt;
        debugInfo('<杠杠-环境音> 搜索 B站环境音', { generationId: runId, attempt, query });
      },
    };
    const result = await resolveBilibiliAmbientAudio(action.location, fallbackBvids, resolveOptions);
    if (!isActiveRequest()) return;

    const latestCurrent = getCurrentAmbientState();
    if (
      latestCurrent.playing &&
      normalizeAmbientLocation(latestCurrent.location) === normalizeAmbientLocation(action.location)
    ) {
      markAmbientReused(runId, action, latestCurrent);
      return;
    }

    const audio = {
      title: action.title,
      url: `https://music-proxy.gdstudio.org/${result.url}`,
    };
    replaceAudioList('ambient', [audio]);
    playAudio('ambient', audio);
    const playbackState = await waitForAmbientPlaybackCheck(runId, audio);
    if (!playbackState || !isActiveRequest()) return;
    runtimeAudit.ambient = {
      ...runtimeAudit.ambient,
      status: 'success',
      matched: true,
      location: action.location,
      current_location: playbackState.location || null,
      source: result.source,
      bvid: result.bvid,
      error: null,
    };
    debugInfo('<杠杠-环境音> 匹配 B站音源并开始播放', {
      generationId: runId,
      location: action.location,
      source: result.source,
      bvid: result.bvid,
    });
  } catch (error) {
    if (!isActiveRequest()) return;
    const message = errorText(error);
    pauseAudioSafely('ambient');
    runtimeAudit.ambient = {
      ...runtimeAudit.ambient,
      status: 'fail',
      error: message,
    };
    runtimeAudit.last_error = message;
    debugWarn('<杠杠-环境音> 搜索或播放失败', { generationId: runId, location: action.location, message });
  } finally {
    if (activeAmbientRequestController === requestController) activeAmbientRequestController = null;
  }
}

function handleAmbientAction(runId: number, action: AmbientAction) {
  if (!isCurrentAmbientGeneration(runId)) return;

  const current = getCurrentAmbientState();
  runtimeAudit.ambient = {
    status: 'pending',
    matched: true,
    location: action.location,
    current_location: current.location || null,
    search_attempts: 0,
    source: null,
    bvid: null,
    error: null,
  };

  if (normalizeAmbientLocation(current.location) === normalizeAmbientLocation(action.location)) {
    if (current.playing) {
      markAmbientReused(runId, action, current);
      return;
    }

    void resumeCurrentAmbient(runId, action, current).then(resumed => {
      if (!resumed && isCurrentAmbientGeneration(runId)) void searchAndPlayAmbient(runId, action);
    });
    return;
  }

  void searchAndPlayAmbient(runId, action);
}

function startGeneration() {
  if (!isBgmEnabled() || !pendingBgmPromptDecision?.bgmPromptIncluded) return;
  generationId += 1;
  const currentGenerationId = generationId;
  const currentSourceContext = activeGenerationSourceContext ?? getConfiguredBgmSourceContext();
  activeGenerationSourceContext = currentSourceContext;
  activeMusicGenerationId = currentGenerationId;
  runtimeAudit.run_id = currentGenerationId;
  runtimeAudit.generation = {
    status: 'success',
    id: currentGenerationId,
    source_mode: currentSourceContext.mode,
    playlist_id: currentSourceContext.playlistId,
  };
  runtimeAudit.marker = { status: 'pending', matched: false, song: null, singer: null, error: null };
  runtimeAudit.stream_finished = { status: 'pending', message_id: null, error: null };
  runtimeAudit.music_lookup = {
    status: 'pending',
    source: 'joox',
    query: null,
    track_id: null,
    error: null,
  };
  runtimeAudit.playlist = { status: 'pending', before_count: 0, removed_count: 0, after_count: 0, error: null };
  runtimeAudit.audio_played = { status: 'pending', error: null };
  runtimeAudit.last_error = null;
  activeScanner = createMarkerScanner(currentGenerationId, action => {
    debugInfo('<杠杠-BGM> marker resolved', { generationId: currentGenerationId, action });
    runtimeAudit.marker = {
      status: 'success',
      matched: action.type !== 'none',
      song: action.song ?? null,
      singer: action.singer ?? null,
      error: null,
    };
    if (action.type === 'play' && action.song && action.singer) {
      void searchAndPlayBgm(currentGenerationId, action.song, action.singer, currentSourceContext);
    }
    if (action.type === 'stop') {
      activeMusicGenerationId = 0;
      cancelBgmTransition();
      pauseAudio('bgm');
    }
  });
  debugInfo(`<杠杠-BGM> generation started #${currentGenerationId}`);
}

function startSkippedGeneration() {
  if (!isBgmEnabled() || !pendingBgmPromptDecision || pendingBgmPromptDecision.bgmPromptIncluded) return;
  generationId += 1;
  const currentGenerationId = generationId;
  activeMusicGenerationId = 0;
  activeScanner = null;
  activeGenerationSourceContext = null;
  runtimeAudit.run_id = currentGenerationId;
  runtimeAudit.generation = {
    status: 'success',
    id: currentGenerationId,
    source_mode: bgmSettingsStore.settings.source_mode,
    playlist_id: null,
  };
  runtimeAudit.marker = { status: 'success', matched: false, song: null, singer: null, error: null };
  runtimeAudit.stream_finished = { status: 'pending', message_id: null, error: null };
  runtimeAudit.music_lookup = { status: 'pending', source: null, query: null, track_id: null, error: null };
  runtimeAudit.playlist = { status: 'pending', before_count: 0, removed_count: 0, after_count: 0, error: null };
  runtimeAudit.audio_played = { status: 'pending', error: null };
  runtimeAudit.last_error = null;
  debugInfo(`<杠杠-BGM> skipped BGM generation started #${currentGenerationId}`);
}

function startAmbientGeneration() {
  if (!isAmbientEnabled()) return;
  abortActiveAmbientRequest();
  ambientGenerationId += 1;
  const currentAmbientGenerationId = ambientGenerationId;
  activeAmbientGenerationId = currentAmbientGenerationId;
  const currentLocation = getCurrentAmbientState().location;
  runtimeAudit.ambient = {
    status: 'pending',
    matched: false,
    location: null,
    current_location: currentLocation || null,
    search_attempts: 0,
    source: null,
    bvid: null,
    error: null,
  };
  activeAmbientScanner = createAmbientMarkerScanner(currentAmbientGenerationId, action => {
    debugInfo('<杠杠-环境音> marker resolved', { generationId: currentAmbientGenerationId, action });
    handleAmbientAction(currentAmbientGenerationId, action);
  });
  debugInfo(`<杠杠-环境音> generation started #${currentAmbientGenerationId}`);
}

function getCurrentBgmPromptCadenceDecision(floorCount = normalAssistantFloorCount + 1) {
  const interval = normalizeBgmPromptInterval(bgmSettingsStore.settings.bgm_prompt_interval);
  if (bgmPromptCadenceState.interval !== interval) {
    bgmPromptCadenceState = updateBgmPromptCadenceInterval(bgmPromptCadenceState, interval);
  }
  return decideBgmPromptCadenceAtFloor(bgmPromptCadenceState, floorCount);
}

function inspectPendingSwipeTarget() {
  const target = pendingSwipeTarget;
  if (!target || target.chatId !== currentChatId() || rawMessageRef(target.messageId) !== target.messageRef) return null;
  const message = getChatMessages(target.messageId)[0];
  if (message?.role !== 'assistant') return null;
  return { target, decision: floorDecisions.get(target.messageRef) };
}

function consumePendingSwipeTarget(type: string) {
  const inspected = inspectPendingSwipeTarget();
  pendingSwipeTarget = null;
  if (type !== 'swipe') return null;
  if (inspected) return inspected;

  // Match the image-machine fallback: when host event order does not leave a
  // pending MESSAGE_SWIPED target, the current assistant tail is the Swipe
  // source. Its raw object identity still carries the original floor decision.
  const messageId = getLastMessageId();
  const messageRef = messageId >= 0 ? rawMessageRef(messageId) : null;
  const message = messageId >= 0 ? getChatMessages(messageId)[0] : undefined;
  if (!messageRef || message?.role !== 'assistant') return null;
  return {
    target: { chatId: currentChatId(), messageId, messageRef },
    decision: floorDecisions.get(messageRef),
  };
}

function updateSwipeAuditFromPendingTarget() {
  const inspected = inspectPendingSwipeTarget();
  updateSwipePromptAudit({
    swipe_enabled: bgmSettingsStore.settings.generate_on_swipe,
    swipe_message_id: inspected?.target.messageId ?? null,
    swipe_eligible: inspected?.decision?.bgmPromptIncluded ?? false,
    swipe_started: false,
    swipe_skipped: true,
  });
  return inspected;
}

function abortPendingBgmGeneration() {
  if (pendingBgmPromptDecision) {
    Object.assign(pendingBgmPromptDecision, markBgmPromptGenerationAborted(pendingBgmPromptDecision));
  }
  pendingBgmPromptDecision = null;
  lastSettledBgmGeneration = null;
  clearSkippedSwipeLifecycle();
  activeScanner = null;
  activeMusicGenerationId = 0;
  activeGenerationSourceContext = null;
  cancelBgmTransition();
}

function bindBgmGenerationAbort(pending: PendingBgmPromptDecision, signal: AbortSignal | undefined) {
  if (!signal) return;
  pending.abortSignal = signal;
  if (signal.aborted) {
    if (pendingBgmPromptDecision === pending) abortPendingBgmGeneration();
    return;
  }
  signal.addEventListener(
    'abort',
    () => {
      if (pendingBgmPromptDecision === pending) {
        debugInfo('<杠杠-BGM> 生成 signal 已中止，不结算当前 normal 楼', { generationType: pending.generationType });
        abortPendingBgmGeneration();
      }
    },
    { once: true },
  );
}

function createPendingBgmGeneration(
  type: 'normal' | 'swipe',
  signal?: AbortSignal,
  lifecycleEvent: BgmPromptSkippedSwipeEvent = 'after_commands',
): PendingBgmPromptDecision | null {
  if (type === 'swipe' && skippedSwipeLifecycle) {
    const current = skippedSwipeLifecycle;
    const advanced = advanceBgmPromptSkippedSwipeLifecycle(current, lifecycleEvent);
    skippedSwipeLifecycle = { ...advanced.state, audit: current.audit };
    updateSwipePromptAudit(current.audit);
    return null;
  }
  if (!isBgmEnabled()) return null;
  const swipe = consumePendingSwipeTarget(type);
  let floorDecision: BgmPromptFloorDecision | undefined;
  let expectedMessageId: number | null = null;
  if (type === 'normal') {
    floorDecision = decideBgmPromptCadenceAtFloor(bgmPromptCadenceState, normalAssistantFloorCount + 1);
  } else {
    expectedMessageId = swipe?.target.messageId ?? null;
    const swipeDecision = swipe?.decision;
    updateSwipePromptAudit({
      swipe_enabled: bgmSettingsStore.settings.generate_on_swipe,
      swipe_message_id: expectedMessageId,
      swipe_eligible: swipeDecision?.bgmPromptIncluded ?? false,
      swipe_started: false,
      swipe_skipped: true,
    });
    if (
      !shouldArmBgmPromptGeneration({
        enabled: isBgmEnabled(),
        type,
        dryRun: false,
        generateOnSwipe: bgmSettingsStore.settings.generate_on_swipe,
        swipeFloorEligible: swipeDecision?.bgmPromptIncluded,
      })
    )
      {
        rememberSkippedSwipeLifecycle(lifecycleEvent, expectedMessageId);
        return null;
      }
    floorDecision = swipeDecision;
  }
  if (!floorDecision) {
    if (type === 'swipe') {
      rememberSkippedSwipeLifecycle(lifecycleEvent, expectedMessageId);
    }
    return null;
  }
  const pending: PendingBgmPromptDecision = {
    ...floorDecision,
    ...createBgmPromptGenerationLifecycle(false, false),
    runtimeStarted: false,
    sourceError: null,
    injectionSucceeded: false,
    generationType: type,
    expectedMessageId,
    startChatLength: SillyTavern.chat.length,
    startTailRef: (() => {
      const tailId = getLastMessageId();
      return tailId >= 0 ? rawMessageRef(tailId) : null;
    })(),
  };
  lastSettledBgmGeneration = null;
  pendingBgmPromptDecision = pending;
  bindBgmGenerationAbort(pending, signal);
  return pending.aborted ? null : pending;
}

function ensurePendingBgmGeneration(
  type: string,
  signal?: AbortSignal,
  lifecycleEvent: BgmPromptSkippedSwipeEvent = 'after_commands',
): PendingBgmPromptDecision | null {
  if (type !== 'normal' && type !== 'swipe') return null;
  if (pendingBgmPromptDecision?.generationType === type && !pendingBgmPromptDecision.aborted) {
    bindBgmGenerationAbort(pendingBgmPromptDecision, signal);
    return pendingBgmPromptDecision;
  }
  if (pendingBgmPromptDecision) abortPendingBgmGeneration();
  lastSettledBgmGeneration = null;
  return createPendingBgmGeneration(type, signal, lifecycleEvent);
}

function startPendingBgmRuntime(pending: PendingBgmPromptDecision) {
  if (pending.aborted || pending.runtimeStarted || !pending.generationStarted || !pending.afterCommandsAccepted) return;
  if (pending.bgmPromptIncluded) startGeneration();
  else startSkippedGeneration();
  pending.runtimeStarted = true;
}

function resolveFinalAssistantMessageId(
  pending: PendingBgmPromptDecision,
  eventMessageId: number | null,
): number | null {
  const candidates = [
    eventMessageId,
    pending.expectedMessageId,
    pending.generationType === 'normal' ? getLastMessageId() : null,
    pending.generationType === 'normal' ? SillyTavern.chat.length - 1 : null,
  ];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    if (pending.generationType === 'normal' && candidate < pending.startChatLength) continue;
    if (pending.generationType === 'swipe' && pending.expectedMessageId !== null && candidate !== pending.expectedMessageId) {
      continue;
    }
    const rawMessage = rawMessageRef(candidate);
    const message = getChatMessages(candidate)[0];
    if (!rawMessage || message?.role !== 'assistant') continue;
    if (pending.generationType === 'normal' && rawMessage === pending.startTailRef) continue;
    return candidate;
  }
  return null;
}

function commitNormalAssistantFloor(pending: PendingBgmPromptDecision, messageId: number) {
  if (pending.settled || pending.aborted || pending.generationType !== 'normal') return;
  Object.assign(pending, markBgmPromptGenerationSettled(pending));
  normalAssistantFloorCount = pending.normalAssistantFloorCount;
  bgmPromptCadenceState = settleBgmPromptCadence(
    bgmPromptCadenceState,
    pending.bgmPromptIncluded,
    pending.sourceError || !pending.injectionSucceeded ? 'source_error' : 'completed',
  );
  const messageRef = rawMessageRef(messageId);
  if (messageRef) {
    floorDecisions.set(messageRef, {
      interval: pending.interval,
      bgmPromptIncluded: pending.bgmPromptIncluded,
      skippedCount: pending.skippedCount,
      completedCount: pending.completedCount,
      decision: pending.decision,
      reason: pending.reason,
      normalAssistantFloorCount: pending.normalAssistantFloorCount,
    });
  }
  updatePlaylistPromptAudit({
    skipped_count: bgmPromptCadenceState.skippedCount,
    completed_count: bgmPromptCadenceState.completedCount,
    assistant_floor_count: normalAssistantFloorCount,
  });
}

function finishAudioGeneration(eventMessageId: number | null, receivedType?: string) {
  const pending = pendingBgmPromptDecision;
  if (pending && receivedType && pending.generationType !== receivedType) {
    debugInfo('<杠杠-BGM> 当前消息类型与 pending generation 不一致，等待对应生成结束', {
      eventMessageId,
      receivedType,
      pendingType: pending.generationType,
    });
    return;
  }
  if (!pending && lastSettledBgmGeneration && eventMessageId === lastSettledBgmGeneration.messageId) {
    debugInfo('<杠杠-BGM> 忽略重复的生成结束事件', {
      eventMessageId,
      generationType: lastSettledBgmGeneration.generationType,
    });
    return;
  }
  if (!pending && skippedSwipeLifecycle) clearSkippedSwipeLifecycle();
  if (pending && (!isBgmPromptGenerationReady(pending) || !pending.runtimeStarted)) {
    debugInfo('<杠杠-BGM> 当前生成生命周期尚未完整，暂不结算正文楼', {
      eventMessageId,
      receivedType,
      generationType: pending.generationType,
      generationStarted: pending.generationStarted,
      afterCommandsAccepted: pending.afterCommandsAccepted,
    });
    return;
  }
  let finalMessageId: number | null = null;
  if (pending && !pending.aborted) {
    finalMessageId = resolveFinalAssistantMessageId(pending, eventMessageId);
  } else if (eventMessageId !== null && Number.isInteger(eventMessageId) && eventMessageId >= 0) {
    const message = getChatMessages(eventMessageId)[0];
    finalMessageId = message?.role === 'assistant' && rawMessageRef(eventMessageId) ? eventMessageId : null;
  }
  if (finalMessageId === null) return;

  const finalMessage = getChatMessages(finalMessageId)[0];
  const finalText = finalMessage?.message ?? '';
  let bgmAction: BgmAction | null = null;
  if (pending && !pending.aborted) {
    if (pending.bgmPromptIncluded && activeScanner) {
      if (!activeScanner.getState().action) activeScanner.pushSnapshot(finalText);
      bgmAction = activeScanner.finish();
    }
    if (pending.generationType === 'normal') {
      commitNormalAssistantFloor(pending, finalMessageId);
    } else {
      Object.assign(pending, markBgmPromptGenerationSettled(pending));
      updateSwipePromptAudit({
        swipe_message_id: finalMessageId,
        swipe_started: true,
        swipe_skipped: false,
      });
    }
    lastSettledBgmGeneration = { generationType: pending.generationType, messageId: finalMessageId };
    pendingBgmPromptDecision = null;
  } else if (activeScanner) {
    activeScanner = null;
  }

  let ambientAction: AmbientAction | null = null;
  if (activeAmbientScanner) {
    if (!activeAmbientScanner.getState().action) activeAmbientScanner.pushSnapshot(finalText);
    ambientAction = activeAmbientScanner.finish();
  }

  runtimeAudit.stream_finished = { status: 'success', message_id: finalMessageId, error: null };
  if (bgmAction?.type === 'none' && runtimeAudit.marker.status === 'pending') {
    runtimeAudit.marker = { status: 'success', matched: false, song: null, singer: null, error: null };
  }
  if (!ambientAction && runtimeAudit.ambient.status === 'pending') {
    const currentLocation = getCurrentAmbientState().location;
    runtimeAudit.ambient = {
      ...runtimeAudit.ambient,
      status: 'success',
      matched: false,
      current_location: currentLocation || null,
    };
  }
  debugInfo('<杠杠-调音台> stream finished', {
    generationId,
    messageId: finalMessageId,
    type: receivedType ?? pending?.generationType ?? 'unknown',
    bgmAction,
    ambientAction,
  });
  activeScanner = null;
  activeAmbientScanner = null;
  activeGenerationSourceContext = null;
}

clearBgmPromptInjections();
eventOn(tavern_events.CHAT_CHANGED, () => {
  resetBgmPromptCadence();
  resetAudioGenerationState();
  pendingSwipeTarget = null;
  clearBgmPromptInjections();
});
watch(
  () => [bgmSettingsStore.settings.module_enabled.bgm, bgmSettingsStore.settings.module_enabled.ambient],
  ([nextBgmEnabled], [previousBgmEnabled]) => {
    // Turning BGM off/on must not erase the normal-floor phase. Preserve an
    // in-flight floor so a reply that already lands can still commit once.
    resetBgmGeneration(true);
    resetAmbientGeneration();
    clearBgmPromptInjections();
    if (nextBgmEnabled !== previousBgmEnabled) {
      updateSwipePromptAudit({ swipe_enabled: bgmSettingsStore.settings.generate_on_swipe });
    }
  },
);
watch(
  () => [
    bgmSettingsStore.settings.source_mode,
    bgmSettingsStore.settings.playlist_id,
    bgmSettingsStore.settings.playlist_sample_count,
  ],
  () => {
    resetBgmGeneration(true);
    clearBgmPromptInjections();
  },
);
watch(
  () => bgmSettingsStore.settings.bgm_prompt_interval,
  nextInterval => {
    const normalizedInterval = normalizeBgmPromptInterval(nextInterval);
    if (nextInterval !== normalizedInterval) bgmSettingsStore.settings.bgm_prompt_interval = normalizedInterval;
    if (bgmPromptCadenceState.interval === normalizedInterval) return;
    // Keep the mature image-machine semantics: changing the interval affects
    // the next normal floor but never resets the accumulated floor count.
    bgmPromptCadenceState = updateBgmPromptCadenceInterval(bgmPromptCadenceState, normalizedInterval);
    updatePlaylistPromptAudit({
      interval: normalizedInterval,
      skipped_count: bgmPromptCadenceState.skippedCount,
      completed_count: bgmPromptCadenceState.completedCount,
      assistant_floor_count: normalAssistantFloorCount,
    });
  },
);
watch(
  () => bgmSettingsStore.settings.generate_on_swipe,
  enabled => updateSwipePromptAudit({ swipe_enabled: enabled }),
);

eventOn(tavern_events.GENERATION_AFTER_COMMANDS, (type: string, option: { signal?: AbortSignal }, dry_run: boolean) => {
  const hasMatchingPending =
    (pendingBgmPromptDecision?.generationType === type && !pendingBgmPromptDecision.aborted) ||
    (type === 'swipe' && skippedSwipeLifecycle !== null);
  if (
    (!isAnyAudioEnabled() && !hasMatchingPending) ||
    !shouldTrackAudioGeneration(type, dry_run) ||
    option?.signal?.aborted
  ) {
    if (type === 'swipe' && (dry_run || option?.signal?.aborted)) clearSkippedSwipeLifecycle();
    consumePendingSwipeTarget(type);
    debugInfo('<杠杠-BGM> 跳过非真实生成的歌单排重提示', { type, dry_run });
    return;
  }
  const isBgmCandidate = shouldHandleBgmGeneration(type, dry_run) && (isBgmEnabled() || hasMatchingPending);
  const pending = isBgmCandidate
    ? ensurePendingBgmGeneration(type, option?.signal, type === 'swipe' ? 'after_commands' : undefined)
    : null;
  if (!pending) {
    // createPendingBgmGeneration already recorded the consumed Swipe target.
    // Only the non-candidate path still needs to snapshot it here.
    if (type === 'swipe' && !isBgmCandidate) {
      updateSwipeAuditFromPendingTarget();
      rememberSkippedSwipeLifecycle('after_commands');
    }
    const preservedSwipeAudit = type === 'swipe' ? snapshotSwipePromptAudit() : undefined;
    consumePendingSwipeTarget(type);
    installCurrentBgmPlaylistPrompt(getCurrentBgmPromptCadenceDecision(), false, preservedSwipeAudit);
    debugInfo('<杠杠-BGM> 本轮类型不计入 BGM 正文楼，仍保留环境音提示', { type });
    return;
  }
  if (!pending.afterCommandsAccepted) {
    const installResult = isBgmEnabled()
      ? installCurrentBgmPlaylistPrompt(pending, true)
      : { bgmPromptIncluded: false, sourceError: null, injectionSucceeded: false };
    pending.sourceError = installResult.sourceError;
    pending.injectionSucceeded = installResult.injectionSucceeded;
    // Keep the same object identity so the AbortSignal listener installed when
    // this generation was created still guards the live pending generation.
    Object.assign(pending, markBgmPromptAfterCommandsAccepted(pending));
    pendingBgmPromptDecision = pending;
    updateSwipePromptAudit({
      swipe_enabled: bgmSettingsStore.settings.generate_on_swipe,
      swipe_message_id: pending.expectedMessageId,
      swipe_eligible: pending.generationType === 'swipe' ? pending.bgmPromptIncluded : runtimeAudit.playlist_prompt.swipe_eligible,
      swipe_started: false,
      swipe_skipped: pending.generationType === 'swipe' ? true : runtimeAudit.playlist_prompt.swipe_skipped,
    });
  }
  startPendingBgmRuntime(pendingBgmPromptDecision ?? pending);
});

eventOn(tavern_events.GENERATION_STARTED, (type: string, option: { signal?: AbortSignal }, dry_run: boolean) => {
  const hasMatchingPending =
    (pendingBgmPromptDecision?.generationType === type && !pendingBgmPromptDecision.aborted) ||
    (type === 'swipe' && skippedSwipeLifecycle !== null);
  if (
    (!isAnyAudioEnabled() && !hasMatchingPending) ||
    !shouldTrackAudioGeneration(type, dry_run) ||
    option?.signal?.aborted
  ) {
    if (type === 'swipe' && (dry_run || option?.signal?.aborted)) clearSkippedSwipeLifecycle();
    consumePendingSwipeTarget(type);
    debugInfo('<杠杠-BGM> 跳过非真实对话的生成', { type, dry_run });
    return;
  }
  const isBgmCandidate = shouldHandleBgmGeneration(type, dry_run) && (isBgmEnabled() || hasMatchingPending);
  const pending = isBgmCandidate
    ? ensurePendingBgmGeneration(type, option?.signal, type === 'swipe' ? 'started' : undefined)
    : null;
  if (pending) {
    if (!pending.generationStarted) {
      // Do not replace the pending object: its AbortSignal listener closes over
      // this identity and must remain able to cancel after both events arrive.
      Object.assign(pending, markBgmPromptGenerationStarted(pending));
      pendingBgmPromptDecision = pending;
    }
    startPendingBgmRuntime(pendingBgmPromptDecision ?? pending);
  } else {
    if (type === 'swipe' && !isBgmCandidate) {
      updateSwipeAuditFromPendingTarget();
      rememberSkippedSwipeLifecycle('started');
    }
    consumePendingSwipeTarget(type);
  }
  if (isAmbientEnabled()) startAmbientGeneration();
});

eventOn(tavern_events.STREAM_TOKEN_RECEIVED, (fullText: string) => {
  if (!isAnyAudioEnabled()) return;
  if (pendingBgmPromptDecision?.generationStarted && pendingBgmPromptDecision.bgmPromptIncluded) {
    startPendingBgmRuntime(pendingBgmPromptDecision);
    activeScanner?.pushSnapshot(fullText);
  }
  if (isAmbientEnabled()) {
    if (!activeAmbientScanner) startAmbientGeneration();
    activeAmbientScanner?.pushSnapshot(fullText);
  }
});

eventOn(tavern_events.MESSAGE_RECEIVED, (messageId: number, type: string) => {
  if (!isAnyAudioEnabled() && !pendingBgmPromptDecision) return;
  if (!shouldTrackAudioGeneration(type, false)) {
    debugInfo('<杠杠-BGM> 跳过非正文楼消息,不结束 scanner', { messageId, type });
    return;
  }
  finishAudioGeneration(messageId, type);
});

eventOn(tavern_events.GENERATION_ENDED, (messageId: number) => {
  if (!isAnyAudioEnabled() && !pendingBgmPromptDecision) return;
  finishAudioGeneration(Number.isInteger(messageId) ? messageId : null);
});

eventOn(tavern_events.GENERATION_STOPPED, () => {
  resetAudioGenerationState();
  debugInfo('<杠杠-调音台> scanner reset after generation stopped');
});

eventOn(tavern_events.MESSAGE_SWIPED, (messageId: number) => {
  resetBgmGeneration(true);
  resetAmbientGeneration();
  lastSettledBgmGeneration = null;
  clearSkippedSwipeLifecycle();
  const messageRef = rawMessageRef(messageId);
  pendingSwipeTarget =
    Number.isInteger(messageId) && messageRef
      ? { chatId: currentChatId(), messageId, messageRef }
      : null;
  updateSwipeAuditFromPendingTarget();
  debugInfo('<杠杠-调音台> recorded swipe source floor', {
    messageId,
    eligible: runtimeAudit.playlist_prompt.swipe_eligible,
  });
});

function mountBgmSettingsPanel() {
  const $mountPoint = $('#extensions_settings2').first();
  if (!$mountPoint.length) {
    debugWarn('<杠杠-BGM> 未找到 #extensions_settings2，跳过设置面板挂载');
    return;
  }

  $('#ganggang-console-settings-panel').remove();
  const app = createApp(BgmSettings).use(bgmPinia);
  const $host = createScriptIdDiv().attr('id', 'ganggang-console-settings-panel').appendTo($mountPoint);
  app.mount($host[0]);
  const { destroy } = teleportStyle();
  const cleanup = () => {
    app.unmount();
    $host.remove();
    destroy();
    $(window).off('pagehide.ganggangConsoleSettings', cleanup);
  };
  $(window).off('pagehide.ganggangConsoleSettings').on('pagehide.ganggangConsoleSettings', cleanup);
}

$(mountBgmSettingsPanel);
