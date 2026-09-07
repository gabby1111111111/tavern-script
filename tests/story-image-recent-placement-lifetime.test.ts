import type { ImageResource } from '../src/杠杠の生图机/image-api';
import { RecentImageCache, type RecentImageRemovalReason } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const revoked: string[] = [];
const removed: Array<{ id: string; reason: RecentImageRemovalReason }> = [];

function resource(label: string): ImageResource {
  return {
    url: `blob:${label}-source`,
    kind: 'object-url',
    clone: () => ({
      url: `blob:${label}-owned`,
      kind: 'object-url',
      revoke: () => revoked.push(label),
    }),
  };
}

function add(cache: RecentImageCache, label: string) {
  return cache.add(
    {
      sourceIntentId: `intent-${label}`,
      purpose: 'current',
      origin: 'generated',
      chatId: 'chat-a',
      target: { messageId: 1, swipeId: 0, imageIndex: 0 },
    },
    resource(label),
  );
}

const cache = new RecentImageCache({
  onRemove: (artifact, reason) => removed.push({ id: artifact.id, reason }),
});
cache.setLimit(1);
const first = add(cache, 'first');
const second = add(cache, 'second');
assert(first && second, '测试图片应加入缓存');
assert(revoked.includes('first'), '容量淘汰必须释放 recent owner');
assert(
  removed.some(item => item.id === first.id && item.reason === 'evicted'),
  '容量淘汰原因必须为 evicted',
);

assert(cache.remove(second.id), '显式删除应成功');
assert(
  removed.some(item => item.id === second.id && item.reason === 'explicit'),
  '用户删除原因必须为 explicit',
);

const third = add(cache, 'third');
assert(third, 'clear 前应有图片');
cache.clear();
assert(
  removed.some(item => item.id === third.id && item.reason === 'cleared'),
  '整体清理原因必须为 cleared',
);
assert(revoked.includes('second') && revoked.includes('third'), '显式删除和整体清理都必须释放资源');

console.info('<杠杠の生图机> recent removal reason tests passed');
