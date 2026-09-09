import { routeSpokenSegments } from '../src/杠杠の配音室/reading';
import type { CastingTable, SpokenSegment } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const segments: SpokenSegment[] = [
  { id: 'user-name', kind: 'dialogue', text: '我想喝茶。', characterName: '小明', sourceMessageId: 1 },
  { id: 'user-alias', kind: 'dialogue', text: '好的。', characterName: '明哥', sourceMessageId: 1 },
  { id: 'generic-user', kind: 'dialogue', text: '继续。', characterName: '用户', sourceMessageId: 1 },
];

const casting = {
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
      id: 'user',
      role: 'user',
      displayName: '小明',
      aliases: ['明哥', '我'],
      voice: { providerProfileId: 'edge', voiceId: 'user-voice' },
    },
    {
      id: 'fallback',
      role: 'fallback',
      displayName: '其他角色',
      aliases: [],
      voice: { providerProfileId: 'edge', voiceId: 'fallback-voice' },
    },
  ],
} as unknown as CastingTable;

const routed = routeSpokenSegments(segments, {
  mode: 'full',
  casting,
  singleVoice: null,
  fallbackVoice: null,
});

assert(routed[0]?.voice.voiceId === 'user-voice', 'Persona 明确姓名应匹配 User 配音');
assert(routed[1]?.voice.voiceId === 'user-voice', 'Persona 稳定别名应匹配 User 配音');
assert(routed[2]?.voice.voiceId === 'fallback-voice', '泛代词不得作为 User 别名匹配');

console.info('<杠杠の配音室> user routing tests passed');
