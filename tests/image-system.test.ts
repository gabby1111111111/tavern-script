import type { ImageResource } from '../src/杠杠の生图机/image-api';
import {
  clearArtifactAssociations,
  createImageIntent,
  MAX_SAFE_IMAGE_ARTIFACT_DESCRIPTORS,
  toSafeImageArtifactDescriptors,
  type ImageArtifact,
} from '../src/杠杠の生图机/image-system';
import { MAX_RECENT_GENERATED_IMAGES, RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';
import {
  createImageTask,
  imageTaskKey,
  ImageTaskCache,
  isCurrentImageTaskForGeneration,
} from '../src/杠杠の生图机/task-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

let resourceSequence = 0;
const releasedUrls: string[] = [];

function clonableResource(label: string): ImageResource {
  const createOwned = (): ImageResource => {
    const url = `blob:${label}-owned-${resourceSequence++}`;
    return {
      url,
      kind: 'object-url',
      clone: createOwned,
      revoke: () => releasedUrls.push(url),
    };
  };
  return {
    url: `blob:${label}-source`,
    kind: 'object-url',
    clone: createOwned,
  };
}

const target = {
  kind: 'inline-anchor' as const,
  messageId: 7,
  swipeId: 1,
  imageIndex: 0,
  paragraphIndex: 2,
  anchorTextBefore: 'before',
  anchorTextAfter: 'after',
};
const intent = createImageIntent({
  purpose: 'current',
  chatId: 'chat-a',
  prompt: 'only-active-task-keeps-this-prompt',
  requestedTarget: target,
});
assert(intent.id.startsWith('image-intent-'), 'intent 应获得页面内唯一 ID');
equal(intent.requestedTarget, target, 'intent 应携带轻量 placement target');

const removalCounts = new Map<string, number>();
const inlineAssociation = { artifactId: null as string | null };
const giftAssociation = { artifactId: null as string | null };
const associations = [inlineAssociation, giftAssociation];
const cache = new RecentImageCache({
  onRemove: removedArtifact => {
    removalCounts.set(removedArtifact.id, (removalCounts.get(removedArtifact.id) ?? 0) + 1);
    clearArtifactAssociations(removedArtifact.id, associations);
  },
});
const artifact = cache.add(
  {
    sourceIntentId: intent.id,
    purpose: intent.purpose,
    origin: 'generated',
    chatId: intent.chatId,
    target: { messageId: 7, swipeId: 1, imageIndex: 0 },
  },
  clonableResource('first'),
);
assert(artifact, '可克隆资源应登记为 artifact');
assert(artifact.id.startsWith('image-artifact-'), 'artifact 应获得页面内唯一 ID');
inlineAssociation.artifactId = artifact.id;
giftAssociation.artifactId = artifact.id;
assert(!('prompt' in artifact), 'artifact 不得保存 prompt');
assert(!('apiKey' in artifact) && !('context' in artifact), 'artifact 不得保存密钥或聊天上下文');
const longArtifactId = 'artifact-' + 'a'.repeat(4_000);
const longSourceIntentId = 'intent-' + 'i'.repeat(4_000);
const unsafeArtifacts = Array.from({ length: MAX_SAFE_IMAGE_ARTIFACT_DESCRIPTORS + 1 }, (_unused, index) => ({
  ...artifact,
  id: index === 0 ? longArtifactId : `descriptor-${index}`,
  sourceIntentId: index === 0 ? longSourceIntentId : artifact.sourceIntentId,
  chatId: 'chat-source-text-'.repeat(1_000),
  target: { ...artifact.target, giftTaskId: 'gift-source-text-'.repeat(1_000) },
  url: `https://secret.invalid/${index}`,
  prompt: 'secret prompt',
  apiKey: 'secret key',
  context: 'secret context',
})) as Array<ImageArtifact & { prompt: string; apiKey: string; context: string }>;
const safeDescriptors = toSafeImageArtifactDescriptors(unsafeArtifacts);
equal(safeDescriptors.length, MAX_SAFE_IMAGE_ARTIFACT_DESCRIPTORS, '安全 descriptor 最多只返回二十条');
assert(
  safeDescriptors.every(
    descriptor =>
      !('url' in descriptor) && !('prompt' in descriptor) && !('apiKey' in descriptor) && !('context' in descriptor),
  ),
  '安全 descriptor 不得包含 URL、prompt、key 或 context',
);
assert(
  safeDescriptors.every(descriptor => !('chatId' in descriptor) && !('giftTaskId' in descriptor.target)),
  '安全 descriptor 应省略无界 chatId/giftTaskId 来源文本',
);
equal(safeDescriptors[0].id, longArtifactId, 'artifact id 用于回指，必须保持精确且不得截断');
equal(safeDescriptors[0].sourceIntentId, longSourceIntentId, 'sourceIntentId 用于回指，必须保持精确且不得截断');
assert(safeDescriptors[0].target !== unsafeArtifacts[0].target, '安全 descriptor 应复制轻量 target');
equal(
  cache.images.value.map(image => ({
    source: image.source,
    messageId: image.messageId,
    swipeId: image.swipeId,
    imageIndex: image.imageIndex,
  })),
  [{ source: '随文插图', messageId: 7, swipeId: 1, imageIndex: 0 }],
  'recent UI 兼容视图应由 artifact purpose 和 target 派生',
);

const placementClone = cache.cloneResource(artifact.id);
assert(placementClone && placementClone.url !== artifact.url, 'cloneResource 应返回独立 object URL');
placementClone.revoke?.();
assert(cache.remove(artifact.id), '移除 artifact 应成功');
assert(!cache.remove(artifact.id), '重复移除 artifact 应返回 false');
equal([inlineAssociation.artifactId, giftAssociation.artifactId], [null, null], '移除 artifact 应清空任务关联');
equal(removalCounts.get(artifact.id), 1, '手动移除回调应且仅应触发一次');
equal(releasedUrls.length, 2, 'placement clone 与 artifact owner 应分别且仅释放自己的资源');
assert(cache.cloneResource(artifact.id) === null, '移除后不得再克隆 artifact');

let oldestId = '';
for (let index = 0; index < MAX_RECENT_GENERATED_IMAGES + 1; index += 1) {
  const item = cache.add(
    {
      sourceIntentId: `bounded-intent-${index}`,
      purpose: index === 0 ? 'gift' : 'current',
      origin: 'generated',
      chatId: 'chat-a',
      target: {
        messageId: index,
        swipeId: 0,
        imageIndex: index === 0 ? null : 0,
        giftTaskId: index === 0 ? 'gift-0' : undefined,
      },
    },
    clonableResource(`bounded-${index}`),
  );
  assert(item, 'bounded artifact 应成功登记');
  if (index === 0) {
    oldestId = item.id;
    inlineAssociation.artifactId = item.id;
  }
}
equal(cache.artifacts.value.length, MAX_RECENT_GENERATED_IMAGES, 'artifact store 上限应继续保持五张');
assert(!cache.artifacts.value.some(item => item.id === oldestId), '第六张 artifact 应淘汰最旧条目');
equal(removalCounts.get(oldestId), 1, '容量淘汰回调应且仅应触发一次');
assert(inlineAssociation.artifactId === null, '容量淘汰也应清空对应任务关联');
assert(
  cache.images.value.every(image => !('prompt' in image)),
  'recent 兼容视图也不得泄露 prompt',
);
const idsBeforeClear = cache.artifacts.value.map(item => item.id);
giftAssociation.artifactId = idsBeforeClear[0];
cache.clear();
cache.clear();
equal(cache.artifacts.value, [], 'clear 应清空 artifact store');
equal(cache.images.value, [], 'clear 后 recent UI 兼容视图也应为空');
assert(
  idsBeforeClear.every(id => removalCounts.get(id) === 1),
  'clear 与重复 clear 对每个 artifact 只回调一次',
);
assert(giftAssociation.artifactId === null, 'clear 也应清空对应任务关联');
equal(releasedUrls.length, MAX_RECENT_GENERATED_IMAGES + 3, 'manual、overflow 与 clear 应释放全部 owner/clone');
equal(new Set(releasedUrls).size, releasedUrls.length, '每个 object URL 应且仅应 revoke 一次');

const inlinePrompt = (index: number, prompt: string) => ({
  index,
  prompt,
  start: 0,
  end: 0,
  paragraphIndex: 0,
  anchorTextBefore: '',
  anchorTextAfter: '',
});
const taskCache = new ImageTaskCache();
const oldPendingTask = createImageTask(inlinePrompt(0, 'old pending'), {
  chatId: 'chat-a',
  messageId: 20,
  swipeId: 0,
  generationId: 'generation-old',
});
const oldSuccessTask = createImageTask(inlinePrompt(0, 'old success'), {
  chatId: 'chat-a',
  messageId: 19,
  swipeId: 0,
  generationId: 'generation-old',
});
oldSuccessTask.status = 'success';
const newPendingTask = createImageTask(inlinePrompt(0, 'new pending'), {
  chatId: 'chat-a',
  messageId: 21,
  swipeId: 0,
  generationId: 'generation-new',
});
taskCache.set(oldPendingTask);
taskCache.set(oldSuccessTask);
taskCache.set(newPendingTask);

equal(taskCache.cancelActiveOutsideGeneration('generation-new'), 1, '新 generation 应取消旧 active 任务');
assert(oldPendingTask.status === 'cancelled', '旧 pending 任务应变为 cancelled');
assert(oldPendingTask.abortController.signal.aborted, '旧 pending 请求应收到 abort');
assert(!taskCache.get(imageTaskKey(oldPendingTask)), '旧 pending 任务应从 cache 失效');
assert(taskCache.get(imageTaskKey(oldSuccessTask)) === oldSuccessTask, '旧 success 任务应保留供旧楼层显示');
assert(taskCache.get(imageTaskKey(newPendingTask)) === newPendingTask, '新 generation 的任务不得被取消');
assert(
  !isCurrentImageTaskForGeneration(oldPendingTask, oldPendingTask, 'generation-new', 'chat-a'),
  '门控必须拒绝非 active generation，即使仍传入同一 task',
);
assert(
  isCurrentImageTaskForGeneration(
    newPendingTask,
    taskCache.get(imageTaskKey(newPendingTask)),
    'generation-new',
    'chat-a',
  ),
  '门控应接受 cache、generation 与 chat 都匹配的新任务',
);
assert(
  !isCurrentImageTaskForGeneration(
    newPendingTask,
    taskCache.get(imageTaskKey(newPendingTask)),
    'generation-old',
    'chat-a',
  ),
  '门控应拒绝 activeGenerationId 不匹配的响应',
);

console.info('<杠杠の生图机> image system tests passed');
