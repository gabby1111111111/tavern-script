// Node-only test harness; production modules do not import Node APIs.
// eslint-disable-next-line import-x/no-nodejs-modules
import assert from 'node:assert/strict';
import { ImageApiError, requestImages, type ImageRequestMode } from '../src/杠杠の生图机/image-api';
import { buildPromptEditorFinalPrompt } from '../src/杠杠の生图机/prompt-editor';
import { processDrawingPrompt } from '../src/杠杠の生图机/prompt-processor';
import { createOutputPreset } from '../src/杠杠の生图机/output-preset';
import type { ImageApiProfile } from '../src/杠杠の生图机/settings';

const profile: ImageApiProfile = {
  id: 'continuity-api',
  name: 'local fixture',
  serviceUrl: 'https://provider.test/v1/images/generations',
  modelListUrl: '',
  apiKey: '',
  model: 'fixture',
  imageSize: '1024x1024',
  quality: 'auto',
  imageCount: 1,
  timeoutMs: 1000,
  retryAttempts: 0,
  retryDelayMs: 1500,
  requestMode: 'json-reference',
  multipartImageField: 'image[]',
  jsonReferenceField: 'images',
  extraBody: {},
};
const user = 'data:image/png;base64,AQ==';
const character = 'data:image/png;base64,Ag==';
const previous = 'data:image/png;base64,Aw==';
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

async function verify(mode: ImageRequestMode, avatars: boolean, prior: boolean, missingUser = false): Promise<void> {
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, 'POST', 'all reference images are already in memory; no read request is needed');
    calls.push(init!);
    return new Response(JSON.stringify({ data: [{ url: 'https://provider.test/result.png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  let avatarReads = 0;
  const processed = await processDrawingPrompt(
    createOutputPreset({
      templateText: '{{reference_sources}}\nPrevious: {{xx_pic}}\nCurrent: {{xx}}',
      useAvatarReferences: avatars,
      usePreviousStoryImage: prior,
    }),
    'new scene',
    {
      previousShotPrompt: 'previous scene',
      previousStoryImage: previous,
      readReferences: async () => {
        avatarReads++;
        return {
          references: missingUser
            ? [{ source: 'character', value: character }]
            : [
                { source: 'character', value: character },
                { source: 'persona', value: user },
              ],
          failedSources: missingUser ? ['persona'] : [],
        };
      },
    },
  );
  const expected = [...(avatars ? (missingUser ? [character] : [user, character]) : []), ...(prior ? [previous] : [])];
  const labels = [
    ...(avatars ? (missingUser ? ['角色头像'] : ['User 头像', '角色头像']) : []),
    ...(prior ? ['上一镜头参考图'] : []),
  ];
  const expectedPrompt =
    `${labels.map((label, index) => `图${index + 1}：${label}`).join('\n')}\nPrevious: previous scene\nCurrent: new scene`.trim();
  const resources = await requestImages({ ...profile, requestMode: mode }, processed, new AbortController().signal);
  assert.equal(resources.length, 1);
  assert.equal(avatarReads, avatars ? 1 : 0);
  assert.equal(calls.length, 1, `${mode}: exactly one image request`);
  const body = calls[0].body;
  const baseKeys = ['model', 'n', 'quality', 'size'];
  if (mode === 'multipart-edit' && expected.length) {
    assert.ok(body instanceof FormData);
    assert.equal(body.get('prompt'), expectedPrompt);
    assert.deepEqual([...new Set(body.keys())].sort(), [...baseKeys, 'prompt', 'image[]'].sort());
    const images = body.getAll('image[]');
    assert.equal(images.length, expected.length);
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      assert.ok(image instanceof Blob);
      assert.deepEqual(
        new Uint8Array(await image.arrayBuffer()),
        new Uint8Array([expected[index] === user ? 1 : expected[index] === character ? 2 : 3]),
      );
    }
  } else {
    assert.equal(typeof body, 'string');
    const parsed = JSON.parse(body as string);
    if (mode === 'chat-multimodal') {
      assert.deepEqual(Object.keys(parsed).sort(), [...baseKeys, 'messages'].sort());
      assert.deepEqual(parsed.messages, [
        {
          role: 'user',
          content: [
            { type: 'text', text: expectedPrompt },
            ...expected.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ]);
    } else {
      assert.deepEqual(
        Object.keys(parsed).sort(),
        [...baseKeys, 'prompt', ...(expected.length ? ['images'] : [])].sort(),
      );
      assert.equal(parsed.prompt, expectedPrompt);
      assert.deepEqual(parsed.images, expected.length ? expected : undefined);
    }
  }
}

async function verifyReadFailure(mode: ImageRequestMode, allMissing = false): Promise<void> {
  const reads: string[] = [];
  const posts: RequestInit[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(init);
      return new Response(JSON.stringify({ data: [{ url: 'https://provider.test/result.png' }] }));
    }
    reads.push(String(input));
    if (allMissing || String(input).includes('missing')) return new Response('', { status: 404 });
    return new Response(new Uint8Array([String(input).includes('character') ? 2 : 3]), {
      headers: { 'Content-Type': 'image/png' },
    });
  };
  const currentProfile = { ...profile, requestMode: mode };
  const signal = new AbortController().signal;
  const preset = createOutputPreset({
    templateText: '{{reference_sources}}\n{{xx}}',
    useAvatarReferences: true,
    usePreviousStoryImage: true,
  });
  const preview = await processDrawingPrompt(preset, 'scene', {
    readReferences: async () => ({
      references: [
        { source: 'persona', value: '/missing-avatar.png' },
        { source: 'character', value: '/character.png' },
      ],
      failedSources: [],
    }),
    previousStoryImage: 'blob:https://tavern.test/prior',
    referenceContext: { profile: currentProfile, signal },
  });
  assert.equal(reads.length, 3);
  assert.equal(posts.length, 0);
  assert.deepEqual(
    preview.referenceSources?.map(source => source.kind) ?? [],
    allMissing ? [] : ['character-avatar', 'previous-story-image'],
  );
  assert.equal(preview.prompt, allMissing ? '\nscene' : '图1：角色头像\n图2：上一镜头参考图\nscene');
  const submitted = await processDrawingPrompt(preset, 'scene', {
    readReferences: async () => {
      throw new Error('must not reread avatars');
    },
    referenceContext: { profile: currentProfile, signal },
    resolvedReferenceSources: preview.referenceSources ?? [],
  });
  assert.equal(
    buildPromptEditorFinalPrompt(preset.templateText, 'scene', '', preview.referenceSources),
    submitted.prompt,
  );
  await requestImages(currentProfile, submitted, signal);
  assert.equal(reads.length, 3, 'preview and submit share successfully materialized bytes');
  assert.equal(posts.length, 1);
  if (allMissing && mode !== 'chat-multimodal') {
    const body = JSON.parse(posts[0].body as string);
    assert.equal(body.prompt, 'scene');
    assert.equal(body.images, undefined);
    assert.equal(posts[0].body instanceof FormData, false, 'all failed optional refs use ordinary generation body');
  }
}

async function verifyAbortAndTimeout(): Promise<void> {
  for (const timedOut of [false, true]) {
    const controller = new AbortController();
    let posts = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'POST') posts++;
      if (timedOut) throw new DOMException('request timed out', 'AbortError');
      controller.abort();
      return new Response('', { status: 404 });
    };
    await assert.rejects(
      async () => {
        const result = await processDrawingPrompt(createOutputPreset({ usePreviousStoryImage: true }), 'scene', {
          previousStoryImage: '/missing',
          referenceContext: { profile, signal: controller.signal },
        });
        await requestImages(profile, result, controller.signal);
      },
      error =>
        timedOut
          ? error instanceof ImageApiError && error.timedOut
          : error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(posts, 0, 'abort or timeout must not become text-only POST');
  }
  globalThis.fetch = async () => {
    throw new Error('unexpected adapter defect');
  };
  await assert.rejects(
    processDrawingPrompt(createOutputPreset({ usePreviousStoryImage: true }), 'scene', {
      previousStoryImage: '/source',
      referenceContext: { profile, signal: new AbortController().signal },
    }),
    /unexpected adapter defect/,
  );
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') posts++;
    return new Response('', { status: 404 });
  };
  await assert.rejects(
    requestImages(
      { ...profile, requestMode: 'multipart-edit' },
      {
        prompt: 'region change',
        referenceImages: [character, '/missing-mask'],
      },
      new AbortController().signal,
    ),
  );
  assert.equal(posts, 0, 'hard region mask remains mandatory');
}

async function verifyRemotePassThrough(): Promise<void> {
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    throw new Error('unexpected CORS fetch');
  };
  for (const mode of ['json-reference', 'chat-multimodal'] as const) {
    const result = await processDrawingPrompt(createOutputPreset({ usePreviousStoryImage: true }), 'scene', {
      previousStoryImage: 'https://remote.test/prior.png',
      referenceContext: { profile: { ...profile, requestMode: mode }, signal: new AbortController().signal },
    });
    assert.deepEqual(result.referenceImages, ['https://remote.test/prior.png']);
  }
  assert.equal(reads, 0);
}

async function verifySrcdocRelativeReferencePipeline(): Promise<void> {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFetch = globalThis.fetch;
  const runtimeWindow = (globalThis as typeof globalThis & { window: { location: { href: string } } }).window;
  const originalHref = runtimeWindow.location.href;
  const sourceDocument = { baseURI: 'https://tavern.test/' };
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: sourceDocument,
    writable: true,
  });
  runtimeWindow.location.href = 'about:srcdoc';
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (init?.method === 'GET') {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    }
    return new Response(JSON.stringify({ data: [{ url: 'https://provider.test/result.png' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    for (const mode of ['json-reference', 'chat-multimodal', 'multipart-edit'] as const) {
      const currentProfile = { ...profile, requestMode: mode };
      const processed = await processDrawingPrompt(
        createOutputPreset({
          templateText: '{{reference_sources}}\n{{xx}}',
          useAvatarReferences: true,
          usePreviousStoryImage: true,
        }),
        'scene',
        {
          readReferences: async () => ({
            references: [
              { source: 'persona', value: '/user/images/persona.png' },
              { source: 'character', value: '/characters/character.png' },
            ],
            failedSources: [],
          }),
          previousStoryImage: previous,
          referenceContext: { profile: currentProfile, signal: new AbortController().signal },
        },
      );
      assert.deepEqual(
        processed.referenceSources?.map(source => source.kind),
        ['user-avatar', 'character-avatar', 'previous-story-image'],
        `${mode} 在 about:srcdoc 下应保留全部三个参考来源`,
      );
      assert.equal(processed.referenceImages?.length, 3, `${mode} 应保留全部三个参考输入`);
      await requestImages(currentProfile, processed, new AbortController().signal);
      assert.equal(calls.length, 3, `${mode} 应先读取两张头像，再只发起一次图片 POST`);
      assert.deepEqual(
        calls.slice(0, 2).map(call => call.url),
        ['https://tavern.test/user/images/persona.png', 'https://tavern.test/characters/character.png'],
        `${mode} 应使用 document.baseURI 读取相对头像`,
      );
      const post = calls[2].init;
      if (mode === 'multipart-edit') {
        assert(post?.body instanceof FormData, 'multipart 应发送 FormData');
        assert.equal((post.body as FormData).getAll('image[]').length, 3, 'multipart 应发送三个参考图文件');
      } else {
        assert.equal(typeof post?.body, 'string', `${mode} 应发送 JSON body`);
        const body = JSON.parse(post!.body as string) as Record<string, unknown>;
        if (mode === 'chat-multimodal') {
          const content = (body.messages as Array<{ content: unknown }>)[0].content as Array<{
            type: string;
            image_url?: { url: string };
          }>;
          assert.equal(content.length, 4, 'chat 应发送文本和三个参考图');
          assert(content.slice(1).every(item => item.image_url?.url.startsWith('data:image/png;base64,')), 'chat 参考图应为 data URL');
        } else {
          const images = body.images as unknown[];
          assert.equal(images.length, 3, 'json-reference 应发送三个参考图');
          assert(images.every(value => typeof value === 'string' && value.startsWith('data:image/png;base64,')), 'JSON 参考图应为 data URL');
        }
      }
      calls.length = 0;
    }
  } finally {
    globalThis.fetch = previousFetch;
    runtimeWindow.location.href = originalHref;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

async function run(): Promise<void> {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      atob,
      location: { href: 'https://tavern.test/' },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
  });
  try {
    for (const mode of ['json-reference', 'multipart-edit', 'chat-multimodal'] as const) {
      for (const avatars of [false, true]) for (const prior of [false, true]) await verify(mode, avatars, prior);
      await verify(mode, true, true, true);
      await verifyReadFailure(mode);
      await verifyReadFailure(mode, true);
    }
    await verifyAbortAndTimeout();
    await verifyRemotePassThrough();
    await verifySrcdocRelativeReferencePipeline();
    console.info('story-image continuity API integration and optional read failure tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}
void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
