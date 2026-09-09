import type {
  CastEntry,
  CastingTable,
  ReadingDefaults,
  ReadingMode,
  SoundEffectEntry,
  TtsProviderKind,
  TtsProviderProfile,
  VoiceRef,
  VoiceSettingsData,
} from './types';
import { VOICE_SETTINGS_SCHEMA_VERSION } from './types';

/** The only Tavern Helper variable scope used by this script. */
export const SCRIPT_VARIABLE_OPTION = { type: 'script' } as const;

export type ScriptVariables = Record<string, unknown>;

export type ScriptVariableApi = {
  getVariables: (option: typeof SCRIPT_VARIABLE_OPTION) => ScriptVariables;
  updateVariablesWith: (
    updater: (variables: ScriptVariables) => ScriptVariables,
    option: typeof SCRIPT_VARIABLE_OPTION,
  ) => ScriptVariables;
};

const PROVIDER_KINDS: readonly TtsProviderKind[] = ['edge', 'openai-compatible', 'doubao', 'minimax', 'xiaomi-mimo'];
const READING_MODES: readonly ReadingMode[] = [
  'full',
  'dialogue-only',
  'single-voice',
  'selected-text',
  'character-only',
];
const DEFAULT_PROFILE: TtsProviderProfile = {
  id: 'edge-default',
  name: 'Edge 默认配置',
  type: 'edge',
  enabled: true,
  endpoint: '',
  apiKey: '',
  model: '',
  defaultVoiceId: '',
  appId: '',
  accessKey: '',
  resourceId: '',
  groupId: '',
  responseFormat: 'mp3',
  platform: '',
  style: '',
  edgeRate: 0,
  extraBody: {},
};

export const DEFAULT_READING_DEFAULTS: ReadingDefaults = {
  mode: 'full',
  singleVoice: null,
  characterName: '',
  includeSoundEffects: false,
  recentMessageCount: 10,
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettingsData = {
  schemaVersion: VOICE_SETTINGS_SCHEMA_VERSION,
  profiles: [DEFAULT_PROFILE],
  castingByCharacter: {},
  readingDefaults: DEFAULT_READING_DEFAULTS,
  soundEffects: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = finiteNumber(value, fallback);
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = finiteNumber(value, fallback);
  return Math.min(maximum, Math.max(minimum, number));
}

function isBinaryExtraBodyField(key: string): boolean {
  return /(?:^|[_-])(?:audio|image|blob|base64|b64|binary|file)(?:$|[_-])/i.test(key);
}

function looksLikeBase64Payload(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  return compact.length >= 256 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function normalizeExtraBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  Object.entries(value).forEach(([key, item]) => {
    if (!key.trim() || key.length > 120) return;
    if (isBinaryExtraBodyField(key)) return;
    if (typeof item === 'string') {
      if (/^(?:data|blob):/i.test(item) || looksLikeBase64Payload(item)) return;
      result[key] = item.slice(0, 2_000);
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      result[key] = item;
      return;
    }
    if (typeof item === 'boolean' || item === null) result[key] = item;
  });
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback;
}

function normalizeVoiceRef(value: unknown): VoiceRef | null {
  if (!isRecord(value)) return null;
  const providerProfileId = stringValue(value.providerProfileId).trim();
  const voiceId = stringValue(value.voiceId).trim();
  if (!providerProfileId || !voiceId) return null;

  const result: VoiceRef = { providerProfileId, voiceId };
  if (typeof value.speed === 'number' && Number.isFinite(value.speed)) {
    result.speed = boundedNumber(value.speed, 1, 0.25, 4);
  }
  if (typeof value.emotion === 'string' && value.emotion.trim()) result.emotion = value.emotion.trim().slice(0, 120);
  return result;
}

export function normalizeProviderProfile(value: unknown, fallbackId = 'profile'): TtsProviderProfile {
  const record = isRecord(value) ? value : {};
  const id = stringValue(record.id, fallbackId).trim() || fallbackId;
  return {
    id,
    name: stringValue(record.name, id).trim() || id,
    type: enumValue(record.type, PROVIDER_KINDS, 'openai-compatible'),
    enabled: booleanValue(record.enabled, true),
    endpoint: stringValue(record.endpoint).trim(),
    apiKey: stringValue(record.apiKey),
    model: stringValue(record.model).trim(),
    defaultVoiceId: stringValue(record.defaultVoiceId).trim(),
    appId: stringValue(record.appId),
    accessKey: stringValue(record.accessKey),
    resourceId: stringValue(record.resourceId).trim(),
    groupId: stringValue(record.groupId).trim(),
    responseFormat: stringValue(record.responseFormat, 'mp3').trim() || 'mp3',
    platform: stringValue(record.platform).trim(),
    style: stringValue(record.style).trim(),
    edgeRate: boundedNumber(record.edgeRate, 0, -100, 100),
    extraBody: normalizeExtraBody(record.extraBody),
  };
}

function normalizeCastEntry(value: unknown, index: number): CastEntry | null {
  if (!isRecord(value)) return null;
  const voice = normalizeVoiceRef(value.voice);
  if (!voice) return null;
  const role = enumValue(value.role, ['narrator', 'user', 'character', 'fallback'] as const, 'character');
  const displayName = stringValue(value.displayName).trim();
  if (!displayName) return null;
  const aliases = Array.isArray(value.aliases)
    ? value.aliases
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    : [];
  const result: CastEntry = {
    id: stringValue(value.id, `${role}-${index}`).trim() || `${role}-${index}`,
    role,
    displayName,
    aliases: [...new Set(aliases)].slice(0, 24),
    voice,
  };
  if (typeof value.reason === 'string' && value.reason.trim()) result.reason = value.reason.trim().slice(0, 500);
  return result;
}

export function normalizeCastingTable(value: unknown, fallbackKey = 'unknown'): CastingTable | null {
  if (!isRecord(value)) return null;
  const entries = Array.isArray(value.entries)
    ? value.entries
        .map((entry, index) => normalizeCastEntry(entry, index))
        .filter((entry): entry is CastEntry => Boolean(entry))
    : [];
  if (entries.length === 0) return null;
  const characterKey = stringValue(value.characterKey, fallbackKey).trim() || fallbackKey;
  const characterName = stringValue(value.characterName, characterKey).trim() || characterKey;
  return {
    characterKey,
    characterName,
    generatedAt: Math.max(0, Math.floor(finiteNumber(value.generatedAt, Date.now()))),
    entries,
  };
}

function normalizeReadingDefaults(value: unknown): ReadingDefaults {
  const record = isRecord(value) ? value : {};
  return {
    mode: enumValue(record.mode, READING_MODES, DEFAULT_READING_DEFAULTS.mode),
    singleVoice: normalizeVoiceRef(record.singleVoice),
    characterName: stringValue(record.characterName).trim(),
    includeSoundEffects: booleanValue(record.includeSoundEffects, DEFAULT_READING_DEFAULTS.includeSoundEffects),
    recentMessageCount: boundedInteger(record.recentMessageCount, DEFAULT_READING_DEFAULTS.recentMessageCount, 1, 50),
  };
}

function normalizeSoundEffect(value: unknown, index: number): SoundEffectEntry | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id, `effect-${index}`).trim() || `effect-${index}`;
  const url = stringValue(value.url).trim();
  // Sound-effect entries are metadata only. Never persist browser data or blob URLs.
  if (!url || /^data:/i.test(url) || /^blob:/i.test(url)) return null;
  return {
    id,
    name: stringValue(value.name, id).trim() || id,
    kind: value.kind === 'ambience' ? 'ambience' : 'sfx',
    category: stringValue(value.category, '未分类').trim() || '未分类',
    url,
    description: stringValue(value.description).trim().slice(0, 500),
    enabled: booleanValue(value.enabled, true),
    volume: boundedNumber(value.volume, 1, 0, 1),
  };
}

/**
 * Convert arbitrary script variables to this script's intentionally small persisted contract.
 * Unknown keys, chat snapshots, audio data and other runtime fields are discarded.
 */
export function normalizeVoiceSettings(value: unknown): VoiceSettingsData {
  const record = isRecord(value) ? value : {};
  const rawProfiles = Array.isArray(record.profiles) ? record.profiles : [];
  const profiles = rawProfiles
    .map((profile, index) => normalizeProviderProfile(profile, `profile-${index + 1}`))
    .filter((profile, index, all) => all.findIndex(candidate => candidate.id === profile.id) === index);
  const normalizedProfiles =
    profiles.length > 0 ? profiles : [normalizeProviderProfile(DEFAULT_PROFILE, DEFAULT_PROFILE.id)];

  const rawCasting = isRecord(record.castingByCharacter) ? record.castingByCharacter : {};
  const castingByCharacter: Record<string, CastingTable> = {};
  Object.entries(rawCasting).forEach(([key, table]) => {
    const normalized = normalizeCastingTable(table, key);
    if (normalized) castingByCharacter[normalized.characterKey] = normalized;
  });

  const rawSoundEffects = Array.isArray(record.soundEffects) ? record.soundEffects : [];
  const soundEffects = rawSoundEffects
    .map((effect, index) => normalizeSoundEffect(effect, index))
    .filter((effect): effect is SoundEffectEntry => Boolean(effect))
    .filter((effect, index, all) => all.findIndex(candidate => candidate.id === effect.id) === index);

  return {
    schemaVersion: VOICE_SETTINGS_SCHEMA_VERSION,
    profiles: normalizedProfiles,
    castingByCharacter,
    readingDefaults: normalizeReadingDefaults(record.readingDefaults),
    soundEffects,
  };
}

function serializeVoiceSettings(settings: VoiceSettingsData): ScriptVariables {
  const normalized = normalizeVoiceSettings(settings);
  return {
    schemaVersion: normalized.schemaVersion,
    profiles: normalized.profiles,
    castingByCharacter: normalized.castingByCharacter,
    readingDefaults: normalized.readingDefaults,
    soundEffects: normalized.soundEffects,
  };
}

function resolveScriptVariableApi(api?: Partial<ScriptVariableApi>): ScriptVariableApi {
  const runtime = globalThis as typeof globalThis & {
    getVariables?: ScriptVariableApi['getVariables'];
    updateVariablesWith?: ScriptVariableApi['updateVariablesWith'];
  };
  const getVariables = api?.getVariables ?? runtime.getVariables;
  const updateVariablesWith = api?.updateVariablesWith ?? runtime.updateVariablesWith;
  if (typeof getVariables !== 'function' || typeof updateVariablesWith !== 'function') {
    throw new Error('杠杠の配音室需要 Tavern Helper 的脚本变量接口');
  }
  return { getVariables, updateVariablesWith };
}

export function loadVoiceSettings(api?: Partial<ScriptVariableApi>): VoiceSettingsData {
  const runtime = resolveScriptVariableApi(api);
  return normalizeVoiceSettings(runtime.getVariables(SCRIPT_VARIABLE_OPTION));
}

/** All writes go through this single updater and serialize only the supported persisted fields. */
export function updateVoiceSettings(
  updater: (current: VoiceSettingsData) => VoiceSettingsData,
  api?: Partial<ScriptVariableApi>,
): VoiceSettingsData {
  const runtime = resolveScriptVariableApi(api);
  let nextSettings: VoiceSettingsData | null = null;
  const persisted = runtime.updateVariablesWith(current => {
    nextSettings = normalizeVoiceSettings(updater(normalizeVoiceSettings(current)));
    return serializeVoiceSettings(nextSettings);
  }, SCRIPT_VARIABLE_OPTION);
  return nextSettings ?? normalizeVoiceSettings(persisted);
}

export function saveCastingTable(table: CastingTable, api?: Partial<ScriptVariableApi>): VoiceSettingsData {
  const normalized = normalizeCastingTable(table, table.characterKey);
  if (!normalized) throw new Error('配音表至少需要一个有效的角色与音色映射');
  return updateVoiceSettings(
    current => ({
      ...current,
      castingByCharacter: { ...current.castingByCharacter, [normalized.characterKey]: normalized },
    }),
    api,
  );
}

export function removeCastingTable(characterKey: string, api?: Partial<ScriptVariableApi>): VoiceSettingsData {
  const key = characterKey.trim();
  return updateVoiceSettings(current => {
    const castingByCharacter = { ...current.castingByCharacter };
    delete castingByCharacter[key];
    return { ...current, castingByCharacter };
  }, api);
}

export function updateReadingDefaults(
  readingDefaults: ReadingDefaults,
  api?: Partial<ScriptVariableApi>,
): VoiceSettingsData {
  return updateVoiceSettings(current => ({ ...current, readingDefaults }), api);
}

export function updateProviderProfiles(
  profiles: TtsProviderProfile[],
  api?: Partial<ScriptVariableApi>,
): VoiceSettingsData {
  return updateVoiceSettings(current => ({ ...current, profiles }), api);
}

export function updateSoundEffects(
  soundEffects: SoundEffectEntry[],
  api?: Partial<ScriptVariableApi>,
): VoiceSettingsData {
  return updateVoiceSettings(current => ({ ...current, soundEffects }), api);
}
