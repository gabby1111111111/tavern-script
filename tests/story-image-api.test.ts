import { ImageApiError, requestImage, type ImageRequestMode } from '../src/杠杠の生图机/image-api';
import type { ImageApiProfile } from '../src/杠杠の生图机/settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

type CompatibleProfile = ImageApiProfile & {
  requestMode?: ImageRequestMode;
  multipartImageField?: 'auto' | 'image' | 'image[]';
  jsonReferenceField?: 'images' | 'reference_images' | 'image';
};

const profile: CompatibleProfile = {
  id: 'api-test',
  name: 'API test',
  serviceUrl: 'https://provider.test/v1/images/generations',
  modelListUrl: '',
  apiKey: 'test-secret',
  model: 'test-model',
  imageSize: '1024x1024',
  timeoutMs: 1_000,
  retryAttempts: 5,
  retryDelayMs: 1_500,
  requestMode: 'auto',
  multipartImageField: 'auto',
  jsonReferenceField: 'images',
  extraBody: {},
};

const originalWindow = (globalThis as Record<string, unknown>).window;
const originalFetch = globalThis.fetch;
const globalObject = globalThis as typeof globalThis & { fetch: typeof fetch };
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

Object.defineProperty(globalThis, 'window', {
  value: {
    atob,
    location: { href: 'https://tavern.test/' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
  configurable: true,
  writable: true,
});

const responseWithImage = (): Response =>
  new Response(JSON.stringify({ data: [{ url: 'https://provider.test/generated.png' }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const responseWithLocalReference = (): Response =>
  new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });

const testNoReferences = async (): Promise<void> => {
  calls.length = 0;
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return responseWithImage();
  };

  const prompt = 'no reference prompt';
  await requestImage(profile, { prompt }, new AbortController().signal);
  equal(calls.length, 1, '无参考图时必须只有一次 API 请求');
  equal(calls[0].url, profile.serviceUrl, '无参考图时使用 generations 地址');
  const init = calls[0].init;
  assert(init?.body && typeof init.body === 'string', '无参考图请求应使用 JSON body');
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  equal(body.prompt, prompt, '无参考图时应保留 prompt');
  assert(!('images' in body), '无参考图时不得发送 images 字段');
  assert(!('reference_images' in body), '无参考图时不得发送 reference_images 字段');
  assert(!('image' in body), '无参考图时不得发送 image 字段');
};

const testMultipartReferences = async (): Promise<void> => {
  calls.length = 0;
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return responseWithImage();
  };
  const references = ['data:image/png;base64,aGVsbG8=', 'data:image/png;base64,aGVsbG8='];
  await requestImage(
    { ...profile, requestMode: 'auto' },
    { prompt: 'reference prompt', referenceImages: references },
    new AbortController().signal,
  );
  equal(calls.length, 1, 'data URL 参考图不应额外发起读取请求');
  equal(calls[0].url, 'https://provider.test/v1/images/edits', '有参考图时 auto 应切换 edits 地址');
  const init = calls[0].init;
  assert(init?.body instanceof FormData, 'multipart 参考图请求应使用 FormData');
  const headers = init.headers as Record<string, string>;
  assert(
    !Object.keys(headers).some(key => key.toLowerCase() === 'content-type'),
    'multipart 不应手动设置 Content-Type',
  );
  equal((init.body as FormData).getAll('image').length, 2, 'multipart 应发送全部参考图');
  equal(headers.Authorization, 'Bearer test-secret', 'multipart 应带 Bearer 认证');
  equal(headers['X-Api-Key'], 'test-secret', '非官方 multipart 应带 X-Api-Key');
};

const testChatAndJsonReferenceModes = async (): Promise<void> => {
  const references = ['/user/images/persona.png', '/characters/character.png'];
  calls.length = 0;
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return url.startsWith('https://tavern.test/') ? responseWithLocalReference() : responseWithImage();
  };
  await requestImage(
    { ...profile, requestMode: 'chat-multimodal' },
    { prompt: 'chat prompt', referenceImages: references },
    new AbortController().signal,
  );
  equal(calls.length, 3, 'chat 模式应读取两张本地参考图后只发起一次最终请求');
  equal(
    calls.slice(0, 2).map(call => call.url),
    ['https://tavern.test/user/images/persona.png', 'https://tavern.test/characters/character.png'],
    '本地参考图应从当前 ST 同源地址读取',
  );
  assert(calls[0].init?.signal instanceof AbortSignal, '本地参考图读取必须接收 AbortSignal');
  const chatInit = calls[2].init;
  assert(typeof chatInit?.body === 'string', 'chat 模式应发送 JSON body');
  const chatBody = JSON.parse(chatInit.body as string) as { messages?: Array<{ content?: unknown }> };
  const content = chatBody.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
  equal(content.length, 3, 'chat 模式应发送文字和两张参考图');
  assert(
    content.slice(1).every(item => item.image_url?.url.startsWith('data:image/png;base64,')),
    'chat 模式不得把本地路径原样发给外部 API',
  );

  const remoteReference = 'https://cdn.test/character.png';
  calls.length = 0;
  await requestImage(
    { ...profile, requestMode: 'chat-multimodal' },
    { prompt: 'remote prompt', referenceImages: [remoteReference] },
    new AbortController().signal,
  );
  equal(calls.length, 1, '真正远程 HTTPS 参考图可直接进入单次最终请求');
  const remoteBody = JSON.parse(calls[0].init?.body as string) as { messages?: Array<{ content?: unknown }> };
  const remoteContent = remoteBody.messages?.[0]?.content as Array<{ image_url?: { url: string } }>;
  equal(remoteContent[1]?.image_url?.url, remoteReference, '真正远程 HTTPS 参考图应保持原 URL');

  calls.length = 0;
  await requestImage(
    {
      ...profile,
      requestMode: 'json-reference',
      jsonReferenceField: 'reference_images',
      extraBody: { images: ['should-not-leak'], reference_images: ['old'] },
    },
    { prompt: 'json prompt', referenceImages: references },
    new AbortController().signal,
  );
  equal(calls.length, 3, 'json-reference 模式应读取两张本地参考图后只发起一次最终请求');
  const jsonInit = calls[2].init;
  assert(typeof jsonInit?.body === 'string', 'json-reference 模式应发送 JSON body');
  const jsonBody = JSON.parse(jsonInit.body as string) as Record<string, unknown>;
  assert(
    Array.isArray(jsonBody.reference_images) &&
      jsonBody.reference_images.every(value => typeof value === 'string' && value.startsWith('data:image/png;base64,')),
    'json-reference 不得把本地路径原样发给外部 API',
  );
  assert(!('images' in jsonBody), 'json-reference 不应保留其他引用字段');
};

const testNoRetryAndSafeError = async (): Promise<void> => {
  calls.length = 0;
  const privateUrl = 'https://private-provider.test/v1/images/generations';
  const privatePrompt = 'private prompt must not appear';
  const privateKey = 'private-key-must-not-appear';
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response('private response body', { status: 500 });
  };
  try {
    await requestImage(
      { ...profile, serviceUrl: privateUrl, apiKey: privateKey },
      { prompt: privatePrompt },
      new AbortController().signal,
    );
    throw new Error('失败请求应抛出异常');
  } catch (error) {
    assert(error instanceof ImageApiError, '失败请求应转换为 ImageApiError');
    equal(calls.length, 1, '失败请求不得自动重试');
    assert(!error.message.includes(privatePrompt), '错误不得包含完整 prompt');
    assert(!error.message.includes(privateUrl), '错误不得包含图片 API URL');
    assert(!error.message.includes(privateKey), '错误不得包含 API Key');
    assert(!error.message.includes('private response body'), '错误不得包含完整响应');
  }
};

testNoReferences()
  .then(testMultipartReferences)
  .then(testChatAndJsonReferenceModes)
  .then(testNoRetryAndSafeError)
  .then(() => console.info('<杠杠の生图机> story image api tests passed'))
  .catch(error => {
    console.error(error);
    (globalThis as typeof globalThis & { process?: { exitCode?: number } }).process!.exitCode = 1;
  })
  .finally(() => {
    globalObject.fetch = originalFetch;
    if (typeof originalWindow === 'undefined') Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true });
  });
