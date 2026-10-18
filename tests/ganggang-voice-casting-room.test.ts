import {
  castingRoomPrompt,
  CASTING_ROOM_JSON_SCHEMA,
  CASTING_ROOM_MAX_CANDIDATES,
  findCharacterExampleLine,
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
  equal(CASTING_ROOM_MAX_CANDIDATES, 10, '候选硬上限应为 10（与 recentStore maxEntries 对齐）');

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

  const chatContext: CastingContext = {
    ...context,
    recentMessages: [
      { messageId: 1, role: 'assistant', name: '程妄', message: '[程妄|温柔]|「今天回来得真晚。」' },
      { messageId: 2, role: 'user', name: '测试用户', message: '路上堵车。' },
      { messageId: 3, role: 'assistant', name: '程妄', message: '他笑了笑：“先吃饭，别凉了。”' },
      { messageId: 4, role: 'assistant', name: '程妄', message: '[程妄]|「汤我热过了，慢慢喝。」' },
    ],
  };
  equal(
    findCharacterExampleLine(chatContext, '程妄', ['妄妄']),
    '汤我热过了，慢慢喝。',
    '应取聊天里该角色最近一次说过的台词当试音例句',
  );
  equal(
    findCharacterExampleLine({ ...chatContext, recentMessages: chatContext.recentMessages.slice(2, 3) }, '程妄'),
    '先吃饭，别凉了。',
    '没有标准对白行时应退到 AI 回复里的引号台词',
  );
  equal(findCharacterExampleLine(context, '程妄'), '', '聊天里没有台词时应返回空串，交给 AI 现编');
  equal(
    findCharacterExampleLine(
      {
        ...context,
        recentMessages: [
          {
            messageId: 1,
            role: 'assistant',
            name: '程妄',
            message: '<center>「202X/11/14｜深秋｜21:42｜夜凉」</center>\n他低声道：“先吃饭，别凉了。”',
          },
        ],
      },
      '程妄',
    ),
    '先吃饭，别凉了。',
    '状态栏里的时间戳与分隔符不能被当成台词',
  );

  const hintPrompts = castingRoomPrompt(context, catalog, '干净温和', '程妄', '汤我热过了，慢慢喝。');
  assert(hintPrompts[1].content.includes('汤我热过了，慢慢喝。'), '给定例句必须写进 prompt');

  const limitPrompts = castingRoomPrompt(chatContext, catalog, '干净温和', '程妄', '', 5);
  assert(limitPrompts[1].content.includes('正好 5 个'), '提示词必须要求 AI 选满用户设定的 N 个');
  assert(limitPrompts[1].content.includes('最近聊天记录：共 4 条'), '提示词必须说明聊天记录的存在与条数');
  assert(limitPrompts[1].content.includes('汤我热过了，慢慢喝。'), '聊天记录正文必须随人设资料一起发给 AI');
  assert(limitPrompts[1].content.includes('角色人设资料'), '人设资料段必须存在（空对象是已知故障）');

  const chatLinePrompts = castingRoomPrompt(chatContext, catalog, '', '程妄', '汤我热过了，慢慢喝。', 5, 'chat');
  assert(chatLinePrompts[1].content.includes('参考台词'), '聊天记录里的台词只能作为参考，不能写死');
  assert(!chatLinePrompts[1].content.includes('必须原样'), '聊天台词不应被强制原样使用');
  const userLinePrompts = castingRoomPrompt(chatContext, catalog, '', '程妄', '你回来了。', 5, 'user');
  assert(userLinePrompts[1].content.includes('用户指定'), '用户手填的例句必须标记为强制使用');

  const fallbackOnly = parseCastingRoomResult(
    { candidates: [{ providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '贴人设' }], exampleLine: '' },
    catalog,
    8,
    '',
    '汤我热过了，慢慢喝。',
  );
  equal(fallbackOnly.exampleLine, '汤我热过了，慢慢喝。', 'AI 没给例句时应回落到聊天台词');
  const aiWinsOverChat = parseCastingRoomResult(
    { candidates: [{ providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '贴人设' }], exampleLine: 'AI 改写的试音句' },
    catalog,
    8,
    '',
    '汤我热过了，慢慢喝。',
  );
  equal(aiWinsOverChat.exampleLine, 'AI 改写的试音句', '聊天台词是参考，AI 可以改写');

  const withOverride = parseCastingRoomResult(
    { candidates: [{ providerProfileId: 'p-mimo', voiceId: 'mimo-1', reason: '贴人设' }], exampleLine: 'AI 现编的句子' },
    catalog,
    8,
    '汤我热过了，慢慢喝。',
  );
  equal(withOverride.exampleLine, '汤我热过了，慢慢喝。', '给定例句应覆盖 AI 生成的 exampleLine');

  console.info('<杠杠の配音室> casting-room tests passed');
};

runCastingRoomTests().then(undefined, error => {
  throw error;
});
