import {
  castingRoomPrompt,
  CASTING_ROOM_JSON_SCHEMA,
  CASTING_ROOM_MAX_CANDIDATES,
  parseCastingRoomResult,
} from '../src/杠杠の配音室/casting-room';
import { findCastingEntryError } from '../src/杠杠の配音室/casting';
import { DEFAULT_TASTE_PROFILE, normalizeTasteProfile } from '../src/杠杠の配音室/settings';
import type { CastingContext, VoiceOption } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function expectError(run: () => unknown, expected: RegExp, message: string): void {
  try {
    run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert(expected.test(text), `${message}: ${text}`);
    return;
  }
  throw new Error(`${message}: 未抛出错误`);
}

function voice(id: string, providerProfileId: string, name = `音色-${id}`): VoiceOption {
  return { providerProfileId, voiceId: id, name };
}

const catalog: VoiceOption[] = [
  voice('mimo-1', 'p-mimo'),
  voice('doubao-1', 'p-doubao'),
  voice('fish-1', 'p-fish'),
  voice('market-junk', 'p-fish'),
];

const context: CastingContext = {
  characterKey: 'character:test',
  characterName: '程妄',
  characterDescription: '温柔黏人的青年',
  characterPersonality: '黏人、嘴甜',
  scenario: '深夜哄人',
  userName: '测试用户',
  userDescription: '',
  worldbookEntries: [],
  recentMessages: [],
};

const runCastingRoomTests = async (): Promise<void> => {
  const prompts = castingRoomPrompt(context, catalog, '干净温和', '程妄');
  equal(prompts.length, 2, 'prompt 必须是 system + user 两条');
  assert(prompts[0].content.includes('candidates'), 'system 提示词必须描述 candidates 契约');
  assert(prompts[1].content.includes('目标角色：程妄'), 'user 提示词必须包含目标角色名');
  assert(prompts[1].content.includes('口味档案：干净温和'), 'user 提示词必须包含口味档案');
  assert(prompts[1].content.includes('[p-mimo] mimo-1'), 'user 提示词必须包含音色目录');

  const serialized = JSON.stringify(CASTING_ROOM_JSON_SCHEMA);
  for (const keyword of ['minItems', 'maxItems', 'minimum', 'maximum', '"enum"']) {
    assert(!serialized.includes(keyword), `schema 不得包含约束关键字 ${keyword}（gemini 网关 400 坑）`);
  }
  equal(CASTING_ROOM_MAX_CANDIDATES, 12, '候选硬上限应为 12');

  const raw = {
    candidates: [
      { providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '贴人设' },
      { providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '重复应去重' },
      { providerProfileId: 'p-ghost', voiceId: 'ghost-voice', reason: '目录外应过滤' },
      'garbage-row',
    ],
    exampleLine: '  你还在生气吗？  ',
  };
  const result = parseCastingRoomResult(raw, catalog, 8);
  equal(result.candidates.length, 1, '只保留目录内候选');
  equal(result.candidates[0].voiceId, 'mimo-1', '保留的候选必须来自目录');
  equal(result.exampleLine, '你还在生气吗？', '例句必须 trim');

  const limited = parseCastingRoomResult(
    {
      candidates: [
        { providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '' },
        { providerProfileId: 'p-doubao', voiceId: 'doubao-1', reason: '' },
        { providerProfileId: 'p-fish', voiceId: 'fish-1', reason: '' },
      ],
      exampleLine: '例句',
    },
    catalog,
    2,
  );
  equal(limited.candidates.length, 2, '上限应截断候选数量');

  expectError(() => parseCastingRoomResult({ candidates: [], exampleLine: '例句' }, catalog, 8), /没有提名任何候选/, '零候选必须报错');
  expectError(
    () =>
      parseCastingRoomResult(
        { candidates: [{ providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '' }], exampleLine: '   ' },
        catalog,
        8,
      ),
    /没有生成试音例句/,
    '空例句必须报错',
  );
  expectError(() => parseCastingRoomResult('not-json-at-all', catalog, 8), /无法解析/, '非法 JSON 必须报错');

  equal(normalizeTasteProfile({ styleNotes: '  干净温和  ' }).styleNotes, '干净温和', '口味档案应 trim');
  equal(normalizeTasteProfile({ styleNotes: '' }).styleNotes, DEFAULT_TASTE_PROFILE.styleNotes, '空口味档案应回落默认');
  equal(normalizeTasteProfile({}).styleNotes, DEFAULT_TASTE_PROFILE.styleNotes, '缺字段应回落默认');
  const long = '长'.repeat(3_000);
  equal(normalizeTasteProfile({ styleNotes: long }).styleNotes.length, 2_000, '口味档案超长应截断到 2000');

  const entries = [
    { id: 'narrator-1', role: 'narrator' as const, displayName: '叙述者', aliases: [], voice: { providerProfileId: 'p-a', voiceId: 'v-a' } },
    { id: 'character-1', role: 'character' as const, displayName: '邹峥', aliases: ['小峥'], voice: { providerProfileId: 'p-a', voiceId: 'v-a' } },
  ];
  equal(findCastingEntryError(entries), null, '合法条目应通过校验');
  entries[1].voice = { providerProfileId: 'p-b', voiceId: 'v-b' };
  equal(entries[1].voice.voiceId, 'v-b', '定角应更新条目 voice');
  entries.push({
    id: 'character-dup',
    role: 'character',
    displayName: '小峥',
    aliases: [],
    voice: { providerProfileId: 'p-b', voiceId: 'v-b' },
  });
  assert(/不能重复/.test(findCastingEntryError(entries) ?? ''), '定角新建条目与别名冲突必须报错');

  console.info('<杠杠の配音室> casting-room tests passed');
};

runCastingRoomTests().then(undefined, error => {
  throw error;
});
