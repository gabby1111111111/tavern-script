import type { ImageResource } from '../src/杠杠の生图机/image-api';
import {
  ImagePlacementCache,
  MAX_IMAGE_PLACEMENTS,
  MAX_IMAGE_PLACEMENT_CAPTION_LENGTH,
} from '../src/杠杠の生图机/image-placement';
import type { ImagePlacementTarget } from '../src/杠杠の生图机/image-system';
import { RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function attemptMutation(mutation: () => void): void {
  try {
    mutation();
  } catch {
    return;
  }
}

let resourceSequence = 0;
const revokeCounts = new Map<string, number>();

function clonableResource(label: string): ImageResource {
  const createOwned = (): ImageResource => {
    const url = `blob:${label}-owned-${resourceSequence++}`;
    return {
      url,
      kind: 'object-url',
      clone: createOwned,
      revoke: () => revokeCounts.set(url, (revokeCounts.get(url) ?? 0) + 1),
    };
  };
  return { url: `blob:${label}-source`, kind: 'object-url', clone: createOwned };
}

function placementTarget(messageId: number): ImagePlacementTarget {
  return {
    kind: 'inline-anchor',
    messageId,
    swipeId: 0,
    imageIndex: 0,
    paragraphIndex: 1,
    anchorTextBefore: 'before',
    anchorTextAfter: 'after',
  };
}

function addArtifact(cache: RecentImageCache, label: string) {
  return cache.add(
    {
      sourceIntentId: `intent-${label}`,
      purpose: 'current',
      origin: 'generated',
      chatId: 'chat-a',
      target: { messageId: 1, swipeId: 0, imageIndex: 0 },
    },
    clonableResource(label),
  );
}

const recentCache = new RecentImageCache();
const removedPlacements: string[] = [];
const placementCache = new ImagePlacementCache(artifactId => recentCache.cloneResource(artifactId), {
  onRemove: placement => removedPlacements.push(placement.id),
});
const artifact = addArtifact(recentCache, 'shared');
assert(artifact, '测试 artifact 应创建成功');

const mutableTarget = placementTarget(10);
const first = placementCache.place({
  artifactId: artifact.id,
  target: mutableTarget,
  caption: 'A'.repeat(MAX_IMAGE_PLACEMENT_CAPTION_LENGTH + 20),
});
const second = placementCache.place({ artifactId: artifact.id, target: placementTarget(11), caption: '第二次说明' });
assert(first && second, '同一 artifact 应可创建多个 placement');
assert(first.url !== second.url, '每个 placement 必须拥有独立 clone URL');
equal(first.caption.length, MAX_IMAGE_PLACEMENT_CAPTION_LENGTH, 'caption 必须限长');
equal(second.caption, '第二次说明', '同一 artifact 的 placement caption 应彼此独立');
mutableTarget.anchorTextBefore = 'mutated';
equal(first.target.anchorTextBefore, 'before', 'placement 应复制 target，不能保留外部可变引用');
assert(Object.isFrozen(first), 'place 返回值必须冻结');
assert(Object.isFrozen(first.target), 'place 返回值的 target 必须深冻结');
assert(Object.isFrozen(placementCache.placements.value), 'computed placements 列表快照必须冻结');
const originalFirstId = first.id;
const originalFirstMessageId = first.target.messageId;
const exposedFirst = placementCache.placements.value.find(item => item.id === originalFirstId);
assert(exposedFirst, 'computed placements 应包含第一条 placement');
assert(exposedFirst === first, 'placement 列表必须保留对象身份，供 renderer 跨 host 重建复用同一 img');
attemptMutation(() => {
  (first as unknown as { id: string }).id = 'tampered-return-id';
});
attemptMutation(() => {
  (exposedFirst as unknown as { id: string }).id = 'tampered-port-id';
});
attemptMutation(() => {
  (exposedFirst.target as unknown as { messageId: number }).messageId = 999;
});
equal(first.id, originalFirstId, '调用方不得篡改 place 返回对象的 id');
equal(exposedFirst.id, originalFirstId, '调用方不得篡改 computed port 元素的 id');
equal(exposedFirst.target.messageId, originalFirstMessageId, '调用方不得篡改 placement target');

assert(recentCache.remove(artifact.id), 'artifact 应可从最近池移除');
equal(revokeCounts.get(artifact.url), 1, 'artifact store 只应释放自己的 owner');
equal(placementCache.placements.value.length, 2, 'artifact 删除后已有 placement 仍应可用');
assert(!revokeCounts.has(first.url) && !revokeCounts.has(second.url), 'artifact 删除不得 revoke placement clone');
assert(placementCache.remove(originalFirstId), '篡改尝试后按原 id 删除 placement 应成功');
assert(!placementCache.remove(originalFirstId), '重复删除 placement 应返回 false');
equal(revokeCounts.get(first.url), 1, '手动删除只应 revoke 自己的 clone 一次');
equal(removedPlacements.filter(id => id === originalFirstId).length, 1, '手动删除与重复删除只应通知一次');
placementCache.clear();
placementCache.clear();
equal(revokeCounts.get(second.url), 1, 'clear 与重复 clear 只应 revoke clone 一次');
equal(removedPlacements.filter(id => id === second.id).length, 1, 'clear 与重复 clear 只应通知一次');

const boundedArtifact = addArtifact(recentCache, 'bounded');
assert(boundedArtifact, '有界 placement 测试 artifact 应创建成功');
const bounded = Array.from({ length: MAX_IMAGE_PLACEMENTS + 1 }, (_unused, index) => {
  const placement = placementCache.place({
    artifactId: boundedArtifact.id,
    target: placementTarget(20 + index),
    caption: `caption-${index}`,
  });
  assert(placement, '有界 placement 应创建成功');
  return placement;
});
equal(placementCache.placements.value.length, MAX_IMAGE_PLACEMENTS, 'placement cache 必须保持有界');
assert(!placementCache.placements.value.some(item => item.id === bounded[0].id), '第十一条应淘汰最旧 placement');
equal(revokeCounts.get(bounded[0].url), 1, 'overflow 只应 revoke 最旧 clone 一次');
equal(removedPlacements.filter(id => id === bounded[0].id).length, 1, 'overflow 只应通知最旧 placement 一次');
assert(placementCache.remove(bounded[1].id), 'overflow 后仍应支持手动删除');
placementCache.clear();
placementCache.clear();
assert(
  bounded.every(item => revokeCounts.get(item.url) === 1),
  'overflow/remove/clear 后每个 clone 只 revoke 一次',
);
assert(
  bounded.every(item => removedPlacements.filter(id => id === item.id).length === 1),
  'overflow/remove/clear 后每个 placement 只通知一次',
);

recentCache.clear();
equal(revokeCounts.get(boundedArtifact.url), 1, '最终清理应独立释放 artifact owner');
assert(
  placementCache.place({ artifactId: boundedArtifact.id, target: placementTarget(99) }) === null,
  '不存在的 artifact 或 clone 失败必须返回 null',
);

console.info('<杠杠の生图机> image placement tests passed');
