import {
  beginVoiceAudit,
  beginVoiceCleanupAudit,
  markPlaybackTimelineBuilt,
  markPlaybackTimelineStep,
  markVoiceCleanup,
  voiceAudit,
} from '../src/杠杠の配音台/audit';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) throw new Error(`${message}\nactual: ${actualText}\nexpected: ${expectedText}`);
}

const playbackRun = beginVoiceAudit('message-playback');
markPlaybackTimelineBuilt(playbackRun, { speechCount: 2, soundCount: 1 });
markPlaybackTimelineStep(playbackRun, 'speech', 'start');
markPlaybackTimelineStep(playbackRun, 'speech', 'end');
markPlaybackTimelineStep(playbackRun, 'sound', 'start');

const cleanupRun = beginVoiceCleanupAudit('message-swipe');
equal(voiceAudit.action, 'cleanup', '清理动作应使用固定 action');
equal(
  voiceAudit.cleanup,
  { status: 'pending', reason: 'message-swipe', had_active_timeline: true },
  '清理 Audit 应记录白名单原因和是否中断活动时间线',
);
equal(voiceAudit.playback_timeline.status, 'pending', '完成清理前应保留上一轮 pending 时间线');
equal(
  voiceAudit.playback_timeline.trace,
  ['speech-start', 'speech-end', 'sound-start'],
  '清理 Audit 应保留被中断时间线的小型执行证据',
);

markVoiceCleanup(cleanupRun);
equal(voiceAudit.cleanup.status, 'success', '资源清理成功应可观察');
equal(voiceAudit.request_cancelled.status, 'success', '资源清理成功应标记请求已取消');
equal(voiceAudit.audio_played.status, 'cancelled', '资源清理成功应标记播放已取消');
equal(voiceAudit.playback_timeline.status, 'cancelled', '被中断时间线应标记 cancelled');
equal(
  voiceAudit.playback_timeline.trace,
  ['speech-start', 'speech-end', 'sound-start', 'cancelled'],
  '被中断时间线应留下 cancelled 终点',
);

markPlaybackTimelineStep(playbackRun, 'sound', 'end');
equal(
  voiceAudit.playback_timeline.trace,
  ['speech-start', 'speech-end', 'sound-start', 'cancelled'],
  '旧 run 的晚到事件不得污染清理 Audit',
);

const nextRun = beginVoiceAudit('selection-playback');
markVoiceCleanup(cleanupRun, false);
equal(voiceAudit.run_id, nextRun, '新动作应推进 run_id');
equal(voiceAudit.cleanup, { status: 'idle', reason: null, had_active_timeline: false }, '新动作应重置清理状态');
equal(voiceAudit.request_cancelled.status, 'idle', '旧清理 run 的晚到结果不得污染新动作');

const idleCleanupRun = beginVoiceCleanupAudit('user-stop');
markVoiceCleanup(idleCleanupRun);
equal(voiceAudit.cleanup.had_active_timeline, false, '无活动时间线时不得伪造中断证据');

const castingGenerationId = 'ganggang-casting-123-456';
const castingCleanupRun = beginVoiceCleanupAudit('replacement', castingGenerationId);
equal(
  voiceAudit.ai_casting,
  { status: 'pending', count: 0, generation_id: castingGenerationId },
  '清理活动中的 AI 配音时应保留脱敏 generation id 供取消状态闭环',
);
markVoiceCleanup(castingCleanupRun);

const sensitiveReason = 'apiKey=https://secret.invalid/chat-text';
const unsafeCleanupRun = beginVoiceCleanupAudit(sensitiveReason as never);
markVoiceCleanup(unsafeCleanupRun);
equal(voiceAudit.cleanup.reason, 'unknown', '运行时传入的非白名单原因必须归一化');
assert(!JSON.stringify(voiceAudit).includes(sensitiveReason), '清理 Audit 不得回显任意原因正文');

console.info('<杠杠の配音台> audit cleanup tests passed');
