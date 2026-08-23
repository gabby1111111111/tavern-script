import {
  boundedReuseAnchorText,
  MAX_REUSE_ANCHOR_TEXT_LENGTH,
  nextAvailableImageIndex,
  selectLatestAssistantSwipe,
} from '../src/杠杠の生图机/runtime';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

equal(selectLatestAssistantSwipe([]), null, '没有 assistant 消息时应返回 null');
equal(
  selectLatestAssistantSwipe([
    { message_id: 2, swipe_id: 0 },
    { message_id: 7, swipe_id: 3 },
  ]),
  { message_id: 7, swipe_id: 3 },
  '应倒序选择最新 assistant 的当前 swipe',
);

equal(nextAvailableImageIndex([]), 0, '无占用索引时应从 0 开始');
equal(nextAvailableImageIndex([0, 2, 3, 0, -1]), 1, '应避开 inline task 与 placement 已用索引');
equal(nextAvailableImageIndex([0, 1, 2]), 3, '连续占用时应选择下一个索引');

equal(boundedReuseAnchorText('  夏天\n  学校   吵架  '), '夏天 学校 吵架', 'anchor 应压缩空白');
const longAnchor = boundedReuseAnchorText(`前缀${'夏'.repeat(MAX_REUSE_ANCHOR_TEXT_LENGTH + 10)}`);
equal(longAnchor.length, MAX_REUSE_ANCHOR_TEXT_LENGTH, 'anchor 必须保持有界');
assert(longAnchor === '夏'.repeat(MAX_REUSE_ANCHOR_TEXT_LENGTH), 'anchor 应保留正文末段而非开头');

console.info('<杠杠の生图机> story image reuse tests passed');
