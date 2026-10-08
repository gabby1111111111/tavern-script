import { createPlaybackSessionManager } from '../src/杠杠の配音室/tts/playback-session';
import { detectAudioType } from '../src/杠杠の配音室/tts/audio-signature';
import {
  buildDoubaoUpstreamRequest,
  DOUBAO_TTS_ENDPOINT,
  DOUBAO_TTS_PROXY_PATH,
  parseDoubaoNdjson,
} from '../src/杠杠の配音室/tts/doubao-request';
import {
  FISH_MODEL_ENDPOINT,
  FISH_TTS_PROXY_PATH,
  MINIMAX_ENDPOINTS,
  XIAOMI_MIMO_ENDPOINT,
} from '../src/杠杠の配音室/tts/cloud-request';
import {
  createProviderRegistry,
  describeProxyFailure,
  MAX_PROXY_AUDIO_BYTES,
  MAX_TTS_RESPONSE_BYTES,
  MAX_TTS_WIRE_BYTES,
  redactProviderSecrets,
} from '../src/杠杠の配音室/tts/providers';
import * as providersModule from '../src/杠杠の配音室/tts/providers';
import { extractContentText, parseSpokenSegments } from '../src/杠杠の配音室/tts/text';
import type { SynthesisRequest, TtsProviderProfile } from '../src/杠杠の配音室/types';

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

  // 豆包经酒馆 /proxy：豆包 CORS 预检不放行新版 X-Api-Key（8000 实测），直连必被拦。
  const doubao = buildDoubaoUpstreamRequest({ apiKey: 'new-api-secret', speaker: 'speaker', text: '你好' });
  equal(DOUBAO_TTS_PROXY_PATH, '/proxy/' + DOUBAO_TTS_ENDPOINT, '豆包必须以相对路径 /proxy + 完整目标 URL');
  equal(doubao.url, DOUBAO_TTS_PROXY_PATH, '豆包合成必须经酒馆同源 /proxy（不走供应商直连）');
  const doubaoRequestHeaders = doubao.headers as Record<string, string>;
  equal(doubaoRequestHeaders['X-Api-Key'], 'new-api-secret', '豆包凭据必须走新版 X-Api-Key 请求头');
  equal(doubaoRequestHeaders['X-Api-App-Key'], undefined, '豆包旧版 APP ID 头已弃用');
  equal(doubaoRequestHeaders['X-Api-Access-Key'], undefined, '豆包旧版 Access Key 头已弃用');
  equal(doubaoRequestHeaders['X-Api-Resource-Id'], 'seed-tts-2.0', '豆包请求必须带 Resource ID');
  assert(Boolean(doubao.headers['X-Api-Request-Id']), '豆包请求必须带独立 Request ID');
  assert(!JSON.stringify(doubao.payload).includes('new-api-secret'), '豆包凭据不得进入请求体');
  await expectError(
    async () => {
      buildDoubaoUpstreamRequest({ apiKey: '', speaker: 'speaker', text: '你好' });
    },
    /豆包 TTS 缺少 API Key/,
    '豆包旧版凭据已弃用：没有 API Key 必须直接报缺凭据，而不是回落到旧版头',
  );
  equal(
    parseDoubaoNdjson(JSON.stringify({ code: 0, data: btoa('mp3') }), 1024).length,
    3,
    '豆包 NDJSON 应拼出音频字节',
  );
  await expectError(
    async () => {
      parseDoubaoNdjson(JSON.stringify({ code: 45000000, message: 'resource mismatch' }), 1024);
    },
    /45000000：音色与资源 ID 不配套/,
    '豆包 45000000 必须给出"音色与资源 ID 不配套"的可读原因',
  );
  await expectError(
    async () => {
      parseDoubaoNdjson(
        JSON.stringify({ code: 55000000, message: 'resource ID is mismatched with speaker related resource' }),
        1024,
      );
    },
    /55000000：音色与资源 ID 不配套/,
    '豆包 55000000（实测拿 Edge 音色配 seed-tts-2.0 触发）也必须给出同一族可读原因',
  );

  // /proxy 会丢上游 Content-Type（2026-10-08 在 8000 实测 content-type 为 null），魔数兜底是硬需求。
  equal(
    detectAudioType(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    'audio/mpeg',
    'ID3 头必须识别为 MP3',
  );
  equal(detectAudioType(new Uint8Array([0xff, 0xfb, 0x90, 0xc4])), 'audio/mpeg', 'MP3 帧同步必须识别为 MP3');
  equal(detectAudioType(new TextEncoder().encode('RIFFxxxxWAVE')), 'audio/wav', 'RIFF/WAVE 必须识别为 WAV');
  const oggHead = new Uint8Array(27);
  oggHead.set([0x4f, 0x67, 0x67, 0x53, 0x00]);
  equal(detectAudioType(oggHead), 'audio/ogg', 'OggS 必须识别为 OGG');
  equal(detectAudioType(new TextEncoder().encode('fLaCxxxx')), 'audio/flac', 'fLaC 必须识别为 FLAC');
  equal(detectAudioType(new TextEncoder().encode('<html>请登录</html>')), null, '文本响应不得被识别为音频');
  equal(detectAudioType(new Uint8Array(0)), null, '空响应不得被识别为音频');

  equal(
    describeProxyFailure('Fish', 404, ''),
    'Fish 酒馆 /proxy 不可用：请在 config.yaml 打开 enableCorsProxy 并重启酒馆',
    '404 必须直接给出 enableCorsProxy 修法',
  );
  equal(
    describeProxyFailure('Fish', 402, ''),
    'Fish 额度不足：请确认请求头 model 是免费档（默认 s2.1-pro-free）',
    '402 必须指向 model 请求头，而不是笼统报网络错误',
  );

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

  const doubaoProfile = baseProfile({
    id: 'doubao',
    name: '豆包',
    type: 'doubao',
    apiKey: 'new-api-secret',
    defaultVoiceId: 'speaker',
    // 旧版字段留着但已弃用：用来证明它们既不进请求头也不进请求体。
    appId: 'stale-app-id',
    accessKey: 'stale-access-secret',
    resourceId: 'seed-tts-2.0',
  });
  const csrfHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' };
  const ndjsonBody = (...events: Array<Record<string, unknown>>) => events.map(event => JSON.stringify(event)).join('\n');
  let capturedDoubao: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const doubaoRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedDoubao = { url, init };
      // 豆包响应是连续的 JSON 对象流：base64 分片 + 结尾 usage 对象
      return new Response(ndjsonBody({ code: 0, data: btoa('mp3audio') }, { code: 20000000 }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
    getSillyTavernHeaders: () => csrfHeaders,
  });
  const doubaoAudio = await doubaoRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile));
  const doubaoCall = capturedDoubao as unknown as { url: RequestInfo | URL; init?: RequestInit };
  const doubaoHeaders = doubaoCall.init?.headers as Record<string, string>;
  const doubaoBody = JSON.parse(String(doubaoCall.init?.body)) as {
    req_params?: { text?: string; speaker?: string; audio_params?: { format?: string }; additions?: string };
  };
  equal(doubaoCall.url, DOUBAO_TTS_PROXY_PATH, '豆包合成必须经酒馆同源 /proxy');
  equal(doubaoHeaders['X-Api-Key'], 'new-api-secret', '豆包凭据必须走新版 X-Api-Key');
  equal(doubaoHeaders['X-Api-App-Key'], undefined, '豆包旧版 APP ID 头已弃用，不得再发送');
  equal(doubaoHeaders['X-Api-Access-Key'], undefined, '豆包旧版 Access Key 头已弃用，不得再发送');
  equal(doubaoHeaders['X-Api-Resource-Id'], 'seed-tts-2.0', '豆包请求必须带 Resource ID');
  assert(Boolean(doubaoHeaders['X-Api-Request-Id']), '豆包请求必须带独立 Request ID');
  equal(doubaoHeaders['X-CSRF-Token'], undefined, '豆包上游请求不得夹带酒馆会话头（/proxy 自行处理）');
  equal(doubaoBody.req_params?.text, '你好', '豆包台词必须放在 req_params.text');
  equal(doubaoBody.req_params?.speaker, 'speaker', '豆包音色必须放在 req_params.speaker');
  equal(doubaoBody.req_params?.audio_params?.format, 'mp3', '豆包必须请求 mp3');
  assert(!String(doubaoCall.init?.body).includes('new-api-secret'), '豆包凭据不得进入请求体');
  assert(!String(doubaoCall.init?.body).includes('stale-access-secret'), '已弃用的旧版凭据不得混入请求体');
  equal(doubaoAudio.mimeType, 'audio/mpeg', '豆包 NDJSON 合成结果必须是 audio/mpeg');
  equal(doubaoAudio.blob.type, 'audio/mpeg', '豆包 Blob 必须是 audio/mpeg');

  await doubaoRegistry.synthesize(doubaoProfile, { ...requestFor(doubaoProfile), contextText: '（低声）' });
  const doubaoContextBody = JSON.parse(
    String((capturedDoubao as unknown as { init?: RequestInit }).init?.body),
  ) as { req_params?: { additions?: string } };
  equal(
    JSON.parse(String(doubaoContextBody.req_params?.additions)).context_texts,
    ['（低声）'],
    '豆包 contextText 必须作为 context_texts additions 发送',
  );

  const probe = await doubaoRegistry.probe(doubaoProfile);
  const doubaoProbeCall = capturedDoubao as unknown as { url: RequestInfo | URL; init?: RequestInit };
  equal(doubaoProbeCall.url, DOUBAO_TTS_PROXY_PATH, '豆包 probe 必须以经 /proxy 的真实合成收尾');
  const doubaoProbeBody = JSON.parse(String(doubaoProbeCall.init?.body)) as {
    req_params?: { text?: string; speaker?: string };
  };
  equal(doubaoProbeBody.req_params?.text, '你好', '豆包 probe 必须合成"你好"而不是配置占位文本');
  equal(
    doubaoProbeBody.req_params?.speaker,
    'zh_male_kailangdidi_uranus_bigtts',
    '豆包 probe 必须使用内置豆包音色，避免默认音色串引擎污染结论',
  );
  equal(probe.mode, 'proxy', '豆包 probe 必须报告 /proxy 传输模式');
  equal(probe.checked, 'synthesis', '豆包 probe 必须声明完成真实合成验证');

  const doubaoAbortController = new AbortController();
  let doubaoRequestAborted: boolean | null = null;
  const doubaoAbortRegistry = createProviderRegistry({
    fetchImpl: async (_url, init) => {
      // 让出一轮微/宏任务，模拟真实网络往返期间调用方取消
      await new Promise(resolve => setTimeout(resolve, 0));
      doubaoRequestAborted = Boolean(init?.signal?.aborted);
      if (doubaoRequestAborted) throw new DOMException('Aborted', 'AbortError');
      return new Response(ndjsonBody({ code: 0, data: btoa('mp3') }), { status: 200 });
    },
  });
  const doubaoAbortProbe = doubaoAbortRegistry.probe(doubaoProfile, doubaoAbortController.signal);
  doubaoAbortController.abort();
  await expectError(() => doubaoAbortProbe, /Abort|取消/, '豆包 probe 必须尊重调用方的取消信号');
  equal(doubaoRequestAborted, true, '豆包 probe 必须把调用方取消透传给上游请求');

  // 回归闸门：豆包只允许打 /proxy（前缀固定），任何供应商直连或桥接请求都是回归。
  const doubaoUpstreamOnlyRegistry = createProviderRegistry({
    fetchImpl: async url => {
      assert(url === DOUBAO_TTS_PROXY_PATH, `豆包不得再请求任何非 /proxy 端点: ${String(url)}`);
      return new Response(ndjsonBody({ code: 0, data: btoa('mp3') }), { status: 200 });
    },
  });
  const doubaoUpstreamOnlyProbe = await doubaoUpstreamOnlyRegistry.probe(doubaoProfile);
  equal(doubaoUpstreamOnlyProbe.mode, 'proxy', '豆包 probe 必须完全脱离直连与同源桥接');

  // 旧版凭据已弃用：profile 里只留 appId/accessKey 时不能静默回落到旧版头，必须直接报缺 API Key。
  const doubaoLegacyOnlyProfile = baseProfile({
    id: 'doubao-legacy',
    name: '豆包旧版',
    type: 'doubao',
    apiKey: '',
    appId: 'stale-app-id',
    accessKey: 'stale-access-secret',
    resourceId: 'seed-tts-2.0',
    defaultVoiceId: 'speaker',
  });
  const doubaoLegacyOnlyRegistry = createProviderRegistry({
    fetchImpl: async () => {
      throw new Error('旧版凭据不得发起任何请求');
    },
  });
  await expectError(
    () => doubaoLegacyOnlyRegistry.probe(doubaoLegacyOnlyProfile),
    /豆包 TTS 缺少 API Key/,
    '只有旧版凭据的 profile 必须直接报缺 API Key',
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

  const doubaoAuthRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 40100000, message: `denied ${doubaoProfile.accessKey}` }), { status: 401 }),
  });
  await expectError(
    () => doubaoAuthRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包 鉴权失败：凭据无效或未授权$/,
    '豆包 401 必须分类为凭据错误，且不回显上游原文或凭据',
  );

  const doubaoResourceMismatchRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 45000000, message: `denied ${doubaoProfile.accessKey}` }), { status: 403 }),
  });
  await expectError(
    () => doubaoResourceMismatchRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包 音色与资源 ID 不配套：2\.0 音色必须配 X-Api-Resource-Id: seed-tts-2\.0$/,
    '豆包 403/45000000 必须点明音色与资源 ID 不配套，与跨域误诊切割',
  );

  const doubaoStreamErrorRegistry = createProviderRegistry({
    fetchImpl: async () => new Response(ndjsonBody({ code: 45000000, message: 'resource mismatch' }), { status: 200 }),
  });
  await expectError(
    () => doubaoStreamErrorRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /豆包 TTS 错误 45000000：音色与资源 ID 不配套/,
    '豆包流内错误码必须给出可读原因',
  );

  const doubaoNetworkRegistry = createProviderRegistry({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await expectError(
    () => doubaoNetworkRegistry.probe(doubaoProfile),
    /豆包 网络错误：无法连接酒馆 \/proxy/,
    '豆包网络故障必须给出 /proxy 相关的可读原因',
  );

  const oversizedDoubaoRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response('too-large', {
        headers: { 'Content-Type': 'text/event-stream', 'Content-Length': String(MAX_TTS_WIRE_BYTES + 1) },
      }),
  });
  await expectError(
    () => oversizedDoubaoRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包数据超过大小限制$/,
    '豆包声明超限的响应必须在浏览器读取前拒绝',
  );

  const minimaxProfile = baseProfile({
    id: 'minimax',
    name: 'MiniMax',
    type: 'minimax',
    apiKey: 'minimax-secret',
    groupId: 'group-123',
    defaultVoiceId: 'male-qn-qingse',
    model: 'speech-2.8-hd',
    responseFormat: 'mp3',
  });
  let capturedMinimax: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const minimaxRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedMinimax = { url, init };
      assert(
        String(url).startsWith(MINIMAX_ENDPOINTS.cn) && String(url).includes('GroupId=group-123'),
        'MiniMax 请求必须携带平台端点与 GroupId 查询参数',
      );
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: '6d7033' } }), {
        status: 200,
      });
    },
  });
  const minimaxVoices = await minimaxRegistry.listVoices(minimaxProfile);
  equal(
    minimaxVoices.map(voice => voice.voiceId),
    ['male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng'],
    'MiniMax 音色表应使用内置精选清单（get_voice 已改版 404）',
  );
  equal(capturedMinimax, null, 'MiniMax 内置清单不得请求供应商目录接口');
  const minimaxProbe = await minimaxRegistry.probe(minimaxProfile);
  const minimaxProbeCall = capturedMinimax as unknown as { url: RequestInfo | URL; init?: RequestInit };
  assert(
    String(minimaxProbeCall.url).startsWith(MINIMAX_ENDPOINTS.cn),
    'MiniMax probe 必须以真实合成验证凭据',
  );
  const minimaxProbeBody = JSON.parse(String(minimaxProbeCall.init?.body)) as { text?: string };
  equal(minimaxProbeBody.text, '你好', 'MiniMax probe 必须合成"你好"');
  equal(minimaxProbe.checked, 'synthesis', 'MiniMax probe 必须声明完成真实合成验证');
  assert(
    (await minimaxRegistry.synthesize(minimaxProfile, requestFor(minimaxProfile))).blob.size > 0,
    'MiniMax 应返回音频',
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
  const mimoRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedMimo = { url, init, body: String(init?.body) };
      return new Response(JSON.stringify({ choices: [{ message: { audio: { data: btoa('wav') } } }] }), {
        status: 200,
      });
    },
  });
  const mimoProbe = await mimoRegistry.probe(mimoProfile);
  equal(
    (capturedMimo as unknown as { url: RequestInfo | URL }).url,
    XIAOMI_MIMO_ENDPOINT,
    'MiMo probe 必须真实合成验证凭据',
  );
  equal(mimoProbe.checked, 'synthesis', 'MiMo probe 必须声明完成真实合成验证');
  const mimoProbeBody = JSON.parse(String((capturedMimo as unknown as { body?: string }).body)) as {
    messages?: Array<{ role: string; content: string }>;
  };
  equal(mimoProbeBody.messages?.[0]?.content, '你好', 'MiMo probe 台词必须放在 assistant 消息');
  assert((await mimoRegistry.synthesize(mimoProfile, requestFor(mimoProfile))).blob.size > 0, 'MiMo 应返回音频');
  await mimoRegistry.synthesize(mimoProfile, {
    ...requestFor(mimoProfile, '（撒娇）你还在生气吗……'),
    instruction: '角色：程妄。指导：明亮干净的年轻男声，尾音上扬。',
  });
  const mimoInstructionBody = JSON.parse(
    String((capturedMimo as unknown as { body?: string }).body),
  ) as { messages?: Array<{ role: string; content: string }> };
  equal(
    mimoInstructionBody.messages?.[0],
    { role: 'user', content: '角色：程妄。指导：明亮干净的年轻男声，尾音上扬。' },
    'MiMo 请求级导演指令必须作为 user 消息优先于 Profile style',
  );
  equal(
    mimoInstructionBody.messages?.[1]?.content,
    '（撒娇）你还在生气吗……',
    'MiMo 台词本体必须放在 assistant 消息',
  );

  const fishProfile = baseProfile({
    id: 'fish',
    name: 'Fish',
    type: 'fish',
    apiKey: 'fish-secret',
    model: 's2.1-pro-free',
    defaultVoiceId: 'fish-ref-1',
    responseFormat: 'mp3',
  });
  const mp3Frame = new Uint8Array([0xff, 0xfb, 0x90, 0xc4, 0x00, 0x00, 0x00, 0x00]);
  let capturedFish: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const fishRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedFish = { url, init };
      if (String(url).startsWith(FISH_MODEL_ENDPOINT)) {
        return Response.json({
          items: [
            { _id: 'fish-ref-1', title: '测试音色' },
            { _id: 'fish-ref-2', title: '另一音色' },
          ],
          total: 2,
        });
      }
      // /proxy 实测会丢上游 Content-Type（content-type 为 null），这里刻意不给响应头以逼出魔数兜底。
      return new Response(mp3Frame, { status: 200 });
    },
    getSillyTavernHeaders: () => ({ 'X-CSRF-Token': 'csrf-fish' }),
  });
  const fishVoices = await fishRegistry.listVoices(fishProfile);
  equal(
    fishVoices.map(voice => voice.voiceId),
    ['fish-ref-1', 'fish-ref-2'],
    'Fish 音色表应直连动态拉取公开音色市场',
  );
  const fishAudio = await fishRegistry.synthesize(fishProfile, requestFor(fishProfile, '[happy] 你好吗'));
  const fishCall = capturedFish as unknown as { url: RequestInfo | URL; init?: RequestInit };
  equal(FISH_TTS_PROXY_PATH, '/proxy/https://api.fish.audio/v1/tts', '/proxy 后必须跟完整目标 URL 且不做 encode');
  equal(fishCall.url, FISH_TTS_PROXY_PATH, 'Fish 合成必须经酒馆同源 /proxy 转发');
  const fishHeaders = fishCall.init?.headers as Record<string, string>;
  equal(fishHeaders.Authorization, 'Bearer fish-secret', 'Fish 凭据必须放在 Authorization 头（/proxy 会透传）');
  equal(fishHeaders.model, 's2.1-pro-free', 'Fish 模型必须在请求头 model（漏了会走付费模型报 402）');
  equal(fishHeaders['Content-Type'], 'application/json', 'Fish 请求必须是 JSON');
  equal(fishHeaders['X-CSRF-Token'], undefined, 'Fish 上游请求不得夹带酒馆会话头');
  const fishBody = JSON.parse(String(fishCall.init?.body)) as Record<string, unknown>;
  equal(fishBody.reference_id, 'fish-ref-1', 'Fish 音色必须以 reference_id 发送');
  equal(fishBody.text, '[happy] 你好吗', 'Fish FAS2 标签必须随台词透传');
  equal(fishBody.format, 'mp3', 'Fish 必须请求 mp3');
  equal(fishBody.latency, 'normal', 'Fish 必须使用 normal 延迟档');
  assert(!String(fishCall.init?.body).includes('fish-secret'), 'Fish 凭据不得进入请求体');
  equal(fishAudio.mimeType, 'audio/mpeg', '/proxy 丢失 Content-Type 时必须靠魔数识别为 audio/mpeg');
  equal(fishAudio.blob.type, 'audio/mpeg', 'Fish Blob 必须是 audio/mpeg');
  assert(fishAudio.blob.size > 0, 'Fish 应返回音频');

  const fishDefaultModelProfile = baseProfile({
    id: 'fish-default-model',
    name: 'Fish 未填模型',
    type: 'fish',
    apiKey: 'fish-secret',
    model: '',
    defaultVoiceId: 'fish-ref-1',
  });
  await fishRegistry.synthesize(fishDefaultModelProfile, requestFor(fishDefaultModelProfile));
  const fishDefaultHeaders = (capturedFish as unknown as { init?: RequestInit }).init?.headers as Record<string, string>;
  equal(fishDefaultHeaders.model, 's2.1-pro-free', 'Fish 未填模型时必须回落到免费档，避免误走付费模型 402');

  const fishProbe = await fishRegistry.probe(fishProfile);
  const fishProbeCall = capturedFish as unknown as { url: RequestInfo | URL };
  equal(fishProbeCall.url, FISH_TTS_PROXY_PATH, 'Fish probe 必须以 /proxy 真实合成收尾');
  equal(fishProbe.mode, 'proxy', 'Fish probe 必须报告 /proxy 传输模式');
  equal(fishProbe.checked, 'synthesis', 'Fish probe 必须声明完成真实合成验证');
  const fishNoVoiceProfile = baseProfile({
    id: 'fish-empty',
    name: 'Fish 无默认音色',
    type: 'fish',
    apiKey: 'fish-secret',
    defaultVoiceId: '',
  });
  await fishRegistry.probe(fishNoVoiceProfile);
  const fishProbeBody = JSON.parse(String((capturedFish as unknown as { init?: RequestInit }).init?.body)) as {
    reference_id?: string;
  };
  equal(fishProbeBody.reference_id, 'fish-ref-1', 'Fish probe 未填音色时应回落到目录第一条');

  const fishProxyDisabledRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response('CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }),
  });
  await expectError(
    () => fishProxyDisabledRegistry.synthesize(fishProfile, requestFor(fishProfile)),
    /enableCorsProxy/,
    '404 必须提示打开 enableCorsProxy 并重启酒馆',
  );
  await expectError(
    () => fishProxyDisabledRegistry.probe(fishProfile),
    /^Fish 酒馆 \/proxy 不可用/,
    'Fish probe 遇到 404 必须给出同一套可读原因',
  );

  const fishQuotaRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response(JSON.stringify({ status: 402, message: 'Insufficient API credit' }), { status: 402 }),
  });
  await expectError(
    () => fishQuotaRegistry.synthesize(fishProfile, requestFor(fishProfile)),
    /model 是免费档/,
    '402 必须指向 model 请求头与免费档（402 ≠ 免费档失效）',
  );

  const fishUnrecognizableRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response('<html><body>请登录酒馆</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  await expectError(
    () => fishUnrecognizableRegistry.synthesize(fishProfile, requestFor(fishProfile)),
    /未返回音频/,
    '返回登录页/HTML 必须分类为未返回音频，绝不能当音频播出去',
  );

  const fishOversizedRegistry = createProviderRegistry({
    fetchImpl: async () => new Response(mp3Frame, { headers: { 'Content-Length': String(MAX_PROXY_AUDIO_BYTES + 1) } }),
  });
  await expectError(
    () => fishOversizedRegistry.synthesize(fishProfile, requestFor(fishProfile)),
    /^Fish 音频超过大小限制$/,
    '超过 25MB 上限的 /proxy 音频必须拒绝',
  );

  const fishNetworkRegistry = createProviderRegistry({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await expectError(
    () => fishNetworkRegistry.synthesize(fishProfile, requestFor(fishProfile)),
    /Fish 网络错误：无法连接酒馆 \/proxy/,
    '网络层失败必须提示检查酒馆 /proxy 与登录状态',
  );

  const fishAbort = new AbortController();
  fishAbort.abort();
  const fishAbortRegistry = createProviderRegistry({
    fetchImpl: async (_url, init) => {
      assert(init?.signal?.aborted === true, 'Fish 合成必须把调用方取消传进 fetch');
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  try {
    await fishAbortRegistry.synthesize(fishProfile, { ...requestFor(fishProfile), signal: fishAbort.signal });
    throw new Error('已取消的 Fish 请求不应成功');
  } catch (error) {
    assert(error instanceof DOMException && error.name === 'AbortError', 'Fish 取消必须保留 AbortError');
  }

  const mimoUnauthorizedRegistry = createProviderRegistry({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: '内容包含敏感信息' } }), { status: 400 }),
  });
  await expectError(
    () => mimoUnauthorizedRegistry.probe(mimoProfile),
    /MiMo 内容被审核拒绝/,
    '审核拒绝必须给出可读原因',
  );
  const mimoQuotaRegistry = createProviderRegistry({
    fetchImpl: async () => new Response('quota', { status: 429 }),
  });
  await expectError(
    () => mimoQuotaRegistry.probe(mimoProfile),
    /MiMo 额度不足或请求过于频繁/,
    '429 必须分类为额度/限流',
  );
  const mimoNetworkRegistry = createProviderRegistry({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await expectError(
    () => mimoNetworkRegistry.probe(mimoProfile),
    /MiMo 网络错误：无法连接服务/,
    '网络故障必须分类为网络错误',
  );
  await expectError(
    () => mimoQuotaRegistry.synthesize(mimoProfile, requestFor(mimoProfile)),
    /MiMo 额度不足或请求过于频繁/,
    '合成失败同样必须给出可读原因',
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
  assert(
    (await edgeRegistry.listVoices(edgeProfile)).some(voice => voice.voiceId === edgeProfile.defaultVoiceId),
    'Edge 应提供静态音色目录',
  );

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

  const revoked: string[] = [];
  const manager = createPlaybackSessionManager({ revokeObjectUrl: url => revoked.push(url) });
  const first = manager.start({ segments: [{ text: 'one' }] });
  const controller = manager.createController(first, 'one');
  manager.registerObjectUrl(first, 'blob:first');
  const second = manager.start({ segments: [{ text: 'two' }] });
  assert(controller.signal.aborted, '新播放会话必须取消旧 synthesis controller');
  assert(manager.isActive(second), '新播放会话必须成为 active session');
  equal(revoked, ['blob:first'], '替换会话必须释放旧 object URL');
  assert(MAX_TTS_RESPONSE_BYTES > 0, 'provider 响应大小限制必须存在');
  assert(MAX_TTS_WIRE_BYTES > MAX_TTS_RESPONSE_BYTES, '豆包线上闸门必须大于解码后的音频上限');
  assert(MAX_PROXY_AUDIO_BYTES === 25 * 1024 * 1024, '/proxy 音频上限必须固定为 25MB');

  // 传输层迁移的全局负向断言：浏览器侧已不再导出任何桥接端点/常量。
  assert(
    !Object.keys(providersModule).some(key => /BRIDGE/.test(key)),
    'v0.2.0 起浏览器侧不得再导出 ganggang-tts-bridge 相关常量',
  );

  console.info('<杠杠の配音室/TTS> offline tests passed');
})().catch(error => {
  console.error(error);
  throw error;
});
