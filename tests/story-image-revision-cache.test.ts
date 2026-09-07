import type { ImageResource } from '../src/杠杠の生图机/image-api';
import { ImagePlacementCache } from '../src/杠杠の生图机/image-placement';
import { ImagePresenter } from '../src/杠杠の生图机/image-presenter';
import type { ImagePlacementTarget } from '../src/杠杠の生图机/image-system';
import { RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let resourceSequence = 0;
const revoked = new Map<string, number>();

function resource(label: string): ImageResource {
  const clone = (): ImageResource => {
    const url = `blob:${label}-${resourceSequence++}`;
    return {
      url,
      kind: 'object-url',
      clone,
      revoke: () => revoked.set(url, (revoked.get(url) ?? 0) + 1),
    };
  };
  return { url: `blob:${label}-request`, kind: 'object-url', clone };
}

const target: ImagePlacementTarget = {
  kind: 'inline-anchor',
  messageId: 4,
  swipeId: 1,
  imageIndex: 0,
  paragraphIndex: 2,
  anchorTextBefore: 'before',
  anchorTextAfter: 'after',
};

const placementRef: { current: ImagePlacementCache | null } = { current: null };
const recent = new RecentImageCache({
  onRemove: artifact => {
    placementRef.current?.placements.value
      .filter(placement => placement.artifactId === artifact.id)
      .forEach(placement => placementRef.current?.remove(placement.id));
  },
});
const placements = new ImagePlacementCache(artifactId => recent.cloneResource(artifactId));
placementRef.current = placements;
const presenter = new ImagePresenter({ recentCache: recent, placementCache: placements });
const messageRef = {};

const variant0 = presenter.present({
  resource: resource('variant-0'),
  chatId: 'chat',
  displayMode: 'inline',
  placementTarget: target,
  messageRef,
  variantIndex: 0,
  revisionIndex: 0,
  prompt: 'original prompt',
});
const variant1 = presenter.present({
  resource: resource('variant-1'),
  chatId: 'chat',
  displayMode: 'inline',
  placementTarget: target,
  messageRef,
  variantIndex: 1,
  revisionIndex: 0,
  prompt: 'original prompt',
});
const revision = presenter.present({
  resource: resource('variant-1-revision'),
  chatId: 'chat',
  displayMode: 'inline',
  placementTarget: target,
  messageRef,
  variantIndex: 1,
  revisionIndex: 1,
  prompt: 'edited prompt',
});

assert(variant0?.placement && variant1?.placement && revision?.placement, '所有版本都应进入页面内存');
assert(placements.placements.value.length === 3, '两个横向变体与一个纵向版本应各自拥有 placement');
assert(variant0.placement.variantIndex === 0, '第一张应是横向 variant 0');
assert(variant1.placement.variantIndex === 1, '第二张应是横向 variant 1');
assert(revision.placement.variantIndex === 1, '重绘必须保留被操作的横向槽位');
assert(revision.placement.revisionIndex === 1, '重绘必须追加纵向版本而非覆盖原版');
assert(revision.placement.prompt === 'edited prompt', '修改后的提示词只应留在页面内存 placement');

const originalRevisionUrl = variant1.placement.url;
const removedRevisionUrl = revision.placement.url;
assert(recent.remove(revision.artifact.id), '删除当前版本应移除对应 recent artifact');
assert(!placements.get(revision.placement.id), '删除当前版本应同步移除其 placement');
assert(placements.get(variant1.placement.id) === variant1.placement, '删除新版不得误删同槽旧版');
assert(placements.get(variant0.placement.id) === variant0.placement, '删除新版不得误删横向相邻变体');
assert(revoked.get(removedRevisionUrl) === 1, '删除版本应释放自己的 placement clone 一次');
assert(!revoked.has(originalRevisionUrl), '保留的旧版资源不得被提前释放');

recent.clear();
assert((placements.placements.value.length as number) === 0, '清空 recent 后所有关联 placement 都应释放');

console.info('<杠杠の生图机> revision cache tests passed');
