/**
 * 配音室独有选角能力的回归测试：上下文窗口语义（hide_state 'all' + 隐藏楼层回补）、
 * 世界书全量上下文（readFullCastingContext）、手动编辑校验、TTS 预设持久化、
 * 异步 stale 拒绝与完整上下文 prompt 内容。
 *
 * 2026-11-04：ganggang-voice-casting.test.ts 改指 src/杠杠の配音台 后，这批只属于
 * 配音室的用例按 HEAD 版语义原样迁入此处（用例仍指向 ../src/杠杠の配音室）。
 */
import {
  createManualCastEntry,
  findCastingEntryError,
  generateCastingTable,
  isStaleCastingInputError,
  parseAliasInput,
} from '../src/杠杠の配音室/casting';
import {
  createCastingInputSignature,
  deriveCharacterKey,
  readCurrentCastingContext,
  readFullCastingContext,
} from '../src/杠杠の配音室/context';
import {
  loadVoiceSettings,
  SCRIPT_VARIABLE_OPTION,
  updateVoiceSettings,
  type ScriptVariables,
} from '../src/杠杠の配音室/settings';
import type { CastEntry, VoiceOption } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const runCastingContextTests = async (): Promise<void> => {
  const initialVariables: ScriptVariables = {
    profiles: [
      {
        id: 'doubao-1',
        name: '豆包',
        type: 'doubao',
        enabled: true,
        endpoint: 'https://tts.example.test',
        apiKey: 'secret-key',
        model: 'v3',
        defaultVoiceId: 'speaker-a',
        appId: 'app-id',
        accessKey: 'access-key',
        resourceId: 'seed-tts-2.0',
        groupId: '',
        responseFormat: 'mp3',
        platform: '',
        style: '',
        edgeRate: 1,
        extraBody: { safe: true },
      },
    ],
    castingByCharacter: {},
    readingDefaults: { mode: 'full', recentMessageCount: 10 },
    soundEffects: [],
  };

  let variables = structuredClone(initialVariables);
  const variableApi = {
    getVariables: (): ScriptVariables => variables,
    updateVariablesWith: (
      updater: (current: ScriptVariables) => ScriptVariables,
    ): ScriptVariables => {
      variables = updater(variables);
      return variables;
    },
  };

  // ---- 设置：TTS 预设（配音室独有能力） ----
  const normalized = loadVoiceSettings(variableApi);
  equal(normalized.ttsPresetEnabled, false, 'TTS 预设默认关闭');
  equal(normalized.ttsPresets.length, 1, '缺省应自带一个 TTS 预设');
  equal(normalized.ttsPresets[0].id, 'default-tts-preset', '默认预设 id 必须稳定');
  equal(normalized.currentTtsPresetId, 'default-tts-preset', '当前预设 id 必须落在预设列表里');

  const presetSaved = updateVoiceSettings(
    current => ({
      ...current,
      ttsPresetEnabled: true,
      ttsPresets: [...current.ttsPresets, { id: 'p-2', name: '带语速', instructionText: 'x' }],
      currentTtsPresetId: 'p-2',
    }),
    variableApi,
  );
  equal(presetSaved.ttsPresetEnabled, true, 'TTS 预设开关必须持久化');
  equal(presetSaved.ttsPresets.length, 2, 'TTS 预设列表必须持久化');
  equal(presetSaved.currentTtsPresetId, 'p-2', '当前 TTS 预设必须持久化');

  // ---- 上下文窗口语义：hide_state 'all' + 隐藏楼层回补 ----
  const context = readCurrentCastingContext(3, {
    getCharData: () => ({
      name: '小葵',
      avatar: 'aoi-avatar.png',
      description: '明亮的角色描述',
      personality: '温柔但坚定',
      scenario: '雨夜的车站',
      json_data: '{"apiKey":"should-not-be-copied"}',
    }),
    getCurrentCharacterName: () => '小葵',
    getCurrentCharacterId: () => 'aoi-avatar.png',
    getLastMessageId: () => 11,
    getChatMessages: (range: string | number, options?: { hide_state?: string }) => {
      equal(range, '4-11', '应为隐藏/跳过的楼层留出余量，而不是只取恰好 N 条');
      equal(
        options?.hide_state,
        'all',
        '隐藏过滤必须在代码里做：酒馆的 unhidden 会把 is_hidden 未定义（而非 false）的 AI 楼层一并丢掉',
      );
      return [
        { message_id: 7, role: 'user', name: '用户', message: '隐藏的前情', is_hidden: true },
        { message_id: 8, role: 'assistant', name: '小葵', message: '被筛掉的隐藏回复', is_hidden: true },
        { message_id: 9, role: 'user', name: '用户', message: '你还好吗？', is_hidden: false },
        { message_id: 10, role: 'assistant', name: '小葵', message: '我没事。', is_hidden: false },
        { message_id: 11, role: 'assistant', name: '小葵', message: '车站的灯亮了。', is_hidden: false },
      ];
    },
  });
  equal(context.characterKey, 'character:aoi-avatar.png', '配音表应按当前角色卡稳定 ID 归档');
  equal(
    deriveCharacterKey({ avatar: 'stable-card.png' }, '17', '角色'),
    'character:stable-card.png',
    '角色卡头像文件名应优先于可能随列表变化的角色索引',
  );
  equal(context.recentMessages.length, 3, '上下文应只包含最近消息');
  equal(
    context.recentMessages.map(message => message.messageId).join(','),
    '9,10,11',
    '隐藏楼层被剔除后仍要补足最近 N 条，而不是让窗口整体前移丢对话',
  );
  assert(!JSON.stringify(context).includes('should-not-be-copied'), '上下文不能复制整张角色卡原始 JSON');

  // ---- 世界书全量上下文（readFullCastingContext） ----
  const longWorldbookContent = '长'.repeat(25_000);
  const fullContext = await readFullCastingContext(3, {
    getCharData: () => ({ name: '小葵', avatar: 'aoi-avatar.png' }),
    getCurrentCharacterName: () => '小葵',
    getCurrentCharacterId: () => 'aoi-avatar.png',
    getLastMessageId: () => 11,
    getChatMessages: () => [],
    getCurrentPersonaName: () => '阿月',
    getPersona: () => ({ name: '阿月', description: '旅行中的旁听者', lorebook: 'user-book' }),
    getCharWorldbookNames: () => ({ primary: 'char-book', additional: ['extra-book', ''] }),
    getWorldbook: async (name: string) => {
      if (name === 'char-book') {
        return [
          { uid: 0, name: '设定A', enabled: true, content: longWorldbookContent },
          { uid: 1, name: '停用条目', enabled: false, content: '停用内容不应出现' },
          { uid: 2, name: '空条目', enabled: true, content: '   ' },
        ];
      }
      if (name === 'extra-book') return [{ uid: 5, name: '设定B', enabled: true, content: '附加内容' }];
      if (name === 'user-book') return [{ uid: 9, name: '用户设定', enabled: true, content: '用户背景' }];
      return [];
    },
  });
  equal(fullContext.userName, '阿月', '完整上下文应包含用户 persona 名称');
  equal(fullContext.userDescription, '旅行中的旁听者', '完整上下文应包含用户设定描述');
  equal(
    fullContext.worldbookEntries.map(entry => [entry.worldbook, entry.uid]),
    [
      ['char-book', 0],
      ['extra-book', 5],
      ['user-book', 9],
    ],
    '世界书条目顺序应为 char primary → char additional → persona，且只保留启用条目',
  );
  equal(
    fullContext.worldbookEntries[0].content.length,
    25_000,
    '世界书条目内容不设上限、不得截断',
  );
  assert(
    !JSON.stringify(fullContext.worldbookEntries).includes('停用内容不应出现'),
    '未启用条目不能进入配音上下文',
  );

  const personaFallbackContext = await readFullCastingContext(1, {
    getCharData: () => null,
    getCurrentCharacterName: () => '角色',
    getCurrentCharacterId: () => '',
    getLastMessageId: () => 0,
    getChatMessages: () => [],
    getCurrentPersonaName: () => null,
  });
  equal(personaFallbackContext.userName, '', '没有 persona 时用户名应为空字符串');
  equal(personaFallbackContext.worldbookEntries, [], '没有 persona 与角色世界书时条目应为空');

  const tolerantContext = await readFullCastingContext(1, {
    getCharData: () => null,
    getCurrentCharacterName: () => '角色',
    getCurrentCharacterId: () => '',
    getLastMessageId: () => 0,
    getChatMessages: () => [],
    getCurrentPersonaName: () => '阿月',
    getPersona: () => ({ name: '阿月', description: '', lorebook: 'broken-book' }),
    getCharWorldbookNames: () => ({ primary: 'broken-book', additional: [] }),
    getWorldbook: async () => {
      throw new Error('世界书读取失败');
    },
  });
  equal(tolerantContext.userName, '阿月', '世界书读取失败不应影响 persona 资料进入上下文');
  equal(tolerantContext.worldbookEntries, [], 'getWorldbook 抛错时对应世界书应被跳过而不中断');

  // ---- 签名与 stale ----
  const voiceOptions: VoiceOption[] = [
    { providerProfileId: 'doubao-1', voiceId: 'speaker-a', name: '清亮女声', locale: 'zh-CN', tags: ['bright'] },
    { providerProfileId: 'edge-1', voiceId: 'en-US-AriaNeural', name: 'Aria' },
  ];
  const signatureProfiles = [{ id: 'doubao-1', type: 'doubao' }];
  const baseSignature = createCastingInputSignature(context, voiceOptions, 3, signatureProfiles);
  assert(
    createCastingInputSignature(
      { ...fullContext, worldbookEntries: fullContext.worldbookEntries.slice(1) },
      voiceOptions,
      3,
      signatureProfiles,
    ) !== createCastingInputSignature(fullContext, voiceOptions, 3, signatureProfiles),
    '世界书条目变化必须使配音表输入过期',
  );

  const validModelResult = JSON.stringify({
    entries: [
      {
        id: 'narrator-main',
        role: 'narrator',
        displayName: '旁白',
        aliases: [],
        providerProfileId: 'doubao-1',
        voiceId: 'speaker-a',
        speed: 1.1,
        reason: '清楚且明亮',
      },
    ],
  });

  let inputCurrent = true;
  let asyncStaleRejected = false;
  try {
    await generateCastingTable({
      context,
      voices: voiceOptions,
      generationId: 'casting-stale-async',
      isInputCurrent: async () => inputCurrent,
      runtime: {
        generateRaw: async () => {
          inputCurrent = false;
          return validModelResult;
        },
        stopGenerationById: () => true,
      },
    });
  } catch (caught) {
    asyncStaleRejected = isStaleCastingInputError(caught);
  }
  assert(asyncStaleRejected, 'isInputCurrent 返回 Promise 时同样必须丢弃过期配音表');

  // ---- 完整上下文必须进入 prompt ----
  let fullCapturedConfig: unknown;
  await generateCastingTable({
    context: fullContext,
    voices: voiceOptions,
    generationId: 'casting-full-1',
    runtime: {
      generateRaw: async config => {
        fullCapturedConfig = config;
        return validModelResult;
      },
      stopGenerationById: () => true,
    },
  });
  const fullPromptText = JSON.stringify((fullCapturedConfig as { ordered_prompts?: unknown[] }).ordered_prompts ?? []);
  assert(fullPromptText.includes('阿月'), 'prompt 应包含用户 persona 名称');
  assert(fullPromptText.includes('旅行中的旁听者'), 'prompt 应包含用户设定描述');
  assert(fullPromptText.includes('用户背景'), 'prompt 应包含启用的世界书条目内容');
  assert(!fullPromptText.includes('停用内容不应出现'), 'prompt 不得包含未启用的世界书条目');

  // ---- 手动编辑校验 ----
  equal(parseAliasInput(' 小甲 、小乙，小丙 , 小甲 '), ['小甲', '小乙', '小丙'], '别名输入应切分、trim 并去重');
  equal(parseAliasInput('  '), [], '纯空白别名输入应得到空数组');
  const manualA = createManualCastEntry('character', { providerProfileId: 'doubao-1', voiceId: 'speaker-a' }, 1);
  const manualB = createManualCastEntry('fallback', { providerProfileId: 'edge-1', voiceId: 'en-US-AriaNeural' }, 2);
  assert(manualA.id !== manualB.id, '手动条目 id 必须唯一');
  equal(manualA.displayName, '角色2', '手动条目应带占位名称');
  equal(manualA.voice, { providerProfileId: 'doubao-1', voiceId: 'speaker-a' }, '手动条目应保留给定音色');
  const entryFixture = (role: 'narrator' | 'character' | 'fallback', displayName: string, aliases: string[] = []): CastEntry => ({
    id: `fixture-${role}-${displayName}`,
    role,
    displayName,
    aliases,
    voice: { providerProfileId: 'doubao-1', voiceId: 'speaker-a' },
  });
  equal(
    findCastingEntryError([entryFixture('narrator', '旁白'), entryFixture('character', '角色甲')]),
    null,
    '合法的手动编辑应通过校验',
  );
  assert(findCastingEntryError([]) !== null, '空配音表必须报错');
  assert(findCastingEntryError([entryFixture('character', '角色甲')]) !== null, '缺少旁白必须报错');
  assert(
    findCastingEntryError([
      entryFixture('narrator', '旁白'),
      entryFixture('character', '角色甲'),
      entryFixture('fallback', '角色甲'),
    ]) !== null,
    '手动编辑造成重名时必须报错',
  );
  assert(findCastingEntryError([entryFixture('narrator', '  ')]) !== null, '名称为空白时必须报错');
  assert(
    findCastingEntryError([entryFixture('narrator', '旁白'), entryFixture('character', '角色甲', ['旁白'])]) !== null,
    '别名与其他角色名称冲突时必须报错',
  );

  console.info('<杠杠の配音室> casting context tests passed');
};

runCastingContextTests().then(undefined, error => {
  throw error;
});
