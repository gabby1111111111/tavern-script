import type { ImageResource } from '../src/杠杠の生图机/image-api';
import {
  DEFAULT_RECENT_IMAGE_LIMIT,
  MAX_RECENT_IMAGE_LIMIT,
  MIN_RECENT_IMAGE_LIMIT,
  RecentImageCache,
} from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const revokeCounts = new Map<string, number>();
const removedIds: string[] = [];

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

const cache = new RecentImageCache({ onRemove: artifact => removedIds.push(artifact.id) });
equal(cache.limit, DEFAULT_RECENT_IMAGE_LIMIT, 'recent cache 默认上限应为十张');

const initial = Array.from({ length: DEFAULT_RECENT_IMAGE_LIMIT }, (_unused, index) => {
  const artifact = addArtifact(cache, `initial-${index}`);
  assert(artifact, '初始 artifact 应创建成功');
  return artifact;
});
equal(cache.images.value.length, DEFAULT_RECENT_IMAGE_LIMIT, '默认 recent cache 应保留十张');

const overflow = addArtifact(cache, 'overflow-10');
assert(overflow, '溢出时新 artifact 应创建成功');
equal(cache.images.value.length, DEFAULT_RECENT_IMAGE_LIMIT, 'FIFO 溢出后 recent cache 总量必须为十');
equal(
  cache.images.value.map(image => {
    const sourceIntentId = image.sourceIntentId;
    assert(sourceIntentId, '测试 artifact 应始终保留 source intent id');
    return sourceIntentId.replace('intent-', '');
  }),
  [
    'overflow-10',
    'initial-9',
    'initial-8',
    'initial-7',
    'initial-6',
    'initial-5',
    'initial-4',
    'initial-3',
    'initial-2',
    'initial-1',
  ],
  'FIFO 溢出应保留最新十张并按最新到最旧排列',
);
assert(!cache.getArtifact(initial[0].id), 'FIFO 溢出应淘汰最旧 artifact');
equal(revokeCounts.get('initial-0'), 1, 'FIFO 溢出只应 revoke 被淘汰项一次');
assert(removedIds.includes(initial[0].id), 'FIFO 溢出应调用既有 onRemove 清理回调');

for (let index = 11; index <= 20; index += 1) {
  assert(addArtifact(cache, `overflow-${index}`), '连续溢出仍应接受新 artifact');
}
equal(cache.images.value.length, DEFAULT_RECENT_IMAGE_LIMIT, '连续溢出后总量仍必须为十');
equal(
  cache.images.value.map(image => {
    const sourceIntentId = image.sourceIntentId;
    assert(sourceIntentId, '测试 artifact 应始终保留 source intent id');
    return sourceIntentId.replace('intent-', '');
  }),
  [
    'overflow-20',
    'overflow-19',
    'overflow-18',
    'overflow-17',
    'overflow-16',
    'overflow-15',
    'overflow-14',
    'overflow-13',
    'overflow-12',
    'overflow-11',
  ],
  '连续 FIFO 溢出应只保留最后十张',
);

const beforeShrink = cache.images.value.map(image => image.id);
const retainedAfterShrink = beforeShrink.slice(0, 3);
equal(cache.setLimit(3), 3, 'setLimit 应返回归一化后的上限');
equal(cache.limit, 3, 'setLimit 应更新当前上限');
equal(
  cache.images.value.map(image => image.id),
  retainedAfterShrink,
  '调小上限应立即保留最新图片',
);
equal(cache.images.value.length, 3, '调小上限应立即淘汰超额旧图');
const evictedByShrink = beforeShrink.slice(3);
evictedByShrink.forEach(id => {
  assert(removedIds.includes(id), '调小上限应为每张淘汰图调用 onRemove');
});
assert(
  evictedByShrink.every(id => !cache.getArtifact(id)),
  '调小上限后超额 artifact 不得继续可取',
);
assert(
  evictedByShrink.every(id => !cache.cloneResource(id)),
  '调小上限后超额资源不得继续可克隆',
);

equal(cache.setLimit(0), MIN_RECENT_IMAGE_LIMIT, '低于最小值时应钳制到一张');
equal(cache.limit, MIN_RECENT_IMAGE_LIMIT, '最小上限应为一张');
equal(cache.images.value.length, MIN_RECENT_IMAGE_LIMIT, '钳制到一张时应立即释放其余图片');
equal(cache.setLimit(100), MAX_RECENT_IMAGE_LIMIT, '高于最大值时应钳制到五十张');
equal(cache.limit, MAX_RECENT_IMAGE_LIMIT, '最大上限应为五十张');
equal(cache.images.value.length, MIN_RECENT_IMAGE_LIMIT, '提高上限不得凭空恢复已淘汰图片');

const explicitlyRemoved = cache.images.value[0];
assert(explicitlyRemoved, '显式移除前应有可用 artifact');
const explicitlyRemovedSourceIntentId = explicitlyRemoved.sourceIntentId;
assert(explicitlyRemovedSourceIntentId, '待显式移除 artifact 应始终保留 source intent id');
const explicitlyRemovedLabel = explicitlyRemovedSourceIntentId.replace('intent-', '');
assert(cache.remove(explicitlyRemoved.id), '显式移除缓存 artifact 应成功');
equal(revokeCounts.get(explicitlyRemovedLabel), 1, '显式移除只应 revoke 一次');
assert(!cache.remove(explicitlyRemoved.id), '重复移除应返回 false');
equal(revokeCounts.get(explicitlyRemovedLabel), 1, '重复移除不得重复 revoke');
assert(removedIds.filter(id => id === explicitlyRemoved.id).length === 1, '显式移除只应调用回调一次');

cache.clear();
cache.clear();
equal(cache.images.value.length, 0, 'clear 必须清空 recent cache');

console.info('<杠杠の生图机> recent image cache tests passed');
