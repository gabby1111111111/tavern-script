import {
  generateCastingTable,
  isStaleCastingInputError,
  parseCastingResult,
  stopCasting,
} from '../src/杠杠の配音室/casting';
import {
  buildCastingRequestPayload,
  createCastingInputSignature,
  deriveCharacterKey,
  readCurrentCastingContext,
  sanitizeVoiceOptions,
} from '../src/杠杠の配音室/context';
import {
  loadVoiceSettings,
  normalizeVoiceSettings,
  saveCastingTable,
  SCRIPT_VARIABLE_OPTION,
  updateVoiceSettings,
} from '../src/杠杠の配音室/settings';
import {
  beginAiCastingAudit,
  beginVoiceAudit,
  markAiCasting,
  markCastingStopped,
  markPlaybackTimelineBuilt,
  markPlaybackTimelineComplete,
  markPlaybackTimelineStep,
  markProviderFailed,
  markProviderReady,
  markVoiceAuditError,
  voiceAudit,
} from '../src/杠杠の配音室/audit';
import type { VoiceOption } from '../src/杠杠の配音室/types';
import type { ScriptVariables } from '../src/杠杠の配音室/settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function expectRejected(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

const runCastingTests = async (): Promise<void> => {
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
        extraBody: { safe: true, audio_base64: 'QUFB', payload: 'A'.repeat(256) },
      },
    ],
    castingByCharacter: {
      stale: {
        characterKey: 'stale',
        characterName: '旧角色',
        generatedAt: 1,
        entries: [],
      },
    },
    readingDefaults: { mode: 'full', recentMessageCount: 10 },
    soundEffects: [
      { id: 'door', name: '门', category: '环境', url: '/audio/door.mp3', description: '', enabled: true, volume: 1 },
      {
        id: 'bad',
        name: 'data',
        category: '环境',
        url: 'data:audio/mp3;base64,AAAA',
        description: '',
        enabled: true,
        volume: 1,
      },
    ],
    chatSnapshot: 'must never be persisted',
    recentAudio: 'blob:must never be persisted',
  };

  let variables = structuredClone(initialVariables);
  let updateOption: unknown;
  const variableApi = {
    getVariables: (option: typeof SCRIPT_VARIABLE_OPTION): ScriptVariables => {
      updateOption = option;
      return variables;
    },
    updateVariablesWith: (
      updater: (current: ScriptVariables) => ScriptVariables,
      option: typeof SCRIPT_VARIABLE_OPTION,
    ): ScriptVariables => {
      updateOption = option;
      variables = updater(variables);
      return variables;
    },
  };

  const normalized = loadVoiceSettings(variableApi);
  equal(normalized.profiles[0].id, 'doubao-1', '应读取脚本变量中的 provider profile');
  equal(normalized.profiles[0].extraBody, { safe: true }, 'Provider extraBody 不应保留二进制字段或原始 Base64');
  equal(normalized.soundEffects.length, 1, '不可持久化的 data URL 音效应被丢弃');
  assert(!('chatSnapshot' in normalized), '规范化设置不能包含聊天快照');
  assert(!('recentAudio' in normalized), '规范化设置不能包含最近音频');
  equal(updateOption, { type: 'script' }, '脚本设置必须使用 type=script 变量范围');

  const changed = updateVoiceSettings(
    current => ({ ...current, readingDefaults: { ...current.readingDefaults, recentMessageCount: 6 } }),
    variableApi,
  );
  equal(changed.readingDefaults.recentMessageCount, 6, '集中 updater 应能保存朗读默认值');
  assert(!('chatSnapshot' in variables), '集中 updater 必须清理不在持久化契约中的字段');
  assert(!('recentAudio' in variables), '集中 updater 不能写入最近音频');

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
    getChatMessages: (range: string | number) => {
      equal(range, '9-11', '只应请求最近 N 条聊天，而不是扫描全部历史');
      return [
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
  assert(!JSON.stringify(context).includes('should-not-be-copied'), '上下文不能复制整张角色卡原始 JSON');

  const voiceOptions: VoiceOption[] = [
    { providerProfileId: 'doubao-1', voiceId: 'speaker-a', name: '清亮女声', locale: 'zh-CN', tags: ['bright'] },
    { providerProfileId: 'edge-1', voiceId: 'en-US-AriaNeural', name: 'Aria' },
    {
      providerProfileId: 'doubao-1',
      voiceId: 'speaker-a',
      name: '重复项',
      ...({ apiKey: 'must-not-leak', accessKey: 'must-not-leak' } as Record<string, string>),
    } as VoiceOption,
  ];
  const sanitizedVoices = sanitizeVoiceOptions(voiceOptions);
  equal(sanitizedVoices.length, 2, '音色目录应去重 profileId+voiceId');
  const payloadText = JSON.stringify(buildCastingRequestPayload(context, voiceOptions));
  assert(!payloadText.includes('must-not-leak'), '发给 AI 的音色目录不能包含 API 凭据');
  assert(!payloadText.includes('secret-key'), '发给 AI 的上下文不能包含 provider API key');

  const signatureProfiles = [{ id: 'doubao-1', type: 'doubao' }];
  const baseSignature = createCastingInputSignature(context, voiceOptions, 3, signatureProfiles);
  equal(
    createCastingInputSignature(structuredClone(context), structuredClone(voiceOptions), 3, [...signatureProfiles]),
    baseSignature,
    '相同的安全输入快照必须生成稳定签名',
  );
  const changedContext = structuredClone(context);
  changedContext.recentMessages[0].message = '消息已经编辑';
  assert(
    createCastingInputSignature(changedContext, voiceOptions, 3, signatureProfiles) !== baseSignature,
    '最近聊天变化必须使配音表输入过期',
  );
  assert(
    createCastingInputSignature(
      { ...context, characterDescription: '角色卡已变化' },
      voiceOptions,
      3,
      signatureProfiles,
    ) !== baseSignature,
    '角色卡变化必须使配音表输入过期',
  );
  assert(
    createCastingInputSignature(context, voiceOptions, 4, signatureProfiles) !== baseSignature,
    '取消息条数变化必须过期',
  );
  assert(
    createCastingInputSignature(context, voiceOptions, 3, [{ id: 'edge-1', type: 'edge' }]) !== baseSignature,
    '启用 Profile 变化必须使配音表输入过期',
  );
  assert(
    createCastingInputSignature(context, voiceOptions.slice(0, 1), 3, signatureProfiles) !== baseSignature,
    '可用音色目录变化必须使配音表输入过期',
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
  const table = parseCastingResult(validModelResult, context, voiceOptions, () => 1234);
  equal(table.characterKey, context.characterKey, '解析结果应绑定当前角色卡 key');
  equal(table.entries[0].voice.providerProfileId, 'doubao-1', '解析结果应保留已请求的 profileId');
  equal(table.generatedAt, 1234, '解析结果应允许注入时间');

  const castEntry = (role: 'narrator' | 'character' | 'fallback', displayName: string, aliases: string[] = []) => ({
    role,
    displayName,
    aliases,
    providerProfileId: 'doubao-1',
    voiceId: 'speaker-a',
  });
  expectRejected(
    () => parseCastingResult(JSON.stringify({ entries: [castEntry('character', '角色甲')] }), context, voiceOptions),
    '配音表必须恰好包含一个旁白',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({ entries: [castEntry('narrator', '旁白'), castEntry('narrator', 'Narrator')] }),
        context,
        voiceOptions,
      ),
    '配音表不得包含多个旁白',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            castEntry('narrator', '旁白'),
            castEntry('fallback', '其他角色'),
            castEntry('fallback', '未知角色'),
          ],
        }),
        context,
        voiceOptions,
      ),
    '配音表不得包含多个兜底身份',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [castEntry('narrator', '旁白'), castEntry('character', 'Alice'), castEntry('character', 'alice')],
        }),
        context,
        voiceOptions,
      ),
    '归一化后相同的角色名必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            castEntry('narrator', '旁白'),
            castEntry('character', '角色甲', ['小甲']),
            castEntry('character', '小甲'),
          ],
        }),
        context,
        voiceOptions,
      ),
    '不同角色的名称和别名不得发生碰撞',
  );

  const compactModelResult = JSON.stringify({
    voiceTable: [
      { roleName: '旁白', voiceId: ' speaker-a ' },
      { roleName: '角色甲', voiceId: 'en-US-AriaNeural' },
    ],
  });
  const compactTable = parseCastingResult(compactModelResult, context, voiceOptions, () => 2345);
  equal(
    compactTable.entries.map(entry => ({
      id: entry.id,
      role: entry.role,
      displayName: entry.displayName,
      aliases: entry.aliases,
      voice: entry.voice,
    })),
    [
      {
        id: 'narrator-1',
        role: 'narrator',
        displayName: '旁白',
        aliases: [],
        voice: { providerProfileId: 'doubao-1', voiceId: 'speaker-a' },
      },
      {
        id: 'character-2',
        role: 'character',
        displayName: '角色甲',
        aliases: [],
        voice: { providerProfileId: 'edge-1', voiceId: 'en-US-AriaNeural' },
      },
    ],
    'voiceTable 应转换为安全的角色配音表',
  );

  const geminiModelResult = JSON.stringify({
    narrator: { providerProfileId: 'doubao-1', voiceId: 'speaker-a' },
    characters: [{ characterName: '角色甲', providerProfileId: 'edge-1', voiceId: 'en-US-AriaNeural' }],
  });
  const geminiTable = parseCastingResult(geminiModelResult, context, voiceOptions, () => 3456);
  equal(geminiTable.entries.length, 2, 'Gemini 角色表应生成旁白和角色映射');
  equal(geminiTable.entries[0].displayName, '旁白', 'Gemini narrator 应规范化为旁白');
  equal(geminiTable.entries[1].displayName, '角色甲', 'Gemini characterName 应保留为角色名');

  let capturedConfig: unknown;
  let stoppedId = '';
  const generated = await generateCastingTable({
    context,
    voices: voiceOptions,
    generationId: 'casting-test-1',
    now: () => 42,
    runtime: {
      generateRaw: async config => {
        capturedConfig = config;
        return validModelResult;
      },
      stopGenerationById: generationId => {
        stoppedId = generationId;
        return true;
      },
    },
  });
  equal(generated.generatedAt, 42, 'generateCastingTable 应返回验证后的配音表');
  let inputCurrent = true;
  let staleRejected = false;
  try {
    await generateCastingTable({
      context,
      voices: voiceOptions,
      generationId: 'casting-stale-1',
      isInputCurrent: () => inputCurrent,
      runtime: {
        generateRaw: async () => {
          inputCurrent = false;
          return validModelResult;
        },
        stopGenerationById: () => true,
      },
    });
  } catch (caught) {
    staleRejected = isStaleCastingInputError(caught);
  }
  assert(staleRejected, '生成返回时输入已变化必须丢弃旧配音表');
  const compactGenerated = await generateCastingTable({
    context,
    voices: voiceOptions,
    generationId: 'casting-voice-table-1',
    runtime: {
      generateRaw: async () => compactModelResult,
      stopGenerationById: () => true,
    },
  });
  equal(compactGenerated.entries.length, 2, 'generateCastingTable 应兼容观测到的 voiceTable 返回');
  equal(compactGenerated.entries[0].role, 'narrator', '明确旁白标记应映射为 narrator');
  const geminiGenerated = await generateCastingTable({
    context,
    voices: voiceOptions,
    generationId: 'casting-gemini-1',
    runtime: {
      generateRaw: async () => geminiModelResult,
      stopGenerationById: () => true,
    },
  });
  equal(geminiGenerated.entries.length, 2, 'generateCastingTable 应兼容观测到的 Gemini 根结构');
  const capturedText = JSON.stringify(capturedConfig);
  assert(
    capturedText.includes('ganggang-casting') || capturedText.includes('casting-test-1'),
    '请求必须有唯一 generation_id',
  );
  assert(capturedText.includes('should_silence'), '配音表请求必须静默生成');
  assert(capturedText.includes('ganggang_voice_casting'), '配音表请求必须使用严格 JSON Schema');
  assert(!capturedText.includes('secret-key'), 'generateRaw payload 不能包含 TTS API key');
  const capturedPromptText = JSON.stringify((capturedConfig as { ordered_prompts?: unknown[] }).ordered_prompts ?? []);
  ['entries', 'role', 'displayName', 'aliases', 'providerProfileId', 'voiceId'].forEach(field => {
    assert(capturedPromptText.includes(field), `prompt 必须明确要求 ${field}`);
  });
  assert(!capturedPromptText.includes('secret-key'), 'prompt 不能包含 TTS API key');
  assert(
    stopCasting('casting-test-1', { stopGenerationById: id => (stoppedId = id) === id, generateRaw: async () => '' }),
    '应能停止指定配音表生成',
  );
  equal(stoppedId, 'casting-test-1', '停止操作必须针对对应 generation_id');

  let invalidRejected = false;
  try {
    parseCastingResult(
      JSON.stringify({
        entries: [
          {
            role: 'character',
            displayName: '伪造角色',
            aliases: [],
            providerProfileId: 'not-requested',
            voiceId: 'invented',
          },
        ],
      }),
      context,
      voiceOptions,
    );
  } catch {
    invalidRejected = true;
  }
  assert(invalidRejected, '模型选择请求外 profileId+voiceId 时必须拒绝整个配音表');

  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({ voiceTable: [{ roleName: '角色甲', voiceId: 'not-requested' }] }),
        context,
        voiceOptions,
      ),
    'voiceTable 选择未知 voiceId 时必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(JSON.stringify({ voiceTable: [{ roleName: '角色甲', voiceId: 'speaker-a' }] }), context, [
        ...voiceOptions,
        { providerProfileId: 'edge-1', voiceId: 'speaker-a', name: '跨来源同名音色' },
      ]),
    'voiceTable 的 voiceId 跨 profile 重名时必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({ payload: { voiceTable: [{ roleName: '角色甲', voiceId: 'speaker-a' }] } }),
        context,
        voiceOptions,
      ),
    'voiceTable 被其他 wrapper 包裹时必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({ voiceTable: [{ role: '角色甲', voiceId: 'speaker-a' }] }),
        context,
        voiceOptions,
      ),
    'voiceTable 不应接受字段别名或非法字段',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          narrator: { providerProfileId: 'doubao-1', voiceId: 'speaker-a' },
          characters: [],
          extra: true,
        }),
        context,
        voiceOptions,
      ),
    'Gemini 根结构出现额外字段时必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          narrator: { providerProfileId: 'doubao-1', voiceId: 'speaker-a' },
          characters: [
            {
              characterName: '角色甲',
              providerProfileId: 'edge-1',
              voiceId: 'en-US-AriaNeural',
              extra: true,
            },
          ],
        }),
        context,
        voiceOptions,
      ),
    'Gemini character 项出现额外字段时必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          narrator: { providerProfileId: 'doubao-1', voiceId: 'speaker-a' },
          characters: [{ characterName: '  ', providerProfileId: 'edge-1', voiceId: 'en-US-AriaNeural' }],
        }),
        context,
        voiceOptions,
      ),
    'Gemini characterName 为空时必须拒绝',
  );
  expectRejected(
    () =>
      parseCastingResult(
        JSON.stringify({
          narrator: { providerProfileId: 'not-requested', voiceId: 'invented' },
          characters: [],
        }),
        context,
        voiceOptions,
      ),
    'Gemini narrator 选择请求外 pair 时必须拒绝',
  );

  saveCastingTable(table, variableApi);
  const stored = normalizeVoiceSettings(variables);
  assert(stored.castingByCharacter[context.characterKey] !== undefined, '验证后的配音表应能按角色卡 key 持久化');
  assert(!JSON.stringify(variables).includes('must-not-leak'), '持久化结果不能包含音色目录附加凭据');

  const pendingRun = beginAiCastingAudit('ganggang-casting-1700000000000-1');
  equal(voiceAudit.action, 'ai-casting', 'AI 配音表开始时 action 必须可识别');
  equal(
    voiceAudit.ai_casting,
    { status: 'pending', count: 0, generation_id: 'ganggang-casting-1700000000000-1' },
    'AI 配音表开始时应记录 pending 和安全 generation_id',
  );
  markAiCasting(pendingRun, 'success', 3);
  equal(voiceAudit.ai_casting.status, 'success', 'AI 配音表成功状态应可观察');
  equal(voiceAudit.ai_casting.count, 3, 'AI 配音表成功状态只记录条目数');

  const failedRun = beginAiCastingAudit('character/chat/voiceId/apiKey/prompt/response');
  equal(voiceAudit.ai_casting.generation_id, null, '非法 generation_id 不得回显');
  markAiCasting(failedRun, 'fail', 999);
  equal(voiceAudit.ai_casting.status, 'fail', 'AI 配音表失败状态应可观察');
  equal(voiceAudit.ai_casting.count, 32, 'Audit 条目数必须限制为小型非负整数');
  assert(voiceAudit.last_error === null, 'AI 配音表 Audit 失败不能记录原始错误');

  const cancelledRun = beginAiCastingAudit('ganggang-casting-1700000000000-2');
  markCastingStopped(cancelledRun, true);
  equal(voiceAudit.ai_casting.status, 'cancelled', 'AI 配音表取消状态应可观察');
  equal(voiceAudit.request_cancelled.status, 'success', 'AI 配音表成功停止时请求取消应成功');

  const stopFailedRun = beginAiCastingAudit('ganggang-casting-1700000000000-3');
  markCastingStopped(stopFailedRun, false);
  equal(voiceAudit.ai_casting.status, 'fail', 'AI 配音表停止失败时状态应失败');
  equal(voiceAudit.request_cancelled.status, 'fail', 'AI 配音表停止失败时请求取消不得成功');
  const ordinaryRun = beginVoiceAudit('message-playback');
  equal(
    voiceAudit.ai_casting,
    { status: 'idle', count: 0, generation_id: null },
    '普通 Audit run 必须清理上一轮 AI 配音表状态',
  );
  void ordinaryRun;

  const timelineRun = beginVoiceAudit('message-playback');
  markPlaybackTimelineBuilt(timelineRun, {
    speechCount: 2,
    soundCount: 1,
    remoteSoundCount: 1,
    pinnedRemoteSoundCount: 1,
  });
  markPlaybackTimelineStep(timelineRun, 'speech', 'start');
  markPlaybackTimelineStep(timelineRun, 'speech', 'end');
  markPlaybackTimelineStep(timelineRun, 'sound', 'start');
  markPlaybackTimelineStep(timelineRun, 'sound', 'end');
  markPlaybackTimelineStep(timelineRun, 'speech', 'start');
  markPlaybackTimelineStep(timelineRun, 'speech', 'end');
  markPlaybackTimelineComplete(timelineRun);
  equal(
    voiceAudit.playback_timeline,
    {
      status: 'success',
      total_count: 3,
      speech_count: 2,
      sound_count: 1,
      completed_count: 3,
      skipped_sound_count: 0,
      active_kind: null,
      max_active: 1,
      remote_sound_count: 1,
      pinned_remote_sound_count: 1,
      trace: ['speech-start', 'speech-end', 'sound-start', 'sound-end', 'speech-start', 'speech-end'],
    },
    '混合时间线 Audit 应证明 speech → sound → speech 严格串行且远程地址锁定版本',
  );

  const probeRun = beginVoiceAudit('provider-probe');
  markProviderReady(probeRun, 'mimo', false);
  equal(
    voiceAudit.provider_ready,
    { status: 'success', profile_id: 'mimo', network_verified: false },
    'MiMo 配置探针必须明确标记为未联网验证',
  );

  const synthesisRun = beginVoiceAudit('selection-playback');
  markProviderReady(synthesisRun, 'mimo', true);
  markProviderFailed(synthesisRun, 'mimo');
  const sensitiveErrorSentinels = [
    'sk-test-must-not-leak',
    'api_key=test-only-secret',
    'https://secret.invalid/private-path',
  ];
  markVoiceAuditError(synthesisRun, new Error(`合成失败 ${sensitiveErrorSentinels.join(' ')}`));
  equal(
    voiceAudit.provider_ready,
    { status: 'fail', profile_id: 'mimo', network_verified: false },
    '后续合成失败不得保留先前 Provider 成功状态',
  );
  equal(voiceAudit.audio_played.status, 'fail', '合成失败必须同步反映到播放 Audit');
  const auditText = JSON.stringify(voiceAudit);
  ['角色', 'chat', 'voiceId', 'apiKey', 'prompt', 'response', ...sensitiveErrorSentinels].forEach(value => {
    assert(!auditText.includes(value), `Audit 不得包含敏感字段 ${value}`);
  });
  equal(voiceAudit.last_error, 'operation-failed', 'Audit 错误必须使用固定码，不能回显上游异常正文');

  console.info('<杠杠の配音室> casting tests passed');
};

runCastingTests().then(undefined, error => {
  throw error;
});
