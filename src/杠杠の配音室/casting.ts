import { buildCastingRequestPayload, sanitizeVoiceOptions } from './context';
import { saveCastingTable } from './settings';
import type { CastEntry, CastRole, CastingContext, CastingRequest, CastingTable, VoiceOption, VoiceRef } from './types';
import { formatVoiceCatalogForPrompt } from './voice-catalog-prompt';

type CastingPrompt = {
  role: 'system' | 'user';
  content: string;
};

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
  /** 口味档案：用户对声音的偏好说明，与选角间共用同一份。 */
  tasteNotes?: string;
  generationId?: string;
  now?: () => number;
  isInputCurrent?: () => boolean | Promise<boolean>;
  runtime?: Partial<CastingRuntime>;
};

// 注意：不要在此 schema 中加入 minItems/maxItems/minimum/maximum/enum 等约束关键字——
// 部分 OpenAI 兼容网关会直接以 400 拒绝它们；生成结果由 parseCastingResult 在代码侧完整校验。
export const CASTING_JSON_SCHEMA: CastingJsonSchema = {
  name: 'ganggang_voice_casting',
  description: '为当前角色卡选择主要叙述者和角色音色，只能使用请求中列出的音色组合。',
  strict: true,
  value: {
    type: 'object',
    additionalProperties: false,
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            displayName: { type: 'string' },
            aliases: { type: 'array', items: { type: 'string' } },
            providerProfileId: { type: 'string' },
            voiceId: { type: 'string' },
            speed: { type: 'number' },
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

let generationSequence = 0;

export function createCastingGenerationId(now = Date.now()): string {
  generationSequence += 1;
  return `ganggang-casting-${now}-${generationSequence}`;
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function resolveRuntime(runtime?: Partial<CastingRuntime>): CastingRuntime {
  const globalRuntime = globalThis as typeof globalThis & {
    generateRaw?: GenerateRawLike;
    stopGenerationById?: (generationId: string) => boolean;
  };
  const generateRaw = runtime?.generateRaw ?? globalRuntime.generateRaw;
  const stopGenerationById = runtime?.stopGenerationById ?? globalRuntime.stopGenerationById;
  if (typeof generateRaw !== 'function' || typeof stopGenerationById !== 'function') {
    throw new Error('杠杠の配音室需要 Tavern Helper 的 generateRaw/stopGenerationById 接口');
  }
  return { generateRaw, stopGenerationById };
}

/**
 * 一键配音的可读目录：音色 ID 必须逐字出现，名称/性别/语言/音色说明必须同时出现，
 * 否则模型只能凭"冰糖""苏打"这种代号瞎猜（2026-10-18 Gabby 反馈）。
 */
function buildCastingPrompt(request: CastingRequest, tasteNotes = ''): CastingPrompt[] {
  const payload = buildCastingRequestPayload(request.context, request.voices);
  const catalog = formatVoiceCatalogForPrompt(payload.voices);
  const taste = tasteNotes.trim();
  return [
    {
      role: 'system',
      content:
        '你是配音导演。请根据角色卡、用户 persona、绑定的世界书条目、最近聊天和口味档案，为旁白与主要角色制作配音表。' +
        '可用音色目录会逐条给出 providerProfileId、voiceId、音色名称、性别/语言和音色说明（音高、年龄感、质地、情绪底色）；' +
        '请依据这些说明和角色气质匹配，不要只凭音色名字的字面意思猜测；除非角色设定如此，不要把中文角色配给非中文音色。' +
        '规范 JSON 根字段必须是 entries；每项必须包含 role、displayName、aliases、providerProfileId、voiceId，' +
        '并附 reason（一句话说明这个音色贴合角色的哪一点：年龄、音高、质地或气质）。' +
        'role 只能是 narrator、character 或 fallback。必须且只能有一个 narrator，最多一个 fallback；不同角色的 displayName 和 aliases 不能重复。' +
        '只能逐字使用目录中给出的 providerProfileId 与 voiceId 组合，不能创造、改写或猜测任何音色 ID。只返回规范 JSON，不要输出解释。',
    },
    {
      role: 'user',
      content: [
        '输出契约：根对象只能包含 entries 数组；entries 的每一项必须包含 role、displayName、aliases、providerProfileId、voiceId、reason。不要使用其他根字段或包装。',
        `可用音色目录（方括号内是 providerProfileId，紧随其后是 voiceId，两者必须逐字选择）：\n${catalog || '（没有可用音色）'}`,
        `口味档案：${taste || '（未填写）'}`,
        `输入资料：\n${JSON.stringify({ context: payload.context }, null, 2)}`,
      ].join('\n\n'),
    },
  ];
}

function parseJsonResult(result: unknown): unknown {
  if (typeof result !== 'string') throw new Error('配音表生成没有返回 JSON 文本');
  const text = result
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!text) throw new Error('配音表生成返回为空');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('配音表生成返回的 JSON 无法解析');
  }
}

function normalizeVoiceRef(value: unknown): VoiceRef | null {
  if (!isRecord(value)) return null;
  const providerProfileId = textValue(value.providerProfileId);
  const voiceId = textValue(value.voiceId);
  if (!providerProfileId || !voiceId) return null;
  const result: VoiceRef = { providerProfileId, voiceId };
  const speed = numberValue(value.speed);
  if (speed !== undefined) result.speed = Math.min(4, Math.max(0.25, speed));
  const emotion = textValue(value.emotion);
  if (emotion) result.emotion = emotion.slice(0, 120);
  return result;
}

function normalizeEntry(value: unknown, index: number, allowed: Set<string>): CastEntry {
  if (!isRecord(value)) throw new Error(`配音表第 ${index + 1} 项格式无效`);
  const role = value.role;
  if (role !== 'narrator' && role !== 'character' && role !== 'fallback') {
    throw new Error(`配音表第 ${index + 1} 项角色类型无效`);
  }
  const displayName = textValue(value.displayName);
  if (!displayName) throw new Error(`配音表第 ${index + 1} 项缺少角色名称`);
  const voice = normalizeVoiceRef(value);
  if (!voice || !allowed.has(`${voice.providerProfileId}\u0000${voice.voiceId}`)) {
    throw new Error(`配音表第 ${index + 1} 项选择了请求之外的音色`);
  }
  const aliases = Array.isArray(value.aliases)
    ? [
        ...new Set(
          value.aliases
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return {
    id: textValue(value.id) || `${role}-${index + 1}`,
    role,
    displayName,
    aliases: aliases.slice(0, 24),
    voice,
    ...(textValue(value.reason) ? { reason: textValue(value.reason).slice(0, 500) } : {}),
  };
}

function isNarratorRoleName(value: string): boolean {
  const normalized = value.toLocaleLowerCase();
  return normalized === '旁白' || normalized === 'narrator';
}

function normalizeVoiceTableEntry(value: unknown, index: number, availableVoices: VoiceOption[]): CastEntry {
  if (!isRecord(value) || !hasExactKeys(value, ['roleName', 'voiceId'])) {
    throw new Error(`voiceTable 第 ${index + 1} 项格式无效`);
  }
  const displayName = textValue(value.roleName);
  const voiceId = textValue(value.voiceId);
  if (!displayName || !voiceId) throw new Error(`voiceTable 第 ${index + 1} 项缺少 roleName 或 voiceId`);

  const matches = availableVoices.filter(voice => voice.voiceId === voiceId);
  if (matches.length !== 1) {
    throw new Error(`voiceTable 第 ${index + 1} 项的 voiceId 无法唯一匹配音色来源`);
  }
  const role = isNarratorRoleName(displayName) ? 'narrator' : 'character';
  return {
    id: `${role}-${index + 1}`,
    role,
    displayName,
    aliases: [],
    voice: { providerProfileId: matches[0].providerProfileId, voiceId },
  };
}

function normalizeGeminiVoiceRef(
  value: unknown,
  label: string,
  allowed: Set<string>,
  expectedKeys: readonly string[] = ['providerProfileId', 'voiceId'],
): VoiceRef {
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
    throw new Error(`${label} 音色格式无效`);
  }
  const voice = normalizeVoiceRef(value);
  if (!voice || !allowed.has(`${voice.providerProfileId}\u0000${voice.voiceId}`)) {
    throw new Error(`${label} 选择了请求之外的音色`);
  }
  return voice;
}

function normalizeGeminiResult(parsed: Record<string, unknown>, allowed: Set<string>): CastEntry[] {
  if (!hasExactKeys(parsed, ['narrator', 'characters'])) {
    throw new Error('配音表 Gemini 根字段格式无效');
  }
  const narratorVoice = normalizeGeminiVoiceRef(parsed.narrator, 'narrator', allowed);
  if (!Array.isArray(parsed.characters)) throw new Error('配音表 characters 必须是数组');
  if (parsed.characters.length > 31) throw new Error('配音表最多支持 32 个角色音色');

  const entries: CastEntry[] = [
    {
      id: 'narrator-1',
      role: 'narrator',
      displayName: '旁白',
      aliases: [],
      voice: narratorVoice,
    },
  ];
  parsed.characters.forEach((value, index) => {
    if (!isRecord(value) || !hasExactKeys(value, ['characterName', 'providerProfileId', 'voiceId'])) {
      throw new Error(`characters 第 ${index + 1} 项格式无效`);
    }
    const displayName = textValue(value.characterName);
    if (!displayName) throw new Error(`characters 第 ${index + 1} 项缺少 characterName`);
    entries.push({
      id: `character-${index + 1}`,
      role: 'character',
      displayName,
      aliases: [],
      voice: normalizeGeminiVoiceRef(value, `characters 第 ${index + 1} 项`, allowed, [
        'characterName',
        'providerProfileId',
        'voiceId',
      ]),
    });
  });
  return entries;
}

function normalizedIdentity(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function validateCastingIdentities(entries: CastEntry[]): void {
  if (entries.filter(entry => entry.role === 'narrator').length !== 1) {
    throw new Error('配音表必须恰好包含一个旁白');
  }
  if (entries.filter(entry => entry.role === 'fallback').length > 1) {
    throw new Error('配音表最多只能包含一个兜底身份');
  }

  const identityOwners = new Map<string, number>();
  entries.forEach((entry, index) => {
    const ownIdentities = new Set([entry.displayName, ...entry.aliases].map(normalizedIdentity).filter(Boolean));
    ownIdentities.forEach(identity => {
      const owner = identityOwners.get(identity);
      if (owner !== undefined && owner !== index) throw new Error('不同角色的名称或别名不能重复');
      identityOwners.set(identity, index);
    });
  });
}

let manualEntrySequence = 0;

/** 为手动编辑的配音表生成稳定唯一的条目 id。 */
export function createManualCastEntry(role: CastRole, voice: VoiceRef, index: number): CastEntry {
  manualEntrySequence += 1;
  const rolePrefix = role === 'narrator' ? 'narrator' : role === 'fallback' ? 'fallback' : 'character';
  return {
    id: `manual-${rolePrefix}-${Date.now()}-${manualEntrySequence}`,
    role,
    displayName: role === 'narrator' ? '旁白' : `角色${index + 1}`,
    aliases: [],
    voice: { providerProfileId: voice.providerProfileId, voiceId: voice.voiceId },
  };
}

/** 把别名输入框的文本切分为去重后的别名数组。 */
export function parseAliasInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[、,，]/)
        .map(item => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** 校验手动编辑后的配音表条目；返回第一条错误文案，合法时返回 null。 */
export function findCastingEntryError(entries: CastEntry[]): string | null {
  if (entries.length === 0) return '配音表至少需要一项音色映射';
  if (entries.some(entry => !entry.displayName.trim())) return '角色名称不能为空';
  try {
    validateCastingIdentities(entries);
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
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

export function parseCastingResult(
  result: unknown,
  context: CastingContext,
  voices: VoiceOption[],
  now = Date.now,
): CastingTable {
  const parsed = parseJsonResult(result);
  if (!isRecord(parsed)) throw new Error('配音表 JSON 缺少 entries 数组');
  const availableVoices = sanitizeVoiceOptions(voices);
  if (availableVoices.length === 0) throw new Error('没有可用于校验配音表的音色');
  const allowed = new Set(availableVoices.map(voice => `${voice.providerProfileId}\u0000${voice.voiceId}`));
  const parsedEntries = parsed.entries;
  const parsedVoiceTable = parsed.voiceTable;
  const hasEntries = Array.isArray(parsedEntries);
  const hasVoiceTable = Array.isArray(parsedVoiceTable);
  const hasGeminiShape = hasExactKeys(parsed, ['narrator', 'characters']);
  const hasGeminiKeys =
    Object.prototype.hasOwnProperty.call(parsed, 'narrator') &&
    Object.prototype.hasOwnProperty.call(parsed, 'characters');
  if (hasGeminiKeys && !hasGeminiShape) throw new Error('配音表 Gemini 根字段不能包含额外字段');
  if (hasEntries && hasVoiceTable) throw new Error('配音表 JSON 不能同时包含 entries 和 voiceTable');

  let entries: CastEntry[];
  if (hasGeminiShape) {
    entries = normalizeGeminiResult(parsed, allowed);
  } else if (Array.isArray(parsedEntries)) {
    entries = parsedEntries.slice(0, 32).map((entry, index) => normalizeEntry(entry, index, allowed));
  } else if (Array.isArray(parsedVoiceTable)) {
    if (!hasExactKeys(parsed, ['voiceTable'])) throw new Error('voiceTable 只能作为配音表根字段');
    entries = parsedVoiceTable
      .slice(0, 32)
      .map((entry, index) => normalizeVoiceTableEntry(entry, index, availableVoices));
  } else {
    throw new Error('配音表 JSON 缺少 entries 数组');
  }
  if (entries.length === 0) throw new Error('配音表至少需要一项音色映射');
  validateCastingIdentities(entries);
  return {
    characterKey: context.characterKey,
    characterName: context.characterName,
    generatedAt: now(),
    entries,
  };
}

export function buildCastingRequest(context: CastingContext, voices: VoiceOption[]): CastingRequest {
  const sanitizedVoices = sanitizeVoiceOptions(voices);
  if (sanitizedVoices.length === 0) throw new Error('请先启用至少一个可用音色');
  return { context, voices: sanitizedVoices };
}

export async function generateCastingTable(options: GenerateCastingOptions): Promise<CastingTable> {
  const request = buildCastingRequest(options.context, options.voices);
  const runtime = resolveRuntime(options.runtime);
  const generationId = options.generationId?.trim() || createCastingGenerationId();
  const result = await runtime.generateRaw({
    generation_id: generationId,
    should_silence: true,
    should_stream: false,
    ordered_prompts: buildCastingPrompt(request, options.tasteNotes),
    json_schema: CASTING_JSON_SCHEMA,
  });
  const table = parseCastingResult(result, request.context, request.voices, options.now ?? Date.now);
  if (options.isInputCurrent) {
    let isCurrent: boolean;
    try {
      isCurrent = await Promise.resolve(options.isInputCurrent());
    } catch {
      isCurrent = false;
    }
    if (!isCurrent) throw new StaleCastingInputError();
  }
  return table;
}

export function stopCasting(generationId: string, runtime?: Partial<CastingRuntime>): boolean {
  const normalized = generationId.trim();
  if (!normalized) return false;
  return resolveRuntime(runtime).stopGenerationById(normalized);
}

export { saveCastingTable };
