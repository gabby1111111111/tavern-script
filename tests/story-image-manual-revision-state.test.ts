import {
  commitManualRevisionFailure,
  createEmptyAudit,
  deriveRuntimeStatusState,
  settleManualRevisionAudit,
  shouldRemovePlacementForRecentReason,
} from '../src/杠杠の生图机/runtime';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const audit = createEmptyAudit();
audit.generation = { id: 'failure', status: 'running' };
audit.last_error = 'failed';
assert(settleManualRevisionAudit(audit, 'failure', 'fail', 0, 1), '当前失败应结算');
assert(audit.generation.status === 'fail', '当前失败应进入 fail');

audit.generation = { id: 'recovery', status: 'running' };
assert(settleManualRevisionAudit(audit, 'recovery', 'success', 1, 1), '后续成功应结算');
assert(audit.generation.status === 'success', '后续成功应进入 success');
assert(audit.last_error === null, '期间没有新错误时成功应清除旧错误');

audit.generation = { id: 'newer', status: 'running' };
assert(!settleManualRevisionAudit(audit, 'older', 'success', 1, 1), '旧请求不得结算新请求');
assert(audit.generation.id === 'newer' && audit.generation.status === 'running', '并发乱序不得覆盖较新审计');

audit.last_error = 'pre-existing';
let errorRevision = 1;
assert(
  !commitManualRevisionFailure(audit, 'older', () => {
    errorRevision += 1;
    audit.last_error = 'older failure';
  }),
  '新请求开始后，旧请求失败不得提交全局错误',
);
assert(errorRevision === 1 && audit.last_error === 'pre-existing', '旧失败不得污染 error revision 或 last_error');
assert(settleManualRevisionAudit(audit, 'newer', 'success', 1, errorRevision), '较新请求仍应成功结算');
assert((audit.generation.status as string) === 'success' && audit.last_error === null, '较新成功应清除启动前已有的旧错误');

audit.generation = { id: 'newer', status: 'running' };

assert(
  deriveRuntimeStatusState({
    stopped: false,
    activeTask: false,
    activeManualRevisions: 2,
    hasError: true,
    hasReadyContent: true,
  }) === 'generating',
  '任一手动重绘仍在进行时整体状态必须为 generating',
);

assert(settleManualRevisionAudit(audit, 'newer', 'cancelled', 1, 1), '当前取消应立即结算');
assert(audit.generation.id === null && audit.generation.status === 'pending', '取消不得让审计永久停在 running');
assert(
  deriveRuntimeStatusState({
    stopped: false,
    activeTask: false,
    activeManualRevisions: 0,
    hasError: false,
    hasReadyContent: true,
  }) === 'ready',
  '取消最后一个请求后，已有内容时应恢复 ready',
);

assert(shouldRemovePlacementForRecentReason('explicit'), '用户显式删除 recent 时应同步删除正文版本');
assert(!shouldRemovePlacementForRecentReason('evicted'), 'recent 容量淘汰不得删除正文版本');
assert(!shouldRemovePlacementForRecentReason('cleared'), '整体清理由 reset 自己负责清理正文版本');

console.info('<杠杠の生图机> manual revision state tests passed');
