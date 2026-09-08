import { createPlaybackSessionManager } from '../src/杠杠の配音室/tts/playback-session';
import {
  buildDoubaoUpstreamRequest,
  DOUBAO_TTS_ENDPOINT,
  parseDoubaoNdjson,
} from '../src/杠杠の配音室/tts/doubao-request';
import {
  MINIMAX_ENDPOINTS,
  MINIMAX_VOICE_ENDPOINTS,
  XIAOMI_MIMO_ENDPOINT,
} from '../src/杠杠の配音室/tts/cloud-request';
import {
  createProviderRegistry,
  DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT,
  DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE,
  DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT,
  MAX_TTS_RESPONSE_BYTES,
  redactProviderSecrets,
} from '../src/杠杠の配音室/tts/providers';
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

  const doubao = buildDoubaoUpstreamRequest({
    appId: 'app-id',
    accessKey: 'access-secret',
    speaker: 'speaker',
    text: '你好',
  });
  equal(doubao.url, DOUBAO_TTS_ENDPOINT, '豆包必须使用固定供应商端点');
  equal(doubao.headers['X-Api-Access-Key'], 'access-secret', '豆包凭据必须放在指定请求头');
  assert(Boolean(doubao.headers['X-Api-Request-Id']), '豆包请求必须带独立 Request ID');
  assert(!JSON.stringify(doubao.payload).includes('access-secret'), '豆包凭据不得进入请求体');

  const doubaoNewAuth = buildDoubaoUpstreamRequest({
    apiKey: 'new-api-secret',
    speaker: 'speaker',
    text: '你好',
  });
  equal(doubaoNewAuth.headers['X-Api-Key'], 'new-api-secret', '豆包新版凭据必须使用 X-Api-Key');
  equal(doubaoNewAuth.headers['X-Api-App-Key'], undefined, '豆包新版请求不得混入旧版 APP ID');
  equal(doubaoNewAuth.headers['X-Api-Access-Key'], undefined, '豆包新版请求不得混入旧版 Access Key');
  equal(doubaoNewAuth.headers['X-Api-Resource-Id'], 'seed-tts-2.0', '豆包新版请求仍必须带 Resource ID');
  assert(!JSON.stringify(doubaoNewAuth.payload).includes('new-api-secret'), '豆包新版凭据不得进入请求体');
  equal(
    parseDoubaoNdjson(JSON.stringify({ code: 0, data: btoa('mp3') }), 1024).length,
    3,
    '豆包 NDJSON 应拼出音频字节',
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
    apiKey: '',
    defaultVoiceId: 'speaker',
    appId: 'app-id',
    accessKey: 'access-secret',
    resourceId: 'seed-tts-2.0',
  });
  const csrfHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' };
  let capturedDoubao: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const doubaoRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedDoubao = { url, init };
      if (url === DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT) {
        return Response.json({
          pluginId: 'ganggang-tts-bridge',
          version: '1.0.0',
          doubao: {
            available: true,
            synthesizePath: DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT,
            requestContentType: DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE,
            credentialModes: ['api-key', 'app-id-access-key'],
            responseContentType: 'audio/mpeg',
          },
        });
      }
      return new Response('mp3audio', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    },
    getSillyTavernHeaders: () => csrfHeaders,
  });
  const doubaoAudio = await doubaoRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile));
  const doubaoCall = capturedDoubao as unknown as { url: RequestInfo | URL; init?: RequestInit };
  const doubaoHeaders = doubaoCall.init?.headers as Record<string, string>;
  const doubaoBody = JSON.parse(String(doubaoCall.init?.body)) as Record<string, unknown>;
  equal(doubaoCall.url, DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT, '豆包 provider 应请求固定同源桥接端点');
  equal(
    doubaoHeaders['Content-Type'],
    DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE,
    '豆包桥接请求必须覆盖 ST 默认 Content-Type 为 vendor JSON',
  );
  equal(doubaoHeaders['X-CSRF-Token'], 'csrf-test-token', '豆包桥接请求必须携带 SillyTavern CSRF');
  equal(doubaoHeaders['X-Api-Access-Key'], undefined, '浏览器不得发送豆包上游鉴权头');
  equal(doubaoBody.apiKey, '', '旧版鉴权请求不得混入新版 API Key');
  equal(doubaoBody.appId, doubaoProfile.appId, '旧版鉴权请求必须把 APP ID 交给同源桥接');
  equal(doubaoBody.accessKey, doubaoProfile.accessKey, '旧版鉴权请求必须把 Access Key 交给同源桥接');
  equal(doubaoBody.endpoint, undefined, '豆包桥接请求体不得允许自定义 endpoint');
  equal(doubaoBody.headers, undefined, '豆包桥接请求体不得允许自定义 headers');
  equal(doubaoAudio.mimeType, 'audio/mpeg', '豆包桥接成功响应必须保持 audio/mpeg');
  equal(doubaoAudio.blob.type, 'audio/mpeg', '豆包桥接 Blob 必须是 audio/mpeg');

  const probeSignal = new AbortController().signal;
  const probe = await doubaoRegistry.probe(doubaoProfile, probeSignal);
  const doubaoProbeCall = capturedDoubao as unknown as { url: RequestInfo | URL; init?: RequestInit };
  equal(doubaoProbeCall.url, DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT, '豆包 probe 必须验证桥接 capabilities');
  assert(doubaoProbeCall.init?.signal === probeSignal, '豆包 probe 必须原样传递 AbortSignal');
  equal(probe.mode, 'plugin', '豆包 probe 只能报告桥接模式');
  equal(probe.unverified, true, '桥接 capability 成功不得伪装成凭据联网验证');

  const staleBridgeRegistry = createProviderRegistry({
    fetchImpl: async () => Response.json({ pluginId: 'other-plugin', doubao: { available: true } }),
    getSillyTavernHeaders: () => csrfHeaders,
  });
  await expectError(
    () => staleBridgeRegistry.probe(doubaoProfile),
    /^豆包桥接版本过旧$/,
    '豆包 probe 不得把其他插件或陈旧 capability 当成可用桥接',
  );

  for (const requestContentType of [undefined, 'application/json']) {
    const incompatibleContentTypeRegistry = createProviderRegistry({
      fetchImpl: async () =>
        Response.json({
          pluginId: 'ganggang-tts-bridge',
          doubao: {
            available: true,
            synthesizePath: DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT,
            requestContentType,
            responseContentType: 'audio/mpeg',
          },
        }),
      getSillyTavernHeaders: () => csrfHeaders,
    });
    await expectError(
      () => incompatibleContentTypeRegistry.probe(doubaoProfile),
      /^豆包桥接版本过旧$/,
      '豆包 probe 必须拒绝缺失或不匹配的 requestContentType capability',
    );
  }

  const doubaoNewProfile = baseProfile({
    id: 'doubao-new',
    name: '豆包新版',
    type: 'doubao',
    apiKey: 'new-api-secret',
    defaultVoiceId: 'speaker',
    appId: 'stale-app-id',
    accessKey: 'stale-access-secret',
    resourceId: 'seed-tts-2.0',
  });
  let capturedDoubaoNew: { url: RequestInfo | URL; init?: RequestInit } | null = null;
  const doubaoNewRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      capturedDoubaoNew = { url, init };
      return new Response('mp3audio', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    },
    getSillyTavernHeaders: () => csrfHeaders,
  });
  await doubaoNewRegistry.synthesize(doubaoNewProfile, requestFor(doubaoNewProfile));
  const doubaoNewCall = capturedDoubaoNew as unknown as { url: RequestInfo | URL; init?: RequestInit };
  const doubaoNewBody = JSON.parse(String(doubaoNewCall.init?.body)) as Record<string, unknown>;
  equal(doubaoNewCall.url, DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT, '豆包新版鉴权也必须走固定同源桥接');
  equal(doubaoNewBody.apiKey, doubaoNewProfile.apiKey, '新版 API Key 必须只进入同源桥接请求体');
  equal(doubaoNewBody.appId, '', '新版鉴权不得混入旧版 APP ID');
  equal(doubaoNewBody.accessKey, '', '新版鉴权不得混入旧版 Access Key');

  const doubaoAbort = new AbortController();
  doubaoAbort.abort();
  const doubaoAbortRegistry = createProviderRegistry({
    fetchImpl: async (_url, init) => {
      assert(init?.signal === doubaoAbort.signal, '豆包 synthesis 必须原样传递 AbortSignal');
      throw new DOMException('Aborted', 'AbortError');
    },
    getSillyTavernHeaders: () => csrfHeaders,
  });
  try {
    await doubaoAbortRegistry.synthesize(doubaoProfile, {
      ...requestFor(doubaoProfile),
      signal: doubaoAbort.signal,
    });
    throw new Error('已取消的豆包桥接请求不应成功');
  } catch (error) {
    assert(error instanceof DOMException && error.name === 'AbortError', '豆包取消必须保留 AbortError');
  }

  const missingBridgeRegistry = createProviderRegistry({
    fetchImpl: async () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
    getSillyTavernHeaders: () => csrfHeaders,
  });
  await expectError(
    () => missingBridgeRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /桥接不可用.*未安装或版本过旧/,
    '404 必须分类为 helper 缺失或过旧',
  );

  const controlledErrorRegistry = createProviderRegistry({
    fetchImpl: async () =>
      Response.json(
        { error: { code: 'UPSTREAM_AUTH', message: `供应商原文 ${doubaoProfile.accessKey}` } },
        { status: 502 },
      ),
    getSillyTavernHeaders: () => csrfHeaders,
  });
  await expectError(
    () => controlledErrorRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包鉴权失败$/,
    '受控 JSON 错误必须短小分类且不回显上游原文或凭据',
  );

  const nonAudioRegistry = createProviderRegistry({
    fetchImpl: async () => Response.json({ ok: true }),
    getSillyTavernHeaders: () => csrfHeaders,
  });
  await expectError(
    () => nonAudioRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包桥接未返回有效音频$/,
    '成功状态但非 audio/mpeg 必须拒绝',
  );

  const oversizedAudioRegistry = createProviderRegistry({
    fetchImpl: async () =>
      new Response('too-large', {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(MAX_TTS_RESPONSE_BYTES + 1),
        },
      }),
    getSillyTavernHeaders: () => csrfHeaders,
  });
  await expectError(
    () => oversizedAudioRegistry.synthesize(doubaoProfile, requestFor(doubaoProfile)),
    /^豆包音频超过大小限制$/,
    '豆包桥接声明的超大音频必须在浏览器读取前拒绝',
  );

  const minimaxProfile = baseProfile({
    id: 'minimax',
    name: 'MiniMax',
    type: 'minimax',
    apiKey: 'minimax-secret',
    defaultVoiceId: 'warm',
    model: 'speech-2.8-hd',
    responseFormat: 'mp3',
  });
  const minimaxRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      void init;
      if (url === MINIMAX_VOICE_ENDPOINTS.cn) {
        return new Response(
          JSON.stringify({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: 'warm', voice_name: '温柔' }] }),
          { status: 200 },
        );
      }
      assert(url === MINIMAX_ENDPOINTS.cn, 'MiniMax 请求必须使用配置的平台端点');
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: '6d7033' } }), {
        status: 200,
      });
    },
  });
  equal((await minimaxRegistry.listVoices(minimaxProfile))[0]?.voiceId, 'warm', 'MiniMax 应返回发现的音色');
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
  let mimoUrl: RequestInfo | URL | null = null;
  const mimoRegistry = createProviderRegistry({
    fetchImpl: async (url, init) => {
      void init;
      mimoUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { audio: { data: btoa('wav') } } }] }), {
        status: 200,
      });
    },
  });
  equal(
    await mimoRegistry.probe(mimoProfile),
    { ok: true, mode: 'direct', configured: true, unverified: true },
    'MiMo 探针必须声明只检查配置、未联网验证',
  );
  equal(mimoUrl, null, 'MiMo 配置探针不得请求供应商端点');
  assert((await mimoRegistry.synthesize(mimoProfile, requestFor(mimoProfile))).blob.size > 0, 'MiMo 应返回音频');
  equal(mimoUrl, XIAOMI_MIMO_ENDPOINT, 'MiMo provider 应使用官方端点');

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

  console.info('<杠杠の配音室/TTS> offline tests passed');
})().catch(error => {
  console.error(error);
  throw error;
});
