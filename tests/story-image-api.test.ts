import {
  collectImageResources,
  ImageApiError,
  requestImage,
  requestImages,
  type ImageRequestMode,
} from '../src/杠杠の生图机/image-api';
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
  quality: 'auto',
  imageCount: 1,
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
const timerStats = { scheduled: 0, cleared: 0 };

const testWindowSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  timerStats.scheduled += 1;
  // Keep the production lower bound (1s) in the request profile while keeping
  // body-lifecycle regressions quick and deterministic in this harness.
  return globalThis.setTimeout(handler, Math.min(timeout ?? 0, 25), ...args);
}) as typeof globalThis.setTimeout;

const testWindowClearTimeout = ((timeoutId: number | ReturnType<typeof globalThis.setTimeout>) => {
  timerStats.cleared += 1;
  globalThis.clearTimeout(timeoutId);
}) as typeof globalThis.clearTimeout;

Object.defineProperty(globalThis, 'window', {
  value: {
    atob,
    location: { href: 'https://tavern.test/' },
    setTimeout: testWindowSetTimeout,
    clearTimeout: testWindowClearTimeout,
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

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function delayedBodyResponse(
  signal: AbortSignal | null | undefined,
  body: string | Uint8Array,
  delayMs: number,
  onComplete?: () => void,
): Response {
  const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let settled = false;
  let abortListener: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) globalThis.clearTimeout(timer);
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        controller.error(abortError());
      };
      abortListener = abort;
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        controller.enqueue(payload);
        controller.close();
        onComplete?.();
      }, delayMs);
    },
    cancel() {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function delayedTextResponseIgnoringAbort(delayMs: number): Response {
  return {
    ok: true,
    status: 200,
    text: async () => {
      await new Promise<void>(resolve => {
        globalThis.setTimeout(resolve, delayMs);
      });
      return JSON.stringify({ data: [{ url: 'https://provider.test/late-consumer.png' }] });
    },
  } as unknown as Response;
}

function trackedSignal(): {
  controller: AbortController;
  signal: AbortSignal;
  added: () => number;
  removed: () => number;
} {
  const controller = new AbortController();
  let addedCount = 0;
  let removedCount = 0;
  const signal = {
    get aborted(): boolean {
      return controller.signal.aborted;
    },
    addEventListener(...args: Parameters<AbortSignal['addEventListener']>): void {
      if (args[0] === 'abort') addedCount += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>): void {
      if (args[0] === 'abort') removedCount += 1;
      controller.signal.removeEventListener(...args);
    },
  } as unknown as AbortSignal;
  return {
    controller,
    signal,
    added: () => addedCount,
    removed: () => removedCount,
  };
}

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
  equal(body.quality, 'auto', '普通生图应发送默认自动质量');
  equal(body.n, 1, '普通生图应发送默认单张数量');
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
    {
      ...profile,
      requestMode: 'auto',
      quality: 'high',
      imageCount: 2,
      extraBody: { quality: 'low', n: 4 },
    },
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
  equal((init.body as FormData).get('quality'), 'high', 'multipart 应发送当前质量并忽略额外 JSON 同名字段');
  equal((init.body as FormData).get('n'), '2', 'multipart 应发送当前数量并忽略额外 JSON 同名字段');
  equal(headers.Authorization, 'Bearer test-secret', 'multipart 应带 Bearer 认证');
  equal(headers['X-Api-Key'], 'test-secret', '非官方 multipart 应带 X-Api-Key');
};

const testQualityAndMultipleImages = async (): Promise<void> => {
  calls.length = 0;
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        data: [{ url: 'https://provider.test/generated-1.png' }, { url: 'https://provider.test/generated-2.png' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const resources = await requestImages(
    { ...profile, quality: 'high', imageCount: 2, extraBody: { quality: 'low', n: 4 } },
    { prompt: 'two candidates' },
    new AbortController().signal,
  );
  const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
  equal(body.quality, 'high', '质量应映射为 API quality 参数');
  equal(body.n, 2, '生成数量应映射为 API n 参数');
  equal(resources.length, 2, '一次响应中的多张图片应全部交给页面内存管线');
};

const testCandidateRepresentationDeduplication = async (): Promise<void> => {
  const firstBase64 = Buffer.from('candidate-one').toString('base64');
  const secondBase64 = Buffer.from('candidate-two').toString('base64');
  const release = (resources: ReturnType<typeof collectImageResources>): void => {
    resources.forEach(resource => resource.revoke?.());
  };

  const oneCandidate = collectImageResources({
    data: [{ url: 'https://provider.test/candidate-one.png', b64_json: firstBase64 }],
  });
  equal(oneCandidate.length, 1, '同一 data 候选同时含 URL 和 b64_json 时只能产生一张图片');
  equal(oneCandidate[0]?.kind, 'remote-url', '同一候选应沿用有效 URL 的优先顺序');
  release(oneCandidate);

  const multipleCandidates = collectImageResources({
    data: [
      { url: 'https://provider.test/candidate-one.png', b64_json: firstBase64 },
      { url: 'https://provider.test/candidate-two.png', b64_json: secondBase64 },
    ],
  });
  equal(multipleCandidates.length, 2, '不同 data 候选仍应各自产生一张图片');
  release(multipleCandidates);

  const invalidPrimary = collectImageResources({
    images: [{ url: 'not-an-image', b64_json: firstBase64 }],
  });
  equal(invalidPrimary.length, 1, '候选主字段无效时应回退到有效 b64_json');
  equal(invalidPrimary[0]?.kind, 'object-url', 'b64_json fallback 应生成页面内存对象 URL');
  release(invalidPrimary);

  const markdownCandidates = collectImageResources({
    output: '![one](https://provider.test/markdown-one.png)\n![two](https://provider.test/markdown-two.png)',
  });
  equal(markdownCandidates.length, 2, '同一文本中的不同 markdown 图片仍应全部保留');
  release(markdownCandidates);

  const chatContent = collectImageResources({
    choices: [
      {
        message: {
          content: [
            { type: 'image_url', image_url: { url: 'https://provider.test/chat-one.png' } },
            { type: 'image_url', image_url: { url: 'https://provider.test/chat-two.png' } },
          ],
        },
      },
    ],
  });
  equal(chatContent.length, 2, '聊天 content 中不同图片仍应保留多图');
  release(chatContent);
};

const testSingleImageCompatibility = async (): Promise<void> => {
  calls.length = 0;
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        data: [{ url: 'https://provider.test/compatible-1.png' }, { url: 'https://provider.test/compatible-2.png' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const resource = await requestImage(
    { ...profile, imageCount: 2 },
    { prompt: 'single-image caller' },
    new AbortController().signal,
  );
  equal(calls.length, 1, '旧 requestImage 调用方仍应只发一次请求');
  equal(resource.url, 'https://provider.test/compatible-1.png', '旧 requestImage 调用方应继续取得第一张图片');
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
    {
      ...profile,
      requestMode: 'chat-multimodal',
      quality: 'medium',
      imageCount: 3,
      extraBody: { quality: 'low', n: 4 },
    },
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
  const chatBody = JSON.parse(chatInit.body as string) as {
    messages?: Array<{ content?: unknown }>;
    quality?: unknown;
    n?: unknown;
  };
  equal(chatBody.quality, 'medium', 'chat 模式应发送当前质量并覆盖额外 JSON 同名字段');
  equal(chatBody.n, 3, 'chat 模式应发送当前数量并覆盖额外 JSON 同名字段');
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
      quality: 'low',
      imageCount: 4,
      extraBody: { images: ['should-not-leak'], reference_images: ['old'], quality: 'high', n: 2 },
    },
    { prompt: 'json prompt', referenceImages: references },
    new AbortController().signal,
  );
  equal(calls.length, 3, 'json-reference 模式应读取两张本地参考图后只发起一次最终请求');
  const jsonInit = calls[2].init;
  assert(typeof jsonInit?.body === 'string', 'json-reference 模式应发送 JSON body');
  const jsonBody = JSON.parse(jsonInit.body as string) as Record<string, unknown>;
  equal(jsonBody.quality, 'low', 'json-reference 模式应发送当前质量并覆盖额外 JSON 同名字段');
  equal(jsonBody.n, 4, 'json-reference 模式应发送当前数量并覆盖额外 JSON 同名字段');
  assert(
    Array.isArray(jsonBody.reference_images) &&
      jsonBody.reference_images.every(value => typeof value === 'string' && value.startsWith('data:image/png;base64,')),
    'json-reference 不得把本地路径原样发给外部 API',
  );
  assert(!('images' in jsonBody), 'json-reference 不应保留其他引用字段');
};

const testResponseBodyTimeout = async (): Promise<void> => {
  calls.length = 0;
  const tracked = trackedSignal();
  const timerBefore = { ...timerStats };
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return delayedBodyResponse(
      init?.signal,
      JSON.stringify({ data: [{ url: 'https://provider.test/delayed.png' }] }),
      100,
    );
  };

  try {
    await requestImage({ ...profile, timeoutMs: 1_000 }, { prompt: 'delayed response body' }, tracked.signal);
    throw new Error('响应正文超时应抛出异常');
  } catch (error) {
    assert(error instanceof ImageApiError, '响应正文超时应转换为 ImageApiError');
    assert(error.message.includes('超时'), '响应正文超时应保留超时错误语义');
  }
  equal(calls.length, 1, '响应正文超时不得自动重试');
  equal(tracked.added(), 1, '请求应注册一个 parent abort 监听');
  equal(tracked.removed(), 1, '响应正文超时后应移除 parent abort 监听');
  equal(timerStats.scheduled - timerBefore.scheduled, 1, '响应正文超时应创建一个请求计时器');
  equal(timerStats.cleared - timerBefore.cleared, 1, '响应正文超时后应清理请求计时器');
};

const testLateConsumerTimeoutGuard = async (): Promise<void> => {
  calls.length = 0;
  const tracked = trackedSignal();
  const timerBefore = { ...timerStats };
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return delayedTextResponseIgnoringAbort(100);
  };

  try {
    await requestImage({ ...profile, timeoutMs: 1_000 }, { prompt: 'late consumer result' }, tracked.signal);
    throw new Error('忽略 signal 的延迟消费应被后验超时 guard 拦截');
  } catch (error) {
    assert(error instanceof ImageApiError, '延迟消费超时应转换为 ImageApiError');
    assert(error.message.includes('超时'), '延迟消费超时应保留超时错误语义');
  }
  equal(calls.length, 1, '延迟消费超时不得自动重试');
  equal(tracked.added(), 1, '延迟消费请求应注册一个 parent abort 监听');
  equal(tracked.removed(), 1, '延迟消费超时后应移除 parent abort 监听');
  equal(timerStats.scheduled - timerBefore.scheduled, 1, '延迟消费请求应创建一个请求计时器');
  equal(timerStats.cleared - timerBefore.cleared, 1, '延迟消费超时后应清理请求计时器');
};

const testParentCancellationDuringResponseBody = async (): Promise<void> => {
  calls.length = 0;
  const tracked = trackedSignal();
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    globalThis.setTimeout(() => tracked.controller.abort(), 5);
    return delayedBodyResponse(
      init?.signal,
      JSON.stringify({ data: [{ url: 'https://provider.test/cancelled.png' }] }),
      100,
    );
  };

  try {
    await requestImage({ ...profile, timeoutMs: 1_000 }, { prompt: 'cancelled response body' }, tracked.signal);
    throw new Error('parent 取消应抛出异常');
  } catch (error) {
    assert(error instanceof Error && error.name === 'AbortError', 'parent 取消应保留 AbortError 语义');
    equal(error.message, '图片请求已取消', 'parent 取消应使用脱敏错误消息');
  }
  equal(calls.length, 1, 'parent 取消不得自动重试');
  assert(calls[0].init?.signal instanceof AbortSignal, 'API 请求应接收独立的 AbortSignal');
  assert(calls[0].init?.signal.aborted, 'parent 取消应传播到实际 API 请求');
  equal(tracked.added(), 1, '取消中的请求应注册一个 parent abort 监听');
  equal(tracked.removed(), 1, '取消中的请求应移除 parent abort 监听');
};

const testResponseBodySuccessCleanup = async (): Promise<void> => {
  calls.length = 0;
  const tracked = trackedSignal();
  const timerBefore = { ...timerStats };
  let clearedAtBodyCompletion: number | null = null;
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return delayedBodyResponse(
      init?.signal,
      JSON.stringify({ data: [{ url: 'https://provider.test/completed.png' }] }),
      5,
      () => {
        clearedAtBodyCompletion = timerStats.cleared;
      },
    );
  };

  const resource = await requestImage({ ...profile, timeoutMs: 1_000 }, { prompt: 'completed response body' }, tracked.signal);
  equal(resource.url, 'https://provider.test/completed.png', '正常响应正文应继续返回图片');
  equal(clearedAtBodyCompletion, timerBefore.cleared, '正文消费完成前不得清理请求计时器');
  equal(timerStats.scheduled - timerBefore.scheduled, 1, '正常请求应创建一个请求计时器');
  equal(timerStats.cleared - timerBefore.cleared, 1, '正常请求完成后应清理请求计时器');
  equal(tracked.added(), 1, '正常请求应注册一个 parent abort 监听');
  equal(tracked.removed(), 1, '正常请求完成后应移除 parent abort 监听');
};

const testReferenceBodyTimeout = async (): Promise<void> => {
  calls.length = 0;
  const tracked = trackedSignal();
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return delayedBodyResponse(init?.signal, new Uint8Array([1, 2, 3, 4]), 100);
  };

  try {
    await requestImages(
      { ...profile, requestMode: 'chat-multimodal', timeoutMs: 1_000 },
      { prompt: 'reference body timeout', referenceImages: ['/user/images/reference.png'] },
      tracked.signal,
    );
    throw new Error('参考图正文超时应抛出异常');
  } catch (error) {
    assert(error instanceof ImageApiError, '参考图正文超时应转换为 ImageApiError');
    assert(error.message.includes('超时'), '参考图正文超时应保留超时错误语义');
  }
  equal(calls.length, 1, '参考图正文超时后不得继续发起最终 API 请求');
  equal(calls[0].url, 'https://tavern.test/user/images/reference.png', '参考图应先读取当前 ST 同源地址');
  equal(tracked.added(), 1, '参考图请求应注册一个 parent abort 监听');
  equal(tracked.removed(), 1, '参考图正文超时后应移除 parent abort 监听');
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
  .then(testQualityAndMultipleImages)
  .then(testCandidateRepresentationDeduplication)
  .then(testSingleImageCompatibility)
  .then(testChatAndJsonReferenceModes)
  .then(testResponseBodyTimeout)
  .then(testLateConsumerTimeoutGuard)
  .then(testParentCancellationDuringResponseBody)
  .then(testResponseBodySuccessCleanup)
  .then(testReferenceBodyTimeout)
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
