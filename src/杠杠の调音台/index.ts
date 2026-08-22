import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import { resolveBilibiliAmbientAudio } from './ambient-audio';
import BgmSettings from './BgmSettings.vue';
import {
  getNeteaseCandidatesForGeneration,
  type NeteasePlaylistTrack,
} from './bgm-playlist';
import { type BgmSourceMode, useBgmSettingsStore } from './bgm-settings';

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

  if (isBgmEnabled()) {
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

function installCurrentBgmPlaylistPrompt() {
  let titles: string[] = [];
  const sourceMode = activeGenerationSourceContext?.mode ?? bgmSettingsStore.settings.source_mode;
  let sourceContext: BgmSourceContext = {
    mode: sourceMode,
    playlistId: null,
    candidates: [],
  };
  let sourceError: string | null = null;
  runtimeAudit.playlist_prompt = {
    status: 'pending',
    id: bgmPlaylistPromptId,
    count: 0,
    titles: [],
    source_mode: sourceMode,
    playlist_id: null,
    candidate_count: 0,
    reason: 'generation_after_commands',
    error: null,
  };

  if (!isAnyAudioEnabled()) {
    clearBgmPromptInjections();
    runtimeAudit.playlist_prompt = {
      status: 'success',
      id: bgmPlaylistPromptId,
      count: 0,
      titles: [],
      source_mode: sourceMode,
      playlist_id: null,
      candidate_count: 0,
      reason: 'generation_after_commands',
      error: null,
    };
    return;
  }

  try {
    clearBgmPromptInjections();
    titles = isBgmEnabled() ? getCurrentBgmTitles() : [];
    if (isBgmEnabled()) {
      sourceContext = activeGenerationSourceContext ?? getConfiguredBgmSourceContext();
      activeGenerationSourceContext = sourceContext;
      if (sourceContext.mode === 'netease_playlist' && sourceContext.candidates.length === 0) {
        sourceError = sourceContext.playlistId
          ? `网易云歌单 ${sourceContext.playlistId} 尚未加载成功`
          : '尚未指定网易云歌单 ID';
      }
    }
    const currentAmbientTitle = isAmbientEnabled() ? getCurrentAmbientTitle() : '';
    const content = createAudioPromptContent(titles, sourceContext, sourceError, currentAmbientTitle);
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
    runtimeAudit.playlist_prompt = {
      status: sourceError ? 'fail' : 'success',
      id: bgmPlaylistPromptId,
      count: titles.length,
      titles,
      source_mode: sourceContext.mode,
      playlist_id: sourceContext.playlistId,
      candidate_count: sourceContext.candidates.length,
      reason: 'generation_after_commands',
      error: sourceError,
    };
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
  } catch (error) {
    const message = errorText(error);
    runtimeAudit.playlist_prompt = {
      status: 'fail',
      id: bgmPlaylistPromptId,
      count: titles.length,
      titles,
      source_mode: sourceContext.mode,
      playlist_id: sourceContext.playlistId,
      candidate_count: sourceContext.candidates.length,
      reason: 'generation_after_commands',
      error: message,
    };
    runtimeAudit.prompt_injection = {
      status: 'fail',
      id: bgmPlaylistPromptId,
      scope: 'current_chat',
      reason: 'generation_after_commands',
      error: message,
    };
    runtimeAudit.last_error = message;
    debugWarn('<杠杠-BGM> 当前歌单排重提示注入失败', { message });
  }
}

function isCurrentMusicGeneration(runId: number) {
  return runId === activeMusicGenerationId;
}

const BGM_FADE_DURATION_MS = 1_000;
const BGM_FADE_STEP_MS = 100;
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

function resetBgmGeneration() {
  activeMusicGenerationId = 0;
  activeScanner = null;
  activeGenerationSourceContext = null;
  cancelBgmTransition();
}

function resetAmbientGeneration() {
  activeAmbientGenerationId = 0;
  activeAmbientScanner = null;
}

function resetAudioGenerationState() {
  resetBgmGeneration();
  resetAmbientGeneration();
}

function waitForBgmFadeStep() {
  return new Promise<void>(resolve => window.setTimeout(resolve, BGM_FADE_STEP_MS));
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
    return playlist;
  } finally {
    if (transitionId === bgmTransitionId) {
      bgmTransitionTargetVolume = null;
      setAudioSettings('bgm', { volume: targetVolume });
    }
  }
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
    const searchRes = await fetch(
      'https://music-api.gdstudio.xyz/api.php?types=search&source=joox&name=' + encodeURIComponent(query) + '&count=5',
    );
    if (!searchRes.ok) throw new Error(`JOOX 搜歌请求失败 (${searchRes.status})`);

    const searchData: unknown = await searchRes.json();
    const firstTrack = Array.isArray(searchData) ? searchData[0] : undefined;
    const rawTrackId = firstTrack && typeof firstTrack === 'object' ? (firstTrack as { id?: unknown }).id : undefined;
    if (typeof rawTrackId !== 'string' && typeof rawTrackId !== 'number') {
      throw new Error('没有搜到可播放的歌曲');
    }
    trackId = String(rawTrackId);

    if (!isCurrentMusicGeneration(runId)) return;
    if (!trackId) throw new Error('没有可用的 JOOX 歌曲 id');

    const urlRes = await fetch(
      `https://music-api.gdstudio.xyz/api.php?types=url&source=${musicSource}&id=${encodeURIComponent(trackId)}&br=320`,
    );
    if (!urlRes.ok) throw new Error(`JOOX 歌曲 URL 请求失败 (${urlRes.status})`);

    const urlData: unknown = await urlRes.json();
    const audioUrl =
      urlData && typeof urlData === 'object' && typeof (urlData as { url?: unknown }).url === 'string'
        ? (urlData as { url: string }).url
        : '';
    if (!audioUrl) throw new Error('歌曲没有可用 URL');
    urlResolved = true;

    if (!isCurrentMusicGeneration(runId)) return;

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

function waitForAmbientPlaybackCheck() {
  return new Promise<void>(resolve => window.setTimeout(resolve, 100));
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

async function resumeCurrentAmbient(
  runId: number,
  action: AmbientAction,
  current: ReturnType<typeof getCurrentAmbientState>,
) {
  if (!current.src || !isCurrentAmbientGeneration(runId)) return false;

  try {
    playAudio('ambient', { title: current.title || action.title, url: current.src });
    await waitForAmbientPlaybackCheck();
    if (!isCurrentAmbientGeneration(runId)) return true;
    const resumed = assertAmbientPlayback({ title: current.title || action.title, url: current.src });
    markAmbientReused(runId, action, resumed);
    return true;
  } catch (error) {
    if (isCurrentAmbientGeneration(runId)) {
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
  try {
    const result = await resolveBilibiliAmbientAudio(action.location, fallbackBvids, {
      shouldContinue: () => isCurrentAmbientGeneration(runId),
      onSearchAttempt: (attempt, query) => {
        if (!isCurrentAmbientGeneration(runId)) return;
        runtimeAudit.ambient.search_attempts = attempt;
        debugInfo('<杠杠-环境音> 搜索 B站环境音', { generationId: runId, attempt, query });
      },
    });
    if (!isCurrentAmbientGeneration(runId)) return;

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
    await waitForAmbientPlaybackCheck();
    if (!isCurrentAmbientGeneration(runId)) return;
    const playbackState = assertAmbientPlayback(audio);
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
    if (!isCurrentAmbientGeneration(runId)) return;
    const message = errorText(error);
    runtimeAudit.ambient = {
      ...runtimeAudit.ambient,
      status: 'fail',
      error: message,
    };
    runtimeAudit.last_error = message;
    debugWarn('<杠杠-环境音> 搜索或播放失败', { generationId: runId, location: action.location, message });
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

function shouldTrack(type: string, dryRun: boolean): boolean {
  if (dryRun) return false;
  if (type === 'quiet') return false;
  return true;
}

function startGeneration() {
  if (!isBgmEnabled()) return;
  generationId += 1;
  const currentGenerationId = generationId;
  const currentSourceContext = getConfiguredBgmSourceContext();
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

function startAmbientGeneration() {
  if (!isAmbientEnabled()) return;
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

clearBgmPromptInjections();
eventOn(tavern_events.CHAT_CHANGED, () => {
  resetAudioGenerationState();
  clearBgmPromptInjections();
});
watch(
  () => [bgmSettingsStore.settings.module_enabled.bgm, bgmSettingsStore.settings.module_enabled.ambient],
  () => {
    resetAudioGenerationState();
    clearBgmPromptInjections();
  },
);
watch(
  () => [
    bgmSettingsStore.settings.source_mode,
    bgmSettingsStore.settings.playlist_id,
    bgmSettingsStore.settings.playlist_sample_count,
  ],
  () => {
    resetBgmGeneration();
    clearBgmPromptInjections();
  },
);

eventOn(tavern_events.GENERATION_AFTER_COMMANDS, (type: string, _option: unknown, dry_run: boolean) => {
  if (!isAnyAudioEnabled()) return;
  if (!shouldTrack(type, dry_run)) {
    debugInfo('<杠杠-BGM> 跳过非真实生成的歌单排重提示', { type, dry_run });
    return;
  }
  installCurrentBgmPlaylistPrompt();
});

eventOn(tavern_events.GENERATION_STARTED, (type: string, _option: unknown, dry_run: boolean) => {
  if (!isAnyAudioEnabled()) return;
  if (!shouldTrack(type, dry_run)) {
    debugInfo('<杠杠-BGM> 跳过非真实对话的生成', { type, dry_run });
    return;
  }
  if (isBgmEnabled()) startGeneration();
  if (isAmbientEnabled()) startAmbientGeneration();
});

eventOn(tavern_events.STREAM_TOKEN_RECEIVED, (fullText: string) => {
  if (!isAnyAudioEnabled()) return;
  if (isBgmEnabled()) {
    if (!activeScanner) startGeneration();
    activeScanner?.pushSnapshot(fullText);
  }
  if (isAmbientEnabled()) {
    if (!activeAmbientScanner) startAmbientGeneration();
    activeAmbientScanner?.pushSnapshot(fullText);
  }
});

eventOn(tavern_events.MESSAGE_RECEIVED, (messageId: number, type: string) => {
  if (!isAnyAudioEnabled()) return;
  if (type === 'quiet') {
    debugInfo('<杠杠-BGM> 跳过 quiet 消息,不结束 scanner', { messageId });
    return;
  }
  let bgmAction = activeScanner?.getState().action ?? null;
  if (activeScanner && !bgmAction) {
    const finalMessage = getChatMessages(messageId)[0]?.message ?? '';
    activeScanner.pushSnapshot(finalMessage);
    bgmAction = activeScanner.finish();
  } else if (activeScanner) {
    bgmAction = activeScanner.finish();
  }

  let ambientAction = activeAmbientScanner?.getState().action ?? null;
  if (activeAmbientScanner && !ambientAction) {
    const finalMessage = getChatMessages(messageId)[0]?.message ?? '';
    activeAmbientScanner.pushSnapshot(finalMessage);
    ambientAction = activeAmbientScanner.finish();
  } else if (activeAmbientScanner) {
    ambientAction = activeAmbientScanner.finish();
  }

  runtimeAudit.stream_finished = { status: 'success', message_id: messageId, error: null };
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
  debugInfo('<杠杠-调音台> stream finished', { generationId, messageId, type, bgmAction, ambientAction });
  activeScanner = null;
  activeAmbientScanner = null;
  activeGenerationSourceContext = null;
});

eventOn(tavern_events.GENERATION_STOPPED, () => {
  resetAudioGenerationState();
  debugInfo('<杠杠-调音台> scanner reset after generation stopped');
});

eventOn(tavern_events.MESSAGE_SWIPED, (messageId: number) => {
  resetAudioGenerationState();
  debugInfo('<杠杠-调音台> scanner reset after swipe', { messageId });
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
