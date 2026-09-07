import * as messageRenderer from '../src/杠杠の生图机/message-renderer';
import * as promptEditor from '../src/杠杠の生图机/prompt-editor';
import * as promptProcessor from '../src/杠杠の生图机/prompt-processor';
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

function installRuntimeMocks() {
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
  let requestCount = 0;
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

  const renderer = messageRenderer as unknown as { renderMessagePlacements: RenderMessagePlacements };
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
    const result = { prompt: '  revised\nprompt  ', outputPreset: { ...input.outputPreset } };
    if (!holdPromptEditor) return Promise.resolve(result);
    return new Promise<typeof result | null>(resolve => {
      releasePromptEditor = () => resolve(result);
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
    const chat = (
      globals.SillyTavern as { chat?: Array<{ swipes?: unknown[]; swipe_id?: number }> }
    ).chat ?? [];
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
  globals.injectPrompts = () => ({ uninject: () => undefined });
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
  const renderCall = [...mocks.renderCalls].reverse().find(call => call.messageId === 0 && call.placements.length === 1);
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
    await waitFor(() => mocks.processedPromptInputs.length === 2, '确认后应加工一次重绘场景描述');
    await waitFor(() => runtime.recentImages.value.length === 2, '确认后应沿同一快照请求图片');
    await redraw;
    assert(mocks.requestCount > initialRequestCount, '确认重绘后应发起图片请求');

    const editorInput = mocks.lastPromptEditorInput;
    assert(editorInput?.outputPreset.name === 'output', '弹窗应显示当前出图预设名称');
    assert(editorInput?.outputPreset.templateText === '{{xx}}', '弹窗应显示当前出图模板');
    assert(editorInput?.avatarReferences.enabled === true, '弹窗头像状态应遵循当前出图预设配置');
    assert(
      editorInput?.avatarReferences.availableSources.join(',') === 'persona,character',
      '弹窗头像状态应区分并显示当前用户和角色头像',
    );

    const processed = mocks.processedPromptInputs.at(-1);
    assert(processed?.[0].useAvatarReferences === true, '请求应复用弹窗确认时的头像配置');
    assert(processed?.[1] === 'revised\nprompt', '请求应接收原始场景描述而不是最终模板文本');
    const references = await processed?.[2]?.readReferences?.();
    assert(references?.references.length === 2, '请求应复用弹窗读取到的两个头像快照');
    assert(settings.outputPresets[0].templateText === '{{xx}}', '临时重绘配置不得修改全局出图预设');
    runtime.stop();
  } finally {
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

    const completedRender = [...mocks.renderCalls].reverse().find(call =>
      call.placements.some(item => item.target.messageId === 0 && item.target.swipeId === 1),
    );
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
      () =>
        runtime.recentImages.value.filter(image => image.messageId === 0 && image.swipeId === 1).length === 2,
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
    const revised = revisedRender?.placements.find(
      item => item.target.imageIndex === 0 && item.revisionIndex === 1,
    );
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
    assert(
      runtime.recentImages.value.length === 2,
      'MESSAGE_RECEIVED 的 swipe 类型不得被当作新正文楼层清理上一楼版本',
    );

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

    const swipeOneRender = [...mocks.renderCalls].reverse().find(call =>
      call.placements.some(item => item.target.swipeId === 1),
    );
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
    const lastRender = [...mocks.renderCalls].reverse().find(call =>
      call.placements.some(item => item.target.messageId === 2),
    );
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

async function testDisabledDuringPromptProcessingSkipsRequest(): Promise<void> {
  const mocks = installRuntimeMocks();
  try {
    const { runtime, placement, handlers } = await startRuntimeWithInitialPlacement(mocks);
    assert(handlers.onEditPrompt, '真实 placement 必须提供提示词重绘入口');
    mocks.holdNextPromptProcessing();
    let submitted = false;
    const redraw = Promise.resolve(submitPromptEdit(handlers, placement, () => (submitted = true)));
    await waitFor(
      () => submitted && mocks.processingStarted,
      '手动重绘应先确认提交并进入提示词加工等待',
    );
    runtime.updateSettings(testSettings(false));
    mocks.releasePromptProcessing();
    await redraw;

    assert(mocks.requestCount === 1, '关闭开关后，等待中的提示词加工不得进入图片 API');
    assert(runtime.recentImages.value.length === 1, '关闭开关不得清除已经存在的旧图片版本');
    runtime.stop();
  } finally {
    mocks.releasePromptProcessing();
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

void (async () => {
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
  await testDisabledDuringPromptProcessingSkipsRequest();
  await testDisabledWhilePromptEditorOpenSkipsRequest();
  await testSwipeAbortsUnconfirmedPromptEditor();
  console.info('<杠杠の生图机> runtime regression tests passed');
})();
