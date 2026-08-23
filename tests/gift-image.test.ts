import { composeGiftImagePrompt } from '../src/杠杠の生图机/gift-prompt';
import type { GiftContextSnapshot } from '../src/杠杠の生图机/gift-context';
import {
  collectImageResources,
  inferImageEditUrl,
  requestGiftImage,
  resolveGiftRequestMode,
} from '../src/杠杠の生图机/image-api';
import { ReferenceImageMemory, type GiftImageReference } from '../src/杠杠の生图机/reference-image-memory';
import type { ImageApiProfile } from '../src/杠杠の生图机/settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function requireRequestInit(value: RequestInit | undefined, message: string): RequestInit {
  if (!value) throw new Error(message);
  return value;
}

const settings = {
  enabled: true,
  triggerInterval: 'manual' as const,
  requestMode: 'auto' as const,
  multipartImageField: 'auto' as const,
  jsonReferenceField: 'images' as const,
  identityPrompt: '角色身份来自参考图。',
  templatePrompt: '模板图只提供动作和构图。',
  scenePrompt: '正文决定服装和氛围。',
  stylePrompt: '2.5D 精致数字绘画风。',
  outputPrompt: '只输出一条中文提示词，保持纯 SFW。',
};
const context: GiftContextSnapshot = {
  chatId: 'chat-test',
  messageId: 12,
  swipeId: 0,
  floor: 12,
  characterName: '角色卡',
  characterDescription: '角色简介',
  characterPersonality: '角色人设',
  characterScenario: '公寓场景',
  recentMessages: [
    { messageId: 12, role: 'assistant', name: '角色卡', message: '傍晚回到公寓，角色换上宽松针织外套。' },
  ],
  currentAssistantMessage: '傍晚回到公寓，角色换上宽松针织外套。',
};
const prompt = composeGiftImagePrompt(settings, context);
assert(prompt.includes('角色身份来自参考图'), '礼物 CG prompt 应明确角色参考图的职责');
assert(prompt.includes('模板图只提供动作和构图'), '礼物 CG prompt 应明确模板图的职责');
assert(prompt.includes('最近聊天消息'), '礼物 CG prompt 应包含当前聊天上下文');
assert(prompt.includes('纯 SFW'), '礼物 CG prompt 应包含安全边界');
assert(!prompt.includes('image2store://'), '礼物 CG prompt 不应引入旧图库引用');

const directRemote = collectImageResources('https://image.test/direct.png');
equal(
  directRemote.map(resource => resource.url),
  ['https://image.test/direct.png'],
  '应读取顶层裸远程图片地址',
);

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
if (!originalWindow) {
  Object.defineProperty(globalThis, 'window', { value: { atob }, configurable: true, writable: true });
}
const directData = collectImageResources('data:image/png;base64,aGVsbG8=');
equal(
  directData.map(resource => resource.kind),
  ['object-url'],
  '应读取顶层裸 data 图片地址',
);
directData.forEach(resource => resource.revoke?.());

const explicitBase64 = collectImageResources({ b64_json: 'aGVsbG8=', image: 'aGVsbG8=' });
equal(
  explicitBase64.map(resource => resource.kind),
  ['object-url'],
  '只应在明确图片字段中读取裸 base64',
);
explicitBase64.forEach(resource => resource.revoke?.());

const plainOutput = collectImageResources({ output: 'test', result: 'test', text: 'test' });
equal(plainOutput, [], '普通 output/result/text 不应被误判为 base64 图片');

if (originalWindow) {
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true });
} else {
  Reflect.deleteProperty(globalThis, 'window');
}

const topLevelArray = collectImageResources([
  { url: 'https://image.test/array.png' },
  { metadata: { url: 'https://example.test/not-an-image' } },
]);
equal(
  topLevelArray.map(resource => resource.url),
  ['https://image.test/array.png'],
  '应读取顶层 [{url}] 图片数组',
);

const explicitImage = collectImageResources({
  data: [{ url: 'https://image.test/data.png' }],
  metadata: { url: 'https://example.test/not-an-image' },
});
equal(
  explicitImage.map(resource => resource.url),
  ['https://image.test/data.png'],
  '只应读取 data 图片字段，不应把普通元数据链接当成图片',
);

const topLevelImageUrl = collectImageResources({ image_url: 'https://image.test/image-url.png' });
equal(
  topLevelImageUrl.map(resource => resource.url),
  ['https://image.test/image-url.png'],
  '应读取顶层 image_url 图片地址',
);

const chatImage = collectImageResources({
  choices: [{ message: { content: [{ type: 'text', text: '结果：![图片](https://image.test/chat.png)' }] } }],
  metadata: { url: 'https://example.test/not-an-image' },
});
equal(
  chatImage.map(resource => resource.url),
  ['https://image.test/chat.png'],
  '应读取聊天内容中的 Markdown 图片',
);

const outputImage = collectImageResources({
  output: { image: 'https://image.test/output.png' },
  nested: { links: [{ url: 'https://example.test/not-an-image' }] },
});
equal(
  outputImage.map(resource => resource.url),
  ['https://image.test/output.png'],
  '应读取 output.image 并忽略深层普通链接',
);

const testGiftImageRequests = async (): Promise<void> => {
  equal(
    resolveGiftRequestMode('https://image.test/v1/images/generations', 'auto'),
    'multipart-edit',
    'auto 普通图片地址应使用 multipart-edit',
  );
  equal(
    resolveGiftRequestMode('https://image.test/v1/chat/completions', 'auto'),
    'chat-multimodal',
    'auto chat 地址应使用 chat-multimodal',
  );
  equal(
    inferImageEditUrl('https://image.test/v1/images/generations'),
    'https://image.test/v1/images/edits',
    'generations 地址应推导 edits 地址',
  );

  const originalRuntimeWindow = (globalThis as unknown as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  const serviceUrl = 'https://image.test/v1/images/generations';
  const apiKey = 'unit-test-key';
  const references: GiftImageReference[] = [
    {
      id: 'character-1',
      kind: 'character',
      name: '角色 1',
      source: 'local',
      mimeType: 'image/png',
      fileName: 'character-1.png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      createdAt: 1,
    },
    {
      id: 'character-2',
      kind: 'character',
      name: '角色 2',
      source: 'local',
      mimeType: 'image/png',
      fileName: 'character-2.png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      createdAt: 2,
    },
    {
      id: 'template',
      kind: 'template',
      name: '模板图',
      source: 'local',
      mimeType: 'image/png',
      fileName: 'template.png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      createdAt: 3,
    },
  ];
  const profile: ImageApiProfile = {
    id: 'unit-test-profile',
    name: '单元测试配置',
    serviceUrl,
    modelListUrl: '',
    apiKey,
    model: 'test-model',
    imageSize: '1024x1024',
    timeoutMs: 1_000,
    retryAttempts: 0,
    retryDelayMs: 0,
    extraBody: {},
  };
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const globalObject = globalThis as typeof globalThis & { fetch: typeof fetch };

  Object.defineProperty(globalThis, 'window', {
    value: {
      atob,
      location: { href: 'https://image.test/' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
    configurable: true,
    writable: true,
  });
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ data: [{ url: 'https://image.test/generated.png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await requestGiftImage({
      prompt: 'unit test prompt',
      references,
      profile,
      requestMode: 'auto',
      multipartImageField: 'auto',
      jsonReferenceField: 'images',
      signal: new AbortController().signal,
    });
    const multipartRequest = requireRequestInit(capturedInit, 'multipart 请求应捕获 RequestInit');
    assert(multipartRequest.body instanceof FormData, 'auto 图片请求应使用 FormData');
    equal(capturedUrl, 'https://image.test/v1/images/edits', 'auto generations 请求应 POST 到 edits 地址');
    const multipartHeaders = multipartRequest.headers as Record<string, string>;
    equal(multipartHeaders.Authorization, `Bearer ${apiKey}`, 'multipart 请求应带 Bearer 认证');
    equal(multipartHeaders['X-Api-Key'], apiKey, 'multipart 请求应带 X-Api-Key 认证');
    assert(
      !Object.keys(multipartHeaders).some(key => key.toLowerCase() === 'content-type'),
      'multipart 请求不应手写 Content-Type',
    );
    const form = multipartRequest.body as FormData;
    equal(form.getAll('image').length, 3, 'multipart 请求应包含三份 image 文件字段');
    equal(
      form.getAll('image').map(value => value instanceof Blob),
      [true, true, true],
      'image 字段应为 Blob/File',
    );
    equal(form.get('model'), 'test-model', 'multipart 请求应包含 model');
    equal(form.get('n'), '1', 'multipart 请求应包含 n=1');
    equal(form.get('size'), '1024x1024', 'multipart 请求应包含 size');

    capturedUrl = '';
    capturedInit = undefined;
    await requestGiftImage({
      prompt: 'unit test prompt',
      references,
      profile: { ...profile, serviceUrl: 'https://api.openai.com/v1/images/generations' },
      requestMode: 'auto',
      multipartImageField: 'auto',
      jsonReferenceField: 'images',
      signal: new AbortController().signal,
    });
    const officialRequest = requireRequestInit(capturedInit, 'OpenAI auto 请求应捕获 RequestInit');
    assert(officialRequest.body instanceof FormData, 'OpenAI auto 应使用 FormData');
    equal(capturedUrl, 'https://api.openai.com/v1/images/edits', 'OpenAI auto 应推导官方 edits 地址');
    const officialHeaders = officialRequest.headers as Record<string, string>;
    equal(officialHeaders.Authorization, 'Bearer ' + apiKey, 'OpenAI multipart 应带 Bearer 认证');
    assert(!('X-Api-Key' in officialHeaders), 'OpenAI multipart 不应发送 X-Api-Key');
    equal((officialRequest.body as FormData).getAll('image[]').length, 3, 'OpenAI auto 应重复发送 image[]');

    capturedInit = undefined;
    await requestGiftImage({
      prompt: 'unit test prompt',
      references,
      profile: { ...profile, serviceUrl: 'https://api.openai.com/v1/images/generations' },
      requestMode: 'auto',
      multipartImageField: 'image',
      jsonReferenceField: 'images',
      signal: new AbortController().signal,
    });
    const explicitImageRequest = requireRequestInit(capturedInit, 'OpenAI 显式 image 请求应捕获 RequestInit');
    assert(explicitImageRequest.body instanceof FormData, 'OpenAI 显式 image 应使用 FormData');
    equal((explicitImageRequest.body as FormData).getAll('image').length, 3, '显式 image 应覆盖 OpenAI 默认 image[]');
    equal((explicitImageRequest.body as FormData).getAll('image[]').length, 0, '显式 image 不应同时发送 image[]');
    const explicitImageHeaders = explicitImageRequest.headers as Record<string, string>;
    assert(!('X-Api-Key' in explicitImageHeaders), 'OpenAI 显式 image 仍不应发送 X-Api-Key');

    capturedInit = undefined;
    await requestGiftImage({
      prompt: 'unit test prompt',
      references,
      profile,
      requestMode: 'multipart-edit',
      multipartImageField: 'image[]',
      jsonReferenceField: 'images',
      signal: new AbortController().signal,
    });
    const explicitArrayRequest = requireRequestInit(capturedInit, '中转显式 image[] 请求应捕获 RequestInit');
    assert(explicitArrayRequest.body instanceof FormData, '中转显式 image[] 应使用 FormData');
    const explicitArrayHeaders = explicitArrayRequest.headers as Record<string, string>;
    equal(explicitArrayHeaders.Authorization, 'Bearer ' + apiKey, '中转显式 image[] 应保留 Bearer');
    equal(explicitArrayHeaders['X-Api-Key'], apiKey, '中转显式 image[] 应保留 X-Api-Key');
    equal((explicitArrayRequest.body as FormData).getAll('image[]').length, 3, '显式字段应覆盖中转默认 image');

    capturedUrl = '';
    capturedInit = undefined;
    await requestGiftImage({
      prompt: 'unit test prompt',
      references,
      profile,
      requestMode: 'json-reference',
      jsonReferenceField: 'images',
      signal: new AbortController().signal,
    });
    const jsonRequest = requireRequestInit(capturedInit, '显式 JSON 请求应捕获 RequestInit');
    equal(capturedUrl, serviceUrl, '显式 json-reference 应保留原始 generations 地址');
    const jsonHeaders = jsonRequest.headers as Record<string, string>;
    equal(jsonHeaders['Content-Type'], 'application/json', '显式 json-reference 应使用 JSON Content-Type');
    assert(!('X-Api-Key' in jsonHeaders), '显式 json-reference 不应带 multipart 专用认证头');
    assert(typeof jsonRequest.body === 'string', '显式 json-reference 应发送 JSON 字符串');
    const jsonBody = JSON.parse(jsonRequest.body as string) as { images?: unknown[] };
    equal(jsonBody.images?.length, 3, '显式 json-reference 应保留三份参考图字段');

    capturedUrl = '';
    capturedInit = undefined;
    await requestGiftImage({
      prompt: 'unit test prompt',
      references,
      profile: { ...profile, apiKey: '' },
      requestMode: 'auto',
      jsonReferenceField: 'images',
      signal: new AbortController().signal,
    });
    const noKeyRequest = requireRequestInit(capturedInit, '空白 Key multipart 请求应捕获 RequestInit');
    assert(noKeyRequest.body instanceof FormData, '空白 Key 请求仍应使用 FormData');
    const noKeyHeaders = noKeyRequest.headers as Record<string, string>;
    assert(!('Authorization' in noKeyHeaders), '空白 apiKey 不应产生 Authorization');
    assert(!('X-Api-Key' in noKeyHeaders), '空白 apiKey 不应产生 X-Api-Key');
  } finally {
    globalObject.fetch = originalFetch;
    if (originalRuntimeWindow) {
      Object.defineProperty(globalThis, 'window', { value: originalRuntimeWindow, configurable: true, writable: true });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

const testReferenceMemoryRace = async (): Promise<void> => {
  const originalFileReader = (globalThis as typeof globalThis & { FileReader?: typeof FileReader }).FileReader;
  const pendingReaders: Array<{ result: string | ArrayBuffer | null; onload: ((event: unknown) => void) | null }> = [];
  class DeferredFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readAsDataURL(): void {
      pendingReaders.push(this);
    }
  }
  Object.defineProperty(globalThis, 'FileReader', { value: DeferredFileReader, configurable: true, writable: true });
  const file = (name: string) => ({ name, type: 'image/png' }) as File;
  const complete = (reader: (typeof pendingReaders)[number], body: string): void => {
    reader.result = `data:image/png;base64,${body}`;
    reader.onload?.({});
  };

  try {
    const memory = new ReferenceImageMemory();
    const supersededByUrl = memory.setLocal('character-1', file('old.png'));
    const urlReference = memory.setUrl('character-1', 'https://image.test/current.png');
    complete(pendingReaders.shift()!, 'b2xk');
    assert(
      await supersededByUrl.then(
        () => false,
        () => true,
      ),
      'setUrl 后旧 setLocal 必须失效',
    );
    equal(memory.get('character-1')?.url, urlReference.url, '旧本地读取不得覆盖较新的 URL 参考图');

    const supersededByClear = memory.setLocal('character-2', file('clear.png'));
    memory.clear();
    complete(pendingReaders.shift()!, 'Y2xlYXI=');
    assert(
      await supersededByClear.then(
        () => false,
        () => true,
      ),
      'clear 后旧 setLocal 必须失效',
    );
    equal(memory.images.value, [], 'clear 后异步读取不得复活参考图');

    const olderLocal = memory.setLocal('template', file('older.png'));
    const newerLocal = memory.setLocal('template', file('newer.png'));
    complete(pendingReaders[1], 'bmV3ZXI=');
    const current = await newerLocal;
    complete(pendingReaders[0], 'b2xkZXI=');
    assert(
      await olderLocal.then(
        () => false,
        () => true,
      ),
      '较新的同槽 setLocal 必须淘汰旧读取',
    );
    equal(memory.get('template')?.dataUrl, current.dataUrl, '旧读取完成不得覆盖较新的本地参考图');
  } finally {
    if (originalFileReader)
      Object.defineProperty(globalThis, 'FileReader', {
        value: originalFileReader,
        configurable: true,
        writable: true,
      });
    else Reflect.deleteProperty(globalThis, 'FileReader');
  }
};

testReferenceMemoryRace()
  .then(testGiftImageRequests)
  .then(() => console.info('<杠杠の生图机> gift image tests passed'))
  .catch(error => {
    console.error(error);
    (globalThis as typeof globalThis & { process?: { exitCode?: number } }).process!.exitCode = 1;
  });
