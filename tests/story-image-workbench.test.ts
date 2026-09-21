/* eslint-disable import-x/no-nodejs-modules -- Node-only SFC component test, never bundled into the browser. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createRenderer, markRaw, nextTick, reactive, ref, type Component } from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import type { WorkbenchShot } from '../src/杠杠の生图机/workbench-types';

// Mount the actual SFC in Vue's renderer. No browser, persisted state or image API is involved.
const load = createRequire(path.resolve(process.cwd(), 'package.json'));
const settings = reactive({ enabled: true });
const componentPath = path.resolve('src/杠杠の生图机/StoryImageWorkbench.vue');
const { descriptor } = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath });
const script = compileScript(descriptor, { id: 'story-workbench-test', inlineTemplate: true });
const code = transpileModule(script.content, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
}).outputText;
const moduleResult: { exports: { default?: Component } } = { exports: {} };
runInNewContext(code, {
  module: moduleResult,
  exports: moduleResult.exports,
  require: (id: string) => (id === './settings' ? { useStoryImageSettingsStore: () => ({ settings }) } : load(id)),
  toastr: {
    error: () => {
      throw new Error('Unexpected UI error');
    },
  },
});
assert.ok(moduleResult.exports.default);

let allowConfirm = false;
let confirmations = 0;
const focusState: { current: FakeNode | null } = { current: null };
const documentListeners = new Map<string, unknown>();
const windowListeners = new Map<string, unknown>();
let observedResize: (() => void) | null = null;
let observerDisconnected = false;
let inputRect = { top: 800, height: 100 };
const hostWindow = {
  innerHeight: 900,
  ResizeObserver: class {
    constructor(callback: () => void) {
      observedResize = callback;
    }
    observe() {}
    disconnect() {
      observerDisconnected = true;
    }
  },
  confirm: () => {
    confirmations += 1;
    return allowConfirm;
  },
  addEventListener: (name: string, fn: unknown) => windowListeners.set(name, fn),
  removeEventListener: (name: string) => windowListeners.delete(name),
};
const hostDocument = {
  defaultView: hostWindow,
  getElementById: (id: string) => (id === 'send_form' ? { getBoundingClientRect: () => inputRect } : null),
  addEventListener: (name: string, fn: unknown) => documentListeners.set(name, fn),
  removeEventListener: (name: string) => documentListeners.delete(name),
};

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  props: Record<string, unknown> = {};
  text = '';
  ownerDocument = hostDocument;
  constructor(readonly tag: string) {
    markRaw(this);
  }
  get isConnected() {
    return this.parent !== null;
  }
  focus() {
    focusState.current = this;
  }
  contains(node: FakeNode): boolean {
    return node === this || this.children.some(child => child.contains(node));
  }
}

const renderer = createRenderer<FakeNode, FakeNode>({
  patchProp: (node, key, _previous, value) => {
    node.props[key] = value;
  },
  insert: (node, parent, anchor = null) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(node);
    else parent.children.splice(index, 0, node);
  },
  remove: node => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  },
  createElement: tag => new FakeNode(tag),
  createText: text => Object.assign(new FakeNode('#text'), { text }),
  createComment: text => Object.assign(new FakeNode('#comment'), { text }),
  setText: (node, text) => {
    node.text = text;
  },
  setElementText: (node, text) => {
    node.text = text;
    node.children = [];
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});

const shot: WorkbenchShot = {
  id: 'chat-a:10:0:0',
  chatId: 'chat-a',
  messageId: 10,
  swipeId: 0,
  imageIndex: 0,
  basePlacementId: 'base',
  confirmedPlacementId: null,
  shotPrompt: '原镜头',
  pendingCount: 0,
  status: 'unconfirmed',
  images: [
    { id: 'base', url: 'blob:base', prompt: '原镜头', variantIndex: 0, revisionIndex: 0 },
    { id: 'candidate', url: 'blob:candidate', prompt: '新镜头', variantIndex: 0, revisionIndex: 1 },
  ],
};
const workbenchShots = ref([shot]);
const calls: string[] = [];
const runtime = {
  workbenchShots,
  confirmWorkbenchImage: (id: string) => calls.push(`confirm:${id}`),
  abandonWorkbenchShot: (id: string) => calls.push(`abandon:${id}`),
  removeWorkbenchImage: (id: string) => calls.push(`remove:${id}`),
  editWorkbenchImage: async (id: string) => {
    calls.push(`edit:${id}`);
  },
  redrawWorkbenchImage: async (id: string) => {
    calls.push(`redraw:${id}`);
  },
  jumpToWorkbenchShot: (id: string) => calls.push(`jump:${id}`),
};
const container = new FakeNode('root');
const app = renderer.createApp(moduleResult.exports.default, { runtime });
app.mount(container);

function all(node: FakeNode = container): FakeNode[] {
  return [node, ...node.children.flatMap(child => all(child))];
}
function content(node: FakeNode): string {
  return node.tag === '#comment' ? '' : node.text + node.children.map(content).join('');
}
function button(label: string): FakeNode {
  const result = all().find(
    node => node.tag === 'button' && (content(node).trim() === label || node.props['aria-label'] === label),
  );
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
async function click(node: FakeNode) {
  const handler = node.props.onClick as (event: unknown) => unknown;
  await handler({ currentTarget: node, target: node });
  await nextTick();
}
function candidate(): FakeNode {
  return button('候选 1 · 版本 2 · 待选');
}

async function main() {
  assert.ok(observedResize, 'Input observation must use the host window, not the hidden script frame');
  inputRect = { top: 600, height: 300 };
  observedResize();
  await nextTick();
  assert.equal(
    (all().find(node => node.props.class === 'story-workbench')?.props.style as Record<string, string>)[
      '--story-workbench-bottom'
    ],
    '312px',
    'Input growth must update the reserved viewport inset',
  );
  await click(button('打开或关闭剧情图面板'));
  assert.equal(focusState.current, button('关闭剧情图面板'), 'Opening panel moves focus to close control');
  await click(candidate());
  assert.deepEqual(calls, [], 'Preview must not confirm, change the base, or issue requests');
  assert.equal(workbenchShots.value[0].basePlacementId, 'base');
  assert.equal(candidate().props['aria-pressed'], true);

  workbenchShots.value = [{ ...shot, pendingCount: 1 }];
  await nextTick();
  assert.equal(candidate().props['aria-pressed'], true, 'Task updates must not reset candidate preview');
  await click(button('放大第 10 楼当前预览图'));
  assert.ok(all().some(node => node.props.role === 'dialog'));
  assert.deepEqual(calls, [], 'Opening full image preview must not issue requests');
  const onKeydown = documentListeners.get('keydown') as (event: unknown) => void;
  onKeydown({
    key: 'Escape',
    defaultPrevented: false,
    target: button('关闭大图 ×'),
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  });
  await nextTick();
  assert.ok(!all().some(node => node.props.role === 'dialog'), 'Escape closes full image preview');
  assert.equal(focusState.current, button('放大第 10 楼当前预览图'), 'Closing preview returns focus to image');
  await click(button('确认这张'));
  assert.deepEqual(calls, [], 'Cancel confirmation must preserve all images');
  allowConfirm = true;
  await click(button('确认这张'));
  assert.deepEqual(calls, ['confirm:candidate']);
  assert.equal(confirmations, 2, 'One confirmation per explicit confirmation action');

  settings.enabled = false;
  await nextTick();
  assert.equal(button('修改提示词').props.disabled, true);
  assert.equal(button('区域重绘').props.disabled, true);
  await click(button('修改提示词'));
  assert.deepEqual(calls, ['confirm:candidate'], 'Disabled generation must remain guarded even if called directly');
  assert.equal(
    button('确认这张').props.disabled,
    false,
    'Existing images remain manageable when generation is disabled',
  );

  workbenchShots.value = [];
  await nextTick();
  assert.ok(!all().some(node => node.tag === 'img'), 'Chat scope removal must remove all previous images');

  await click(button('关闭剧情图面板'));
  assert.equal(focusState.current, button('打开或关闭剧情图面板'), 'Closing panel returns focus');
  app.unmount();
  assert.equal(documentListeners.size, 0, 'Unmount removes keyboard listener');
  assert.equal(windowListeners.size, 0, 'Unmount removes resize listener');
  assert.equal(observerDisconnected, true, 'Unmount disconnects the host ResizeObserver');
  console.log('story-image-workbench: preview, confirmation, disabled generation and lifecycle passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
