import {
  ImageRetention,
  imageRetentionMessageImageKey,
  imageRetentionScopeKey,
  type ImageRetentionScope,
} from '../src/杠杠の生图机/image-retention';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const scope = (swipeId: number): ImageRetentionScope => ({
  chatId: 'chat',
  messageId: 4,
  swipeId,
  imageIndex: 0,
});

function testManualPinSequenceWinsAcrossSwipes(): void {
  const retention = new ImageRetention();
  const first = scope(0);
  const second = scope(1);
  retention.pin(first, 'placement-a');
  retention.pin(second, 'placement-b');

  const latest = retention.latestManualSelection(
    first,
    [
      { id: 'placement-a', scope: first },
      { id: 'placement-b', scope: second },
    ],
  );
  assert(latest?.placementId === 'placement-b', '跨 Swipe 手动固定应按单调序号选择最后一次固定');
  assert(retention.isPinned('placement-a'), '早期手动固定状态在清理前应仍可识别');
  assert(retention.isPinned('placement-b'), '最新手动固定状态应可识别');
}

function testPlacementIdentitySurvivesMessageIndexShift(): void {
  const retention = new ImageRetention();
  retention.pin(scope(0), 'stable-placement');
  const shifted = { ...scope(0), messageId: 2 };
  const latest = retention.latestManualSelection(
    shifted,
    [{ id: 'stable-placement', scope: shifted }],
  );
  assert(latest?.placementId === 'stable-placement', '消息序号变化后应按 placement 身份重新读取固定状态');
  assert(imageRetentionScopeKey(shifted) === 'chat::2::0::0', 'scope key 应包含当前消息身份');
  assert(imageRetentionMessageImageKey(shifted) === 'chat::2::0', '跨 Swipe 自动 scope 应合并同楼同位置');
}

function testDeferredTaskStateIsOneShotAndBounded(): void {
  const retention = new ImageRetention();
  const pending = scope(2);
  retention.invalidate(pending);
  const token = retention.token(pending);
  retention.defer(pending);
  assert(retention.isDeferred(pending), 'pending 首图应可记录一次性保留许可');
  assert(retention.consumeDeferred(pending), '一次性保留许可应只消费一次');
  assert(!retention.consumeDeferred(pending), '一次性保留许可消费后不得重复使用');
  retention.forgetScope(pending);
  assert(retention.token(pending) === 0, 'scope 完成清理后 token 状态应释放');
  assert(token === 1, 'invalidate 应只产生当前 scope 的失效版本');
}

function testMoveScopeTransfersDeferredState(): void {
  const retention = new ImageRetention();
  const oldScope = scope(1);
  const nextScope = scope(0);
  retention.invalidate(oldScope);
  retention.defer(oldScope);
  retention.moveScope(oldScope, nextScope);

  assert(!retention.isDeferred(oldScope), 'Swipe 删除后旧 scope 不得继续保留 deferred 状态');
  assert(retention.isDeferred(nextScope), '迁移后的 task scope 应继续拥有一次 deferred 保留许可');
  assert(retention.token(oldScope) === 0, '迁移后旧 scope token 应释放');
  assert(retention.token(nextScope) === 1, '迁移后新 scope 应接管旧 token');
  assert(retention.consumeDeferred(nextScope), '迁移后的 deferred 状态应可被原 task 消费');
  assert(!retention.isDeferred(nextScope), '原 task 消费后新 scope 不得残留 deferred 状态');
}

testManualPinSequenceWinsAcrossSwipes();
testPlacementIdentitySurvivesMessageIndexShift();
testDeferredTaskStateIsOneShotAndBounded();
testMoveScopeTransfersDeferredState();
console.info('<杠杠の生图机> retention tests passed');
