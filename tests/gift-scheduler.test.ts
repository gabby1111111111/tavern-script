import { GiftScheduler } from '../src/杠杠の生图机/gift-scheduler';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const everyThree = new GiftScheduler();
equal(
  everyThree.registerAssistantReply('chat-a', 1, '3'),
  { assistantReplyCount: 1, shouldAttempt: false, skipReason: null },
  '第 1 条回复只计数',
);
everyThree.registerAssistantReply('chat-a', 2, '3');
const third = everyThree.registerAssistantReply('chat-a', 3, '3');
assert(third.shouldAttempt, '每 3 条应在第 3 条登记一次尝试');
assert(everyThree.hasAttempted('chat-a', 3), '到点后必须在运行时检查前登记 attempted');

const duplicate = everyThree.registerAssistantReply('chat-a', 3, '3');
equal(
  duplicate,
  { assistantReplyCount: 3, shouldAttempt: false, skipReason: 'duplicate_message' },
  '同 messageId 的 swipe/regenerate/continue/append 不得重复计数或触发',
);

const manual = new GiftScheduler();
manual.registerAssistantReply('chat-a', 1, 'manual');
manual.registerAssistantReply('chat-a', 2, 'manual');
equal(
  manual.registerAssistantReply('chat-a', 3, 'manual'),
  { assistantReplyCount: 3, shouldAttempt: false, skipReason: null },
  '手动模式仍累计回复，但不自动触发',
);

const switched = new GiftScheduler();
for (let messageId = 1; messageId <= 4; messageId += 1) {
  const decision = switched.registerAssistantReply('chat-a', messageId, '5');
  assert(!decision.shouldAttempt, '切换前未到第 5 条不应触发');
}
const afterSwitch = switched.registerAssistantReply('chat-a', 5, '3');
assert(!afterSwitch.shouldAttempt, '切换为每 3 条时不得立即触发或追补');
assert(switched.registerAssistantReply('chat-a', 6, '3').shouldAttempt, '切换后应沿用累计数并在下一个整除点触发');

switched.reset();
equal(
  switched.registerAssistantReply('chat-a', 6, '3'),
  { assistantReplyCount: 1, shouldAttempt: false, skipReason: null },
  '删除消息并 reset 后，同一聊天复用旧 messageId 也应作为新回复从 1 计数',
);
assert(!switched.hasAttempted('chat-a', 6), '删除重置后应清空旧 attempted 登记');

console.info('gift scheduler tests passed');
