import {
  MINIMAX_ENDPOINTS,
  MINIMAX_VOICE_ENDPOINTS,
  XIAOMI_MIMO_ENDPOINT,
  buildMinimaxRequest,
  buildMinimaxVoiceListRequest,
} from '../src/杠杠の配音台/tts/cloud-request';
import { DEFAULT_DOUBAO_RESOURCE_ID } from '../src/杠杠の配音台/tts/doubao-request';
import {
  DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT,
  DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE,
  DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT,
  MAX_TTS_RESPONSE_BYTES,
  createProviderRegistry,
  redactProviderSecrets,
  withTimeout,
} from '../src/杠杠の配音台/tts/providers';
import { extractContentText, parseSpokenSegments } from '../src/杠杠の配音台/tts/text';
import type { SynthesisRequest, TtsProviderProfile } from '../src/杠杠の配音台/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

async function expectError(run: () => Promise<unknown>, expected: RegExp, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert(expected.test(text), `${message}: ${text}`);
    return;
  }
  throw new Error(`${message}: 未抛出错误`);
}

void (async () => {
  const baseProfile = (overrides: Partial<TtsProviderProfile> = {}): TtsProviderProfile => ({
    id: 'local',
    name: 'Local TTS',
    type: 'openai-compatible',
    enabled: true,
    endpoint: 'http://127.0.0.1:7880/v1/audio/speech',
    apiKey: 'secret-key',
    model: 'index-tts2',
    defaultVoiceId: 'default',
    appId: '',
    accessKey: '',
    resourceId: '',
    groupId: '',
    responseFormat: 'wav',
    platform: 'cn',
    style: '',
    edgeRate: 0,
    extraBody: {},
    ...overrides,
  });

  equal(
    redactProviderSecrets('MiMo HTTP 401 mimo-trimmed-secret', baseProfile({ apiKey: '  mimo-trimmed-secret  ' })),
    'MiMo HTTP 401 [redacted]',
    '错误脱敏必须覆盖实际请求使用的去空格凭据',
  );

  const requestFor = (profile: TtsProviderProfile, text = '你好'): SynthesisRequest => ({
    text,
    voice: { providerProfileId: profile.id, voiceId: profile.defaultVoiceId },
    signal: new AbortController().signal,
  });

  equal(
    extractContentText('<content><p>第一段</p><p>第二段 &amp; 更多</p></content><content>忽略</content>'),
    '第一段\n第二段 & 更多',
    '只应提取第一个 content 块并清理 HTML',
  );

  const segments = parseSpokenSegments(
    '<content>雨落在窗沿。\n[小艾|温柔][0.1, 0.2] | “喝一点吧。”\n<chat_bubble>[外层|[小艾] | 「卡片台词。」]</chat_bubble></content>',
    { sourceMessageId: 8 },
  );
  equal(
    segments.map(segment => ({ kind: segment.kind, characterName: segment.characterName, text: segment.text })),
    [
      { kind: 'narration', characterName: null, text: '雨落在窗沿。' },
      { kind: 'dialogue', characterName: '小艾', text: '喝一点吧。' },
      { kind: 'dialogue', characterName: '小艾', text: '卡片台词。' },
    ],
    '混合文本应按顺序解析旁白、普通台词和嵌套台词',
  );
  assert(
    segments.every(segment => segment.sourceMessageId === 8),
    '解析结果必须携带消息 ID',
  );
  assert(new Set(segments.map(segment => segment.id)).size === segments.length, '解析结果 ID 必须唯一');

  // F1 回归闸门：MiniMax 合成与音色列表都必须带 GroupId 查询参数。
  await expectError(
    async () => {
      buildMinimaxRequest({ apiKey: 'minimax-secret', text: '你好', voiceId: 'female-shaonv' });
    },
    /缺少 MiniMax Group ID/,
    'MiniMax 合成请求缺 GroupId 必须直接报缺，而不是发出必然失败的请求',
  );
  await expectError(
    async () => {
      buildMinimaxVoiceListRequest({ apiKey: 'minimax-secret' });
    },
    /缺少 MiniMax Group ID/,
    'MiniMax 音色列表请求同样必须有 GroupId 校验',
  );
  const minimaxUpstream = buildMinimaxRequest({
    apiKey: 'minimax-secret',
    groupId: 'group 123/ab',
    text: '你好',
    voiceId: 'female-shaonv',
  });
  equal(
    minimaxUpstream.url,
    `${MINIMAX_ENDPOINTS.cn}?GroupId=${encodeURIComponent('group 123/ab')}`,
    'GroupId 必须作为 URL 查询参数并做 encodeURIComponent',
  );
  const voiceListUpstream = buildMinimaxVoiceListRequest({ apiKey: 'k', groupId: 'group-123' });
  equal(
    voiceListUpstream.url,
    `${MINIMAX_VOICE_ENDPOINTS.cn}?GroupId=group-123`,
    '音色列表端点也必须拼 GroupId 查询参数',
  );
  equal(DEFAULT_DOUBAO_RESOURCE_ID, 'seed-tts-2.0', '豆包默认 Resource ID 必须稳定');
  assert(MAX_TTS_RESPONSE_BYTES > 0, 'provider 响应大小限制必须存在');

  // 超时保护（F2）：withTimeout 必须在超时后用可读 Error 中止，并转发调用方取消。
  const timeoutHandle = withTimeout(undefined, 20, '合成超时测试（120 秒）');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert(timeoutHandle.signal.aborted, '超时后 signal 必须中止');
  const timeoutReason = (timeoutHandle.signal as AbortSignal & { reason?: unknown }).reason;
  assert(timeoutReason instanceof Error && /超时/.test(timeoutReason.message), '超时原因必须是可读的 Error');
  timeoutHandle.dispose();
  const callerController = new AbortController();
  const callerHandle = withTimeout(callerController.signal, 10_000, '不该触发');
  callerController.abort();
  assert(callerHandle.signal.aborted, '调用方取消必须立即转发到合并 signal');
  callerHandle.dispose();
  const disposedHandle = withTimeout(undefined, 20, '不该触发');
  disposedHandle.dispose();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert(!disposedHandle.signal.aborted, 'dispose 之后定时器不得再中止 signal');

  const openAiProfile = baseProfile();
  let capturedOpenAi: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const openAiRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedOpenAi = { url, init };
      return new Response('RIFFaudio', { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    },
  });
  const openAiAudio = await openAiRegistry.synthesize(openAiProfile, requestFor(openAiProfile));
  const openAiCall = capturedOpenAi as unknown as { url: RequestInfo | URL; init?: RequestInit };
  equal(openAiCall.url, openAiProfile.endpoint, 'OpenAI 兼容 provider 应请求 Profile endpoint');
  assert(openAiAudio.blob.size > 0, 'OpenAI 兼容 provider 应返回 Blob');
  assert(!String(openAiCall.init?.body).includes(openAiProfile.apiKey), 'OpenAI 请求体不得带 API Key');

  // 豆包：合成走 SillyTavern 同源桥接（server-plugins/ganggang-tts-bridge），凭据只发给同源桥接。
  const doubaoProfile = baseProfile({
    id: 'doubao',
    name: '豆包',
    type: 'doubao',
    apiKey: 'new-api-secret',
    defaultVoiceId: 'speaker',
    resourceId: 'seed-tts-2.0',
  });
  const csrfHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' };
  let capturedDoubao: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const doubaoRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedDoubao = { url, init };
      if (String(url) === DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT) {
        return new Response(
          JSON.stringify({
            pluginId: 'ganggang-tts-bridge',
            doubao: {
              available: true,
              synthesizePath: DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT,
              requestContentType: DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE,
              responseContentType: 'audio/mpeg',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('bridge-mp3-audio', {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    },
    getSillyTavernHeaders: () => csrfHeaders,
  });
  const doubaoAudio = await doubaoRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile));
  const doubaoCall = capturedDoubao as unknown as { url: RequestInfo | URL; init?: RequestInit };
  const doubaoHeaders = doubaoCall.init?.headers as Record<string, string>;
  const doubaoBody = JSON.parse(String(doubaoCall.init?.body)) as {
    apiKey?: string;
    appId?: string;
    accessKey?: string;
    resourceId?: string;
    speaker?: string;
    text?: string;
    contextText?: string;
  };
  equal(doubaoCall.url, DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT, '豆包合成必须发给同源桥接端点');
  equal(doubaoHeaders['Content-Type'], DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE, '豆包桥接请求必须使用专用 Content-Type');
  equal(doubaoHeaders['X-CSRF-Token'], 'csrf-test-token', '桥接请求必须携带酒馆会话头');
  equal(doubaoBody.apiKey, 'new-api-secret', '豆包新版凭据必须交给同源桥接（由服务端转发上游）');
  equal(doubaoBody.appId, '', '使用新版 API Key 时旧版 APP ID 必须为空');
  equal(doubaoBody.accessKey, '', '使用新版 API Key 时旧版 Access Key 必须为空');
  equal(doubaoBody.resourceId, 'seed-tts-2.0', '豆包请求必须带 Resource ID');
  equal(doubaoBody.speaker, 'speaker', '豆包音色必须放在 speaker 字段');
  equal(doubaoBody.text, '你好', '豆包台词必须放在 text 字段');
  equal(doubaoAudio.mimeType, 'audio/mpeg', '豆包桥接合成结果必须是 audio/mpeg');
  equal(doubaoAudio.blob.type, 'audio/mpeg', '豆包 Blob 必须是 audio/mpeg');
  assert(doubaoAudio.blob.size > 0, '豆包应返回音频');
  assert(!JSON.stringify(doubaoAudio).includes('new-api-secret'), '合成结果与缓存描述不得包含凭据');

  await doubaoRegistry.synthesize(doubaoProfile, { ...requestFor(doubaoProfile), contextText: '（低声）' });
  const doubaoContextBody = JSON.parse(
    String((capturedDoubao as unknown as { init?: RequestInit }).init?.body),
  ) as { contextText?: string };
  equal(doubaoContextBody.contextText, '（低声）', '豆包 contextText 必须原样交给桥接');

  // probe：只检查同源桥接能力，不联网验证凭据。
  const doubaoProbe = await doubaoRegistry.probe(doubaoProfile);
  const doubaoProbeCall = capturedDoubao as unknown as { url: RequestInfo | URL; init?: RequestInit };
  equal(doubaoProbeCall.url, DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT, '豆包 probe 必须请求桥接能力端点');
  equal((doubaoProbeCall.init as { method?: string }).method, 'GET', '豆包 probe 必须用 GET 拉能力');
  equal(doubaoProbe.mode, 'plugin', '豆包 probe 必须报告 plugin 传输模式');
  equal(doubaoProbe.configured, true, '豆包 probe 必须声明桥接已配置');
  equal(doubaoProbe.unverified, true, '豆包 probe 必须声明未联网验证凭据');

  // Resource ID 缺省时回落到内置默认值。
  const doubaoDefaultProfile = baseProfile({
    id: 'doubao',
    name: '豆包',
    type: 'doubao',
    apiKey: 'k2',
    defaultVoiceId: 'speaker',
    resourceId: '',
  });
  await doubaoRegistry.synthesize(doubaoDefaultProfile, requestFor(doubaoDefaultProfile));
  const doubaoDefaultBody = JSON.parse(
    String((capturedDoubao as unknown as { init?: RequestInit }).init?.body),
  ) as { resourceId?: string };
  equal(doubaoDefaultBody.resourceId, DEFAULT_DOUBAO_RESOURCE_ID, '未填 Resource ID 必须回落到内置默认值');

  const doubaoBridgeDownRegistry = createProviderRegistry({
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });
  await expectError(
    () => doubaoBridgeDownRegistry.probe(doubaoProfile),
    /豆包桥接不可用（未安装或版本过旧）/,
    '桥接 404 必须给出可读的安装提示',
  );
  const doubaoAuthRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 'UPSTREAM_AUTH' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  await expectError(
    () => doubaoAuthRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包鉴权失败$/,
    '桥接 UPSTREAM_AUTH 必须分类为鉴权失败，且不回显上游原文或凭据',
  );
  const doubaoNetworkRegistry = createProviderRegistry({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await expectError(
    () => doubaoNetworkRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /Failed to fetch/,
    '网络层失败必须给出可观察原因',
  );

  const doubaoAbort = new AbortController();
  doubaoAbort.abort();
  const doubaoAbortSynthesizeRegistry = createProviderRegistry({
    fetchImpl: async (_url, init) => {
      assert(init?.signal?.aborted === true, '豆包 synthesis 必须把调用方取消传进 fetch');
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  try {
    await doubaoAbortSynthesizeRegistry.synthesize(doubaoProfile, {
      ...requestFor(doubaoProfile),
      signal: doubaoAbort.signal,
    });
    throw new Error('已取消的豆包请求不应成功');
  } catch (error) {
    assert(error instanceof DOMException && error.name === 'AbortError', '豆包取消必须保留 AbortError');
  }

  const minimaxProfile = baseProfile({
    id: 'minimax',
    name: 'MiniMax',
    type: 'minimax',
    apiKey: 'minimax-secret',
    groupId: 'group-123',
    defaultVoiceId: 'female-shaonv',
    model: 'speech-2.8-hd',
    responseFormat: 'mp3',
  });
  let capturedMinimax: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  let minimaxCallCount = 0;
  const minimaxRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      minimaxCallCount += 1;
      capturedMinimax = { url, init };
      if (String(url).startsWith(MINIMAX_VOICE_ENDPOINTS.cn)) {
        assert(
          String(url).includes('GroupId=group-123'),
          'MiniMax 音色列表请求必须携带 GroupId 查询参数',
        );
        return new Response(
          JSON.stringify({
            base_resp: { status_code: 0 },
            system_voice: [
              { voice_id: 'male-qn-qingse', voice_name: '青涩青年', description: ['少年感男声'] },
              { voice_id: 'female-shaonv', voice_name: '少女', description: '少女音' },
            ],
          }),
          { status: 200 },
        );
      }
      assert(
        String(url).startsWith(MINIMAX_ENDPOINTS.cn) && String(url).includes('GroupId=group-123'),
        'MiniMax 合成请求必须携带平台端点与 GroupId 查询参数',
      );
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: '6d7033' } }), {
        status: 200,
      });
    },
  });
  const minimaxVoices = await minimaxRegistry.listVoices(minimaxProfile);
  equal(
    minimaxVoices.map(voice => voice.voiceId),
    ['male-qn-qingse', 'female-shaonv'],
    'MiniMax listVoices 必须解析上游目录接口返回的音色',
  );
  equal(capturedMinimax && String((capturedMinimax as unknown as { url: RequestInfo | URL }).url).startsWith(MINIMAX_VOICE_ENDPOINTS.cn), true, 'MiniMax listVoices 必须请求音色目录端点');
  assert(
    minimaxVoices.every(voice => (voice.description ?? '').length > 0),
    '上游返回的音色说明必须保留，AI 才能按音色选人',
  );
  const minimaxProbe = await minimaxRegistry.probe(minimaxProfile);
  equal(minimaxCallCount, 2, 'probe 内部已拉取音色目录时不得对上游发第二次相同请求');
  equal(minimaxProbe.mode, 'direct', 'MiniMax probe 必须报告 direct 传输模式');
  equal(minimaxProbe.configured, true, 'MiniMax probe 必须声明已配置');
  equal(minimaxProbe.voiceCount, 2, 'MiniMax probe 必须报告音色数量');
  equal(
    (minimaxProbe.voices ?? []).map(voice => voice.voiceId),
    ['male-qn-qingse', 'female-shaonv'],
    'probe 必须带回已拉取的音色目录，供 runtime 复用',
  );
  assert(
    (await minimaxRegistry.synthesize(minimaxProfile, requestFor(minimaxProfile))).blob.size > 0,
    'MiniMax 应返回音频',
  );
  const minimaxSynthBody = JSON.parse(
    String((capturedMinimax as unknown as { init?: RequestInit }).init?.body),
  ) as { voice_setting?: { voice_id?: string } };
  equal(minimaxSynthBody.voice_setting?.voice_id, 'female-shaonv', 'MiniMax 音色必须放在 voice_setting.voice_id');
  const minimaxAuthHeaders = ((capturedMinimax as unknown as { init?: RequestInit }).init?.headers ??
    {}) as Record<string, string>;
  equal(minimaxAuthHeaders.Authorization, 'Bearer minimax-secret', 'MiniMax 凭据必须放在 Authorization 头');
  assert(
    !String((capturedMinimax as unknown as { init?: RequestInit }).init?.body).includes('minimax-secret'),
    'MiniMax 凭据不得进入请求体',
  );

  const minimaxServiceErrorRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key minimax-secret' } }), {
        status: 200,
      }),
  });
  await expectError(
    () => minimaxServiceErrorRegistry.synthesize(minimaxProfile, requestFor(minimaxProfile)),
    /MiniMax 服务错误 1004(?!.*minimax-secret)/,
    'MiniMax 业务错误必须给出错误码，且错误正文必须脱敏凭据',
  );

  const mimoProfile = baseProfile({
    id: 'mimo',
    name: 'MiMo',
    type: 'xiaomi-mimo',
    apiKey: 'mimo-secret',
    defaultVoiceId: 'mimo_default',
    model: 'mimo-v2.5-tts',
    responseFormat: 'wav',
  });
  let capturedMimo: { url: RequestInfo | URL; init?: RequestInit; body?: string } | null = null;
  let mimoCallCount = 0;
  const mimoRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      mimoCallCount += 1;
      capturedMimo = { url, init, body: String(init?.body) };
      return new Response(JSON.stringify({ choices: [{ message: { audio: { data: btoa('wav') } } }] }), {
        status: 200,
      });
    },
  });
  const mimoProbe = await mimoRegistry.probe(mimoProfile);
  equal(mimoCallCount, 0, 'MiMo probe 是纯配置检查，不得发起任何网络请求');
  equal(mimoProbe.mode, 'direct', 'MiMo probe 必须报告 direct 模式');
  equal(mimoProbe.configured, true, 'MiMo probe 必须声明已配置');
  equal(mimoProbe.unverified, true, 'MiMo probe 必须声明未联网验证');
  const mimoAudio = await mimoRegistry.synthesize(mimoProfile, requestFor(mimoProfile));
  equal(
    (capturedMimo as unknown as { url: RequestInfo | URL }).url,
    XIAOMI_MIMO_ENDPOINT,
    'MiMo 合成必须请求小米 MiMo 端点',
  );
  assert(mimoAudio.blob.size > 0, 'MiMo 应返回音频');
  const mimoBody = JSON.parse(String((capturedMimo as unknown as { body?: string }).body)) as {
    messages?: Array<{ role: string; content: string }>;
    audio?: { voice?: string };
  };
  equal(mimoBody.messages?.[0]?.content, '你好', 'MiMo 台词必须放在 assistant 消息');
  equal(mimoBody.audio?.voice, 'mimo_default', 'MiMo 音色必须放在 audio.voice');
  const mimoStyleProfile = baseProfile({
    id: 'mimo-style',
    name: 'MiMo',
    type: 'xiaomi-mimo',
    apiKey: 'mimo-secret',
    defaultVoiceId: 'mimo_default',
    style: '低声细语',
  });
  await mimoRegistry.synthesize(mimoStyleProfile, requestFor(mimoStyleProfile));
  const mimoStyleBody = JSON.parse(String((capturedMimo as unknown as { body?: string }).body)) as {
    messages?: Array<{ role: string; content: string }>;
  };
  equal(mimoStyleBody.messages?.[0], { role: 'user', content: '低声细语' }, 'MiMo Profile style 必须作为 user 消息');
  equal(mimoStyleBody.messages?.[1]?.content, '你好', 'MiMo 台词本体必须放在 assistant 消息');

  const mimoQuotaRegistry = createProviderRegistry({
    fetchImpl: async () => new Response('quota', { status: 429 }),
  });
  await expectError(
    () => mimoQuotaRegistry.synthesize(mimoProfile, requestFor(mimoProfile)),
    /HTTP 429/,
    '合成失败必须给出 HTTP 状态原因',
  );
  const mimoNetworkRegistry = createProviderRegistry({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await expectError(
    () => mimoNetworkRegistry.synthesize(mimoProfile, requestFor(mimoProfile)),
    /Failed to fetch/,
    '网络故障必须可观察且不泄露凭据',
  );

  const edgeProfile = baseProfile({
    id: 'edge',
    name: 'Edge',
    type: 'edge',
    apiKey: '',
    defaultVoiceId: 'zh-CN-XiaoxiaoNeural',
  });
  let capturedEdge: RequestInfo | URL | null = null;
  const edgeRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      void init;
      capturedEdge = url;
      return new Response('EDGE', { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    },
  });
  await edgeRegistry.synthesize(edgeProfile, requestFor(edgeProfile, '旁白'));
  equal(capturedEdge, '/api/plugins/edge-tts/generate', 'Edge provider 应使用 Tavern Edge 插件端点');
  const edgeVoices = await edgeRegistry.listVoices(edgeProfile);
  assert(
    edgeVoices.some(voice => voice.voiceId === edgeProfile.defaultVoiceId),
    'Edge 应提供静态音色目录',
  );
  assert(
    edgeVoices.every(voice => (voice.description ?? '').length > 0),
    'Edge 内置目录每个音色都要带说明（AI 配音导演靠它选人）',
  );
  const doubaoVoices = await doubaoRegistry.listVoices(doubaoProfile);
  assert(doubaoVoices.length >= 20, '豆包内置目录应有足够候选');
  assert(
    doubaoVoices.every(voice => (voice.description ?? '').length > 0),
    '豆包内置目录每个音色都要带说明（AI 配音导演靠它选人）',
  );
  const mimoVoices = await mimoRegistry.listVoices(mimoProfile);
  assert(
    mimoVoices.every(voice => (voice.description ?? '').length > 0),
    'MiMo 内置目录每个音色都要带说明（音色名是代号，AI 无法从名字判断）',
  );
  equal(mimoCallCount, 2, 'MiMo 只有两次合成请求；静态目录不得发起网络请求');

  const aborted = new AbortController();
  aborted.abort();
  const abortRegistry = createProviderRegistry({
    fetchImpl: async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response('unexpected', { status: 500 });
    },
  });
  try {
    await abortRegistry.synthesize(openAiProfile, { ...requestFor(openAiProfile), signal: aborted.signal });
    throw new Error('已取消的 TTS 请求不应成功');
  } catch (error) {
    assert(error instanceof DOMException && error.name === 'AbortError', '取消请求必须保留 AbortError');
  }

  console.info('<杠杠の配音台> offline TTS tests passed');
})().catch(error => {
  console.error(error);
  throw error;
});
