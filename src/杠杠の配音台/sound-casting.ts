import { parseSoundCues } from './sound-effects';
import type { SoundCue, SoundEffectEntry, SpokenSegment } from './types';

type GenerateRawLike = (config: {
  generation_id: string;
  should_silence: true;
  should_stream: false;
  ordered_prompts: Array<{ role: 'system' | 'user'; content: string }>;
  json_schema: { name: string; description: string; strict: true; value: Record<string, unknown> };
}) => Promise<unknown>;

export type SoundCuePlanOptions = {
  messageId: number;
  message: string;
  segments: SpokenSegment[];
  catalog: SoundEffectEntry[];
  generationId?: string;
  generate?: GenerateRawLike;
};

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  return JSON.parse(normalized);
}

function enabledCatalog(catalog: SoundEffectEntry[]) {
  return catalog
    .filter(effect => effect.enabled && effect.id.trim() && effect.url.trim())
    .map(effect => ({
      id: effect.id,
      name: effect.name,
      category: effect.category,
      description: effect.description,
    }));
}

export async function planSoundCues(options: SoundCuePlanOptions): Promise<SoundCue[]> {
  const message = options.message.trim();
  const segments = options.segments
    .filter(segment => segment.sourceMessageId === options.messageId && segment.id.trim() && segment.text.trim())
    .slice(0, 64)
    .map(segment => ({ id: segment.id, text: segment.text.slice(0, 500) }));
  const catalog = enabledCatalog(options.catalog);
  if (!message || segments.length === 0 || catalog.length === 0) return [];
  const generate = options.generate ?? generateRaw;
  const allowedIds = catalog.map(effect => effect.id);
  const result = await generate({
    generation_id: options.generationId ?? `ganggang-sfx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    should_silence: true,
    should_stream: false,
    ordered_prompts: [
      {
        role: 'system',
        content:
          '你是有声书音效标注员。只从给定音效库选择少量真正有帮助的音效；sourceSegmentId 必须来自给定语音段，anchorText 必须逐字出现在该语音段 text 中，anchorOccurrence 是该短语在本段中从 0 开始的序号。不要改写原文，不要虚构 ID，不要为每句话都加音效。',
      },
      {
        role: 'user',
        content: JSON.stringify({ message, spokenSegments: segments, soundEffects: catalog }),
      },
    ],
    json_schema: {
      name: 'ganggang_sound_cues',
      description: '把音效按钮锚定到原文中的短文本。',
      strict: true,
      value: {
        type: 'object',
        additionalProperties: false,
        required: ['cues'],
        properties: {
          cues: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['effectId', 'sourceSegmentId', 'anchorText', 'anchorOccurrence', 'placement'],
              properties: {
                effectId: { type: 'string', enum: allowedIds },
                sourceSegmentId: { type: 'string', enum: segments.map(segment => segment.id) },
                anchorText: { type: 'string', minLength: 1, maxLength: 120 },
                anchorOccurrence: { type: 'integer', minimum: 0, maximum: 31 },
                placement: { type: 'string', enum: ['before', 'after'] },
              },
            },
          },
        },
      },
    },
  });

  return parseSoundCues(parseJson(result), options.catalog, {
    sourceMessageId: options.messageId,
    sourceSegments: options.segments,
    maxCues: 8,
  });
}
