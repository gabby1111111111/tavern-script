import {
  cleanInlineImageMessage,
  cleanInlineImageMarkers,
  extractInlineImagePrompts,
  scanInlineImagePrompts,
} from '../src/杠杠の生图机/marker';
import {
  createImageTask,
  deriveGenerationStatus,
  imageTaskKey,
  ImageTaskCache,
  MAX_IMAGE_TASKS,
  type ImageTask,
} from '../src/杠杠の生图机/task-cache';
import { createImageIntent } from '../src/杠杠の生图机/image-system';
import { MAX_RECENT_GENERATED_IMAGES, RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const taskIdentity = { chatId: 'chat-a', messageId: 7, swipeId: 0, imageIndex: 1 };
equal(imageTaskKey(taskIdentity), 'chat-a::7::0::1', '图片任务身份必须包含四元组');
assert(
  imageTaskKey(taskIdentity) !== imageTaskKey({ ...taskIdentity, swipeId: 1 }),
  '不同 swipe 不得复用同一图片任务身份',
);

function makeTask(overrides: Partial<ImageTask> = {}): ImageTask {
  const intent = createImageIntent({
    purpose: 'current',
    chatId: 'chat-a',
    prompt: 'test',
    requestedTarget: {
      kind: 'inline-anchor',
      messageId: 7,
      swipeId: 0,
      imageIndex: 0,
      paragraphIndex: 0,
      anchorTextBefore: '',
      anchorTextAfter: '',
    },
  });
  return {
    chatId: 'chat-a',
    messageId: 7,
    swipeId: 0,
    imageIndex: 0,
    generationId: 'generation-1',
    intent,
    artifactId: null,
    status: 'pending',
    image: null,
    error: null,
    abortController: new AbortController(),
    createdAt: Date.now(),
    paragraphIndex: 0,
    anchorTextBefore: '',
    anchorTextAfter: '',
    ...overrides,
  };
}

equal(deriveGenerationStatus([{ status: 'success' }, { status: 'running' }]), 'running', '仍有任务运行时不能提前成功');
equal(deriveGenerationStatus([{ status: 'success' }, { status: 'failed' }]), 'fail', '任一失败应聚合为失败');
equal(
  deriveGenerationStatus([{ status: 'success' }, { status: 'cancelled' }]),
  'success',
  '全部终态且无失败应聚合为成功',
);

const generationEvictions: ImageTask[] = [];
const generationCache = new ImageTaskCache({ onRemove: task => generationEvictions.push(task) });
let revoked = 0;
const firstGenerationTask = makeTask({
  generationId: 'generation-1',
  image: { url: 'blob:first', kind: 'object-url', revoke: () => revoked++ },
});
generationCache.set(firstGenerationTask);
const secondGenerationTask = makeTask({ generationId: 'generation-2' });
generationCache.set(secondGenerationTask);
assert(generationCache.get(imageTaskKey(firstGenerationTask)) === secondGenerationTask, '新 generation 应替换旧 task');
assert(firstGenerationTask.abortController.signal.aborted, '替换旧 generation 必须 abort 旧 task');
assert(firstGenerationTask.image === null, '替换旧 task 必须释放自己的资源');
equal(revoked, 1, '旧 task 的 object URL 只应释放一次');
assert(generationEvictions.includes(firstGenerationTask), '替换旧 task 应触发移除回调');

const boundedCache = new ImageTaskCache({ onRemove: task => generationEvictions.push(task) });
const boundedTasks = Array.from({ length: MAX_IMAGE_TASKS + 1 }, (_unused, index) => {
  const task = makeTask({ messageId: index + 1, createdAt: index });
  boundedCache.set(task);
  return task;
});
equal(boundedCache.values().length, MAX_IMAGE_TASKS, 'inline cache 必须限制为十个 task');
assert(boundedTasks[0].abortController.signal.aborted, 'inline cache 淘汰必须 abort 最旧 task');
assert(generationEvictions.includes(boundedTasks[0]), 'inline cache 淘汰必须触发移除回调');

const recentCache = new RecentImageCache();
for (let index = 0; index < MAX_RECENT_GENERATED_IMAGES + 1; index += 1) {
  recentCache.add(
    {
      sourceIntentId: `intent-${index}`,
      purpose: 'current',
      origin: 'generated',
      chatId: 'chat-a',
      target: { messageId: index, swipeId: 0, imageIndex: 0 },
    },
    {
      url: `blob:recent-${index}`,
      kind: 'object-url',
      clone: () => ({ url: `blob:recent-${index}-clone`, kind: 'object-url', revoke: () => undefined }),
    },
  );
}
equal(recentCache.images.value.length, MAX_RECENT_GENERATED_IMAGES, 'recent cache 默认必须限制为十张图片');
const recentId = recentCache.images.value[0].id;
assert(recentCache.remove(recentId), 'recent cache 应支持移除加载失败的图片');
assert(!recentCache.images.value.some(image => image.id === recentId), '移除后 recent cache 不应保留破图');

const two = extractInlineImagePrompts('第一段\n\n<pic prompt="one &amp; moon">\n\n第二段 <pic prompt="two">结束');
equal(
  two.map(marker => marker.prompt),
  ['one & moon', 'two'],
  '两个标记按顺序解析',
);
equal(
  two.map(marker => marker.index),
  [0, 1],
  '标记 index 稳定',
);
assert(two[1].paragraphIndex === 2, '第二个标记应落在第二个正文段落之后');
const createdTask = createImageTask(two[0], {
  chatId: 'chat-a',
  messageId: 7,
  swipeId: 0,
  generationId: 'generation-created',
});
assert(createdTask.intent.purpose === 'current', 'inline task 必须携带 current intent');
equal(createdTask.intent.prompt, 'one & moon', 'inline 请求必须从 task intent 读取原提示词');
assert(createdTask.artifactId === null, 'inline task 成功前不得伪造 artifactId');

const truncated = scanInlineImagePrompts('<pic prompt="one"><pic prompt="two"><pic prompt="three"><pic prompt="four">');
equal(truncated.markers.length, 2, '最多处理两个标记');
assert(truncated.truncated, '第三个及之后的有效标记应触发截断标记');
equal(truncated.totalValid, 4, '截断前有效标记数量应可审计');

const codeExample = scanInlineImagePrompts(
  '正文 `<pic prompt="fake">`\n\n```html\n<pic prompt="also fake">\n```\n\n<pic prompt="real">',
);
equal(
  codeExample.markers.map(marker => marker.prompt),
  ['real'],
  '代码块中的伪标记必须忽略',
);

const empty = scanInlineImagePrompts('<pic prompt=""> <pic prompt="  "> <pic prompt="valid">');
equal(
  empty.markers.map(marker => marker.prompt),
  ['valid'],
  '空提示词不能创建任务',
);

const cleaned = cleanInlineImageMarkers('前文 <pic prompt="one"> 后文 `<pic prompt="fake">`');
assert(cleaned.includes('前文  后文'), '显示层清理应移除有效标记');
assert(cleaned.includes('<pic prompt="fake">'), '代码中的伪标记不应被清理');

const cleanedMessage = cleanInlineImageMessage('<content>\n第一段剧情\n\n<pic prompt="one">\n第二段剧情\n</content>');
equal(cleanedMessage, '\n第一段剧情\n\n\n第二段剧情\n', '源数据清理应保留正文和原始换行');
assert(!/<\/?content\b|<pic\b/i.test(cleanedMessage), '源数据中不应残留控制标签');

console.info('<杠杠の生图机> marker tests passed');
