import type { ImageResource } from '../src/杠杠の生图机/image-api';
import { createImageIntent, type ImageIntent, type ImagePurpose } from '../src/杠杠の生图机/image-system';
import {
  canReplacePrediction,
  isPredictionArtifactOwnedBy,
  isPredictionContextCurrent,
  PredictionSlot,
  type PredictionArtifactOwner,
  type PredictionContext,
} from '../src/杠杠の生图机/prediction-slot';
import { RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function predictionIntent(label: string): ImageIntent {
  return createImageIntent({ purpose: 'prediction', chatId: 'chat-a', prompt: label, requestedTarget: null });
}

const discarded: Array<{ artifactId: string; owner: PredictionArtifactOwner }> = [];
const slot = new PredictionSlot({
  onDiscardArtifact: (artifactId, owner) => discarded.push({ artifactId, owner }),
});
const firstIntent = predictionIntent('first');
const secondIntent = predictionIntent('second');

const firstCandidate = slot.replace(firstIntent, 0, 'artifact-1');
equal(slot.status, 'ready', '携带 artifact 的 prediction 应为 ready');
const secondCandidate = slot.replace(secondIntent, 0, 'artifact-2');
equal(
  discarded.map(item => item.artifactId),
  ['artifact-1'],
  'latest-wins 必须删除旧的未消费 artifact',
);
equal(discarded[0].owner, firstCandidate.ticket, '删除回调必须携带旧候选的精确 owner');
equal(slot.peek()?.intent.id, secondIntent.id, 'peek 只应返回最新候选');
assert(slot.attach(firstCandidate.ticket, 'late-artifact') === null, 'B 开始后 A ticket 必须失效');
slot.attach(secondCandidate.ticket, 'artifact-3');
equal(
  discarded.map(item => item.artifactId),
  ['artifact-1', 'artifact-2'],
  'attach 新 artifact 应删除旧的未消费 artifact',
);
const consumed = slot.consume(secondCandidate.ticket);
equal(consumed?.artifactId, 'artifact-3', 'consume 应交出当前候选');
equal(slot.status, 'empty', 'consume 后单槽应为空');
equal(
  discarded.map(item => item.artifactId),
  ['artifact-1', 'artifact-2'],
  'consume 后 artifact 应由消费者决定，不得自动删除',
);

const intentOnly = slot.replace(predictionIntent('intent-only'), 0);
equal(slot.status, 'intent', '尚未 attach artifact 的候选应为 intent');
slot.attach(intentOnly.ticket, 'artifact-4');
assert(slot.drop(intentOnly.ticket), 'drop 应丢弃当前候选');
assert(!slot.drop(intentOnly.ticket), '空槽重复 drop 应返回 false');
equal(
  discarded.map(item => item.artifactId),
  ['artifact-1', 'artifact-2', 'artifact-4'],
  'drop 应删除未消费 artifact',
);
assert(slot.attach(intentOnly.ticket, 'orphan') === null, '空槽不得 attach artifact');

const initialContext: PredictionContext = { epoch: 4, revision: 0, chatId: 'chat-a' };
assert(
  canReplacePrediction(firstIntent, initialContext, initialContext),
  'prediction intent 与当前 epoch/revision/chat 一致时应允许 replace',
);
assert(
  !canReplacePrediction({ ...firstIntent, purpose: 'current' }, initialContext, initialContext),
  '非 prediction intent 不得 replace',
);
assert(
  !canReplacePrediction(firstIntent, initialContext, { ...initialContext, revision: 1 }),
  '旧 revision 的 replace 必须被拒绝',
);
assert(
  !canReplacePrediction(firstIntent, initialContext, { ...initialContext, epoch: 5 }),
  '生命周期清理后的旧 epoch replace 必须被拒绝',
);
assert(
  !isPredictionContextCurrent(initialContext, { ...initialContext, chatId: 'chat-b' }),
  '切换聊天后旧 context 必须失效',
);

let resourceSequence = 0;
function clonableResource(): ImageResource {
  const createOwned = (): ImageResource => ({
    url: `blob:prediction-${resourceSequence++}`,
    kind: 'object-url',
    clone: createOwned,
    revoke: () => undefined,
  });
  return { url: 'blob:prediction-source', kind: 'object-url', clone: createOwned };
}

const integratedSlotHolder: { current: PredictionSlot | null } = { current: null };
const recentCache = new RecentImageCache({
  onRemove: artifact => integratedSlotHolder.current?.invalidateArtifact(artifact.id),
});
function discardOwnedPredictionArtifact(artifactId: string, owner: PredictionArtifactOwner): void {
  const artifact = recentCache.getArtifact(artifactId);
  if (isPredictionArtifactOwnedBy(artifact, owner)) recentCache.remove(artifactId);
}
const integratedSlot = new PredictionSlot({ onDiscardArtifact: discardOwnedPredictionArtifact });
integratedSlotHolder.current = integratedSlot;

function addArtifact(
  intent: ImageIntent,
  purpose: ImagePurpose = 'prediction',
  chatId = intent.chatId,
  sourceIntentId: string | null = intent.id,
) {
  return recentCache.add(
    {
      sourceIntentId,
      purpose,
      origin: 'generated',
      chatId,
      target: { messageId: null, swipeId: null, imageIndex: null },
    },
    clonableResource(),
  );
}

const latestOldIntent = predictionIntent('latest-old');
const latestNewIntent = predictionIntent('latest-new');
const latestOldArtifact = addArtifact(latestOldIntent);
const latestNewArtifact = addArtifact(latestNewIntent);
assert(latestOldArtifact && latestNewArtifact, 'latest-wins 测试 artifacts 应创建成功');
integratedSlot.replace(latestOldIntent, 0, latestOldArtifact.id);
const latestCandidate = integratedSlot.replace(latestNewIntent, 0, latestNewArtifact.id);
assert(!recentCache.getArtifact(latestOldArtifact.id), 'latest-wins 应真正删除最近池中的旧未消费 artifact');
assert(recentCache.getArtifact(latestNewArtifact.id), 'latest-wins 应保留最新 artifact');
integratedSlot.consume(latestCandidate.ticket);

const externalIntent = predictionIntent('external');
const externalArtifact = addArtifact(externalIntent);
assert(externalArtifact, '外部删除测试 artifact 应创建成功');
integratedSlot.replace(externalIntent, 0, externalArtifact.id);
recentCache.remove(externalArtifact.id);
equal(integratedSlot.status, 'empty', 'artifact 被外部删除时当前 prediction 必须失效');

const droppedIntent = predictionIntent('drop');
const droppedArtifact = addArtifact(droppedIntent);
assert(droppedArtifact, 'drop 测试 artifact 应创建成功');
const droppedCandidate = integratedSlot.replace(droppedIntent, 0, droppedArtifact.id);
integratedSlot.drop(droppedCandidate.ticket);
assert(!recentCache.getArtifact(droppedArtifact.id), 'drop 应通过回调删除未消费 artifact');

const consumedIntent = predictionIntent('consume');
const consumedArtifact = addArtifact(consumedIntent);
assert(consumedArtifact, 'consume 测试 artifact 应创建成功');
const consumedCandidate = integratedSlot.replace(consumedIntent, 0, consumedArtifact.id);
integratedSlot.consume(consumedCandidate.ticket);
assert(recentCache.getArtifact(consumedArtifact.id), 'consume 后 artifact 应继续存在，由消费者决定');
recentCache.clear();

const outOfOrderA = predictionIntent('out-of-order-a');
const outOfOrderB = predictionIntent('out-of-order-b');
const ticketA = integratedSlot.replace(outOfOrderA, 7).ticket;
const ticketB = integratedSlot.replace(outOfOrderB, 7).ticket;
const lateArtifactA = addArtifact(outOfOrderA);
const artifactB = addArtifact(outOfOrderB);
assert(lateArtifactA && artifactB, '乱序测试 artifacts 应创建成功');
assert(integratedSlot.attach(ticketA, lateArtifactA.id) === null, 'A 迟到结果不得覆盖已开始的 B');
discardOwnedPredictionArtifact(lateArtifactA.id, ticketA);
assert(!recentCache.getArtifact(lateArtifactA.id), 'A 的精确迟到 prediction artifact 应安全回收');
assert(integratedSlot.attach(ticketB, artifactB.id), 'B 的当前 ticket 应可 attach 自己的 artifact');
integratedSlot.drop(ticketB);
assert(!recentCache.getArtifact(artifactB.id), '丢弃 B 应回收 B 自己的未消费 artifact');

const epochIntent = predictionIntent('old-epoch');
const oldEpochTicket = integratedSlot.replace(epochIntent, 8).ticket;
integratedSlot.drop(oldEpochTicket);
const oldEpochArtifact = addArtifact(epochIntent);
assert(oldEpochArtifact, '旧 epoch 迟到 artifact 应创建成功');
assert(integratedSlot.attach(oldEpochTicket, oldEpochArtifact.id) === null, '生命周期清理后旧 ticket 不得复活');
discardOwnedPredictionArtifact(oldEpochArtifact.id, oldEpochTicket);
assert(!recentCache.getArtifact(oldEpochArtifact.id), '生命周期清理后的精确迟到 artifact 应回收');

const ownerIntent = predictionIntent('owner-guard');
const owner = { intentId: ownerIntent.id, chatId: ownerIntent.chatId };
const correctShape = { purpose: 'prediction' as const, chatId: 'chat-a', sourceIntentId: ownerIntent.id };
assert(isPredictionArtifactOwnedBy(correctShape, owner), '完全匹配的 prediction artifact 应属于 ticket');
assert(
  !isPredictionArtifactOwnedBy({ ...correctShape, purpose: 'current' }, owner),
  'current artifact 不得归 prediction 所有',
);
assert(
  !isPredictionArtifactOwnedBy({ ...correctShape, purpose: 'gift' }, owner),
  'gift artifact 不得归 prediction 所有',
);
assert(
  !isPredictionArtifactOwnedBy({ ...correctShape, sourceIntentId: 'other-intent' }, owner),
  'sourceIntentId 不匹配不得归 prediction 所有',
);
assert(
  !isPredictionArtifactOwnedBy({ ...correctShape, chatId: 'chat-b' }, owner),
  'chatId 不匹配不得归 prediction 所有',
);

const currentArtifact = addArtifact(ownerIntent, 'current');
const giftArtifact = addArtifact(ownerIntent, 'gift');
const wrongSourceArtifact = addArtifact(ownerIntent, 'prediction', ownerIntent.chatId, 'other-intent');
const wrongChatArtifact = addArtifact(ownerIntent, 'prediction', 'chat-b');
assert(
  currentArtifact && giftArtifact && wrongSourceArtifact && wrongChatArtifact,
  'ownership 防护 artifacts 应创建成功',
);
[currentArtifact, giftArtifact, wrongSourceArtifact, wrongChatArtifact].forEach(item =>
  discardOwnedPredictionArtifact(item.id, owner),
);
assert(recentCache.getArtifact(currentArtifact.id), 'prediction 清理绝不能删除 current artifact');
assert(recentCache.getArtifact(giftArtifact.id), 'prediction 清理绝不能删除 gift artifact');
assert(recentCache.getArtifact(wrongSourceArtifact.id), 'prediction 清理绝不能删除其他 intent 的 artifact');
assert(recentCache.getArtifact(wrongChatArtifact.id), 'prediction 清理绝不能删除其他 chat 的 artifact');
recentCache.clear();

console.info('<杠杠の生图机> prediction slot tests passed');
