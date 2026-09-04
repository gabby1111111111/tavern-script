import {
  clearLastErrorIfUnchanged,
  notifyGiftArrivalOnce,
  runReceivedInlineMessageEffects,
  shouldRenderInlineTask,
  shouldProcessReceivedInlineMessage,
  type GiftArrivalNoticeAudit,
  type GiftArrivalNoticeReadiness,
} from '../src/杠杠の生图机/runtime';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(!shouldProcessReceivedInlineMessage(false), '关闭随文生图时不得扫描或持久清理收到的消息');
assert(!shouldProcessReceivedInlineMessage(undefined), '设置尚未就绪时不得处理收到的消息');
assert(shouldProcessReceivedInlineMessage(true), '开启随文生图时应保留原有消息处理流程');

assert(shouldRenderInlineTask('inline', 'pending'), '随文任务等待请求时应显示占位');
assert(shouldRenderInlineTask('inline', 'running'), '随文任务请求进行中应显示占位');
assert(!shouldRenderInlineTask('inline', 'success'), '随文任务成功后不得继续保留占位');
assert(!shouldRenderInlineTask('inline', 'failed'), '随文任务失败后不得留下失败占位');
assert(!shouldRenderInlineTask('gift', 'pending'), '礼物任务等待请求时不应显示随文占位');

let giftEventCount = 0;
const inlineEventEffects: string[] = [];
const exerciseMessageReceived = (inlineEnabled: boolean | undefined): boolean => {
  giftEventCount += 1;
  return runReceivedInlineMessageEffects(inlineEnabled, () => {
    inlineEventEffects.push('scanMarkers', 'startMarkerTasks', 'cleanMessage', 'setChatMessages');
  });
};
assert(!exerciseMessageReceived(false), '关闭随文插图时 MESSAGE_RECEIVED 应跳过整个随文副作用处理体');
assert(giftEventCount === 1, '关闭随文插图不得阻断独立的礼物事件链路');
assert(inlineEventEffects.length === 0, '关闭随文插图不得扫描、启动随文任务、清理或回写正文');
assert(exerciseMessageReceived(true), '开启随文插图时 MESSAGE_RECEIVED 应保留既有随文处理体');
assert(giftEventCount === 2, '开启随文插图时礼物事件链路仍应只处理一次');
assert(
  inlineEventEffects.join(',') === 'scanMarkers,startMarkerTasks,cleanMessage,setChatMessages',
  '开启随文插图时不得吞掉扫描、任务、清理或回写流程',
);

const staleFailure = { last_error: '礼物 CG 请求失败 (503)' };
assert(clearLastErrorIfUnchanged(staleFailure, 1, 1), '成功边界应清理任务开始前留下的旧错误');
assert(staleFailure.last_error === null, '礼物 CG 成功后 last_error 应恢复为空');

const newerFailure = { last_error: '并发图片任务失败' };
assert(!clearLastErrorIfUnchanged(newerFailure, 1, 2), '成功边界不应清理任务运行期间出现的新错误');
assert(newerFailure.last_error === '并发图片任务失败', '并发新错误应继续保留在审计中');

function attemptNotice(
  readiness: GiftArrivalNoticeReadiness,
  notify: () => void,
): { attempted: boolean; audit: GiftArrivalNoticeAudit } {
  const task = {};
  const audit: GiftArrivalNoticeAudit = { status: 'pending', shown: false };
  const attempted = notifyGiftArrivalOnce(task, readiness, new WeakSet(), audit, notify);
  return { attempted, audit };
}

const ready = { currentTask: true, artifactCached: true, giftSucceeded: true } satisfies GiftArrivalNoticeReadiness;
for (const blocked of [
  { ...ready, currentTask: false },
  { ...ready, artifactCached: false },
  { ...ready, giftSucceeded: false },
]) {
  let notifyCount = 0;
  const result = attemptNotice(blocked, () => {
    notifyCount += 1;
  });
  assert(!result.attempted, '任一成功前置条件不满足时都不应尝试到达提示');
  assert(notifyCount === 0, '未就绪礼物任务不得调用 notifier');
  assert(result.audit.status === 'skipped' && !result.audit.shown, '未就绪提示审计应只记录安全跳过摘要');
}

const successfulTask = {};
const successfulAttempts = new WeakSet<object>();
const successfulNotice: GiftArrivalNoticeAudit = { status: 'pending', shown: false };
let successfulNotifyCount = 0;
assert(
  notifyGiftArrivalOnce(successfulTask, ready, successfulAttempts, successfulNotice, () => {
    successfulNotifyCount += 1;
  }),
  '当前任务、内存缓存和礼物成功审计都就绪后应尝试一次提示',
);
assert(successfulNotifyCount === 1, '成功礼物任务应显示一次到达提示');
assert(successfulNotice.status === 'success' && successfulNotice.shown, '成功提示应留下最小成功摘要');
assert(
  !notifyGiftArrivalOnce(successfulTask, ready, successfulAttempts, successfulNotice, () => {
    successfulNotifyCount += 1;
  }),
  '同一礼物任务不得重复提示',
);
assert(successfulNotifyCount === 1, '重复调用不能再次触发 notifier');

const throwingNotice: GiftArrivalNoticeAudit = { status: 'pending', shown: false };
const protectedImageState = { taskStatus: 'success', giftStatus: 'success', last_error: null as string | null };
assert(
  notifyGiftArrivalOnce({}, ready, new WeakSet(), throwingNotice, () => {
    throw new Error('toastr unavailable');
  }),
  '抛错 notifier 仍应算作本任务的一次提示尝试',
);
assert(throwingNotice.status === 'fail' && !throwingNotice.shown, 'notifier 抛错只应标记独立提示摘要失败');
assert(
  protectedImageState.taskStatus === 'success' &&
    protectedImageState.giftStatus === 'success' &&
    protectedImageState.last_error === null,
  'notifier 抛错不得污染图片成功状态或 last_error',
);
assert(
  Object.keys(throwingNotice).sort().join(',') === 'shown,status',
  'arrival_notice 只能暴露状态与是否显示，不得携带 URL、Base64、提示词、密钥或响应',
);

console.info('<杠杠の生图机> audit error boundary tests passed');
