import { parseDialogueLine } from './tts/text';
import type { CastingContext, VoiceOption } from './types';
import { formatVoiceCatalogForPrompt } from './voice-catalog-prompt';

export const CASTING_ROOM_JSON_SCHEMA = {
  name: 'ganggang_casting_room',
  description: '根据角色人设与口味，从给定音色目录中跨引擎提名候选音色，并生成一条贴合人设的试音例句。',
  strict: true,
  value: {
    type: 'object',
    additionalProperties: false,
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            providerProfileId: { type: 'string' },
            voiceId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['providerProfileId', 'voiceId', 'reason'],
        },
      },
      exampleLine: { type: 'string' },
    },
    required: ['candidates', 'exampleLine'],
  },
} as const;

export type CastingRoomCandidate = {
  providerProfileId: string;
  voiceId: string;
  reason: string;
};

export type CastingRoomResult = {
  candidates: CastingRoomCandidate[];
  exampleLine: string;
};

export const CASTING_ROOM_MAX_CANDIDATES = 10;
export const CASTING_ROOM_MAX_REASON_LENGTH = 300;
export const CASTING_ROOM_MAX_EXAMPLE_LENGTH = 200;

/** 试音例句的来源：用户手填 / 聊天记录 / AI 自拟。 */
export type CastingRoomExampleSource = '' | 'user' | 'chat' | 'ai';

export function castingRoomPrompt(
  context: CastingContext,
  voiceCatalog: VoiceOption[],
  tasteNotes: string,
  targetRoleName: string,
  exampleLineHint = '',
  candidateLimit = 8,
  exampleLineSource: CastingRoomExampleSource = '',
  displayCount = candidateLimit,
): Array<{ role: 'system' | 'user'; content: string }> {
  const catalogLines = formatVoiceCatalogForPrompt(voiceCatalog);
  const hint = exampleLineHint.trim();
  const limit = Math.max(1, Math.min(CASTING_ROOM_MAX_CANDIDATES, Math.floor(candidateLimit) || 8));
  const recentCount = Array.isArray(context.recentMessages) ? context.recentMessages.length : 0;
  const exampleInstruction = !hint
    ? '试音例句：请根据人设与最近聊天的语气自拟一句。'
    : exampleLineSource === 'user'
      ? `试音例句（用户指定，必须原样作为 exampleLine）：${hint}`
      : `参考台词（来自最近聊天里该角色说过的话；可以原样使用，也可以改写成更适合试音的短句）：${hint}`;
  return [
    {
      role: 'system',
      content:
        '你是配音导演。根据角色人设、最近聊天与口味档案，从音色目录中跨引擎提名最适合该角色的候选音色，并为该角色生成一条试音例句。规范 JSON 根字段必须是 candidates 与 exampleLine；candidates 每项必须包含 providerProfileId、voiceId、reason，且只能从目录中逐字选择组合，不能创造或改写任何 ID；reason 简述提名理由（贴合人设的哪一点、与聊天里的语气是否一致）。exampleLine 是给所有候选统一试音的台词（40 字以内、第一人称、带情绪张力、内容健康，不写舞台指示）。只返回规范 JSON，不要输出解释。',
    },
    {
      role: 'user',
      content: [
        '输出契约：根对象只能包含 candidates 数组与 exampleLine 字符串；candidates 每项必须包含 providerProfileId、voiceId、reason；只能逐字选择目录中列出的组合。',
        `目标角色：${targetRoleName}`,
        `候选数量：正好 ${limit} 个（这是用户设定的数量，可用音色不足时才允许少）；按合适度从高到低排列，其中前 ${Math.max(1, Math.min(limit, Math.floor(displayCount) || limit))} 个直接给用户试听，其余作为替换备选。`,
        `口味档案：${tasteNotes || '（未填写）'}`,
        exampleInstruction,
        `最近聊天记录：${recentCount > 0 ? `共 ${recentCount} 条，附在角色人设资料的 recentMessages 字段里；请据此判断这个角色的口癖、称呼、语速与情绪基调，理由里要能对上聊天里的表现。` : '（本次没有取到聊天记录，按人设判断）'}`,
        '角色人设资料：',
        JSON.stringify(context, null, 2),
        '音色目录：',
        catalogLines || '（目录为空）',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
}

/**
 * 从最近聊天里找这个角色真正说过的一句台词当试音例句。
 *
 * 优先用酒馆约定的对白行 `[角色|情绪]|「台词」`；找不到再退到最近一条 AI 回复里的引号内容。
 * 返回空串表示聊天里没有可用台词，交给 AI 现编。
 */
export function findCharacterExampleLine(
  context: CastingContext,
  roleName: string,
  aliases: readonly string[] = [],
): string {
  const target = roleName.trim().toLocaleLowerCase();
  if (!target) return '';
  const names = new Set([target, ...aliases.map(alias => alias.trim().toLocaleLowerCase()).filter(Boolean)]);
  const messages = Array.isArray(context.recentMessages) ? context.recentMessages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    for (const rawLine of String(message.message || '').split('\n')) {
      const parsed = parseDialogueLine(rawLine);
      if (!parsed) continue;
      if (!names.has(parsed.character.trim().toLocaleLowerCase())) continue;
      const line = parsed.text.trim();
      if (line.length >= 4) return line.slice(0, 120);
    }
  }

  // 没有标准对白行时，退一步用最近一条 AI 回复里的引号台词。
  // 注意：状态栏常写成「202X/11/14｜深秋｜21:42」，必须排除，否则会拿时间戳去试音。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const lines = String(message.message || '').split('\n');
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const line = lines[lineIndex].trim();
      if (!line || line.startsWith('<')) continue;
      const quoted = [...line.matchAll(/[“"]([^“”"\n]{4,80})[”"]/g)].map(match => match[1].trim());
      for (let quoteIndex = quoted.length - 1; quoteIndex >= 0; quoteIndex -= 1) {
        if (isSpeakableLine(quoted[quoteIndex])) return quoted[quoteIndex];
      }
    }
    break;
  }
  return '';
}

function isSpeakableLine(text: string): boolean {
  if (!text || text.length < 4 || text.length > 80) return false;
  // 状态栏/模板行：含分隔符、HTML、年份日期的一律跳过。
  if (/[｜|<>{}[\]]/.test(text)) return false;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(text)) return false;
  return /[\u4e00-\u9fa5a-zA-Z]/.test(text);
}

export function parseCastingRoomResult(
  raw: unknown,
  voiceCatalog: VoiceOption[],
  maxCandidates = 8,
  exampleLineOverride = '',
  exampleLineFallback = '',
): CastingRoomResult {
  let parsed: unknown = raw;
  if (typeof parsed === 'string') {
    const text = parsed
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('AI 海选返回的 JSON 无法解析');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 海选返回的 JSON 缺少根对象');
  }
  const record = parsed as Record<string, unknown>;
  const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
  if (!rawCandidates.length) throw new Error('AI 海选没有提名任何候选');
  const override = exampleLineOverride.trim().slice(0, CASTING_ROOM_MAX_EXAMPLE_LENGTH);
  const fallback = exampleLineFallback.trim().slice(0, CASTING_ROOM_MAX_EXAMPLE_LENGTH);
  // 用户手填的例句优先级最高；聊天台词只是兜底，让 AI 有机会改写成更顺口的试音句。
  const exampleLine =
    override ||
    String(record.exampleLine || '')
      .trim()
      .slice(0, CASTING_ROOM_MAX_EXAMPLE_LENGTH) ||
    fallback;
  if (!exampleLine) throw new Error('AI 海选没有生成试音例句');

  const catalogKeys = new Set(voiceCatalog.map(voice => `${voice.providerProfileId}\u0000${voice.voiceId}`));
  const candidates: CastingRoomCandidate[] = [];
  const seen = new Set<string>();
  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const providerProfileId = String((item as Record<string, unknown>).providerProfileId || '').trim();
    const voiceId = String((item as Record<string, unknown>).voiceId || '').trim();
    const reason = String((item as Record<string, unknown>).reason || '')
      .trim()
      .slice(0, CASTING_ROOM_MAX_REASON_LENGTH);
    const key = `${providerProfileId}\u0000${voiceId}`;
    if (!providerProfileId || !voiceId || !catalogKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ providerProfileId, voiceId, reason });
    if (candidates.length >= maxCandidates) break;
  }
  if (!candidates.length) throw new Error('AI 提名的候选都不在音色目录里，请重试或调整口味档案');
  return { candidates, exampleLine };
}
