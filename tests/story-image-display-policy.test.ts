import type { ImageResource } from '../src/杠杠の生图机/image-api';
import {
  decideFloorTrigger,
  floorInterval,
  normalizeDisplaySettings,
  normalizeSkipFloors,
} from '../src/杠杠の生图机/display-policy';
import { ImagePlacementCache } from '../src/杠杠の生图机/image-placement';
import { presentGeneratedImage } from '../src/杠杠の生图机/image-presenter';
import { RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

equal(normalizeSkipFloors(-2), 0, '负数 skipFloors 应归零');
equal(normalizeSkipFloors(2.9), 2, 'skipFloors 应取非负整数');
equal(normalizeSkipFloors('2'), 0, '字符串 skipFloors 不应被隐式接受');
equal(floorInterval(0), 1, 'skipFloors=0 应每楼触发');
equal(floorInterval(1), 2, 'skipFloors=1 应隔一楼触发');
equal(
  normalizeDisplaySettings({ displayMode: 'gift', skipFloors: -1 }),
  {
    displayMode: 'gift',
    skipFloors: 0,
  },
  '展现设置应规范化',
);

const decisions = [1, 2, 3, 4].map(
  count => decideFloorTrigger({ normalAssistantFloorCount: count, displaySettings: { skipFloors: 1 } }).shouldTrigger,
);
equal(decisions, [true, false, true, false], 'skipFloors=1 应在第 1、3 个正常 AI 楼层触发');
assert(
  decideFloorTrigger({ normalAssistantFloorCount: 1, displaySettings: { skipFloors: 0 } }).shouldTrigger,
  'skipFloors=0 的第一个正常 AI 楼层应触发',
);
equal(
  decideFloorTrigger({ normalAssistantFloorCount: 2, displaySettings: { skipFloors: 0 }, isNormalGeneration: false }),
  { shouldTrigger: false, normalAssistantFloorCount: 2, interval: 1, reason: 'non-normal-generation' },
  '非正常生成不得打开图片机会',
);
equal(
  decideFloorTrigger({ normalAssistantFloorCount: 2, displaySettings: { skipFloors: 0 }, isGroupChat: true }),
  { shouldTrigger: false, normalAssistantFloorCount: 2, interval: 1, reason: 'group-chat' },
  '群聊在 speaker 身份未明确前应跳过',
);

let sequence = 0;
function resource(label: string): ImageResource {
  const clone = (): ImageResource => ({
    url: `blob:${label}:owned:${sequence++}`,
    kind: 'object-url',
    clone,
    revoke: () => undefined,
  });
  return {
    url: `blob:${label}:source`,
    kind: 'object-url',
    clone,
  };
}

const recentCache = new RecentImageCache();
const placementCache = new ImagePlacementCache(artifactId => recentCache.cloneResource(artifactId));
const context = { recentCache, placementCache };
const gift = presentGeneratedImage(context, {
  resource: resource('gift'),
  chatId: 'chat-a',
  sourceIntentId: 'intent-gift',
  displayMode: 'gift',
});
assert(gift, 'gift 图片应登记到 recent cache');
equal(gift.placement, null, 'gift 图片不得创建正文 placement');
equal(gift.recentImage.source, '礼物 CG', 'gift 图片应标记为礼物来源');

const inline = presentGeneratedImage(context, {
  resource: resource('inline'),
  chatId: 'chat-a',
  sourceIntentId: 'intent-inline',
  displayMode: 'inline',
  placementTarget: {
    kind: 'inline-anchor',
    messageId: 3,
    swipeId: 0,
    imageIndex: 0,
    paragraphIndex: 0,
    anchorTextBefore: '',
    anchorTextAfter: '',
  },
});
assert(inline?.placement, 'inline 图片应创建 placement');
equal(inline.recentImage.source, '随文插图', 'inline 图片应标记为随文来源');
assert(
  presentGeneratedImage(context, { resource: resource('invalid'), chatId: 'chat-a', displayMode: 'inline' }) === null,
  'inline 缺少锚点时应拒绝登记',
);

placementCache.clear();
recentCache.clear();
console.info('<杠杠の生图机> story image display policy tests passed');
