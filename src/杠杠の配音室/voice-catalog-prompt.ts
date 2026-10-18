import type { VoiceOption } from './types';

export type VoiceCatalogPromptOptions = {
  /** 单条音色说明的最大字数：默认 120，目录很大时统一截断避免 prompt 爆长。 */
  maxDescriptionLength?: number;
  /** 是否按来源分段；默认 true，来源只有一个时自动省略段头。 */
  groupByProfile?: boolean;
};

const DEFAULT_MAX_DESCRIPTION_LENGTH = 120;

function describeVoice(voice: VoiceOption, maxDescriptionLength: number): string {
  const meta = [voice.gender, voice.locale, ...(voice.tags ?? [])].filter(Boolean).join('/');
  const head = meta ? `${voice.name} · ${meta}` : voice.name;
  const description = String(voice.description ?? '')
    .trim()
    .slice(0, maxDescriptionLength);
  return `- [${voice.providerProfileId}] ${voice.voiceId}（${head}）${description ? `：${description}` : ''}`;
}

/**
 * Render the voice catalog as a human-readable block for an AI prompt.
 *
 * 一键配音与选角间共用这份渲染：音色 ID 必须逐字出现（模型要原样回填），
 * 而名称/性别/语言/音色说明决定模型能否"读懂"这个音色，缺一不可。
 * 说明缺失时保留名称本身，不做任何编造。
 */
export function formatVoiceCatalogForPrompt(
  voices: readonly VoiceOption[],
  options: VoiceCatalogPromptOptions = {},
): string {
  const maxDescriptionLength = options.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
  const groupByProfile = options.groupByProfile ?? true;
  const groups = new Map<string, VoiceOption[]>();
  for (const voice of voices) {
    if (!voice?.providerProfileId || !voice?.voiceId) continue;
    const list = groups.get(voice.providerProfileId);
    if (list) list.push(voice);
    else groups.set(voice.providerProfileId, [voice]);
  }
  if (groups.size === 0) return '';

  const blocks: string[] = [];
  for (const [providerProfileId, group] of groups) {
    const lines = group.map(voice => describeVoice(voice, maxDescriptionLength));
    blocks.push(groupByProfile && groups.size > 1 ? `来源 ${providerProfileId}（${group.length} 个音色）\n${lines.join('\n')}` : lines.join('\n'));
  }
  return blocks.join('\n\n');
}
