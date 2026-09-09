import assert from 'node:assert/strict';
import {
  getPromptEditorFocusableElements,
  openImagePromptEditor,
  type ImagePromptEditorInput,
} from '../src/杠杠の生图机/prompt-editor';

type FakeEvent = {
  type: string;
  key?: string;
  shiftKey?: boolean;
  target?: FakeElement;
  preventDefault: () => void;
  stopPropagation: () => void;
};
type FakeListener = (event: FakeEvent) => void;

function requireValue<T>(value: T, message: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
  return value as NonNullable<T>;
}

async function awaitWithTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时`)), 1000);
    }),
  ]);
}

class FakeDocument {
  readonly body = new FakeElement(this);
  readonly defaultView = {
    getComputedStyle: () => ({ display: '', visibility: 'visible' }),
  };
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<FakeListener>>();

  createElement(tag: string): FakeElement {
    const element = new FakeElement(this);
    element.tagName = tag.toUpperCase();
    return element;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(type: string, event: Partial<FakeEvent> = {}): void {
    const dispatched: FakeEvent = {
      type,
      target: this.activeElement ?? undefined,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(dispatched);
  }
}

class FakeElement {
  tagName = 'DIV';
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  inert = false;
  type = '';
  checked = false;
  value = '';
  rows = 0;
  autocomplete = '';
  spellcheck = false;
  tabIndex = 0;
  readonly style = { display: '', visibility: '', pointerEvents: '', aspectRatio: '' };
  readonly children: FakeElement[] = [];
  parent: FakeElement | FakeDocument | null = null;
  readonly ownerDocument: FakeDocument;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<FakeListener>>();

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  get isConnected(): boolean {
    return this.parent !== null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(_selector: string): FakeElement | null {
    return null;
  }

  append(...nodes: FakeElement[]): void {
    nodes.forEach(node => {
      node.parent = this;
      this.children.push(node);
    });
  }

  remove(): void {
    if (this.parent instanceof FakeElement) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    } else if (this.parent instanceof FakeDocument) {
      this.parent.body.children.splice(this.parent.body.children.indexOf(this), 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(type: string, event: Partial<FakeEvent> = {}): void {
    const dispatched: FakeEvent = {
      type,
      target: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(dispatched);
  }

  click(): void {
    this.dispatchEvent('click');
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => {
      if (selector.startsWith('.')) return element.className.split(/\s+/u).includes(selector.slice(1));
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const result: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (matches(element)) result.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return result;
  }
}

function baseInput(overrides: Partial<ImagePromptEditorInput> = {}): ImagePromptEditorInput {
  return {
    prompt: 'scene prompt',
    outputPreset: {
      id: 'output',
      name: 'output',
      templateText: 'prefix {{xx}} suffix',
      useAvatarReferences: false,
      usePreviousStoryImage: false,
    },
    avatarReferences: { enabled: false, availableSources: [], failedSources: [] },
    referenceSources: [],
    referenceSelection: { known: true, useAvatarReferences: false, usePreviousStoryImage: false },
    referenceAvailability: { avatarReferences: false, previousStoryImage: false },
    ...overrides,
  };
}

async function withFakeDocument<T>(run: (ownerDocument: FakeDocument) => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as { document?: unknown; $?: unknown };
  const previousDocument = globals.document;
  const previousDollar = globals.$;
  const ownerDocument = new FakeDocument();
  globals.document = ownerDocument;
  delete globals.$;
  try {
    return await run(ownerDocument);
  } finally {
    if (typeof previousDocument === 'undefined') delete globals.document;
    else globals.document = previousDocument;
    if (typeof previousDollar === 'undefined') delete globals.$;
    else globals.$ = previousDollar;
  }
}

async function testEditedFinalPromptSurvivesReopen(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    const firstOpen = openImagePromptEditor(baseInput());
    const finalPrompt = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__final-textarea'),
      '首次打开应渲染最终提示词输入框',
    );
    const confirm = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__button--primary'),
      '首次打开应渲染确认按钮',
    );
    finalPrompt.value = 'user edited final prompt';
    finalPrompt.dispatchEvent('input');
    confirm.click();
    const firstResult = requireValue(await awaitWithTimeout(firstOpen, '首次编辑'), '编辑最终提示词后应能确认');
    assert.equal(firstResult.prompt, 'user edited final prompt', '提交结果必须保留用户编辑的最终文本');

    const secondOpen = openImagePromptEditor(baseInput({ finalPrompt: firstResult.prompt }));
    const reopenedFinalPrompt = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__final-textarea'),
      '再次打开应渲染最终提示词输入框',
    );
    const cancel = requireValue(
      ownerDocument.body
        .querySelectorAll('.story-image-prompt-editor__button')
        .find(button => button.textContent === '取消'),
      '再次打开应渲染取消按钮',
    );
    assert.equal(
      reopenedFinalPrompt.value,
      'user edited final prompt',
      '再次打开必须优先显示页面内存中保存的最终 API 文本',
    );
    cancel.click();
    assert.equal(await awaitWithTimeout(secondOpen, '第二次编辑关闭'), null, '测试结束应关闭第二次编辑器');
  });
}

async function testDisabledAvatarPreparationDoesNotBlockTextEdit(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    let preparationCalls = 0;
    const neverResolve = (): Promise<never> => new Promise<never>(() => undefined);
    const editor = openImagePromptEditor(
      baseInput({
        referenceSources: [{ kind: 'user-avatar', label: 'User 头像', value: '' }],
        referenceAvailability: { avatarReferences: true, previousStoryImage: false },
        prepareReferenceSources: async (_selection, _signal) => {
          preparationCalls += 1;
          return neverResolve();
        },
      }),
    );
    const confirm = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__button--primary'),
      '未选参考图时应渲染确认按钮',
    );
    assert.equal(preparationCalls, 0, '未启用头像参考时不得启动头像读取或准备');
    confirm.click();
    const result = requireValue(
      await awaitWithTimeout(editor, '未启用参考图的纯文本编辑'),
      '未启用参考图时确认纯文本修改不应等待参考图',
    );
    assert.equal(result.referenceSources?.length, 0, '未启用参考图时提交来源应为空');
  });
}

async function testReferencePreparationCancelsWithEditor(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    const external = new AbortController();
    let preparationSignal: AbortSignal | null = null;
    let preparationCalls = 0;
    const editor = openImagePromptEditor(
      baseInput({
        referenceSources: [{ kind: 'previous-story-image', label: '上一镜头参考图', value: '' }],
        referenceSelection: { known: true, useAvatarReferences: false, usePreviousStoryImage: true },
        referenceAvailability: { avatarReferences: false, previousStoryImage: true },
        prepareReferenceSources: async (_selection, signal) => {
          preparationCalls += 1;
          preparationSignal = signal;
          return new Promise<never>(() => undefined);
        },
        signal: external.signal,
      }),
    );
    assert.equal(preparationCalls, 1, '已启用上一镜头图时应启动一次必要的参考准备');
    assert(ownerDocument.body.querySelector('.story-image-prompt-editor'), '等待参考准备时编辑器仍应可见');
    external.abort();
    assert.equal(await awaitWithTimeout(editor, '参考准备取消'), null, '外部取消应关闭编辑器并取消参考准备');
    const capturedSignal = preparationSignal as AbortSignal | null;
    assert(capturedSignal !== null, '参考准备必须收到取消信号对象');
    assert(capturedSignal.aborted, '关闭编辑器必须让参考准备收到取消信号');
  });
}

async function testSettledReferencePreparationCanBeReused(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    let preparationCalls = 0;
    const editor = openImagePromptEditor(
      baseInput({
        referenceSources: [{ kind: 'user-avatar', label: 'User 头像', value: '' }],
        referenceAvailability: { avatarReferences: true, previousStoryImage: false },
        prepareReferenceSources: async () => {
          preparationCalls += 1;
          return [{ kind: 'user-avatar', label: 'User 头像', value: 'resolved-avatar' }];
        },
      }),
    );
    const toggles = ownerDocument.body.querySelectorAll('.story-image-prompt-editor__reference-toggle');
    const avatarToggle = toggles[0];
    const confirm = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__button--primary'),
      '编辑器应渲染确认按钮',
    );

    avatarToggle.checked = true;
    avatarToggle.dispatchEvent('change');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(preparationCalls, 1, '首次开启头像参考只应读取一次');
    assert(!confirm.disabled, '首次参考准备完成后应恢复确认按钮');

    avatarToggle.checked = false;
    avatarToggle.dispatchEvent('change');
    assert(!confirm.disabled, '关闭头像参考后应可直接确认');
    avatarToggle.checked = true;
    avatarToggle.dispatchEvent('change');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(preparationCalls, 1, '重新开启同一参考组合应复用已完成结果');
    assert(!confirm.disabled, '复用已完成参考结果后仍应恢复确认按钮');

    confirm.click();
    const result = requireValue(await awaitWithTimeout(editor, '复用已完成参考'), '复用参考后应能确认');
    assert.equal(result.referenceSources?.[0]?.value, 'resolved-avatar', '确认应使用已缓存的参考结果');
  });
}

async function testTabIncludesAvailableReferenceToggle(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    const editor = openImagePromptEditor(
      baseInput({
        referenceSources: [{ kind: 'user-avatar', label: 'User 头像', value: '' }],
        referenceAvailability: { avatarReferences: true, previousStoryImage: false },
      }),
    );
    const scene = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__scene-textarea'),
      '编辑器应渲染场景输入框',
    );
    const toggles = ownerDocument.body.querySelectorAll('.story-image-prompt-editor__reference-toggle');
    const finalPrompt = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__final-textarea'),
      '编辑器应渲染最终提示词输入框',
    );
    const clear = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor__clear-final'),
      '编辑器应渲染清空按钮',
    );
    const buttons = ownerDocument.body.querySelectorAll('.story-image-prompt-editor__button');
    assert(toggles.length === 2 && buttons.length === 3, '编辑器参考开关和按钮应完整渲染');
    const avatarToggle = toggles[0];
    const previousToggle = toggles[1];
    assert(!avatarToggle.disabled, '可用头像来源对应的开关必须可聚焦');
    assert(previousToggle.disabled, '不可用上一镜头图对应的开关必须禁用');
    const focusable = getPromptEditorFocusableElements([
      scene as unknown as HTMLElement,
      avatarToggle as unknown as HTMLElement,
      previousToggle as unknown as HTMLElement,
      finalPrompt as unknown as HTMLElement,
      clear as unknown as HTMLElement,
      ...buttons.map(button => button as unknown as HTMLElement),
    ]);
    const avatarElement = avatarToggle as unknown as HTMLElement;
    const previousElement = previousToggle as unknown as HTMLElement;
    assert(focusable.includes(avatarElement), 'Tab 焦点列表必须包含可用的头像参考开关');
    assert(!focusable.includes(previousElement), 'Tab 焦点列表必须排除 disabled 的上一镜头图开关');

    scene.focus();
    ownerDocument.dispatchEvent('keydown', { key: 'Tab' });
    assert.equal(ownerDocument.activeElement, avatarToggle, '从场景框按 Tab 应进入可用的头像开关');
    ownerDocument.dispatchEvent('keydown', { key: 'Tab' });
    assert.equal(ownerDocument.activeElement, finalPrompt, '下一个 Tab 应跳过 disabled 开关');
    const cancel = requireValue(
      buttons.find(button => button.textContent === '取消'),
      '编辑器应提供取消按钮',
    );
    cancel.click();
    assert.equal(await awaitWithTimeout(editor, 'Tab 测试关闭'), null, '测试结束应关闭编辑器');
  });
}

async function run(): Promise<void> {
  await testEditedFinalPromptSurvivesReopen();
  await testDisabledAvatarPreparationDoesNotBlockTextEdit();
  await testReferencePreparationCancelsWithEditor();
  await testSettledReferencePreparationCanBeReused();
  await testTabIncludesAvailableReferenceToggle();
  console.info('story-image prompt editor review tests passed');
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
