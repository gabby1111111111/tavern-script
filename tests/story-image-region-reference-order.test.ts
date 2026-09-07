import { requestImages, type ImageRequestMode, type MultipartImageField } from '../src/杠杠の生图机/image-api';
import type { ImageApiProfile } from '../src/杠杠の生图机/settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const originalBytes = 'original-image';
const markedBytes = 'marked-image';
const references = [
  `data:image/png;base64,${Buffer.from(originalBytes).toString('base64')}`,
  `data:image/png;base64,${Buffer.from(markedBytes).toString('base64')}`,
];
const responseBase64 = Buffer.from('generated-image').toString('base64');
const profile: ImageApiProfile = {
  id: 'region-order',
  name: 'region order',
  serviceUrl: 'https://provider.test/v1/images/generations',
  modelListUrl: '',
  apiKey: '',
  model: 'test-model',
  imageSize: '1024x1024',
  quality: 'auto',
  imageCount: 1,
  timeoutMs: 1_000,
  retryAttempts: 0,
  retryDelayMs: 0,
  requestMode: 'auto',
  multipartImageField: 'auto',
  jsonReferenceField: 'images',
  extraBody: {},
};

const originalWindow = (globalThis as Record<string, unknown>).window;
const originalFetch = globalThis.fetch;
let lastRequest: RequestInit | undefined;

Object.defineProperty(globalThis, 'window', {
  value: {
    atob,
    btoa,
    location: { href: 'https://tavern.test/' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
  configurable: true,
  writable: true,
});

globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  lastRequest = init;
  return new Response(JSON.stringify({ data: [{ b64_json: responseBase64 }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function request(mode: ImageRequestMode, options: Partial<ImageApiProfile> = {}): Promise<RequestInit> {
  lastRequest = undefined;
  const resources = await requestImages(
    { ...profile, ...options, requestMode: mode },
    { prompt: 'edit', referenceImages: references },
    new AbortController().signal,
  );
  resources.forEach(resource => resource.revoke?.());
  assert(lastRequest, `${mode} 应发出最终请求`);
  return lastRequest;
}

async function testMultipart(field: Exclude<MultipartImageField, 'auto'>): Promise<void> {
  const init = await request('multipart-edit', { multipartImageField: field });
  assert(init.body instanceof FormData, `${field} 应使用 FormData`);
  const values = init.body.getAll(field);
  equal(
    await Promise.all(values.map(value => (value as Blob).text())),
    [originalBytes, markedBytes],
    `${field} 必须保持原图、标记图顺序`,
  );
}

async function run(): Promise<void> {
  await testMultipart('image');
  await testMultipart('image[]');

  const chat = await request('chat-multimodal');
  assert(typeof chat.body === 'string', 'chat 应使用 JSON body');
  const content = (JSON.parse(chat.body) as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> })
    .messages[0].content;
  equal(
    content.slice(1).map(item => item.image_url?.url),
    references,
    'chat 必须保持原图、标记图顺序',
  );

  for (const field of ['images', 'reference_images', 'image'] as const) {
    const json = await request('json-reference', { jsonReferenceField: field });
    assert(typeof json.body === 'string', `${field} 应使用 JSON body`);
    equal(
      (JSON.parse(json.body) as Record<string, unknown>)[field],
      references,
      `${field} payload 必须保持原图、标记图顺序`,
    );
  }
}

run()
  .then(() => console.info('<杠杠の生图机> region reference order tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalWindow === 'undefined') Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true });
  });
