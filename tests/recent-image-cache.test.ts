import type { ImageResource } from '../src/杠杠の生图机/image-api';
import { MAX_RECENT_GENERATED_IMAGES, RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const revokeCounts = new Map<string, number>();

function clonableResource(label: string): ImageResource {
  return {
    url: `blob:${label}-source`,
    kind: 'object-url',
    clone: () => ({
      url: `blob:${label}-owned`,
      kind: 'object-url',
      revoke: () => revokeCounts.set(label, (revokeCounts.get(label) ?? 0) + 1),
    }),
  };
}

function addArtifact(cache: RecentImageCache, label: string) {
  return cache.add(
    {
      sourceIntentId: `intent-${label}`,
      purpose: 'current',
      origin: 'generated',
      chatId: 'chat-a',
      target: { messageId: Number(label.replace(/\D/g, '')) || 0, swipeId: 0, imageIndex: 0 },
    },
    clonableResource(label),
  );
}

const cache = new RecentImageCache();
const initial = Array.from({ length: MAX_RECENT_GENERATED_IMAGES }, (_unused, index) => {
  const artifact = addArtifact(cache, `initial-${index}`);
  assert(artifact, '初始 artifact 应创建成功');
  return artifact;
});
const oldest = initial[0];
assert(cache.pinArtifact(oldest.id), '应可 pin 已存在的 artifact');
equal(cache.pinnedArtifactId, oldest.id, 'pin getter 应只返回当前 artifact id');

const overflow = addArtifact(cache, 'overflow-5');
assert(overflow, '溢出时新 artifact 应创建成功');
equal(cache.images.value.length, MAX_RECENT_GENERATED_IMAGES, 'pin 不得增加 recent cache 总量');
assert(cache.getArtifact(oldest.id), '最旧 artifact 被 pin 后不应被 overflow 淘汰');
assert(!cache.getArtifact(initial[1].id), 'overflow 应淘汰最旧的非 pinned artifact');
equal(revokeCounts.get('initial-1'), 1, 'overflow 只应 revoke 被淘汰项一次');

assert(cache.pinArtifact(overflow.id), '切换 pin 应成功');
equal(cache.pinnedArtifactId, overflow.id, '切换后 getter 应返回新 pinned artifact');
assert(!cache.pinArtifact('missing-artifact'), '不存在的 artifact 不得成为 pin');
equal(cache.pinnedArtifactId, overflow.id, '失败的 pin 不得清除现有 pin');

for (let index = 6; index <= 10; index += 1) {
  assert(addArtifact(cache, `overflow-${index}`), '连续溢出仍应接受新 artifact');
}
equal(cache.images.value.length, MAX_RECENT_GENERATED_IMAGES, '连续溢出后总量仍必须为五');
assert(cache.getArtifact(overflow.id), '当前 pinned artifact 在连续溢出后仍应保留');
assert(!cache.getArtifact(oldest.id), '旧 pinned 项在切换后应恢复普通淘汰');
equal(revokeCounts.get('initial-0'), 1, '旧 pinned 项被淘汰时只应 revoke 一次');

assert(cache.remove(overflow.id), '显式移除当前 pinned artifact 应成功');
equal(cache.pinnedArtifactId, null, '移除 pinned artifact 必须清理 pin');
equal(revokeCounts.get('overflow-5'), 1, '移除 pinned artifact 只应 revoke 一次');
assert(!cache.remove(overflow.id), '重复移除应返回 false');
equal(revokeCounts.get('overflow-5'), 1, '重复移除不得重复 revoke');

const finalPinned = cache.images.value[0];
assert(finalPinned && cache.pinArtifact(finalPinned.id), 'clear 前应能重新设置 pin');
const remainingLabels = cache.images.value.map(image => {
  const sourceIntentId = image.sourceIntentId;
  assert(sourceIntentId, '测试 artifact 应始终保留 source intent id');
  return sourceIntentId.replace('intent-', '');
});
cache.clear();
cache.clear();
equal(cache.pinnedArtifactId, null, 'clear 必须清理 pin');
equal(cache.images.value.length, 0, 'clear 必须清空 recent cache');
assert(
  remainingLabels.every(label => revokeCounts.get(label) === 1),
  'clear 与重复 clear 对每个 owner 只 revoke 一次',
);

console.info('<杠杠の生图机> recent image cache tests passed');
