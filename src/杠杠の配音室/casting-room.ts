import type { CastingContext, VoiceOption } from './types';

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

export const CASTING_ROOM_MAX_CANDIDATES = 12;
export const CASTING_ROOM_MAX_REASON_LENGTH = 300;
export const CASTING_ROOM_MAX_EXAMPLE_LENGTH = 200;

export function castingRoomPrompt(context: CastingContext, voiceCatalog: VoiceOption[], tasteNotes: string, targetRoleName: string): Array<{ role: 'system' | 'user'; content: string }> {
  const catalogLines = voiceCatalog
    .map(voice => {
      const tags = [voice.gender, voice.locale, ...(voice.tags || [])].filter(Boolean).join('/');
      const description = voice.description ? `：${voice.description.slice(0, 120)}` : '';
      return `- [${voice.providerProfileId}] ${voice.voiceId}（${voice.name}${tags ? ` · ${tags}` : ''}）${description}`;
    })
    .join('\n');
  return [
    {
      role: 'system',
      content:
        '你是配音导演。根据角色人设与口味档案，从音色目录中跨引擎提名最适合该角色的候选音色，并为该角色生成一条试音例句。规范 JSON 根字段必须是 candidates 与 exampleLine；candidates 每项必须包含 providerProfileId、voiceId、reason，且只能从目录中逐字选择组合，不能创造或改写任何 ID；reason 简述提名理由（贴合人设的哪一点）。exampleLine 是给所有候选统一试音的台词（40 字以内、第一人称、带情绪张力、内容健康，不写舞台指示）。只返回规范 JSON，不要输出解释。',
    },
    {
      role: 'user',
      content: [
        '输出契约：根对象只能包含 candidates 数组与 exampleLine 字符串；candidates 每项必须包含 providerProfileId、voiceId、reason；只能逐字选择目录中列出的组合。',
        `目标角色：${targetRoleName}`,
        `口味档案：${tasteNotes || '（未填写）'}`,
        '角色人设资料：',
        JSON.stringify(context, null, 2),
        '音色目录：',
        catalogLines || '（目录为空）',
      ].join('\n\n'),
    },
  ];
}

export function parseCastingRoomResult(
  raw: unknown,
  voiceCatalog: VoiceOption[],
  maxCandidates = 8,
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
  const exampleLine = String(record.exampleLine || '')
    .trim()
    .slice(0, CASTING_ROOM_MAX_EXAMPLE_LENGTH);
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
