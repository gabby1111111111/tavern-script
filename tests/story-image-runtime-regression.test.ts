import * as messageRenderer from '../src/杠杠の生图机/message-renderer';
import * as promptEditor from '../src/杠杠の生图机/prompt-editor';
import * as promptProcessor from '../src/杠杠の生图机/prompt-processor';
import * as referenceResolution from '../src/杠杠の生图机/reference-resolution';
import {
  buildPromptEditorFinalPrompt,
  describePromptEditorAvatarReferences,
  describePromptEditorTemplateWarning,
} from '../src/杠杠の生图机/prompt-editor';
import { groupImagePlacements } from '../src/杠杠の生图机/renderer-model';
import { createStoryImageRuntime, type StoryImageRuntime } from '../src/杠杠の生图机/runtime';
import { ImageSettings, type StoryImageSettings } from '../src/杠杠の生图机/settings';
import type { ImagePlacement } from '../src/杠杠の生图机/image-placement';
import type { ImagePlacementRenderHandlers } from '../src/杠杠の生图机/message-renderer';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type EventListener = (...args: unknown[]) => void;
type FakeCollection = {
  length: number;
  find: (_selector: string) => FakeCollection;
  remove: () => FakeCollection;
  each: (_callback: (_index: number, _element: unknown) => void) => FakeCollection;
  filter: (_callback: (_index: number, _element: unknown) => boolean) => FakeCollection;
};

const emptyCollection: FakeCollection = {
  length: 0,
  find: () => emptyCollection,
  remove: () => emptyCollection,
  each: () => emptyCollection,
  filter: () => emptyCollection,
};

const eventNames = {
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
} as const;

type TestGlobals = Record<string, unknown>;
type RenderMessagePlacements = typeof messageRenderer.renderMessagePlacements;
type RenderCall = {
  placements: ReadonlyArray<ImagePlacement>;
  messageId: number;
  handlers?: ImagePlacementRenderHandlers;
  swipeIdOverride?: number;
};

function submitPromptEdit(
  handlers: ImagePlacementRenderHandlers,
  placement: ImagePlacement,
  onSubmitted: () => void,
): Promise<void> | void {
  const onEditPrompt = handlers.onEditPrompt;
  assert(onEditPrompt, '真实 placement 必须提供提示词重绘入口');
  return onEditPrompt(placement, onSubmitted);
}

function installRuntimeMocks(trackPendingHosts = false) {
  const globals = globalThis as unknown as TestGlobals;
  const previous = new Map<string, unknown>();
  const keys = [
    '$',
    'SillyTavern',
    'eventOn',
    'fetch',
    'getCharacter',
    'getChatMessages',
    'getLastMessageId',
    'getPersonaAvatarPath',
    'injectPrompts',
    'location',
    'uninjectPrompts',
    'retrieveDisplayedMessage',
    'setChatMessages',
    'tavern_events',
    'toastr',
    'window',
    '__storyImageAudit',
  ];
  keys.forEach(key => previous.set(key, globals[key]));

  const listeners = new Map<string, Set<EventListener>>();
  const message: {
    message_id: number;
    role: string;
    message: string;
    swipe_id: number;
    swipes?: string[];
  } = {
    message_id: 0,
    role: 'assistant',
    message: '',
    swipe_id: 0,
  };
  const chat = [message];
  const renderCalls: RenderCall[] = [];
  const pendingHosts = new Set<string>();
  const injections: Array<Array<{ content: string }>> = [];
  let requestCount = 0;
  let failPersonaReference = false;
  let referenceReadCount = 0;
  const imagePosts: Array<{ url: string; init: RequestInit }> = [];
  let holdNextRequest = false;
  let releaseResponse: (() => void) | null = null;
  let lastRequestSignal: AbortSignal | null = null;
  let holdPromptEditor = false;
  let releasePromptEditor: (() => void) | null = null;
  let lastPromptEditorSignal: AbortSignal | null = null;
  let holdNextPromptProcessing = false;
  let processingStarted = false;
  let releasePromptProcessing: (() => void) | null = null;
  let lastPromptEditorInput: Parameters<typeof promptEditor.openImagePromptEditor>[0] | null = null;

  const renderer = messageRenderer as unknown as {
    renderMessagePlacements: RenderMessagePlacements;
    renderImageTask: typeof messageRenderer.renderImageTask;
    removeRenderedTaskHost: typeof messageRenderer.removeRenderedTaskHost;
    clearRenderedHosts: typeof messageRenderer.clearRenderedHosts;
  };
  const originalRenderTask = renderer.renderImageTask;
  const originalRemoveTask = renderer.removeRenderedTaskHost;
  const originalClearHosts = renderer.clearRenderedHosts;
  if (trackPendingHosts) {
    const taskKey = (task: Parameters<typeof messageRenderer.renderImageTask>[0]): string =>
      `${task.chatId}:${task.messageId}:${task.swipeId}:${task.imageIndex}`;
    renderer.renderImageTask = task => {
      pendingHosts.add(taskKey(task));
      return true;
    };
    renderer.removeRenderedTaskHost = task => {
      pendingHosts.delete(taskKey(task));
    };
    renderer.clearRenderedHosts = () => {
      pendingHosts.clear();
      originalClearHosts();
    };
  }
  const previousRenderMessagePlacements = renderer.renderMessagePlacements;
  const promptEditorModule = promptEditor as unknown as {
    openImagePromptEditor: typeof promptEditor.openImagePromptEditor;
  };
  const previousOpenImagePromptEditor = promptEditorModule.openImagePromptEditor;
  const promptProcessorModule = promptProcessor as unknown as {
    processDrawingPrompt: typeof promptProcessor.processDrawingPrompt;
  };
  const previousProcessDrawingPrompt = promptProcessorModule.processDrawingPrompt;
  const processedPromptInputs: Array<Parameters<typeof previousProcessDrawingPrompt>> = [];
  renderer.renderMessagePlacements = (placements, messageId, handlers, swipeIdOverride) => {
    renderCalls.push({ placements: [...placements], messageId, handlers, swipeIdOverride });
    return 0;
  };
  promptEditorModule.openImagePromptEditor = input => {
    lastPromptEditorInput = input;
    lastPromptEditorSignal = input.signal ?? null;
    const resultPromise = (async () => {
      const selection = input.referenceSelection;
      const shouldPrepare = Boolean(
        input.prepareReferenceSources &&
        selection &&
        (selection.useAvatarReferences || selection.usePreviousStoryImage),
      );
      const preparedSources = shouldPrepare
        ? await input.prepareReferenceSources!(selection!, input.signal ?? new AbortController().signal)
        : input.referenceSources
          ? promptEditor.selectPromptEditorReferenceSources(input.referenceSources, input.referenceSelection)
          : undefined;
      if (preparedSources && input.referenceSources) input.referenceSources = preparedSources;
      return {
        prompt: 'final expanded\nprompt',
        scenePrompt: '  revised\nprompt  ',
        referenceSources: preparedSources,
        outputPreset: { ...input.outputPreset },
      };
    })();
    if (!holdPromptEditor) return resultPromise;
    return new Promise<Awaited<typeof resultPromise> | null>((resolve, reject) => {
      releasePromptEditor = () => {
        void resultPromise.then(resolve, reject);
      };
    });
  };
  promptProcessorModule.processDrawingPrompt = (...args) => {
    processedPromptInputs.push(args);
    if (!holdNextPromptProcessing) return previousProcessDrawingPrompt(...args);
    holdNextPromptProcessing = false;
    processingStarted = true;
    return new Promise<Awaited<ReturnType<typeof previousProcessDrawingPrompt>>>((resolve, reject) => {
      releasePromptProcessing = () => {
        void previousProcessDrawingPrompt(...args).then(resolve, reject);
      };
    });
  };

  const response = (): Response =>
    new Response(
      JSON.stringify({
        data: [
          { url: 'https://images.test/synthetic-revision.png' },
          { url: 'https://images.test/synthetic-revision-variant.png' },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );

  globals.window = globals;
  globals.location = { href: 'http://story-image.test/' };
  globals.tavern_events = eventNames;
  globals.$ = () => emptyCollection;
  globals.retrieveDisplayedMessage = () => emptyCollection;
  globals.SillyTavern = {
    chat,
    groupId: '',
    name2: '测试角色',
    getCurrentChatId: () => 'synthetic-chat',
  };
  globals.getChatMessages = (messageId?: number) => [chat[messageId ?? chat.length - 1] ?? message];
  globals.getPersonaAvatarPath = () => '/avatars/user.png';
  globals.getCharacter = async () => ({ avatar: 'character.png' });
  globals.getLastMessageId = () => {
    const chat = (globals.SillyTavern as { chat?: Array<{ swipes?: unknown[]; swipe_id?: number }> }).chat ?? [];
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const candidate = chat[index];
      if (
        Array.isArray(candidate?.swipes) &&
        typeof candidate.swipe_id === 'number' &&
        candidate.swipe_id >= candidate.swipes.length
      ) {
        continue;
      }
      return index;
    }
    return -1;
  };
  globals.injectPrompts = (prompts: Array<{ content: string }>) => {
    injections.push(prompts);
    return { uninject: () => undefined };
  };
  globals.uninjectPrompts = () => undefined;
  globals.setChatMessages = () => Promise.resolve();
  globals.toastr = { error: () => undefined, info: () => undefined, warning: () => undefined };
  globals.eventOn = (event: unknown, listener: unknown) => {
    const name = String(event);
    const typedListener = listener as EventListener;
    const bucket = listeners.get(name) ?? new Set<EventListener>();
    bucket.add(typedListener);
    listeners.set(name, bucket);
    return {
      stop: () => bucket.delete(typedListener),
    };
  };
  globals.fetch = (_input: unknown, init?: unknown) => {
    const request = init as RequestInit | undefined;
    if (request?.method === 'GET') {
      referenceReadCount += 1;
      if (failPersonaReference && String(_input).includes('/avatars/user.png'))
        return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }));
    }
    imagePosts.push({ url: String(_input), init: request ?? {} });
    requestCount += 1;
    lastRequestSignal = (init as RequestInit | undefined)?.signal ?? null;
    if (!holdNextRequest) return Promise.resolve(response());
    holdNextRequest = false;
    return new Promise<Response>(resolve => {
      releaseResponse = () => resolve(response());
    });
  };

  const emit = async (event: string, ...args: unknown[]): Promise<void> => {
    const bucket = listeners.get(event);
    for (const listener of [...(bucket ?? [])]) listener(...args);
    await Promise.resolve();
  };

  const restore = (): void => {
    renderer.renderMessagePlacements = previousRenderMessagePlacements;
    renderer.renderImageTask = originalRenderTask;
    renderer.removeRenderedTaskHost = originalRemoveTask;
    renderer.clearRenderedHosts = originalClearHosts;
    promptEditorModule.openImagePromptEditor = previousOpenImagePromptEditor;
    promptProcessorModule.processDrawingPrompt = previousProcessDrawingPrompt;
    previous.forEach((value, key) => {
      if (typeof value === 'undefined') delete globals[key];
      else globals[key] = value;
    });
  };

  return {
    message,
    chat,
    emit,
    renderCalls,
    pendingHosts,
    imagePosts,
    failPersonaReference: () => {
      failPersonaReference = true;
    },
    get referenceReadCount() {
      return referenceReadCount;
    },
    injections,
    holdNextRequest: () => {
      holdNextRequest = true;
    },
    releaseResponse: () => {
      const release = releaseResponse;
      releaseResponse = null;
      release?.();
    },
    holdPromptEditor: () => {
      holdPromptEditor = true;
    },
    releasePromptEditor: () => {
      const release = releasePromptEditor;
      releasePromptEditor = null;
      release?.();
    },
    holdNextPromptProcessing: () => {
      holdNextPromptProcessing = true;
    },
    releasePromptProcessing: () => {
      const release = releasePromptProcessing;
      releasePromptProcessing = null;
      release?.();
    },
    restore,
    get requestCount() {
      return requestCount;
    },
    get lastRequestSignal() {
      return lastRequestSignal;
    },
    get lastPromptEditorSignal() {
      return lastPromptEditorSignal;
    },
    get lastPromptEditorInput() {
      return lastPromptEditorInput;
    },
    get processedPromptInputs() {
      return processedPromptInputs;
    },
    get processingStarted() {
      return processingStarted;
    },
  };
}

function testSettings(
  enabled: boolean,
  useAvatarReferences = false,
  displayMode: 'inline' | 'gift' = 'inline',
): StoryImageSettings {
  return ImageSettings.parse({
    enabled,
    drawingPresets: [{ id: 'drawing', name: 'drawing', instructionText: '' }],
    currentDrawingPresetId: 'drawing',
    outputPresets: [{ id: 'output', name: 'output', templateText: '{{xx}}', useAvatarReferences }],
    currentOutputPresetId: 'output',
    recentImageLimit: 10,
    displaySettings: { displayMode, skipFloors: 0, generateOnSwipe: true },
    activeApiProfileId: 'synthetic-profile',
    apiProfiles: [
      {
        id: 'synthetic-profile',
        name: 'synthetic',
        serviceUrl: 'https://images.test/v1/images/generations',
        modelListUrl: '',
        apiKey: 'synthetic-key',
        model: 'synthetic-image-model',
        imageSize: '1024x1024',
        quality: 'auto',
        imageCount: 1,
        timeoutMs: 5_000,
        retryAttempts: 0,
        retryDelayMs: 0,
        requestMode: 'auto',
        multipartImageField: 'auto',
        jsonReferenceField: 'images',
        extraBody: {},
      },
    ],
    storyApiProfileId: 'synthetic-profile',
    giftApiProfileId: 'synthetic-profile',
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

async function startRuntimeWithInitialPlacement(
  mocks: ReturnType<typeof installRuntimeMocks>,
  settings = testSettings(true),
): Promise<{ runtime: StoryImageRuntime; placement: ImagePlacement; handlers: ImagePlacementRenderHandlers }> {
  const runtime = createStoryImageRuntime();
  runtime.updateSettings(settings);
  runtime.start();
  mocks.message.message = '<content>正文\n<pic prompt="initial prompt">\n</content>';
  await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
  await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
  await waitFor(
    () => mocks.renderCalls.some(call => call.messageId === 0 && call.placements.length === 1),
    '正常生成应通过真实 runtime 链路建立初始 placement',
  );
  const renderCall = [...mocks.renderCalls]
    .reverse()
    .find(call => call.messageId === 0 && call.placements.length === 1);
  const placement = renderCall?.placements[0];
  const handlers = renderCall?.handlers;
  assert(placement && handlers, '初始 placement 必须携带真实重绘 handlers');
  return { runtime, placement, handlers };
}

async function testSwipeGenerationUsesMessageSwipedTarget(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime } = await startRuntimeWithInitialPlacement(mocks);
    await waitFor(() => runtime.recentImages.value.length === 1, '初始图片应先完成');
    const initialRequestCount = mocks.requestCount;

    // SillyTavern marks the new in-progress swipe with swipe_id === swipes.length.
    // Its default getLastMessageId() deliberately skips that entry, so the runtime
    // must use the preceding MESSAGE_SWIPED event to recover the exact target.
    mocks.message.swipes = ['initial swipe'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<content>Swipe 正文\n<pic prompt="swipe prompt">\n</content>';
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);

    assert(runtime.audit.swipe.message_id === 0, 'Swipe generation 应锁定 MESSAGE_SWIPED 提供的消息 ID');
    assert(runtime.audit.swipe.eligible === true, 'Swipe generation 应复用原消息楼层的触发资格');
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(
      () => mocks.requestCount === initialRequestCount + 1,
      '有效 Swipe 回复应沿真实事件链路发起图片 API 请求',
    );
    await waitFor(() => runtime.recentImages.value.length === 2, 'Swipe 图片应写入页面内存缓存');

    assert(runtime.audit.swipe.started === true, 'Swipe 回复收到后应记录 started');
    assert(runtime.audit.swipe.skipped === false, '有效 Swipe 回复不应记录 skipped');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testPromptEditorUsesPresetAndAvatarSnapshot(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    assert(
      buildPromptEditorFinalPrompt('前缀 {{xx}} 后缀', '  场景描述  ') === '前缀 场景描述 后缀',
      '最终提示词预览必须复用真实模板替换逻辑',
    );
    assert(
      describePromptEditorTemplateWarning('固定模板') !== '',
      '不含 {{xx}} 的模板必须显示场景描述不会进入最终提示词的提示',
    );
    assert(
      describePromptEditorAvatarReferences({
        enabled: true,
        availableSources: ['persona'],
        failedSources: ['character'],
      }).includes('用户头像'),
      '头像状态必须区分用户头像来源',
    );

    const settings = testSettings(true, true);
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks, settings);
    await waitFor(() => runtime.recentImages.value.length === 1, '启用头像引用的初始图片应先完成');
    const initialRequestCount = mocks.requestCount;
    const redraw = Promise.resolve(submitPromptEdit(handlers, placement, () => undefined));
    await waitFor(() => mocks.lastPromptEditorInput !== null, '头像读取后应打开提示词弹窗');
    await waitFor(() => runtime.recentImages.value.length === 2, '确认后应沿同一快照请求图片');
    await redraw;
    assert(mocks.requestCount > initialRequestCount, '确认重绘后应发起图片请求');

    const editorInput = mocks.lastPromptEditorInput;
    assert(editorInput?.outputPreset.name === 'output', '弹窗应显示当前出图预设名称');
    assert(editorInput?.outputPreset.templateText === '{{xx}}', '提交快照仍保留当前模板配置');
    assert(editorInput?.avatarReferences.enabled === true, '弹窗头像状态应遵循当前出图预设配置');
    assert(editorInput?.referenceSelection?.known === true, '弹窗参考默认值应来自当前图片的实际记录');
    assert(editorInput?.referenceSelection?.useAvatarReferences === true, '当前图片使用头像时默认勾选头像参考');
    assert(
      editorInput?.referenceSources?.map(source => source.kind).join(',') === 'user-avatar,character-avatar',
      '弹窗应保留当前图片实际使用的头像来源候选',
    );

    const posted = mocks.imagePosts.at(-1);
    assert(posted, '确认后应发起一次实际图片请求');
    const postedPrompt =
      posted.init.body instanceof FormData
        ? String(posted.init.body.get('prompt'))
        : JSON.parse(String(posted.init.body)).prompt;
    assert(postedPrompt === 'final expanded\nprompt', '请求应发送用户确认的最终提示词原文');
    assert(mocks.processedPromptInputs.length === 1, '最终提示词已展开后，确认重绘不得再次加工或套用出图模板');
    assert(settings.outputPresets[0].templateText === '{{xx}}', '临时重绘配置不得修改全局出图预设');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testPlacementKeepsFinalPromptOnReopen(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks, testSettings(true));
    await submitPromptEdit(handlers, placement, () => undefined);
    assert(mocks.referenceReadCount === 0, '未选参考图时打开纯文本编辑不得读取头像或图片');
    const revisedRender = [...mocks.renderCalls]
      .reverse()
      .find(call => call.placements.some(item => item.target.messageId === 0 && item.revisionIndex === 1));
    const revised = revisedRender?.placements.find(item => item.revisionIndex === 1);
    assert(revised, '手动重绘应创建新的 revision placement');
    assert(revised.prompt === 'revised\nprompt', '场景提示词应单独保留为镜头文字');
    assert(revised.finalPrompt === 'final expanded\nprompt', 'revision 应保留最终 API 提示词');
    mocks.holdPromptEditor();
    const reopening = submitPromptEdit(revisedRender!.handlers!, revised, () => undefined);
    await waitFor(
      () => mocks.lastPromptEditorInput?.finalPrompt === 'final expanded\nprompt',
      '再次打开编辑器应优先显示保存的最终 API 提示词',
    );
    mocks.releasePromptEditor();
    await reopening;
    runtime.stop();
  } finally {
    mocks.releasePromptEditor();
    mocks.restore();
  }
}

async function testSwipeTaskSurvivesDisplaySwitches(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime } = await startRuntimeWithInitialPlacement(mocks);
    await waitFor(() => runtime.recentImages.value.length === 1, '初始图片应先完成');
    const initialRequestCount = mocks.requestCount;

    mocks.message.swipes = ['initial swipe'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<content>Swipe 正文\n<pic prompt="background swipe prompt">\n</content>';
    mocks.holdNextRequest();
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(
      () => mocks.requestCount === initialRequestCount + 1,
      'Swipe 自动任务应只发起一次图片 API 请求并保持等待',
    );
    assert(runtime.audit.tasks[0]?.status === 'running', '新 Swipe 任务应处于 running');

    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    mocks.message.swipe_id = 1;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    assert(runtime.audit.tasks[0]?.status === 'running', '切走再切回不得取消原 Swipe 任务');

    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    mocks.releaseResponse();
    await waitFor(() => runtime.recentImages.value.length === 2, '切走期间完成的结果应进入最近生成');
    assert(mocks.requestCount === initialRequestCount + 1, '切换 Swipe 不得重试或新增图片请求');

    const completedRender = [...mocks.renderCalls]
      .reverse()
      .find(call => call.placements.some(item => item.target.messageId === 0 && item.target.swipeId === 1));
    assert(completedRender, '完成结果必须保留原 Swipe target placement');

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert(mocks.requestCount === initialRequestCount + 1, '自动任务完成后不得因切换再次请求');
    mocks.message.swipe_id = 1;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    const restoredRender = mocks.renderCalls.at(-1);
    assert(restoredRender?.swipeIdOverride === 1, '切回 Swipe 应按当前 Swipe 渲染');
    assert(
      groupImagePlacements(restoredRender.placements, 0, 1)[0]?.variants[0]?.revisions.length === 1,
      '切回原 Swipe 应恢复已完成的图片 placement',
    );
    assert(String(runtime.audit.tasks[0]?.status) === 'success', '切回原 Swipe 后任务应显示 success');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testDeferredTaskSwipeDeletionMigratesRetentionScope(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();
    mocks.message.message = '<content>初始 Swipe\n<pic prompt="initial prompt">\n</content>';
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 1, '初始图片应先完成');

    mocks.message.swipes = ['初始回复'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<content>待迁移 Swipe\n<pic prompt="deferred swipe prompt">\n</content>';
    mocks.holdNextRequest();
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(() => mocks.requestCount === 2, 'Swipe1 自动任务应进入等待');

    mocks.chat.push({ message_id: 1, role: 'user', message: '新楼', swipe_id: 0 });
    await mocks.emit(eventNames.MESSAGE_SENT, 1);
    assert(mocks.lastRequestSignal?.aborted === false, '新楼清理不得取消待迁移 Swipe 任务');

    mocks.message.swipes = [];
    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPE_DELETED, { messageId: 0, swipeId: 0, newSwipeId: 0 });
    assert(mocks.lastRequestSignal?.aborted === false, '删除旧 Swipe 不得取消下移后的任务');
    mocks.releaseResponse();
    await waitFor(
      () => runtime.recentImages.value.some(image => image.messageId === 0 && image.swipeId === 0),
      '下移后的 deferred 任务应完成并归属新 Swipe0',
    );

    const multiImageSettings = testSettings(true);
    multiImageSettings.apiProfiles[0]!.imageCount = 2;
    runtime.updateSettings(multiImageSettings);
    mocks.message.swipes = ['删除后 Swipe0'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<content>新的 Swipe1\n<pic prompt="new swipe prompt">\n</content>';
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(
      () => runtime.recentImages.value.filter(image => image.messageId === 0 && image.swipeId === 1).length === 2,
      '旧 deferred 状态不得截断重新生成的 Swipe1 结果',
    );
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testSwipeKeepsManualRevisionOnOriginalSwipe(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    assert(handlers.onEditPrompt, '真实 placement 必须提供提示词重绘入口');
    mocks.holdNextRequest();
    let submitted = false;
    const redraw = Promise.resolve(submitPromptEdit(handlers, placement, () => (submitted = true)));
    await waitFor(() => mocks.requestCount === 2, '手动重绘应在初始生成后进入第二次图片 API 请求');
    assert(submitted, '编辑器确认后才应通知 renderer 进入生成态');

    mocks.message.swipe_id = 1;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    assert(mocks.lastRequestSignal?.aborted === false, '切换 Swipe 不得 abort 已提交的手动重绘请求');
    mocks.releaseResponse();
    await redraw;

    assert(mocks.requestCount === 2, 'Swipe 切换后的手动重绘不得隐式重试');
    assert(runtime.recentImages.value.length === 2, '迟到结果应保留原 Swipe 的新版本');
    const completedRender = [...mocks.renderCalls].reverse().find(call => call.swipeIdOverride === undefined);
    assert(completedRender, '重绘完成应通过不带旧 Swipe override 的真实渲染调用');
    const revisions = completedRender.placements.filter(
      item => item.target.messageId === 0 && item.target.swipeId === 0 && item.variantIndex === 0,
    );
    const revisedPlacement = revisions.find(item => item.revisionIndex === 1);
    assert(revisedPlacement, '迟到版本必须写回原消息的原 Swipe');
    assert(revisedPlacement.prompt === 'revised\nprompt', '多行提示词只应 trim 首尾空白并保留换行');
    assert(groupImagePlacements(completedRender.placements, 0, 1).length === 0, '当前 Swipe 不得显示原 Swipe 版本');
    const originalSwipeGroups = groupImagePlacements(completedRender.placements, 0, 0);
    assert(
      originalSwipeGroups[0]?.variants[0]?.revisions.some(item => item.revisionIndex === 1) === true,
      '按真实 placement target 分组后，切回原 Swipe 应能读取新版本',
    );

    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    const restoredRender = mocks.renderCalls.at(-1);
    assert(restoredRender, '切回原 Swipe 应触发 placement 渲染');
    assert(
      groupImagePlacements(restoredRender.placements, 0, 0)[0]?.variants[0]?.revisions.some(
        item => item.revisionIndex === 1,
      ) === true,
      '切回原 Swipe 后渲染输入应包含手动重绘版本',
    );
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testDeletingOnePlacementKeepsAnotherRedrawAlive(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement: firstPlacement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    await waitFor(() => runtime.recentImages.value.length === 1, '初始图片应先完成');

    const firstRedraw = Promise.resolve(submitPromptEdit(handlers, firstPlacement, () => undefined));
    await waitFor(() => runtime.recentImages.value.length === 2, '第一版本重绘应先完成');
    await firstRedraw;
    const firstRevisionRender = [...mocks.renderCalls]
      .reverse()
      .find(call => call.placements.some(item => item.revisionIndex === 1));
    const secondPlacement = firstRevisionRender?.placements.find(item => item.revisionIndex === 1);
    assert(secondPlacement, '删除竞态需要一个已存在的第二版本');

    mocks.holdNextRequest();
    const secondRedraw = Promise.resolve(submitPromptEdit(handlers, secondPlacement, () => undefined));
    await waitFor(() => mocks.requestCount === 3, '第二版本重绘应进入独立图片 API 请求');
    assert(mocks.lastRequestSignal?.aborted === false, '第二版本请求开始时不应被取消');

    await Promise.resolve(handlers.onDelete?.(firstPlacement));
    assert(mocks.lastRequestSignal?.aborted === false, '删除第一版本不得取消另一版本的重绘');
    mocks.releaseResponse();
    await secondRedraw;
    await waitFor(() => runtime.recentImages.value.length === 2, '另一版本迟到结果应保留在页面内存');
    assert(mocks.requestCount === 3, '删除候选版本不得触发重试或新增请求');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testPinPrunesOnlyItsImagePositionAndBlocksLateRedraw(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();
    mocks.message.message = `<content>两个位置
<pic prompt="first position">
中间
<pic prompt="second position">
</content>`;
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 2, '两个 imageIndex 应各自产生一张初始图片');
    const initialRender = [...mocks.renderCalls].reverse().find(call => call.placements.length === 2);
    const first = initialRender?.placements.find(item => item.target.imageIndex === 0);
    const second = initialRender?.placements.find(item => item.target.imageIndex === 1);
    const handlers = initialRender?.handlers;
    assert(first && second && handlers, '固定测试需要两个真实 placement 与 handlers');

    const firstRedraw = Promise.resolve(submitPromptEdit(handlers, first, () => undefined));
    await waitFor(() => runtime.recentImages.value.length === 3, '第一个位置应先产生第二个 revision');
    await firstRedraw;
    const revisedRender = [...mocks.renderCalls]
      .reverse()
      .find(call => call.placements.some(item => item.target.imageIndex === 0 && item.revisionIndex === 1));
    const revised = revisedRender?.placements.find(item => item.target.imageIndex === 0 && item.revisionIndex === 1);
    assert(revised, '固定测试需要选择第一个位置的新 revision');

    await Promise.resolve(handlers.onPin?.(revised));
    await waitFor(() => runtime.recentImages.value.length === 2, '固定一个位置应立即释放同位置旧版本');
    const pinnedRender = mocks.renderCalls.at(-1);
    assert(
      pinnedRender?.placements.some(item => item.id === revised.id) === true,
      '固定版本应继续保留在真实渲染输入中',
    );
    assert(
      pinnedRender?.placements.some(item => item.id === second.id) === true,
      '固定一个位置不得清理同楼其他 imageIndex',
    );
    assert(
      pinnedRender?.placements.some(item => item.id === first.id) === false,
      '固定新版本后同位置旧版本不得继续留在渲染输入中',
    );
    assert(handlers.isPinned?.(revised) === true, '固定版本应回报 pinned 状态');

    const beforeLateRedraw = runtime.recentImages.value.length;
    mocks.holdNextRequest();
    const lateRedraw = Promise.resolve(submitPromptEdit(handlers, revised, () => undefined));
    await waitFor(() => mocks.requestCount === 4, '固定版本的第二次重绘应进入独立 API 请求');
    await Promise.resolve(handlers.onPin?.(revised));
    assert(mocks.lastRequestSignal?.aborted === true, '再次固定时应取消同位置仍进行中的重绘');
    mocks.releaseResponse();
    await lateRedraw;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert(runtime.recentImages.value.length === beforeLateRedraw, '忽略 abort 的迟到重绘不得复活旧候选');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testNewTailRetainsPendingPreviousFloorOnce(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();
    mocks.message.message = `<content>旧楼层
<pic prompt="pending initial prompt">
</content>`;
    mocks.holdNextRequest();
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => mocks.requestCount === 1, '旧楼层首次图片任务应先进入等待');

    mocks.chat.push({
      message_id: 1,
      role: 'user',
      message: '新用户楼层',
      swipe_id: 0,
    });
    await mocks.emit(eventNames.MESSAGE_SENT, 1);
    await mocks.emit(eventNames.MESSAGE_SENT, 1);
    mocks.releaseResponse();
    await waitFor(() => runtime.recentImages.value.length === 1, '新楼出现时旧楼 pending 首图应允许完成一次');
    assert(mocks.requestCount === 1, '新楼自动清理不得重试旧楼图片任务');
    const completed = [...mocks.renderCalls].reverse().find(call => call.placements.length === 1);
    assert(completed?.placements[0]?.target.messageId === 0, '迟到图片必须仍归属上一楼');

    await mocks.emit(eventNames.MESSAGE_SENT, 1);
    await mocks.emit(eventNames.MORE_MESSAGES_LOADED);
    assert(runtime.recentImages.value.length === 1, '重复事件和历史加载不得重复清理或重建图片');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testStreamingAssistantTailTriggersAdvanceCleanup(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();
    mocks.message.message = '<content>上一楼 <pic prompt="stream previous"></content>';
    mocks.holdNextRequest();
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => mocks.requestCount === 1, '上一楼任务应先进入等待');

    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    mocks.chat.push({
      message_id: 1,
      role: 'assistant',
      message: '流式新楼',
      swipe_id: 0,
    });
    await mocks.emit(eventNames.STREAM_TOKEN_RECEIVED, '仅用于触发事件，不读取内容');
    mocks.releaseResponse();
    await waitFor(() => runtime.recentImages.value.length === 1, 'assistant 尾楼首次流式出现应触发上一楼清理');
    assert(runtime.recentImages.value[0]?.messageId === 0, '流式触发后的迟到图片仍应归属上一楼');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testNonFloorAssistantEventTypesDoNotAdvanceCleanup(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    assert(handlers.onEditPrompt, '非楼层事件回归需要真实提示词重绘入口');
    const redraw = Promise.resolve(submitPromptEdit(handlers, placement, () => undefined));
    await waitFor(() => runtime.recentImages.value.length === 2, '非楼层事件回归需要两个同位置版本');
    await redraw;

    mocks.chat.push({
      message_id: 1,
      role: 'assistant',
      message: 'Swipe 事件尾楼',
      swipe_id: 0,
    });
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'swipe');
    assert(runtime.recentImages.value.length === 2, 'MESSAGE_RECEIVED 的 swipe 类型不得被当作新正文楼层清理上一楼版本');

    mocks.chat.push({
      message_id: 2,
      role: 'assistant',
      message: 'regenerate 事件尾楼',
      swipe_id: 0,
    });
    await mocks.emit(eventNames.CHARACTER_MESSAGE_RENDERED, 2, 'regenerate');
    assert(
      runtime.recentImages.value.length === 2,
      'CHARACTER_MESSAGE_RENDERED 的 regenerate 类型不得被当作新正文楼层清理上一楼版本',
    );
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testNewTailPrunesPreviousFloorAcrossSwipesOnly(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const earlierMessage = {
      message_id: 0,
      role: 'assistant',
      message: '<content>更早楼层 <pic prompt="earlier floor"></content>',
      swipe_id: 0,
    };
    mocks.message.message_id = 1;
    mocks.chat.splice(0, 1, earlierMessage, mocks.message);
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();

    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 1, '更早楼层图片应先完成');

    mocks.message.message = '<content>当前楼层 <pic prompt="current swipe 0"></content>';
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 2, '当前楼层初始 Swipe 应先完成');

    mocks.message.swipes = ['当前楼层 Swipe 0'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<content>当前楼层 <pic prompt="current swipe 1"></content>';
    await mocks.emit(eventNames.MESSAGE_SWIPED, 1);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'swipe');
    await waitFor(() => runtime.recentImages.value.length === 3, '当前楼层新 Swipe 图片应先完成');

    mocks.chat.push({ message_id: 2, role: 'user', message: '推进到新楼', swipe_id: 0 });
    await mocks.emit(eventNames.MESSAGE_SENT, 2);
    await waitFor(() => runtime.recentImages.value.length === 2, '新楼出现后当前楼应跨 Swipe 只保留一张');
    const currentFloorImages = runtime.recentImages.value.filter(image => image.messageId === 1);
    assert(currentFloorImages.length === 1, '当前楼所有 Swipe/revision 应只保留一张');
    assert(currentFloorImages[0]?.swipeId === 1, '无手动固定时应保留当时当前显示 Swipe');
    assert(
      runtime.recentImages.value.some(image => image.messageId === 0),
      '新楼清理上一楼不得误删更早楼层图片',
    );

    await mocks.emit(eventNames.MESSAGE_SENT, 2);
    await mocks.emit(eventNames.MORE_MESSAGES_LOADED);
    assert(runtime.recentImages.value.length === 2, '重复推进事件和历史加载不得重建或再次清理');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testLatestManualPinWinsAcrossSwipesOnAdvance(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();
    mocks.message.message = '<content>当前楼层 <pic prompt="swipe 0"></content>';
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 1, 'Swipe 0 图片应先完成');

    mocks.message.swipes = ['Swipe 0'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<content>当前楼层 <pic prompt="swipe 1"></content>';
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(() => runtime.recentImages.value.length === 2, 'Swipe 1 图片应先完成');

    const swipeOneRender = [...mocks.renderCalls]
      .reverse()
      .find(call => call.placements.some(item => item.target.swipeId === 1));
    const swipeOne = swipeOneRender?.placements.find(item => item.target.swipeId === 1);
    assert(swipeOneRender && swipeOne && swipeOneRender.handlers, '跨 Swipe 固定需要 Swipe 1 placement');
    await Promise.resolve(swipeOneRender.handlers.onPin?.(swipeOne));

    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    const swipeZeroRender = mocks.renderCalls.at(-1);
    const swipeZero = swipeZeroRender?.placements.find(item => item.target.swipeId === 0);
    assert(swipeZeroRender && swipeZero && swipeZeroRender.handlers, '跨 Swipe 固定需要 Swipe 0 placement');
    await Promise.resolve(swipeZeroRender.handlers.onPin?.(swipeZero));

    mocks.message.swipe_id = 1;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    const swipeOneAgainRender = mocks.renderCalls.at(-1);
    const swipeOneAgain = swipeOneAgainRender?.placements.find(item => item.target.swipeId === 1);
    assert(
      swipeOneAgainRender && swipeOneAgain && swipeOneAgainRender.handlers,
      '第二次固定需要仍存在的 Swipe 1 placement',
    );
    await Promise.resolve(swipeOneAgainRender.handlers.onPin?.(swipeOneAgain));

    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    mocks.chat.push({ message_id: 1, role: 'user', message: '新楼', swipe_id: 0 });
    await mocks.emit(eventNames.MESSAGE_SENT, 1);
    await waitFor(() => runtime.recentImages.value.length === 1, '自动推进后同楼各 Swipe 应只保留一张');
    assert(runtime.recentImages.value[0]?.swipeId === 1, '最新手动固定应优先于当前显示 Swipe');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testMessageDeletionReconcilesByRawIdentity(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const earlierMessage = { message_id: 0, role: 'assistant', message: '更早', swipe_id: 0 };
    const lastMessage = {
      message_id: 2,
      role: 'assistant',
      message: '<content>最后楼层 <pic prompt="last floor"></content>',
      swipe_id: 0,
    };
    mocks.message.message_id = 1;
    mocks.chat.splice(0, 1, earlierMessage, mocks.message, lastMessage);
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();

    mocks.message.message = '<content>中间楼层 <pic prompt="middle floor"></content>';
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 1, '中间楼层图片应先完成');

    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 2, 'normal');
    await waitFor(() => runtime.recentImages.value.length === 2, '最后楼层图片应先完成');
    const lastRender = [...mocks.renderCalls]
      .reverse()
      .find(call => call.placements.some(item => item.target.messageId === 2));
    const lastPlacement = lastRender?.placements.find(item => item.target.messageId === 2);
    assert(lastRender && lastPlacement && lastRender.handlers, '删除中间楼回归需要固定最后楼层图片');
    await Promise.resolve(lastRender.handlers.onPin?.(lastPlacement));

    mocks.chat.splice(1, 1);
    await mocks.emit(eventNames.MESSAGE_DELETED, mocks.chat.length);
    await waitFor(() => runtime.recentImages.value.length === 1, '删除中间楼应只清理已删除楼层图片');
    const remaining = runtime.recentImages.value[0];
    assert(remaining?.messageId === 1, '最后楼层图片应按 raw message identity 移动到新楼层序号');
    assert(remaining?.id === lastPlacement.artifactId, '最后楼层固定图片不得因错误删除参数被清除');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testNewTailDoesNotCancelGiftTask(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true, false, 'gift'));
    runtime.start();
    mocks.message.message = `<content>礼物楼层
<pic prompt="gift prompt">
</content>`;
    mocks.holdNextRequest();
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => mocks.requestCount === 1, '礼物任务应先进入图片 API 请求');

    mocks.chat.push({ message_id: 1, role: 'user', message: '新用户楼层', swipe_id: 0 });
    await mocks.emit(eventNames.MESSAGE_SENT, 1);
    assert(mocks.lastRequestSignal?.aborted === false, '新楼清理正文插图时不得取消礼物任务');
    mocks.releaseResponse();
    await waitFor(() => runtime.recentImages.value.length === 1, '礼物任务应完成并保留图片');
    assert(runtime.audit.gift.status === 'success', '礼物任务完成状态应保持成功');
    assert(runtime.audit.cache.placement_count === 0, '礼物任务不得被截成正文 placement');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testDisabledDuringManualRequestSkipsLateResult(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    assert(handlers.onEditPrompt, '真实 placement 必须提供提示词重绘入口');
    mocks.holdNextRequest();
    let submitted = false;
    const redraw = Promise.resolve(submitPromptEdit(handlers, placement, () => (submitted = true)));
    await waitFor(() => submitted && mocks.requestCount === 2, '手动重绘应先确认提交并进入图片请求等待');
    runtime.updateSettings(testSettings(false));
    assert(mocks.lastRequestSignal?.aborted === true, '关闭开关应取消进行中的手动图片请求');
    mocks.releaseResponse();
    await redraw;

    assert(mocks.requestCount === 2, '关闭开关后不得补发或重试图片 API');
    assert(runtime.recentImages.value.length === 1, '关闭开关不得清除已经存在的旧图片版本');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testDisabledWhilePromptEditorOpenSkipsRequest(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    assert(handlers.onEditPrompt, '真实 placement 必须提供提示词重绘入口');
    mocks.holdPromptEditor();
    let submitted = false;
    const editing = Promise.resolve(submitPromptEdit(handlers, placement, () => (submitted = true)));
    await waitFor(() => mocks.lastPromptEditorSignal !== null, '编辑器应收到 runtime 生命周期 signal');

    runtime.updateSettings(testSettings(false));
    assert(mocks.lastPromptEditorSignal?.aborted === true, '关闭开关应关闭未确认的提示词编辑器');
    mocks.releasePromptEditor();
    await editing;

    assert(submitted === false, '未确认的编辑不得通知 renderer 进入生成态');
    assert(mocks.requestCount === 1, '编辑器等待期间关闭不得发起图片 API 请求');
    runtime.stop();
  } finally {
    mocks.releasePromptEditor();
    mocks.restore();
  }
}

async function testSwipeAbortsUnconfirmedPromptEditor(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    assert(handlers.onEditPrompt, '真实 placement 必须提供提示词重绘入口');
    mocks.holdPromptEditor();
    let submitted = false;
    const editing = Promise.resolve(submitPromptEdit(handlers, placement, () => (submitted = true)));
    await waitFor(() => mocks.lastPromptEditorSignal !== null, '编辑器应收到 runtime 生命周期 signal');

    mocks.message.swipe_id = 1;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    assert(mocks.lastPromptEditorSignal?.aborted === true, '切换 Swipe 应关闭未确认的提示词编辑器');
    mocks.releasePromptEditor();
    await editing;

    assert(submitted === false, '未确认的编辑不得通知 renderer 进入生成态');
    assert(mocks.requestCount === 1, '未确认的编辑不得发起图片 API 请求');
    runtime.stop();
  } finally {
    mocks.releasePromptEditor();
    mocks.restore();
  }
}

function continuitySettings(id = 'A', enabled = true): StoryImageSettings {
  const settings = testSettings(true);
  settings.drawingPresets = [{ id, name: id, instructionText: enabled ? '上一镜头 {{xx_pic}}' : '普通配图' }];
  settings.currentDrawingPresetId = id;
  settings.outputPresets[0].templateText = enabled ? '上一镜头 {{xx_pic}}；当前 {{xx}}' : '{{xx}}';
  settings.outputPresets[0].usePreviousStoryImage = enabled;
  settings.apiProfiles[0].requestMode = 'json-reference';
  settings.recentImageLimit = 50;
  return settings;
}

async function appendContinuityMessage(mocks: ReturnType<typeof installRuntimeMocks>, text: string): Promise<number> {
  const messageId = mocks.chat.length;
  await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
  mocks.chat.push({ message_id: messageId, role: 'assistant', swipe_id: 0, message: text });
  await mocks.emit(eventNames.MESSAGE_RECEIVED, messageId, 'normal');
  return messageId;
}

async function testContinuityCombinationAndSharedSnapshot(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    assert(placement.continuity?.drawingPresetId === 'A', '初始图片记录生成开始的组合');
    runtime.updateSettings(continuitySettings('B'));
    await appendContinuityMessage(mocks, '<pic prompt="B1">');
    await waitFor(() => runtime.audit.generation.status === 'success', 'B1 完成');
    assert(mocks.processedPromptInputs.at(-1)?.[2]?.previousShotPrompt === '', 'B1 不得引用 A1');
    await appendContinuityMessage(mocks, '<pic prompt="B2">');
    await waitFor(() => runtime.audit.generation.status === 'success', 'B2 完成');
    assert(mocks.processedPromptInputs.at(-1)?.[2]?.previousShotPrompt === 'B1', 'B2 必须延续 B1');
    runtime.updateSettings(continuitySettings('A'));
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    assert(mocks.injections.at(-1)?.[0].content.includes('initial prompt'), '正文注入引用 A1 镜头');
    const lockedSource = runtime.audit.continuity.source?.placementId;
    runtime.updateSettings(continuitySettings('C'));
    const messageId = mocks.chat.length;
    mocks.chat.push({
      message_id: messageId,
      role: 'assistant',
      swipe_id: 0,
      message: '<pic prompt="A2 first">\n<pic prompt="A2 second">',
    });
    await mocks.emit(eventNames.MESSAGE_RECEIVED, messageId, 'normal');
    await waitFor(() => runtime.audit.generation.status === 'success', 'A2 双图完成');
    const pair = mocks.processedPromptInputs.slice(-2);
    assert(
      pair.every(input => input[2]?.previousShotPrompt === 'initial prompt'),
      '同楼两任务共用 A1 镜头快照',
    );
    assert(pair[0][2]?.previousStoryImage === pair[1][2]?.previousStoryImage, '同楼两任务共用同一参考图');
    const latest = mocks.renderCalls.at(-1)?.placements.filter(item => item.target.messageId === messageId) ?? [];
    assert(
      latest.length === 2 && latest.every(item => item.continuity?.drawingPresetId === 'A'),
      '生成中切预设不改变图片组合',
    );
    assert(lockedSource === placement.id && mocks.requestCount === 5, 'A2 回到 A1，且没有额外模型调用');
    assert(
      runtime.audit.continuity.reference_count === 1 &&
        runtime.audit.continuity.reference_kinds[0] === 'previous-story-image',
      '审计只记录实际引用种类和数量',
    );
    await waitFor(() => runtime.audit.continuity.status === 'released', '双任务结束释放快照');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testContinuityDeletionDuringRequest(enabled: boolean): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(
      mocks,
      continuitySettings('A', enabled),
    );
    mocks.holdNextRequest();
    await appendContinuityMessage(mocks, '<pic prompt="next">');
    await waitFor(() => mocks.requestCount === 2, '下一楼请求已经发出');
    const signal = mocks.lastRequestSignal;
    await handlers.onDelete?.(placement);
    assert(signal?.aborted === enabled, '只有实际消费连续性时源删除才取消请求');
    mocks.releaseResponse();
    await waitFor(() => runtime.status.value !== 'generating', '迟到响应结算');
    const latest = mocks.renderCalls.at(-1)?.placements.filter(item => item.target.messageId === 1) ?? [];
    assert(enabled ? latest.length === 0 : latest.length === 1, '失效快照丢弃迟到结果，普通生图不受影响');
    assert(mocks.requestCount === 2, '删除不得补跑或自动重试');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testContinuityManualPromptKeepsCombo(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    await appendContinuityMessage(mocks, '<pic prompt="second scene">');
    await waitFor(() => runtime.audit.generation.status === 'success', '第二楼完成');
    const latest = mocks.renderCalls.at(-1);
    const placement = latest?.placements.find(item => item.target.messageId === 1);
    assert(placement && latest?.handlers, '第二楼有编辑入口');
    runtime.updateSettings(continuitySettings('B'));
    await submitPromptEdit(latest.handlers, placement, () => undefined);
    const edited = mocks.renderCalls
      .at(-1)
      ?.placements.find(item => item.target.messageId === 1 && item.revisionIndex === 1);
    assert(edited?.continuity?.drawingPresetId === 'A', '手动改提示词保留原图组合');
    assert(edited?.continuity?.shotPrompt === 'revised\nprompt', '手动改提示词更新镜头描述');
    assert(mocks.lastPromptEditorInput?.previousShotPrompt === 'initial prompt', '编辑器预览使用原图组合前镜头');
    assert(
      mocks.lastPromptEditorInput?.referenceSelection?.known === true &&
        mocks.lastPromptEditorInput.referenceSelection.useAvatarReferences === false &&
        mocks.lastPromptEditorInput.referenceSelection.usePreviousStoryImage === true,
      '编辑器参考默认值应来自当前版本实际使用的上一镜头图',
    );
    const postedBody = JSON.parse(String(mocks.imagePosts.at(-1)?.init.body));
    const previewSources = mocks.lastPromptEditorInput?.referenceSources ?? [];
    const previewValues = promptEditor
      .selectPromptEditorReferenceSources(previewSources, mocks.lastPromptEditorInput?.referenceSelection)
      .map(source => source.value);
    const postedValues = Array.isArray(postedBody.images) ? postedBody.images : [];
    assert(JSON.stringify(postedValues) === JSON.stringify(previewValues), '编辑器预览和执行使用同一参考快照');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testGenerationEndedBeforeMessageReceivedUsesOneReply(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const runtime = createStoryImageRuntime();
    runtime.updateSettings(testSettings(true));
    runtime.start();

    mocks.chat.push({ message_id: 1, role: 'user', message: 'scene', swipe_id: 0 });
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    mocks.chat.push({
      message_id: 2,
      role: 'assistant',
      message: '<content>正文\n<pic prompt="ended first">\n</content>',
      swipe_id: 0,
    });

    // SillyTavern emits GENERATION_ENDED with chat.length before MESSAGE_RECEIVED.
    await mocks.emit(eventNames.GENERATION_ENDED, 3);
    await waitFor(() => mocks.requestCount === 1, '结束事件先到时仍应消费最终助手消息并只请求一次');
    await waitFor(() => runtime.audit.generation.status === 'success', '结束事件先到时应收束 generation 审计');

    await mocks.emit(eventNames.MESSAGE_RECEIVED, 2, 'normal');
    assert(mocks.requestCount === 1, '后续 MESSAGE_RECEIVED 不得重复启动图片任务');
    assert(runtime.audit.markers.valid_count === 1, '结束事件兜底应记录原始正文标记');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testContinuityLifecycleRelease(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    await waitFor(() => runtime.audit.continuity.active_snapshots === 0, '初始任务释放快照');
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    assert(runtime.audit.continuity.active_snapshots === 1, '正文开始同步持有快照');
    await mocks.emit(eventNames.GENERATION_ENDED, 0);
    assert(Number(runtime.audit.continuity.active_snapshots) === 0, '无 MESSAGE_RECEIVED 的结束也必须释放');
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.GENERATION_STOPPED);
    assert(Number(runtime.audit.continuity.active_snapshots) === 0, '停止正文释放快照');
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    mocks.message.message = '没有生图标记';
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'normal');
    await waitFor(() => runtime.audit.continuity.active_snapshots === 0, '无标记正常结束释放快照');
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    runtime.updateSettings({ ...continuitySettings(), enabled: false });
    assert(Number(runtime.audit.continuity.active_snapshots) === 0, '关闭脚本释放快照');
    runtime.updateSettings(continuitySettings());
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    await mocks.emit(eventNames.CHAT_CHANGED, 'another-chat');
    assert(Number(runtime.audit.continuity.active_snapshots) === 0, '切聊天释放快照');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testContinuityGiftAndPendingFallback(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    const giftSettings = continuitySettings();
    giftSettings.displaySettings.displayMode = 'gift';
    runtime.updateSettings(giftSettings);
    await appendContinuityMessage(mocks, '<pic prompt="gift scene">');
    await waitFor(() => runtime.audit.generation.status === 'success', '礼物完成');
    assert(mocks.processedPromptInputs.at(-1)?.[2]?.previousShotPrompt === undefined, '礼物不消费镜头文字');
    assert(mocks.processedPromptInputs.at(-1)?.[2]?.previousStoryImage === undefined, '礼物不消费连续图');
    runtime.updateSettings(continuitySettings());
    mocks.holdNextRequest();
    await appendContinuityMessage(mocks, '<pic prompt="slow inline">');
    await waitFor(() => mocks.requestCount === 3, '中间楼仍请求中');
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    assert(runtime.audit.continuity.source?.placementId === placement.id, '礼物和未完成图片不抢占已有前镜头');
    const messageId = mocks.chat.length;
    mocks.chat.push({
      message_id: messageId,
      role: 'assistant',
      swipe_id: 0,
      message: '<pic prompt="without waiting">',
    });
    await mocks.emit(eventNames.MESSAGE_RECEIVED, messageId, 'normal');
    await waitFor(() => mocks.requestCount === 4, '新楼不等待上一楼图片');
    assert(mocks.processedPromptInputs.at(-1)?.[2]?.previousShotPrompt === 'initial prompt', '新楼沿用更早有效镜头');
    mocks.releaseResponse();
    await waitFor(() => runtime.audit.continuity.active_snapshots === 0, '两楼完成都释放');
    assert(mocks.requestCount === 4, '迟到图不补跑新楼');
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testContinuitySelectedSwipeAndMiddleRevision(): Promise<void> {
  const mocks = installRuntimeMocks();
  const renderer = messageRenderer as unknown as {
    getSelectedImagePlacements: typeof messageRenderer.getSelectedImagePlacements;
  };
  const originalSelect = renderer.getSelectedImagePlacements;
  try {
    const { runtime } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    mocks.message.swipes = ['original'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<pic prompt="swipe one">';
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(() => runtime.audit.generation.status === 'success', 'Swipe 1 完成');
    const first = mocks.renderCalls.at(-1)?.placements.find(item => item.target.swipeId === 1);
    const handlers = mocks.renderCalls.at(-1)?.handlers;
    assert(first && handlers, 'Swipe 1 重绘入口');
    await submitPromptEdit(handlers, first, () => undefined);
    await submitPromptEdit(handlers, first, () => undefined);
    const middle = mocks.renderCalls
      .at(-1)
      ?.placements.find(item => item.target.swipeId === 1 && item.revisionIndex === 1);
    assert(middle, '两次重绘提供中间版本');
    // Renderer contract: this is the exact currently displayed selected revision.
    renderer.getSelectedImagePlacements = placements =>
      originalSelect(placements).map(item =>
        item.target.messageId === 0 && item.target.swipeId === 1
          ? (placements.find(candidate => candidate.id === middle.id) ?? item)
          : item,
      );
    mocks.holdNextRequest();
    await appendContinuityMessage(mocks, '<pic prompt="next shot">');
    await waitFor(() => mocks.requestCount === 5, '下一楼 API 已启动');
    assert(runtime.audit.continuity.source?.placementId === middle.id, '选择当前 Swipe 中间版本而非最新重绘');
    mocks.message.swipe_id = 0;
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    assert(mocks.lastRequestSignal?.aborted === false, '启动后仅切换显示不改变快照');
    mocks.releaseResponse();
    await waitFor(() => runtime.audit.generation.status === 'success', '锁定版本成功完成');
    assert(
      mocks.processedPromptInputs.at(-1)?.[2]?.previousShotPrompt === middle.continuity?.shotPrompt,
      '执行镜头文字与中间版本一致',
    );
    runtime.stop();
  } finally {
    renderer.getSelectedImagePlacements = originalSelect;
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testContinuityRetentionInvalidatesLockedSource(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    await handlers.onPin?.(placement);
    mocks.message.swipes = ['pinned'];
    mocks.message.swipe_id = 1;
    mocks.message.message = '<pic prompt="active swipe">';
    await mocks.emit(eventNames.MESSAGE_SWIPED, 0);
    await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 0, 'swipe');
    await waitFor(() => runtime.audit.generation.status === 'success', '当前 Swipe 图完成');
    await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
    assert(runtime.audit.continuity.source?.swipeId === 1, '锁定当前有效 Swipe，不引用其他分支固定图');
    mocks.chat.push({ message_id: 1, role: 'assistant', swipe_id: 0, message: '<pic prompt="new shot">' });
    await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'normal');
    assert(runtime.audit.continuity.status === 'invalidated', '新楼清理删掉源时必须明确作废快照');
    assert(
      runtime.audit.continuity.active_snapshots === 0 && mocks.requestCount === 2,
      '作废后释放资源，不切换参考也不补跑',
    );
    const retained = mocks.renderCalls.at(-1)?.placements ?? [];
    assert(
      retained.some(item => item.id === placement.id),
      '保持 v0.3.1 的跨 Swipe 固定保留语义',
    );
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testContinuityCapacityEvictionRollsBackPresentation(manual: boolean): Promise<void> {
  const mocks = installRuntimeMocks(true);
  try {
    // Seed the existing tail before startup so this fixture tests capacity eviction,
    // independently of new-tail retention cleanup.
    mocks.chat.push({ message_id: 1, role: 'assistant', swipe_id: 0, message: '' });
    const { runtime, placement: source } = await startRuntimeWithInitialPlacement(
      mocks,
      continuitySettings('A', false),
    );
    for (let index = 0; index < 49; index += 1) {
      mocks.chat[1].message = `<pic prompt="capacity filler ${index}">`;
      await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
      await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'normal');
      await waitFor(() => runtime.audit.generation.status === 'success', '容量填充任务完成');
    }
    assert(runtime.recentImages.value.length === 50, '前镜头与 49 个版本恰好达到缓存上限');
    const beforeIds = new Set(runtime.recentImages.value.map(image => image.id));
    runtime.updateSettings(continuitySettings());
    if (manual) {
      const lastRender = mocks.renderCalls.at(-1);
      const target = lastRender?.placements.find(item => item.target.messageId === 1);
      assert(target && lastRender?.handlers, '容量测试手动编辑入口');
      await submitPromptEdit(lastRender.handlers, target, () => undefined);
    } else {
      mocks.chat[1].message = '<pic prompt="must roll back">';
      await mocks.emit(eventNames.GENERATION_STARTED, 'swipe', null, false);
      assert(runtime.audit.continuity.source?.placementId === source.id, 'Swipe 锁定前楼最旧来源');
      await mocks.emit(eventNames.MESSAGE_RECEIVED, 1, 'swipe');
    }
    await waitFor(() => runtime.audit.continuity.active_snapshots === 0, '同步淘汰来源后释放快照');
    assert(runtime.audit.continuity.source?.placementId === source.id, '普通与手动请求均使用被淘汰前镜头');
    assert(runtime.audit.continuity.status === 'invalidated', 'present 插入第 51 张时源淘汰明确作废');
    const expectedRetainedCount = manual ? 50 : 49;
    assert(
      Number(runtime.recentImages.value.length) === expectedRetainedCount,
      manual ? '纯文本手动重绘不应因未使用的上一图被取消' : '源与本轮新结果都被移除',
    );
    assert(
      runtime.audit.cache.artifact_count === expectedRetainedCount &&
        runtime.audit.cache.placement_count === expectedRetainedCount,
      '容量处理后缓存审计必须同步实际数量',
    );
    if (manual) {
      assert(
        runtime.recentImages.value.some(image => !beforeIds.has(image.id)),
        '纯文本手动重绘应保留本轮新 artifact',
      );
    } else {
      assert(
        runtime.recentImages.value.every(image => beforeIds.has(image.id)),
        '自动任务不得保留作废请求的新 artifact',
      );
    }
    assert(mocks.pendingHosts.size === 0, '回滚结束即清除等待占位，不依赖其他 MESSAGE_UPDATED 重绘');
    assert(runtime.audit.generation.status !== 'running', '容量作废的自动与手动任务均结算 generation 审计');
    await mocks.emit(eventNames.MESSAGE_UPDATED, 1);
    const remaining = mocks.renderCalls.at(-1)?.placements ?? [];
    assert(remaining.length === expectedRetainedCount, '容量处理后的聊天渲染数量应与缓存一致');
    if (manual) {
      assert(
        remaining.some(item => !beforeIds.has(item.artifactId)),
        '纯文本手动重绘的 placement 应继续显示',
      );
    } else {
      assert(
        remaining.every(item => beforeIds.has(item.artifactId)),
        '自动任务渲染不能保留作废请求的新 placement',
      );
    }
    assert(mocks.requestCount === 51, '容量作废不得重试或重新选择来源');
    runtime.stop();
  } finally {
    mocks.restore();
  }
}

async function testCancelledManualRevisionSettlesAudit(preserveNewer: boolean): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement: source } = await startRuntimeWithInitialPlacement(mocks, continuitySettings());
    await appendContinuityMessage(mocks, '<pic prompt="second scene">');
    await waitFor(() => runtime.audit.generation.status === 'success', '第二楼完成');
    const rendered = mocks.renderCalls.at(-1);
    const target = rendered?.placements.find(placement => placement.target.messageId === 1);
    assert(target && rendered?.handlers, '第二楼编辑入口');
    mocks.holdNextRequest();
    const pending = submitPromptEdit(rendered.handlers, target, () => undefined);
    await waitFor(() => mocks.requestCount === 3, '手动编辑停在图片请求');
    runtime.removeRecentImage(source.artifactId);
    let nextGeneration: string | null = null;
    if (preserveNewer) {
      await mocks.emit(eventNames.GENERATION_STARTED, 'normal', null, false);
      nextGeneration = runtime.audit.generation.id;
      // A newer generation's error must not be cleared by the old cancellation.
      runtime.audit.last_error = 'newer synthetic error';
    }
    mocks.releaseResponse();
    await pending;
    assert(mocks.requestCount === 3, '手动引用失效后不得重试或新增请求');
    if (preserveNewer) {
      assert(
        runtime.audit.generation.id === nextGeneration && runtime.audit.generation.status === 'running',
        '旧任务取消不能覆盖新 generation',
      );
      assert(runtime.audit.last_error === 'newer synthetic error', '旧任务取消不能清理新错误');
    } else {
      assert(
        runtime.audit.generation.status === 'pending' && runtime.audit.generation.id === null,
        '手动早退必须结算为 cancelled 的 pending 审计',
      );
      assert(
        runtime.audit.continuity.status === 'invalidated' && runtime.audit.continuity.active_snapshots === 0,
        '失效引用释放并保留审计证据',
      );
    }
    runtime.stop();
  } finally {
    mocks.releaseResponse();
    mocks.restore();
  }
}

async function testReferenceFallbackAndEditorFrozenProfile(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const initialSettings = continuitySettings();
    initialSettings.outputPresets[0].useAvatarReferences = true;
    const { runtime } = await startRuntimeWithInitialPlacement(mocks, initialSettings);
    const settings = continuitySettings();
    settings.outputPresets[0].useAvatarReferences = true;
    settings.outputPresets[0].templateText = '{{reference_sources}}\n{{xx}}';
    runtime.updateSettings(settings);
    mocks.failPersonaReference();
    await appendContinuityMessage(mocks, '<pic prompt="with remaining references">');
    await waitFor(() => runtime.audit.generation.status === 'success', '头像缺失仍使用可用引用完成');
    const automaticBody = JSON.parse(String(mocks.imagePosts.at(-1)?.init.body));
    assert(mocks.requestCount === 2 && automaticBody.images.length === 2, '404 用户头像不阻止唯一图片请求');
    assert(
      automaticBody.prompt.includes('图1：角色头像') && automaticBody.prompt.includes('图2：上一镜头参考图'),
      '实际请求按剩余来源重新编号',
    );
    assert(runtime.audit.continuity.reference_count === 2, '审计记录实际引用数');
    const lastRender = mocks.renderCalls.at(-1);
    const target = lastRender?.placements.find(item => item.target.messageId === 1);
    assert(target && lastRender?.handlers, '可编辑第二楼');
    mocks.holdPromptEditor();
    const pending = submitPromptEdit(lastRender.handlers, target, () => undefined);
    await waitFor(
      () => (mocks.lastPromptEditorInput?.referenceSources?.length ?? 0) === 2,
      '参考开关确认后应完成实际引用准备',
    );
    const readsAtPreview = mocks.referenceReadCount;
    const previewSources = mocks.lastPromptEditorInput?.referenceSources;
    assert(
      previewSources?.map(source => source.kind).join(',') === 'character-avatar,previous-story-image',
      '编辑器不显示不可用头像',
    );
    const changedSettings = continuitySettings();
    changedSettings.apiProfiles[0].serviceUrl = 'https://changed.test/images/edits';
    changedSettings.apiProfiles[0].requestMode = 'multipart-edit';
    runtime.updateSettings(changedSettings);
    mocks.releasePromptEditor();
    await pending;
    assert(
      runtime.audit.continuity.reference_count === 2 &&
        runtime.audit.continuity.reference_kinds.join(',') === 'character-avatar,previous-story-image',
      '手动预览审计记录实际可用来源',
    );
    const posted = mocks.imagePosts.at(-1);
    const postedBody = JSON.parse(String(posted?.init.body));
    assert(posted?.url === settings.apiProfiles[0].serviceUrl, '编辑确认使用打开时锁定 API 配置');
    assert(mocks.referenceReadCount === readsAtPreview, '确认后不重读预览来源');
    assert(
      JSON.stringify(postedBody.images) === JSON.stringify(previewSources.map(source => source.value)),
      '预览与实际请求引用完全相同',
    );
    assert(Number(mocks.requestCount) === 3, '编辑确认只请求一次生图 API');
    runtime.stop();
  } finally {
    mocks.releasePromptEditor();
    mocks.restore();
  }
}

async function testPromptEditorReferencePreparationErrorIsReported(): Promise<void> {
  const mocks = installRuntimeMocks();
  const resolver = referenceResolution as unknown as {
    materializeReferenceSources: typeof referenceResolution.materializeReferenceSources;
  };
  const original = resolver.materializeReferenceSources;
  try {
    const settings = continuitySettings();
    settings.outputPresets[0].useAvatarReferences = true;
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks, settings);
    resolver.materializeReferenceSources = async () => {
      throw new Error('timeout https://private.test/path synthetic-key');
    };
    await submitPromptEdit(handlers, placement, () => undefined);
    assert(mocks.lastPromptEditorInput !== null && mocks.requestCount === 1, '编辑器应先打开且不发起生图请求');
    assert(
      runtime.audit.last_error === '参考图准备失败，请稍后再试。' && runtime.status.value === 'error',
      '预览前失败必须提供有界错误提示',
    );
    assert(runtime.audit.continuity.active_snapshots === 0, '预览失败释放快照');
    runtime.stop();
  } finally {
    resolver.materializeReferenceSources = original;
    mocks.restore();
  }
}

void (async () => {
  await testPromptEditorReferencePreparationErrorIsReported();
  await testReferenceFallbackAndEditorFrozenProfile();
  await testPlacementKeepsFinalPromptOnReopen();
  await testCancelledManualRevisionSettlesAudit(false);
  await testCancelledManualRevisionSettlesAudit(true);
  await testContinuityCapacityEvictionRollsBackPresentation(false);
  await testContinuityCapacityEvictionRollsBackPresentation(true);
  await testContinuityRetentionInvalidatesLockedSource();
  await testContinuitySelectedSwipeAndMiddleRevision();
  await testGenerationEndedBeforeMessageReceivedUsesOneReply();
  await testContinuityLifecycleRelease();
  await testContinuityGiftAndPendingFallback();
  await testContinuityCombinationAndSharedSnapshot();
  await testContinuityDeletionDuringRequest(true);
  await testContinuityDeletionDuringRequest(false);
  await testContinuityManualPromptKeepsCombo();
  await testSwipeGenerationUsesMessageSwipedTarget();
  await testPromptEditorUsesPresetAndAvatarSnapshot();
  await testSwipeTaskSurvivesDisplaySwitches();
  await testDeferredTaskSwipeDeletionMigratesRetentionScope();
  await testSwipeKeepsManualRevisionOnOriginalSwipe();
  await testDeletingOnePlacementKeepsAnotherRedrawAlive();
  await testPinPrunesOnlyItsImagePositionAndBlocksLateRedraw();
  await testNewTailRetainsPendingPreviousFloorOnce();
  await testStreamingAssistantTailTriggersAdvanceCleanup();
  await testNonFloorAssistantEventTypesDoNotAdvanceCleanup();
  await testNewTailPrunesPreviousFloorAcrossSwipesOnly();
  await testLatestManualPinWinsAcrossSwipesOnAdvance();
  await testMessageDeletionReconcilesByRawIdentity();
  await testNewTailDoesNotCancelGiftTask();
  await testDisabledDuringManualRequestSkipsLateResult();
  await testDisabledWhilePromptEditorOpenSkipsRequest();
  await testSwipeAbortsUnconfirmedPromptEditor();
  console.info('<杠杠の生图机> runtime regression tests passed');
})();
