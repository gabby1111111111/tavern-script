import {
  filterSegmentsForMode,
  mapSelectionToSegments,
  routeSpokenSegments,
  voiceRouteKey,
} from '../src/杠杠の配音室/reading';
import { buildReadingTimeline } from '../src/杠杠の配音室/reading-timeline';
import type { CastingTable, SoundCue, SpokenSegment } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const segments: SpokenSegment[] = [
  { id: 'n1', kind: 'narration', text: '门外下着雨。', characterName: null, sourceMessageId: 5 },
  { id: 'd1', kind: 'dialogue', text: '进来吧。', characterName: '阿青', sourceMessageId: 5 },
  { id: 'd2', kind: 'dialogue', text: '打扰了。', characterName: '小白', sourceMessageId: 5 },
];

const casting: CastingTable = {
  characterKey: 'card-1',
  characterName: '阿青',
  generatedAt: 1,
  entries: [
    {
      id: 'narrator',
      role: 'narrator',
      displayName: '旁白',
      aliases: [],
      voice: { providerProfileId: 'edge', voiceId: 'narrator-voice' },
    },
    {
      id: 'aqing',
      role: 'character',
      displayName: '阿青',
      aliases: ['青'],
      voice: { providerProfileId: 'doubao', voiceId: 'aqing-voice', emotion: 'happy' },
    },
    {
      id: 'fallback',
      role: 'fallback',
      displayName: '其他角色',
      aliases: [],
      voice: { providerProfileId: 'edge', voiceId: 'fallback-voice' },
    },
  ],
};

equal(
  filterSegmentsForMode(segments, 'dialogue-only').map(segment => segment.id),
  ['d1', 'd2'],
  '仅对白模式应移除旁白',
);
equal(
  filterSegmentsForMode(segments, 'character-only', '阿青').map(segment => segment.id),
  ['d1'],
  '指定角色模式应只保留对应对白',
);

const routed = routeSpokenSegments(segments, {
  mode: 'full',
  casting,
  singleVoice: null,
  fallbackVoice: null,
});
equal(
  routed.map(segment => segment.voice.voiceId),
  ['narrator-voice', 'aqing-voice', 'fallback-voice'],
  '配音表应按旁白、角色、兜底依次路由',
);
assert(voiceRouteKey(routed[1]).includes('happy'), '合成相关情绪应进入路由键');

const oneVoice = routeSpokenSegments(segments, {
  mode: 'single-voice',
  casting,
  singleVoice: { providerProfileId: 'mimo', voiceId: 'single' },
  fallbackVoice: null,
});
equal(
  oneVoice.map(segment => segment.voice.voiceId),
  ['single', 'single', 'single'],
  '单音色模式必须覆盖所有角色路由',
);

const mappedSelection = mapSelectionToSegments('进来吧', segments, 5);
equal(mappedSelection[0].characterName, '阿青', '可映射的选区应保留角色元数据');

const freeSelection = mapSelectionToSegments('没有来源的新选区', segments, 5);
equal(
  { kind: freeSelection[0].kind, characterName: freeSelection[0].characterName },
  { kind: 'dialogue', characterName: null },
  '无法映射的选区应形成无角色对白，让路由使用兜底音色',
);

const timelineCues: SoundCue[] = [
  {
    id: 'rain-before',
    effectId: 'rain-hit',
    sourceMessageId: 5,
    sourceSegmentId: 'n1',
    anchorText: '下着',
    anchorOccurrence: 0,
    placement: 'before',
  },
  {
    id: 'door-after',
    effectId: 'door-open',
    sourceMessageId: 5,
    sourceSegmentId: 'd1',
    anchorText: '进来',
    anchorOccurrence: 0,
    placement: 'after',
  },
  {
    id: 'ambient-ignored',
    effectId: 'long-rain',
    sourceMessageId: 5,
    sourceSegmentId: 'n1',
    anchorText: '雨',
    anchorOccurrence: 0,
    placement: 'after',
  },
];
const timeline = buildReadingTimeline(routed, timelineCues, {
  eligibleEffectIds: new Set(['rain-hit', 'door-open']),
});
equal(
  timeline.items.map(item => (item.kind === 'speech' ? `speech:${item.segment.text}` : `sound:${item.cue.effectId}`)),
  [
    'speech:门外',
    'sound:rain-hit',
    'speech:下着雨。',
    'speech:进来',
    'sound:door-open',
    'speech:吧。',
    'speech:打扰了。',
  ],
  '音效时间线应在 AI 锚点处拆分语音，并保持 speech → sound → speech 顺序',
);
equal(
  { speech: timeline.speechCount, sound: timeline.soundCount, ignored: timeline.ignoredCueCount },
  { speech: 5, sound: 2, ignored: 1 },
  '时间线应只串入允许的短音效，并报告被忽略的长环境音',
);
assert(
  timeline.items.filter(item => item.kind === 'speech').every(item => item.segment.voice.providerProfileId.length > 0),
  '拆分后的语音片段必须保留原路由音色',
);

const repeatedSegment = routeSpokenSegments(
  [{ id: 'repeat', kind: 'narration', text: '敲门，又敲门。', characterName: null, sourceMessageId: 8 }],
  {
    mode: 'full',
    casting,
    singleVoice: null,
    fallbackVoice: null,
  },
);
const repeatedTimeline = buildReadingTimeline(
  repeatedSegment,
  [
    {
      id: 'second-knock',
      effectId: 'knock',
      sourceMessageId: 8,
      sourceSegmentId: 'repeat',
      anchorText: '敲门',
      anchorOccurrence: 1,
      placement: 'after',
    },
  ],
  { eligibleEffectIds: new Set(['knock']) },
);
equal(
  repeatedTimeline.items.map(item => (item.kind === 'speech' ? item.segment.text : '[敲门声]')),
  ['敲门，又敲门', '[敲门声]', '。'],
  '重复锚点必须按 anchorOccurrence 精确放置，不能总命中第一次',
);
