import { buildCastingRequestPayload, sanitizeVoiceOptions } from './context';
import { saveCastingTable } from './settings';
import type { CastingContext, CastingRequest, CastingTable, CastEntry, VoiceOption, VoiceRef } from './types';

type CastingPrompt = { role: 'system'; content: string };

type CastingJsonSchema = {
  name: string;
  description: string;
  strict: true;
  value: Record<string, unknown>;
};

export type CastingGenerateConfig = {
  generation_id: string;
  should_silence: true;
  should_stream: false;
  ordered_prompts: CastingPrompt[];
  user_input: string;
  json_schema: CastingJsonSchema;
};

export type GenerateRawLike = (config: CastingGenerateConfig) => Promise<unknown>;

export type CastingRuntime = {
  generateRaw: GenerateRawLike;
  stopGenerationById: (generationId: string) => boolean;
};

export type GenerateCastingOptions = {
  context: CastingContext;
  voices: VoiceOption[];
  generationId?: string;
  now?: () => number;
  isInputCurrent?: () => boolean;
  runtime?: Partial<CastingRuntime>;
};

export type CastingRole = 'narrator' | 'user' | 'character' | 'fallback';

export type CastingContractEntry = Omit<CastEntry, 'role'> & { role: CastingRole };

export type CastingValidationCode =
  | 'INVALID_JSON'
  | 'INVALID_ROOT'
  | 'INVALID_ENTRY'
  | 'ROLE_COUNT'
  | 'PERSONA_USER_REQUIRED'
  | 'UNKNOWN_PERSON'
  | 'UNKNOWN_VOICE'
  | 'GENERIC_ALIAS'
  | 'LANGUAGE_INFO_MISSING'
  | 'VOICE_LOCALE_INFO_MISSING'
  | 'VOICE_LANGUAGE_MISMATCH'
  | 'COMPATIBLE_VOICE_INSUFFICIENT'
  | 'DUPLICATE_PRIORITY_VOICE'
  | 'NARRATOR_VOICE_NOT_INDEPENDENT';

export class CastingValidationError extends Error {
  readonly code: CastingValidationCode;

  constructor(code: CastingValidationCode, message: string) {
    super(message);
    this.name = 'CastingValidationError';
    this.code = code;
  }
}

export const CASTING_JSON_SCHEMA: CastingJsonSchema = {
  name: 'ganggang_voice_casting',
  description:
    '为当前资料选择旁白、用户和角色音色。只能选择输入清单中的 profile/voice 组合；先匹配人物语言和 locale，旁白独立，前五个优先人物在兼容音色足够时不重复。',
  strict: true,
  value: {
    type: 'object',
    additionalProperties: false,
    properties: {
      entries: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            role: { type: 'string', enum: ['narrator', 'user', 'character', 'fallback'] },
            displayName: { type: 'string' },
            aliases: { type: 'array', maxItems: 24, items: { type: 'string' } },
            providerProfileId: { type: 'string' },
            voiceId: { type: 'string' },
            speed: { type: 'number', minimum: 0.25, maximum: 4 },
            emotion: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['role', 'displayName', 'aliases', 'providerProfileId', 'voiceId'],
        },
      },
    },
    required: ['entries'],
  },
};

const MAX_ENTRIES = 32;
const MAX_ALIASES = 24;
const MAX_NAME_LENGTH = 300;
const MAX_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const MAX_EMOTION_LENGTH = 120;
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
const PAIR_SEPARATOR = '\u0000';
const GENERIC_IDENTITIES = new Set(
  'i me my we us our you your he him his she her it they them someone somebody user theuser persona player 你 您 我 他 她 它 我们 你们 他们 她们 用户 人类 玩家'.split(
    ' ',
  ),
);
const LANGUAGE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['中文', 'zh'],
  ['普通话', 'zh'],
  ['粤语', 'zh'],
  ['chinese', 'zh'],
  ['mandarin', 'zh'],
  ['英语', 'en'],
  ['英文', 'en'],
  ['english', 'en'],
  ['日语', 'ja'],
  ['日文', 'ja'],
  ['japanese', 'ja'],
  ['韩语', 'ko'],
  ['韩文', 'ko'],
  ['korean', 'ko'],
  ['法语', 'fr'],
  ['french', 'fr'],
  ['德语', 'de'],
  ['german', 'de'],
  ['西班牙语', 'es'],
  ['spanish', 'es'],
  ['俄语', 'ru'],
  ['russian', 'ru'],
  ['阿拉伯语', 'ar'],
  ['arabic', 'ar'],
  ['en', 'en'],
  ['zh', 'zh'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['fr', 'fr'],
  ['de', 'de'],
  ['es', 'es'],
  ['ru', 'ru'],
  ['ar', 'ar'],
];
const COUNTRY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['中国', 'zh'],
  ['中国大陆', 'zh'],
  ['台湾', 'zh'],
  ['香港', 'zh'],
  ['china', 'zh'],
  ['taiwan', 'zh'],
  ['美国', 'en'],
  ['英国', 'en'],
  ['united states', 'en'],
  ['united kingdom', 'en'],
  ['日本', 'ja'],
  ['japan', 'ja'],
  ['韩国', 'ko'],
  ['korea', 'ko'],
  ['法国', 'fr'],
  ['france', 'fr'],
  ['德国', 'de'],
  ['germany', 'de'],
];
const LANGUAGE_FIELDS = ['language', 'languages', 'locale', 'locales', 'spokenLanguage', 'spokenLanguages'];
const NATIONALITY_FIELDS = ['nationality', 'nationalities', 'country', 'countries'];
const PERSON_NAME_FIELDS = ['name', 'displayName', 'characterName', 'personaName'];
const PERSON_COLLECTION_FIELDS = ['people', 'persons', 'characters', 'participants', 'roster'];
type PersonDescriptor = {
  role: 'user' | 'character';
  names: Set<string>;
  languages: Set<string>;
};

type PersonInfo = {
  descriptors: PersonDescriptor[];
  hasPersona: boolean;
  strict: boolean;
  enforceMissing: boolean;
};

type LanguageValidation = {
  candidates: Map<string, Set<string>>;
  mismatches: Set<string>;
};

let generationSequence = 0;

export function createCastingGenerationId(now = Date.now()): string {
  generationSequence += 1;
  return 'ganggang-casting-' + now + '-' + generationSequence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every(key => hasOwn(value, key));
}

function pairKey(providerProfileId: string, voiceId: string): string {
  return providerProfileId + PAIR_SEPARATOR + voiceId;
}

function resolveRuntime(runtime?: Partial<CastingRuntime>): CastingRuntime {
  const globals = globalThis as typeof globalThis & {
    generateRaw?: GenerateRawLike;
    stopGenerationById?: (generationId: string) => boolean;
    TavernHelper?: Partial<CastingRuntime>;
  };
  const helper = globals.TavernHelper;
  const generateRaw = runtime?.generateRaw ?? globals.generateRaw ?? helper?.generateRaw;
  const stopGenerationById = runtime?.stopGenerationById ?? globals.stopGenerationById ?? helper?.stopGenerationById;
  if (typeof generateRaw !== 'function' || typeof stopGenerationById !== 'function') {
    throw new Error('杠杠の配音室需要 Tavern Helper 的 generateRaw/stopGenerationById 接口');
  }
  return { generateRaw, stopGenerationById };
}

function promptPayload(request: CastingRequest): Record<string, unknown> {
  const payload = buildCastingRequestPayload(request.context, request.voices);
  const context: Record<string, unknown> = isRecord(payload.context) ? { ...payload.context } : {};
  delete context.characterKey;
  return {
    context,
    voices: Array.isArray(payload.voices) ? payload.voices.map(voice => ({ ...voice })) : [],
  };
}

export function buildCastingPrompt(_request: CastingRequest): CastingPrompt[] {
  return [
    {
      role: 'system',
      content:
        '你是配音导演。只根据唯一的输入资料 JSON 生成配音表。根对象只能有 entries 数组，最多 32 项；每项必须有 role、displayName、aliases、providerProfileId、voiceId，role 只能是 narrator、user、character 或 fallback。旁白必须恰好一个；存在 Persona 时 user 必须恰好一个；fallback 最多一个。aliases 只能使用稳定称谓，不能使用你、他、她、我、it、you、he、she 等泛代词。只逐字选择 voices 清单中的 providerProfileId+voiceId，不能创造、改写或猜测 ID。先按人物实际使用语言匹配 voice 的 locale、名称、标签和描述，再考虑性别、年龄和声线；不得为了去重跨语言。旁白音色必须独立。按输出顺序排列的前五个 user/character 优先人物，在兼容音色足够时必须使用不同音色。你不能听到音频。只返回规范 JSON，不输出解释。',
    },
  ];
}

export function buildCastingUserInput(request: CastingRequest): string {
  return [
    '下面是本次配音表的唯一输入资料。不要使用酒馆其他提示词、记忆或未列出的音色。',
    JSON.stringify(promptPayload(request), null, 2),
    '只返回符合 JSON Schema 的 JSON；资料没有明确人物或语言时不要猜测，返回将由本地安全校验。',
  ].join('\n\n');
}

function parseJsonResult(result: unknown): unknown {
  if (typeof result !== 'string') {
    throw new CastingValidationError('INVALID_JSON', '配音表生成没有返回 JSON 文本');
  }
  const fence = String.fromCharCode(96).repeat(3);
  const text = result
    .trim()
    .replace(new RegExp('^' + fence + '(?:json)?\\s*', 'iu'), '')
    .replace(new RegExp('\\s*' + fence + '$', 'u'), '')
    .trim();
  if (!text) throw new CastingValidationError('INVALID_JSON', '配音表生成返回为空');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CastingValidationError('INVALID_JSON', '配音表生成返回的 JSON 无法解析');
  }
}

function normalizeVoiceRef(value: unknown, allowed: Set<string>, label: string): VoiceRef | null {
  if (!isRecord(value)) return null;
  const providerProfileId = textValue(value.providerProfileId);
  const voiceId = textValue(value.voiceId);
  if (!providerProfileId || !voiceId) return null;
  if (!allowed.has(pairKey(providerProfileId, voiceId))) {
    throw new CastingValidationError('UNKNOWN_VOICE', label + '选择了请求之外的音色');
  }
  const voice: VoiceRef = { providerProfileId, voiceId };
  if (hasOwn(value, 'speed')) {
    const speed = numberValue(value.speed);
    if (speed === undefined || speed < MIN_SPEED || speed > MAX_SPEED) {
      throw new CastingValidationError('INVALID_ENTRY', label + '的 speed 超出允许范围');
    }
    voice.speed = speed;
  }
  if (hasOwn(value, 'emotion')) {
    const emotion = textValue(value.emotion);
    if (emotion.length > MAX_EMOTION_LENGTH) {
      throw new CastingValidationError('INVALID_ENTRY', label + '的 emotion 过长');
    }
    if (emotion) voice.emotion = emotion;
  }
  return voice;
}

function normalizedIdentity(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s"'“”‘’.,!?;:(){}<>/\\|_-]+/gu, '');
}

function isGenericIdentity(value: string): boolean {
  return GENERIC_IDENTITIES.has(normalizedIdentity(value));
}

function normalizeAliases(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new CastingValidationError('INVALID_ENTRY', label + '的 aliases 必须是数组');
  }
  if (value.length > MAX_ALIASES) {
    throw new CastingValidationError('INVALID_ENTRY', label + '的 aliases 数量超出上限');
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new CastingValidationError('INVALID_ENTRY', label + '的第 ' + (index + 1) + ' 个别名无效');
    }
    const alias = item.trim();
    const identity = normalizedIdentity(alias);
    if (!alias || alias.length > MAX_NAME_LENGTH) {
      throw new CastingValidationError('INVALID_ENTRY', label + '的别名长度无效');
    }
    if (isGenericIdentity(alias)) {
      throw new CastingValidationError('GENERIC_ALIAS', label + '的 aliases 不能使用泛代词');
    }
    if (seen.has(identity)) {
      throw new CastingValidationError('INVALID_ENTRY', label + '的 aliases 不能重复');
    }
    seen.add(identity);
    return alias;
  });
}

function normalizeEntry(value: unknown, index: number, allowed: Set<string>): CastingContractEntry {
  const label = '配音表第 ' + (index + 1) + ' 项';
  if (!isRecord(value)) throw new CastingValidationError('INVALID_ENTRY', label + '格式无效');
  const allowedFields = [
    'id',
    'role',
    'displayName',
    'aliases',
    'providerProfileId',
    'voiceId',
    'speed',
    'emotion',
    'reason',
  ];
  const requiredFields = ['role', 'displayName', 'aliases', 'providerProfileId', 'voiceId'];
  if (Object.keys(value).some(key => !allowedFields.includes(key))) {
    throw new CastingValidationError('INVALID_ENTRY', label + '包含未知字段');
  }
  if (requiredFields.some(key => !hasOwn(value, key))) {
    throw new CastingValidationError('INVALID_ENTRY', label + '缺少必填字段');
  }

  const role = value.role;
  if (role !== 'narrator' && role !== 'user' && role !== 'character' && role !== 'fallback') {
    throw new CastingValidationError('INVALID_ENTRY', label + '角色类型无效');
  }
  const displayName = textValue(value.displayName);
  if (!displayName || displayName.length > MAX_NAME_LENGTH) {
    throw new CastingValidationError('INVALID_ENTRY', label + '缺少有效角色名称');
  }
  if (role !== 'narrator' && isGenericIdentity(displayName)) {
    throw new CastingValidationError('GENERIC_ALIAS', label + '不能使用泛称作为角色名称');
  }
  const aliases = normalizeAliases(value.aliases, label);
  const ownIdentities = new Set([displayName, ...aliases].map(normalizedIdentity));
  if (ownIdentities.size !== aliases.length + 1) {
    throw new CastingValidationError('INVALID_ENTRY', label + '的名称和 aliases 不能重复');
  }
  const voice = normalizeVoiceRef(value, allowed, label);
  if (!voice) throw new CastingValidationError('UNKNOWN_VOICE', label + '缺少可用音色');

  let id = role + '-' + (index + 1);
  if (hasOwn(value, 'id')) {
    if (typeof value.id !== 'string' || value.id.trim().length > MAX_ID_LENGTH) {
      throw new CastingValidationError('INVALID_ENTRY', label + '的 id 无效');
    }
    if (value.id.trim()) id = value.id.trim();
  }
  let reason: string | undefined;
  if (hasOwn(value, 'reason')) {
    if (typeof value.reason !== 'string' || value.reason.trim().length > MAX_REASON_LENGTH) {
      throw new CastingValidationError('INVALID_ENTRY', label + '的 reason 无效');
    }
    if (value.reason.trim()) reason = value.reason.trim();
  }
  return { id, role, displayName, aliases, voice, ...(reason ? { reason } : {}) };
}

function isNarratorName(value: string): boolean {
  const identity = normalizedIdentity(value);
  return identity === '旁白' || identity === 'narrator';
}

function normalizeVoiceTableEntry(value: unknown, index: number, voices: VoiceOption[]): CastingContractEntry {
  const label = 'voiceTable 第 ' + (index + 1) + ' 项';
  if (!isRecord(value) || !hasExactKeys(value, ['roleName', 'voiceId'])) {
    throw new CastingValidationError('INVALID_ENTRY', label + '格式无效');
  }
  const displayName = textValue(value.roleName);
  const voiceId = textValue(value.voiceId);
  if (!displayName || !voiceId) {
    throw new CastingValidationError('INVALID_ENTRY', label + '缺少 roleName 或 voiceId');
  }
  const matches = voices.filter(voice => voice.voiceId === voiceId);
  if (matches.length !== 1) {
    throw new CastingValidationError('UNKNOWN_VOICE', label + '的 voiceId 无法唯一匹配音色来源');
  }
  const role: CastingRole = isNarratorName(displayName) ? 'narrator' : 'character';
  if (role !== 'narrator' && isGenericIdentity(displayName)) {
    throw new CastingValidationError('GENERIC_ALIAS', label + '不能使用泛称作为角色名称');
  }
  return {
    id: role + '-' + (index + 1),
    role,
    displayName,
    aliases: [],
    voice: { providerProfileId: matches[0].providerProfileId, voiceId },
  };
}

function normalizeLegacyVoiceRef(
  value: unknown,
  label: string,
  allowed: Set<string>,
  expectedKeys: readonly string[] = ['providerProfileId', 'voiceId'],
): VoiceRef {
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
    throw new CastingValidationError('INVALID_ENTRY', label + '音色格式无效');
  }
  const voice = normalizeVoiceRef(value, allowed, label);
  if (!voice) throw new CastingValidationError('UNKNOWN_VOICE', label + '缺少可用音色');
  return voice;
}

function normalizeLegacyObjectResult(parsed: Record<string, unknown>, allowed: Set<string>): CastingContractEntry[] {
  if (!hasExactKeys(parsed, ['narrator', 'characters'])) {
    throw new CastingValidationError('INVALID_ROOT', '配音表兼容根字段格式无效');
  }
  const narratorVoice = normalizeLegacyVoiceRef(parsed.narrator, 'narrator', allowed);
  if (!Array.isArray(parsed.characters)) {
    throw new CastingValidationError('INVALID_ENTRY', '配音表 characters 必须是数组');
  }
  if (parsed.characters.length > MAX_ENTRIES - 1) {
    throw new CastingValidationError('ROLE_COUNT', '配音表角色数量超出 32 项技术上限');
  }
  const entries: CastingContractEntry[] = [
    { id: 'narrator-1', role: 'narrator', displayName: '旁白', aliases: [], voice: narratorVoice },
  ];
  parsed.characters.forEach((value, index) => {
    const label = 'characters 第 ' + (index + 1) + ' 项';
    if (!isRecord(value) || !hasExactKeys(value, ['characterName', 'providerProfileId', 'voiceId'])) {
      throw new CastingValidationError('INVALID_ENTRY', label + '格式无效');
    }
    const displayName = textValue(value.characterName);
    if (!displayName || displayName.length > MAX_NAME_LENGTH) {
      throw new CastingValidationError('INVALID_ENTRY', label + '缺少 characterName');
    }
    if (isGenericIdentity(displayName)) {
      throw new CastingValidationError('GENERIC_ALIAS', label + '不能使用泛称作为角色名称');
    }
    entries.push({
      id: 'character-' + (index + 1),
      role: 'character',
      displayName,
      aliases: [],
      voice: normalizeLegacyVoiceRef(value, label, allowed, ['characterName', 'providerProfileId', 'voiceId']),
    });
  });
  return entries;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => stringValues(item));
  return [];
}

function languageTokensFromText(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().trim().replace(/[_/]/gu, '-');
  const tokens = new Set<string>();
  for (const [alias, language] of LANGUAGE_ALIASES) {
    const found =
      alias.length > 2
        ? normalized.includes(alias)
        : new RegExp('(^|[^a-z])' + alias + '([^a-z]|$)', 'u').test(normalized);
    if (found) tokens.add(language);
  }
  for (const [alias, language] of COUNTRY_ALIASES) {
    if (normalized.includes(alias)) tokens.add(language);
  }
  const codeMatches = normalized.match(/[a-z]{2,3}(?:-[a-z]{2,4})?/gu) ?? [];
  for (const code of codeMatches) {
    const languageCode = code.split('-')[0];
    const language = LANGUAGE_ALIASES.find(([alias]) => alias === languageCode)?.[1];
    if (language) tokens.add(language);
  }
  return tokens;
}

function languageTokensFromValues(values: unknown[]): Set<string> {
  const tokens = new Set<string>();
  values
    .flatMap(value => stringValues(value))
    .map(value => value.trim())
    .filter(Boolean)
    .forEach(value => languageTokensFromText(value).forEach(token => tokens.add(token)));
  return tokens;
}

function descriptorFrom(
  value: unknown,
  role: 'user' | 'character',
  fallbackName: string | undefined,
  extraValues: unknown[] = [],
): PersonDescriptor | null {
  const record = isRecord(value) ? value : {};
  const names = new Set<string>();
  for (const field of PERSON_NAME_FIELDS) {
    for (const name of stringValues(record[field])) {
      const identity = normalizedIdentity(name);
      if (identity) names.add(identity);
    }
  }
  if (fallbackName) {
    const identity = normalizedIdentity(fallbackName);
    if (identity) names.add(identity);
  }
  if (names.size === 0) return null;
  const spokenValues = LANGUAGE_FIELDS.flatMap(field => (hasOwn(record, field) ? [record[field]] : []));
  const nationalityValues = NATIONALITY_FIELDS.flatMap(field => (hasOwn(record, field) ? [record[field]] : []));
  const spokenLanguages = languageTokensFromValues([...spokenValues, ...extraValues]);
  return {
    role,
    names,
    languages: spokenLanguages.size ? spokenLanguages : languageTokensFromValues(nationalityValues),
  };
}

function roleForPerson(value: Record<string, unknown>): 'user' | 'character' {
  const role = textValue(value.role).toLocaleLowerCase();
  return role === 'user' || role === 'persona' || role === 'self' || value.isUser === true || value.isPersona === true
    ? 'user'
    : 'character';
}

function extractPersonInfo(context: CastingContext): PersonInfo {
  const record = context as unknown as Record<string, unknown>;
  const descriptors: PersonDescriptor[] = [];
  const personaValue = record.persona ?? record.user;
  const hasPersona =
    meaningful(personaValue) || meaningful(record.personaName) || meaningful(record.personaDescription);
  if (hasPersona) {
    const persona = descriptorFrom(personaValue, 'user', textValue(record.personaName), [
      record.personaLanguage,
      record.personaNationality,
    ]);
    if (persona) descriptors.push(persona);
  }

  let hasCollection = false;
  for (const field of PERSON_COLLECTION_FIELDS) {
    const items = collectionEntries(record[field]);
    if (items.length === 0) continue;
    hasCollection = true;
    for (const item of items) {
      if (!isRecord(item.value)) continue;
      const descriptor = descriptorFrom(item.value, roleForPerson(item.value), item.fallbackName);
      if (descriptor) descriptors.push(descriptor);
    }
  }

  const topLanguageValues = [...LANGUAGE_FIELDS, ...NATIONALITY_FIELDS].flatMap(field => {
    const key = 'character' + field[0].toLocaleUpperCase() + field.slice(1);
    return hasOwn(record, key) ? [record[key]] : [];
  });
  const main = descriptorFrom(
    { name: record.characterName, language: record.characterLanguage, nationality: record.characterNationality },
    'character',
    textValue(record.characterName),
    [...topLanguageValues],
  );
  if (main) descriptors.push(main);
  const explicitLanguage = topLanguageValues.some(value => stringValues(value).some(text => text.trim()));
  const personaLanguage = descriptors.find(descriptor => descriptor.role === 'user')?.languages.size ?? 0;
  const strict = hasCollection || explicitLanguage || personaLanguage > 0;
  return { descriptors, hasPersona, strict, enforceMissing: hasCollection || explicitLanguage };
}

function meaningful(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return value.enabled !== false && Object.keys(value).length > 0;
  return value !== null && value !== undefined && Boolean(value);
}

function collectionEntries(value: unknown): Array<{ value: unknown; fallbackName?: string }> {
  if (Array.isArray(value)) return value.map(item => ({ value: item }));
  if (isRecord(value)) return Object.entries(value).map(([fallbackName, item]) => ({ value: item, fallbackName }));
  return [];
}

function descriptorForEntry(
  entry: CastingContractEntry,
  descriptors: readonly PersonDescriptor[],
): PersonDescriptor | undefined {
  const role = entry.role === 'user' ? 'user' : 'character';
  const identities = [entry.displayName, ...entry.aliases].map(normalizedIdentity);
  return descriptors.find(
    descriptor => descriptor.role === role && identities.some(identity => descriptor.names.has(identity)),
  );
}

function voiceLanguageTokens(voice: VoiceOption): Set<string> {
  const locale = languageTokensFromValues([voice.locale]);
  return locale.size > 0 ? locale : languageTokensFromValues([voice.name, voice.description, voice.tags]);
}

function hasLanguageIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function validateLanguageAssignments(
  entries: readonly CastingContractEntry[],
  context: CastingContext,
  voices: VoiceOption[],
): LanguageValidation {
  const info = extractPersonInfo(context);
  const voiceLanguages = new Map<string, Set<string>>();
  voices.forEach(voice => {
    voiceLanguages.set(pairKey(voice.providerProfileId, voice.voiceId), voiceLanguageTokens(voice));
  });
  const result: LanguageValidation = { candidates: new Map(), mismatches: new Set() };
  if (!info.strict) return result;

  const people = entries.filter(entry => entry.role === 'user' || entry.role === 'character');
  const descriptors = new Map<string, PersonDescriptor>();
  for (const entry of people) {
    const descriptor = descriptorForEntry(entry, info.descriptors);
    if (!descriptor) {
      if (info.enforceMissing) {
        throw new CastingValidationError('UNKNOWN_PERSON', entry.displayName + '不在输入资料的人物清单中');
      }
      continue;
    }
    descriptors.set(entry.id, descriptor);
  }
  for (const entry of people) {
    const descriptor = descriptors.get(entry.id);
    if (!descriptor || descriptor.languages.size === 0) {
      if (info.enforceMissing) {
        throw new CastingValidationError('LANGUAGE_INFO_MISSING', entry.displayName + '缺少可验证的语言信息');
      }
    }
  }
  for (const entry of people) {
    const descriptor = descriptors.get(entry.id);
    if (!descriptor || descriptor.languages.size === 0) continue;
    const candidates = new Set<string>();
    voiceLanguages.forEach((languages, key) => {
      if (hasLanguageIntersection(descriptor.languages, languages)) candidates.add(key);
    });
    if (candidates.size === 0) {
      throw new CastingValidationError('COMPATIBLE_VOICE_INSUFFICIENT', entry.displayName + '没有兼容语言的可用音色');
    }
    result.candidates.set(entry.id, candidates);

    const selectedKey = pairKey(entry.voice.providerProfileId, entry.voice.voiceId);
    const selectedLanguages = voiceLanguages.get(selectedKey);
    if (!selectedLanguages || selectedLanguages.size === 0) {
      throw new CastingValidationError(
        'VOICE_LOCALE_INFO_MISSING',
        entry.displayName + '所选音色缺少可验证的 locale 或语言元数据',
      );
    }
    if (!hasLanguageIntersection(descriptor.languages, selectedLanguages)) result.mismatches.add(entry.id);
  }
  return result;
}

function canAssignDistinct(
  priority: readonly CastingContractEntry[],
  candidates: Map<string, Set<string>>,
  allVoices: Set<string>,
  narratorKey: string | undefined,
): boolean {
  const assigned = new Map<string, string>();
  const visit = (entryId: string, seen: Set<string>): boolean => {
    const options = candidates.get(entryId) ?? allVoices;
    for (const key of options) {
      if (key === narratorKey || seen.has(key)) continue;
      seen.add(key);
      const old = assigned.get(key);
      if (!old || visit(old, seen)) {
        assigned.set(key, entryId);
        return true;
      }
    }
    return false;
  };
  return priority.every(entry => visit(entry.id, new Set<string>()));
}

function validateVoiceUsage(
  entries: readonly CastingContractEntry[],
  voices: VoiceOption[],
  language: LanguageValidation,
): void {
  const narrator = entries.find(entry => entry.role === 'narrator');
  const people = entries.filter(entry => entry.role === 'user' || entry.role === 'character');
  const priority = people.slice(0, 5);
  const allVoices = new Set(voices.map(voice => pairKey(voice.providerProfileId, voice.voiceId)));
  const narratorKey = narrator ? pairKey(narrator.voice.providerProfileId, narrator.voice.voiceId) : undefined;

  if (priority.length > 0 && !canAssignDistinct(priority, language.candidates, allVoices, narratorKey)) {
    throw new CastingValidationError('COMPATIBLE_VOICE_INSUFFICIENT', '前五个优先人物没有足够的兼容独立音色');
  }
  if (
    narrator &&
    narratorKey &&
    entries.some(
      entry => entry !== narrator && pairKey(entry.voice.providerProfileId, entry.voice.voiceId) === narratorKey,
    )
  ) {
    if (allVoices.size < 2) {
      throw new CastingValidationError('COMPATIBLE_VOICE_INSUFFICIENT', '旁白没有可独立使用的其他音色');
    }
    throw new CastingValidationError('NARRATOR_VOICE_NOT_INDEPENDENT', '旁白音色必须与人物音色独立');
  }
  if (language.mismatches.size > 0) {
    const entry = people.find(item => language.mismatches.has(item.id));
    throw new CastingValidationError(
      'VOICE_LANGUAGE_MISMATCH',
      (entry?.displayName ?? '人物') + '所选音色与人物语言不匹配',
    );
  }
  const seen = new Set<string>();
  for (const entry of priority) {
    const key = pairKey(entry.voice.providerProfileId, entry.voice.voiceId);
    if (seen.has(key)) {
      throw new CastingValidationError('DUPLICATE_PRIORITY_VOICE', '前五个优先人物不得重复使用音色');
    }
    seen.add(key);
  }
}

export function validateCastingEntries(
  entries: readonly CastingContractEntry[],
  context: CastingContext,
  voices: VoiceOption[],
): void {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new CastingValidationError('ROLE_COUNT', '配音表条目数量超出 1-32 的技术上限');
  }
  if (entries.filter(entry => entry.role === 'narrator').length !== 1) {
    throw new CastingValidationError('ROLE_COUNT', '配音表必须恰好包含一个旁白');
  }
  if (entries.filter(entry => entry.role === 'fallback').length > 1) {
    throw new CastingValidationError('ROLE_COUNT', '配音表最多只能包含一个兜底身份');
  }
  const userCount = entries.filter(entry => entry.role === 'user').length;
  if (userCount > 1) throw new CastingValidationError('ROLE_COUNT', '配音表最多只能包含一个 user');
  const info = extractPersonInfo(context);
  if (info.hasPersona && userCount !== 1) {
    throw new CastingValidationError('PERSONA_USER_REQUIRED', '存在 Persona 时配音表必须恰好包含一个 user');
  }

  const owners = new Map<string, number>();
  entries.forEach((entry, index) => {
    for (const identity of [entry.displayName, ...entry.aliases].map(normalizedIdentity)) {
      const owner = owners.get(identity);
      if (owner !== undefined && owner !== index) {
        throw new CastingValidationError('INVALID_ENTRY', '不同角色的名称或别名不能重复');
      }
      owners.set(identity, index);
    }
  });

  const available = sanitizeVoiceOptions(voices);
  if (available.length === 0) throw new CastingValidationError('UNKNOWN_VOICE', '没有可用于校验配音表的音色');
  const language = validateLanguageAssignments(entries, context, available);
  validateVoiceUsage(entries, available, language);
}

class StaleCastingInputError extends Error {
  readonly code = 'STALE_CASTING_INPUT';

  constructor() {
    super('生成期间角色或音色输入已变化');
    this.name = 'StaleCastingInputError';
  }
}

export function isStaleCastingInputError(value: unknown): boolean {
  return value instanceof StaleCastingInputError;
}

function parseCanonicalEntries(parsed: Record<string, unknown>, allowed: Set<string>): CastingContractEntry[] {
  if (!hasExactKeys(parsed, ['entries']) || !Array.isArray(parsed.entries)) {
    throw new CastingValidationError('INVALID_ROOT', '配音表根对象只能包含 entries 数组');
  }
  if (parsed.entries.length === 0 || parsed.entries.length > MAX_ENTRIES) {
    throw new CastingValidationError('ROLE_COUNT', '配音表条目数量超出 1-32 的技术上限');
  }
  return parsed.entries.map((entry, index) => normalizeEntry(entry, index, allowed));
}

export function parseCastingResult(
  result: unknown,
  context: CastingContext,
  voices: VoiceOption[],
  now = Date.now,
): CastingTable {
  const parsed = parseJsonResult(result);
  if (!isRecord(parsed)) throw new CastingValidationError('INVALID_ROOT', '配音表 JSON 根对象无效');
  const available = sanitizeVoiceOptions(voices);
  if (available.length === 0) throw new CastingValidationError('UNKNOWN_VOICE', '没有可用于校验配音表的音色');
  const allowed = new Set(available.map(voice => pairKey(voice.providerProfileId, voice.voiceId)));

  let entries: CastingContractEntry[];
  if (hasOwn(parsed, 'entries')) {
    entries = parseCanonicalEntries(parsed, allowed);
  } else if (hasOwn(parsed, 'voiceTable')) {
    if (!hasExactKeys(parsed, ['voiceTable']) || !Array.isArray(parsed.voiceTable)) {
      throw new CastingValidationError('INVALID_ROOT', 'voiceTable 只能作为配音表根字段');
    }
    if (parsed.voiceTable.length === 0 || parsed.voiceTable.length > MAX_ENTRIES) {
      throw new CastingValidationError('ROLE_COUNT', 'voiceTable 条目数量超出技术上限');
    }
    entries = parsed.voiceTable.map((entry, index) => normalizeVoiceTableEntry(entry, index, available));
  } else if (hasOwn(parsed, 'narrator') || hasOwn(parsed, 'characters')) {
    entries = normalizeLegacyObjectResult(parsed, allowed);
  } else {
    throw new CastingValidationError('INVALID_ROOT', '配音表 JSON 缺少 entries 数组');
  }

  validateCastingEntries(entries, context, available);
  return {
    characterKey: context.characterKey,
    characterName: context.characterName,
    generatedAt: now(),
    entries: entries.map(entry => entry as unknown as CastEntry),
  };
}

export function buildCastingRequest(context: CastingContext, voices: VoiceOption[]): CastingRequest {
  const sanitized = sanitizeVoiceOptions(voices);
  if (sanitized.length === 0) throw new Error('请先启用至少一个可用音色');
  return { context, voices: sanitized };
}

export async function generateCastingTable(options: GenerateCastingOptions): Promise<CastingTable> {
  const request = buildCastingRequest(options.context, options.voices);
  const runtime = resolveRuntime(options.runtime);
  const generationId = options.generationId?.trim() || createCastingGenerationId();
  const result = await runtime.generateRaw({
    generation_id: generationId,
    should_silence: true,
    should_stream: false,
    ordered_prompts: buildCastingPrompt(request),
    user_input: buildCastingUserInput(request),
    json_schema: CASTING_JSON_SCHEMA,
  });
  const table = parseCastingResult(result, request.context, request.voices, options.now ?? Date.now);
  if (options.isInputCurrent) {
    let current: boolean;
    try {
      current = options.isInputCurrent();
    } catch {
      current = false;
    }
    if (!current) throw new StaleCastingInputError();
  }
  return table;
}

export function stopCasting(generationId: string, runtime?: Partial<CastingRuntime>): boolean {
  const normalized = generationId.trim();
  if (!normalized) return false;
  return resolveRuntime(runtime).stopGenerationById(normalized);
}

export { saveCastingTable };
