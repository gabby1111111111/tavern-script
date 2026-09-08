import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { z } from 'zod';
import { DEFAULT_NETEASE_PLAYLISTS } from './bgm-playlist';

export const GANGGANG_MIXER_VERSION = '0.3.0';

export const DEFAULT_BGM_INJECTION_LOCATION = '需要 BGM 时，必须在正文内容之前单独输出一行 <杠杠-BGM=歌曲名-歌手> 标记。';

export const DEFAULT_AMBIENT_PROMPT_CONTENT = [
  '1. 必须在 <content> 标签的正文内容之前单独输出一行 <杠杠-环境音=白噪音-地点> 标记，必须在 <content> 标签外部。',
  '2. 上一轮的地点是 {{current_ambient_location}}；如果现在地点不变，请原样输出 <杠杠-环境音=白噪音-{{current_ambient_location}}> 标记，否则输出的地点改成新地点。',
].join('\n');

export const DEFAULT_BGM_PROMPT_CONTENT = [
  '你正在正常生成角色回复正文。除非用户明确要求不要配 BGM，否则每次正常回复必须按当前正文氛围追加一条歌曲 BGM。',
  '保持正常的角色回复和剧情正文，不要输出候选列表、分析过程或选曲理由。',
  '【选曲流程（仅在内部完成）】1. 分析当前场景的情绪基调、人物心理状态、剧情节奏，重点看情绪、氛围和节奏的契合度，而不是只看歌词字面意思。',
  '2. 在心中列出 3-5 首不同歌手或乐队的候选曲目。3. 排除本次对话历史中已经在 BGM 标记出现过的歌曲，不能重复同一首。',
  '4. 优先选择该歌手的非代表作、专辑曲目、B 面曲或冷门单曲，不要每次都选最热门歌曲。5. 剧情出现明显转折时必须重新选曲。',
  '【硬性规则】更像电视剧、电影或 Galgame 的 BGM 选曲逻辑；可以使用中文、日文、韩文、英文歌曲，但不能使用纯音乐或器乐曲；歌名与歌手必须真实准确，不可编造。',
].join('');

export const DEFAULT_BGM_FORBIDDEN_LIST =
  '本次选曲时不得选择当前 BGM 播放列表中的歌曲（歌名和歌手组合），必须选择未出现在当前列表中的新 BGM：\n{{current_bgm_playlist}}';

export const DEFAULT_BGM_REQUIRED_LIST = '{{required_candidates}}';

export const BGM_PROMPT_FIELD_KEYS = [
  'bgm_injection_location',
  'ambient_prompt_content',
  'bgm_prompt_content',
  'bgm_forbidden_list_prompt',
  'bgm_required_list_prompt',
] as const;

export type BgmPromptField = (typeof BGM_PROMPT_FIELD_KEYS)[number];

const BgmPromptFields = z.object({
  bgm_injection_location: z.string(),
  ambient_prompt_content: z.string(),
  bgm_prompt_content: z.string(),
  bgm_forbidden_list_prompt: z.string(),
  bgm_required_list_prompt: z.string(),
});

export type BgmPromptFields = z.infer<typeof BgmPromptFields>;

export const DEFAULT_BGM_PROMPT_PRESET_ID = 'default-bgm-prompt';
export const DEFAULT_BGM_PROMPT_PRESET_NAME = '默认提示词';

export const BgmPromptPresetSchema = BgmPromptFields.extend({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
});

export type BgmPromptPreset = z.infer<typeof BgmPromptPresetSchema>;

export const DEFAULT_BGM_PROMPT_PRESET: BgmPromptPreset = {
  id: DEFAULT_BGM_PROMPT_PRESET_ID,
  name: DEFAULT_BGM_PROMPT_PRESET_NAME,
  bgm_injection_location: DEFAULT_BGM_INJECTION_LOCATION,
  ambient_prompt_content: DEFAULT_AMBIENT_PROMPT_CONTENT,
  bgm_prompt_content: DEFAULT_BGM_PROMPT_CONTENT,
  bgm_forbidden_list_prompt: DEFAULT_BGM_FORBIDDEN_LIST,
  bgm_required_list_prompt: DEFAULT_BGM_REQUIRED_LIST,
};

const MAX_BGM_PROMPT_PRESET_NAME_LENGTH = 80;

export type BgmPromptCadenceState = {
  interval: number;
  promptDue: boolean;
  skippedCount: number;
  completedCount: number;
};

export type BgmPromptCadenceDecision = {
  interval: number;
  bgmPromptIncluded: boolean;
  skippedCount: number;
  completedCount: number;
  decision: 'inject' | 'skip';
  reason: 'cadence_due' | 'cadence_wait';
};

export type BgmPromptCadenceSettlement = 'completed' | 'source_error' | 'aborted';

export type BgmPromptFloorDecision = BgmPromptCadenceDecision & {
  /** The one-based normal assistant floor count represented by this decision. */
  normalAssistantFloorCount: number;
};

export type BgmPromptGenerationLifecycle = {
  generationStarted: boolean;
  afterCommandsAccepted: boolean;
  settled: boolean;
  aborted: boolean;
};

export function createBgmPromptGenerationLifecycle(
  generationStarted = false,
  afterCommandsAccepted = false,
  settled = false,
  aborted = false,
): BgmPromptGenerationLifecycle {
  return { generationStarted, afterCommandsAccepted, settled, aborted };
}

export function markBgmPromptGenerationStarted(
  state: BgmPromptGenerationLifecycle,
): BgmPromptGenerationLifecycle {
  return { ...state, generationStarted: true };
}

export function markBgmPromptAfterCommandsAccepted(
  state: BgmPromptGenerationLifecycle,
): BgmPromptGenerationLifecycle {
  return { ...state, afterCommandsAccepted: true };
}

export function isBgmPromptGenerationReady(
  state: BgmPromptGenerationLifecycle,
): boolean {
  return state.generationStarted && state.afterCommandsAccepted && !state.settled && !state.aborted;
}

export function markBgmPromptGenerationSettled(
  state: BgmPromptGenerationLifecycle,
): BgmPromptGenerationLifecycle {
  return { ...state, settled: true };
}

export function markBgmPromptGenerationAborted(
  state: BgmPromptGenerationLifecycle,
): BgmPromptGenerationLifecycle {
  return { ...state, aborted: true };
}

export type BgmPromptSkippedSwipeEvent = 'started' | 'after_commands';

export type BgmPromptSkippedSwipeLifecycle = {
  firstEvent: BgmPromptSkippedSwipeEvent;
  messageId: number | null;
  completed: boolean;
};

export function createBgmPromptSkippedSwipeLifecycle(
  firstEvent: BgmPromptSkippedSwipeEvent,
  messageId: number | null,
): BgmPromptSkippedSwipeLifecycle {
  return { firstEvent, messageId, completed: false };
}

export function advanceBgmPromptSkippedSwipeLifecycle(
  state: BgmPromptSkippedSwipeLifecycle,
  event: BgmPromptSkippedSwipeEvent,
): { state: BgmPromptSkippedSwipeLifecycle; action: 'wait' | 'reuse' | 'ignore' } {
  if (state.completed) return { state, action: 'ignore' };
  if (state.firstEvent === event) return { state, action: 'wait' };
  return { state: { ...state, completed: true }, action: 'reuse' };
}

export type BgmPromptSwipeAudit = {
  swipe_enabled: boolean;
  swipe_message_id: number | null;
  swipe_eligible: boolean | null;
  swipe_started: boolean;
  swipe_skipped: boolean;
};

/** Keep the source-floor facts while rebuilding the rest of playlist_prompt. */
export function mergeBgmPromptSwipeAudit<T extends object>(
  base: T,
  patch?: Partial<BgmPromptSwipeAudit>,
): T & Partial<BgmPromptSwipeAudit> {
  return patch ? { ...base, ...patch } : base;
}

export const BGM_TRACKED_GENERATION_TYPES = ['normal'] as const;

export const BGM_SWIPE_GENERATION_TYPES = ['swipe'] as const;

export function shouldTrackAudioGeneration(type: string, dryRun: boolean): boolean {
  return !dryRun && type !== 'quiet';
}

export function shouldTrackBgmGeneration(type: string, dryRun: boolean): boolean {
  return !dryRun && (BGM_TRACKED_GENERATION_TYPES as readonly string[]).includes(type);
}

export function shouldHandleBgmGeneration(type: string, dryRun: boolean): boolean {
  return !dryRun && (
    (BGM_TRACKED_GENERATION_TYPES as readonly string[]).includes(type) ||
    (BGM_SWIPE_GENERATION_TYPES as readonly string[]).includes(type)
  );
}

export function shouldArmBgmPromptGeneration(input: {
  enabled: boolean;
  type: string;
  dryRun: boolean;
  generateOnSwipe?: boolean;
  swipeFloorEligible?: boolean;
}): boolean {
  if (!input.enabled || input.dryRun) return false;
  if (input.type === 'normal') return true;
  return input.type === 'swipe' && input.generateOnSwipe === true && input.swipeFloorEligible === true;
}

export function normalizeBgmPromptInterval(value: unknown): number {
  const numericValue = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(numericValue) || numericValue < 0) return 0;
  return Math.floor(numericValue);
}

export function createBgmPromptCadenceState(interval: unknown = 0): BgmPromptCadenceState {
  return {
    interval: normalizeBgmPromptInterval(interval),
    promptDue: true,
    skippedCount: 0,
    completedCount: 0,
  };
}

function normalizeCadenceCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isCadenceDue(interval: number, completedCount: number): boolean {
  return interval === 0 || completedCount % (interval + 1) === 0;
}

function cadenceSkippedCount(interval: number, completedCount: number): number {
  return interval === 0 ? 0 : completedCount % (interval + 1);
}

export function updateBgmPromptCadenceInterval(
  state: BgmPromptCadenceState,
  interval: unknown,
): BgmPromptCadenceState {
  const normalizedInterval = normalizeBgmPromptInterval(interval);
  const completedCount = normalizeCadenceCount(state.completedCount);
  const promptDue = isCadenceDue(normalizedInterval, completedCount);
  return {
    interval: normalizedInterval,
    promptDue,
    skippedCount: cadenceSkippedCount(normalizedInterval, completedCount),
    completedCount,
  };
}

export function decideBgmPromptCadenceAtFloor(
  state: BgmPromptCadenceState,
  normalAssistantFloorCount: number,
): BgmPromptFloorDecision {
  const interval = normalizeBgmPromptInterval(state.interval);
  const completedCount = normalizeCadenceCount(state.completedCount);
  const floorCount = normalizeCadenceCount(normalAssistantFloorCount);
  const bgmPromptIncluded = floorCount > 0 && isCadenceDue(interval, floorCount - 1);
  return {
    interval,
    bgmPromptIncluded,
    skippedCount: cadenceSkippedCount(interval, completedCount),
    completedCount,
    decision: bgmPromptIncluded ? 'inject' : 'skip',
    reason: bgmPromptIncluded ? 'cadence_due' : 'cadence_wait',
    normalAssistantFloorCount: floorCount,
  };
}

export function decideBgmPromptCadence(state: BgmPromptCadenceState): BgmPromptCadenceDecision {
  return decideBgmPromptCadenceAtFloor(state, normalizeCadenceCount(state.completedCount) + 1);
}

export function settleBgmPromptCadence(
  state: BgmPromptCadenceState,
  bgmPromptIncluded: boolean,
  settlement: BgmPromptCadenceSettlement = 'completed',
): BgmPromptCadenceState {
  void bgmPromptIncluded;
  const interval = normalizeBgmPromptInterval(state.interval);
  if (settlement === 'aborted') return updateBgmPromptCadenceInterval(state, interval);

  // A source or injection failure does not undo a normal assistant floor that
  // has already landed. Only an aborted/stopped generation leaves the phase
  // untouched.
  const completedCount = normalizeCadenceCount(state.completedCount) + 1;
  const promptDue = isCadenceDue(interval, completedCount);
  return {
    interval,
    promptDue,
    skippedCount: cadenceSkippedCount(interval, completedCount),
    completedCount,
  };
}

function isObjectIdentity(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Page-memory state keyed by raw SillyTavern message objects. */
export class BgmMessageIdentityStore<T> {
  private values = new WeakMap<object, T>();

  set(message: unknown, value: T): boolean {
    if (!isObjectIdentity(message)) return false;
    this.values.set(message, value);
    return true;
  }

  get(message: unknown): T | undefined {
    return isObjectIdentity(message) ? this.values.get(message) : undefined;
  }

  reset(): void {
    this.values = new WeakMap<object, T>();
  }
}

export function normalizeBgmPromptName(value: unknown, fallback = '未命名提示词'): string {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (normalized || fallback).slice(0, MAX_BGM_PROMPT_PRESET_NAME_LENGTH);
}

export function areBgmPromptPresetsEqual(left: BgmPromptPreset, right: BgmPromptPreset): boolean {
  if (left.name !== right.name) return false;
  return BGM_PROMPT_FIELD_KEYS.every(key => left[key] === right[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBgmPromptFields(value: unknown, fallback: BgmPromptFields = DEFAULT_BGM_PROMPT_PRESET): BgmPromptFields {
  const record = isRecord(value) ? value : {};
  const fallbackAmbient = fallback.ambient_prompt_content.trim() ? fallback.ambient_prompt_content : DEFAULT_AMBIENT_PROMPT_CONTENT;
  const fields = { ...fallback, ambient_prompt_content: fallbackAmbient };
  for (const key of BGM_PROMPT_FIELD_KEYS) {
    if (typeof record[key] !== 'string') continue;
    if (key === 'ambient_prompt_content' && !record[key].trim()) {
      fields[key] = DEFAULT_AMBIENT_PROMPT_CONTENT;
      continue;
    }
    fields[key] = record[key];
  }
  return fields;
}

function fallbackBgmPromptPresetId(index: number): string {
  return index === 0 ? DEFAULT_BGM_PROMPT_PRESET_ID : `${DEFAULT_BGM_PROMPT_PRESET_ID}-${index + 1}`;
}

function uniqueBgmPromptPresetId(candidate: string, used: Set<string>, index: number): string {
  const base = candidate.trim() || fallbackBgmPromptPresetId(index);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

export function normalizeBgmPromptPreset(
  raw: unknown,
  index = 0,
  fallback: BgmPromptFields = DEFAULT_BGM_PROMPT_PRESET,
): BgmPromptPreset | null {
  if (!isRecord(raw)) return null;
  const fields = readBgmPromptFields(raw, fallback);
  return BgmPromptPresetSchema.parse({
    ...fields,
    id: typeof raw.id === 'string' ? raw.id.trim() || fallbackBgmPromptPresetId(index) : fallbackBgmPromptPresetId(index),
    name: normalizeBgmPromptName(raw.name, index === 0 ? DEFAULT_BGM_PROMPT_PRESET_NAME : `提示词 ${index + 1}`),
  });
}

export function normalizeBgmPromptPresets(
  raw: unknown,
  fallback: BgmPromptFields = DEFAULT_BGM_PROMPT_PRESET,
): BgmPromptPreset[] {
  const source = Array.isArray(raw) ? raw : [];
  const used = new Set<string>();
  const presets = source
    .map((item, index) => normalizeBgmPromptPreset(item, index, fallback))
    .filter((preset): preset is BgmPromptPreset => preset !== null)
    .map((preset, index) => ({ ...preset, id: uniqueBgmPromptPresetId(preset.id, used, index) }));
  return presets.length > 0 ? presets : [{ ...DEFAULT_BGM_PROMPT_PRESET, ...fallback }];
}

let bgmPromptPresetSequence = 0;

function createGeneratedBgmPromptPresetId(used: Set<string>): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  const base = typeof randomUUID === 'function'
    ? `bgm-prompt-${randomUUID.call(globalThis.crypto)}`
    : `bgm-prompt-${Date.now()}-${bgmPromptPresetSequence++}`;
  return uniqueBgmPromptPresetId(base, used, used.size);
}

export function createBgmPromptPreset(
  input: Partial<Omit<BgmPromptPreset, 'id'>> & { id?: string } = {},
  existingIds: Iterable<string> = [],
): BgmPromptPreset {
  const used = new Set(existingIds);
  const id = input.id?.trim()
    ? uniqueBgmPromptPresetId(input.id, used, used.size)
    : createGeneratedBgmPromptPresetId(used);
  const fields = readBgmPromptFields(input);
  return BgmPromptPresetSchema.parse({
    ...fields,
    id,
    name: normalizeBgmPromptName(input.name, '新建提示词'),
  });
}

export function getCurrentBgmPromptPreset(presets: BgmPromptPreset[], currentId: string): BgmPromptPreset {
  return presets.find(preset => preset.id === currentId) ?? presets[0] ?? DEFAULT_BGM_PROMPT_PRESET;
}

export function updateBgmPromptPreset(
  presets: BgmPromptPreset[],
  id: string,
  patch: Partial<Omit<BgmPromptPreset, 'id'>>,
): BgmPromptPreset[] {
  return presets.map(preset =>
    preset.id === id
      ? BgmPromptPresetSchema.parse({
          ...preset,
          ...patch,
          id: preset.id,
          name: normalizeBgmPromptName(patch.name ?? preset.name),
        })
      : { ...preset },
  );
}

export type BgmPromptPresetUpsert = {
  presets: BgmPromptPreset[];
  preset: BgmPromptPreset;
};

export function upsertBgmPromptPreset(presets: BgmPromptPreset[], input: BgmPromptPreset): BgmPromptPresetUpsert {
  const normalized = BgmPromptPresetSchema.parse({
    ...input,
    id: input.id.trim(),
    name: normalizeBgmPromptName(input.name, '未命名提示词'),
  });
  const index = presets.findIndex(preset => preset.id === normalized.id);
  const next = presets.map(preset => ({ ...preset }));
  if (index >= 0) next[index] = normalized;
  else next.push(normalized);
  return { presets: next, preset: normalized };
}

export type BgmPromptPresetDeletion = {
  presets: BgmPromptPreset[];
  currentId: string;
  deleted: boolean;
  restoredDefault: boolean;
};

export function deleteBgmPromptPreset(
  presets: BgmPromptPreset[],
  id: string,
  currentId: string,
): BgmPromptPresetDeletion {
  const normalized = normalizeBgmPromptPresets(presets);
  if (!normalized.some(preset => preset.id === id)) {
    const fallbackCurrentId = normalized.some(preset => preset.id === currentId) ? currentId : normalized[0].id;
    return {
      presets: normalized.map(preset => ({ ...preset })),
      currentId: fallbackCurrentId,
      deleted: false,
      restoredDefault: false,
    };
  }
  if (normalized.length === 1) {
    return {
      presets: [{ ...DEFAULT_BGM_PROMPT_PRESET }],
      currentId: DEFAULT_BGM_PROMPT_PRESET_ID,
      deleted: true,
      restoredDefault: true,
    };
  }
  const next = normalized.filter(preset => preset.id !== id).map(preset => ({ ...preset }));
  const nextCurrentId = id === currentId || !next.some(preset => preset.id === currentId) ? next[0].id : currentId;
  return { presets: next, currentId: nextCurrentId, deleted: true, restoredDefault: false };
}

const PlaylistEntry = z.object({
  id: z.string(),
  name: z.string(),
});

const ModuleEnabled = z.object({
  bgm: z.boolean().default(true),
  ambient: z.boolean().default(false),
});

const BgmSettings = z
  .object({
    bgm_injection_location: z.string().default(DEFAULT_BGM_INJECTION_LOCATION),
    ambient_prompt_content: z.string().default(DEFAULT_AMBIENT_PROMPT_CONTENT),
    bgm_prompt_content: z.string().default(DEFAULT_BGM_PROMPT_CONTENT),
    bgm_forbidden_list_prompt: z.string().default(DEFAULT_BGM_FORBIDDEN_LIST),
    bgm_required_list_prompt: z.string().default(DEFAULT_BGM_REQUIRED_LIST),
     prompt_presets: z.array(BgmPromptPresetSchema).min(1).default([{ ...DEFAULT_BGM_PROMPT_PRESET }]),
     current_prompt_preset_id: z.string().default(DEFAULT_BGM_PROMPT_PRESET_ID),
     bgm_prompt_interval: z.coerce.number().int().min(0).default(0),
     generate_on_swipe: z.boolean().default(true),
     playlist_limit: z.coerce.number().int().min(1).max(20).default(5),
    playlist_sample_count: z.coerce.number().int().min(1).max(20).default(5),
    ambient_fallback_bv_ids: z.array(z.string()).default([]),
    debug_mode: z.boolean().default(false),
    module_enabled: ModuleEnabled.prefault({}),
    source_mode: z.enum(['random', 'netease_playlist']).default('random'),
    playlist_id: z.string().default(''),
    playlist_name_overrides: z.record(z.string(), z.string()).default({}),
    playlist_catalog: z
      .array(PlaylistEntry)
      .default(DEFAULT_NETEASE_PLAYLISTS.map(playlist => ({ id: playlist.id, name: playlist.name }))),
  })
  .prefault({});

export type BgmSourceMode = z.infer<typeof BgmSettings>['source_mode'];
export type BgmSettings = z.infer<typeof BgmSettings>;

function applyBgmPromptPresetToSettings(settings: BgmSettings, preset: BgmPromptPreset): void {
  for (const key of BGM_PROMPT_FIELD_KEYS) settings[key] = preset[key];
}

export function migrateBgmSettings(raw: unknown): BgmSettings {
  const record = isRecord(raw) ? raw : {};
  const legacyFields = readBgmPromptFields(record);
  const presets = normalizeBgmPromptPresets(record.prompt_presets, legacyFields);
  const requestedCurrentId = typeof record.current_prompt_preset_id === 'string' ? record.current_prompt_preset_id.trim() : '';
  const currentPreset = getCurrentBgmPromptPreset(presets, requestedCurrentId);
  const currentId = currentPreset.id;
  const candidate = {
    ...record,
    ...currentPreset,
    prompt_presets: presets,
    current_prompt_preset_id: currentId,
    bgm_prompt_interval: normalizeBgmPromptInterval(record.bgm_prompt_interval),
  };
  const parsed = BgmSettings.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // Keep valid prompt data even when an unrelated legacy setting is malformed.
  const defaults = BgmSettings.parse({});
  const migrated = {
    ...defaults,
    prompt_presets: presets,
    current_prompt_preset_id: currentId,
  };
  applyBgmPromptPresetToSettings(migrated, currentPreset);
  return migrated;
}

export const useBgmSettingsStore = defineStore('ganggang-console-settings', () => {
  const scriptVariableOption = { type: 'script' as const, script_id: getScriptId() };
  const rawSettings = getVariables(scriptVariableOption);
  const initialSettings = migrateBgmSettings(rawSettings);
  const settings = ref(initialSettings);

  function selectPromptPreset(id: string): boolean {
    const preset = settings.value.prompt_presets.find(item => item.id === id.trim());
    if (!preset) return false;
    settings.value.current_prompt_preset_id = preset.id;
    applyBgmPromptPresetToSettings(settings.value, preset);
    return true;
  }

  function savePromptPreset(preset: BgmPromptPreset): BgmPromptPreset {
    const normalized = BgmPromptPresetSchema.parse({
      ...preset,
      id: preset.id.trim(),
      name: normalizeBgmPromptName(preset.name, '未命名提示词'),
    });
    const upserted = upsertBgmPromptPreset(settings.value.prompt_presets, normalized);
    settings.value.prompt_presets = upserted.presets;
    settings.value.current_prompt_preset_id = upserted.preset.id;
    applyBgmPromptPresetToSettings(settings.value, upserted.preset);
    return upserted.preset;
  }

  function removePromptPreset(id: string): BgmPromptPresetDeletion {
    const result = deleteBgmPromptPreset(settings.value.prompt_presets, id, settings.value.current_prompt_preset_id);
    if (!result.deleted) return result;
    settings.value.prompt_presets = result.presets;
    settings.value.current_prompt_preset_id = result.currentId;
    applyBgmPromptPresetToSettings(settings.value, getCurrentBgmPromptPreset(result.presets, result.currentId));
    return result;
  }

  watch(
    settings,
    nextSettings => {
      updateVariablesWith(variables => ({ ...variables, ...klona(nextSettings) }), scriptVariableOption);
    },
    { deep: true, immediate: true },
  );

  return { settings, selectPromptPreset, savePromptPreset, removePromptPreset };
});
