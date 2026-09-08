import { CUSTOM_ONLY_VOICE_EDITION } from './edition';
import type { VoiceAudit, VoiceAuditStatus, VoiceCleanupReason, VoiceEditionId } from './types';

const SAFE_CASTING_GENERATION_ID = /^ganggang-casting-\d+-\d+$/;
const SAFE_CLEANUP_REASONS = new Set<VoiceCleanupReason>([
  'user-stop',
  'replacement',
  'chat-change',
  'message-swipe',
  'message-edit',
  'message-delete',
  'pagehide',
  'unmount',
  'unknown',
]);
type AiCastingStatus = Exclude<VoiceAuditStatus, 'idle'>;

declare global {
  interface Window {
    __ganggangVoiceAudit?: VoiceAudit;
  }
}

function status(value: VoiceAuditStatus = 'idle'): VoiceAuditStatus {
  return value;
}

function emptyAiCastingAudit(): VoiceAudit['ai_casting'] {
  return { status: 'idle', count: 0, generation_id: null };
}

function emptyPlaybackTimelineAudit(): VoiceAudit['playback_timeline'] {
  return {
    status: 'idle',
    total_count: 0,
    speech_count: 0,
    sound_count: 0,
    completed_count: 0,
    skipped_sound_count: 0,
    active_kind: null,
    max_active: 0,
    remote_sound_count: 0,
    pinned_remote_sound_count: 0,
    trace: [],
  };
}

function emptyCleanupAudit(): VoiceAudit['cleanup'] {
  return { status: 'idle', reason: null, had_active_timeline: false };
}

function clonePlaybackTimelineAudit(timeline: VoiceAudit['playback_timeline']): VoiceAudit['playback_timeline'] {
  return { ...timeline, trace: [...timeline.trace] };
}

function safeCleanupReason(reason: VoiceCleanupReason): VoiceCleanupReason {
  return SAFE_CLEANUP_REASONS.has(reason) ? reason : 'unknown';
}

function safeCastingGenerationId(generationId: string): string | null {
  const value = typeof generationId === 'string' ? generationId.trim() : '';
  return SAFE_CASTING_GENERATION_ID.test(value) ? value : null;
}

function safeAuditVersion(version: string): string {
  const value = typeof version === 'string' ? version.trim() : '';
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value.slice(0, 32) : 'unknown';
}

function auditCount(value: number): number {
  return Number.isFinite(value) ? Math.min(32, Math.max(0, Math.floor(value))) : 0;
}

function createAudit(): VoiceAudit {
  return {
    version: CUSTOM_ONLY_VOICE_EDITION.version,
    edition: CUSTOM_ONLY_VOICE_EDITION.id,
    run_id: 0,
    action: 'idle',
    content_extracted: { status: status(), count: 0 },
    route_built: { status: status(), count: 0 },
    provider_ready: { status: status(), profile_id: null, network_verified: null },
    ai_casting: emptyAiCastingAudit(),
    sound_catalog: { status: status(), count: 0, sfx_count: 0, ambience_count: 0 },
    sound_effect: { status: status() },
    playback_timeline: emptyPlaybackTimelineAudit(),
    cleanup: emptyCleanupAudit(),
    request_cancelled: { status: status() },
    audio_played: { status: status(), item_id: null },
    recent_count: 0,
    last_error: null,
  };
}

export const voiceAudit = createAudit();

if (typeof window !== 'undefined') window.__ganggangVoiceAudit = voiceAudit;

export function setVoiceAuditBuild(edition: VoiceEditionId, version: string): void {
  voiceAudit.edition = edition === 'remote-catalog' ? 'remote-catalog' : 'custom-only';
  voiceAudit.version = safeAuditVersion(version);
}

export function beginVoiceAudit(action: string): number {
  voiceAudit.run_id += 1;
  voiceAudit.action = action;
  voiceAudit.content_extracted = { status: 'pending', count: 0 };
  voiceAudit.route_built = { status: 'pending', count: 0 };
  voiceAudit.provider_ready = { status: 'pending', profile_id: null, network_verified: null };
  voiceAudit.ai_casting = emptyAiCastingAudit();
  voiceAudit.sound_catalog = { status: 'idle', count: 0, sfx_count: 0, ambience_count: 0 };
  voiceAudit.sound_effect = { status: 'idle' };
  voiceAudit.playback_timeline = emptyPlaybackTimelineAudit();
  voiceAudit.cleanup = emptyCleanupAudit();
  voiceAudit.request_cancelled = { status: 'idle' };
  voiceAudit.audio_played = { status: 'pending', item_id: null };
  voiceAudit.last_error = null;
  return voiceAudit.run_id;
}

export function beginAiCastingAudit(generationId: string): number {
  const runId = beginVoiceAudit('ai-casting');
  voiceAudit.ai_casting = {
    status: 'pending',
    count: 0,
    generation_id: safeCastingGenerationId(generationId),
  };
  return runId;
}

export function markAiCasting(runId: number, nextStatus: AiCastingStatus, count = 0): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.ai_casting = {
    status: nextStatus,
    count: auditCount(count),
    generation_id: voiceAudit.ai_casting.generation_id,
  };
}

function beginSoundAudit(action: 'sound-catalog-load' | 'sound-effect-playback'): number {
  const runId = beginVoiceAudit(action);
  voiceAudit.content_extracted = { status: 'idle', count: 0 };
  voiceAudit.route_built = { status: 'idle', count: 0 };
  voiceAudit.provider_ready = { status: 'idle', profile_id: null, network_verified: null };
  voiceAudit.audio_played = { status: 'idle', item_id: null };
  return runId;
}

export function beginSoundCatalogAudit(): number {
  const runId = beginSoundAudit('sound-catalog-load');
  voiceAudit.sound_catalog.status = 'pending';
  return runId;
}

export function beginSoundEffectAudit(): number {
  const runId = beginSoundAudit('sound-effect-playback');
  voiceAudit.sound_effect.status = 'pending';
  return runId;
}

export function markSoundCatalog(
  runId: number,
  nextStatus: 'success' | 'fail',
  count = 0,
  sfxCount = 0,
  ambienceCount = 0,
): void {
  if (!isCurrentAuditRun(runId)) return;
  const bounded = (value: number) => (Number.isFinite(value) ? Math.min(512, Math.max(0, Math.floor(value))) : 0);
  voiceAudit.sound_catalog = {
    status: nextStatus,
    count: bounded(count),
    sfx_count: bounded(sfxCount),
    ambience_count: bounded(ambienceCount),
  };
  if (nextStatus === 'fail') voiceAudit.last_error = '音效目录读取失败';
}

export function markSoundEffect(runId: number, nextStatus: 'success' | 'fail'): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.sound_effect.status = nextStatus;
  if (nextStatus === 'fail') voiceAudit.last_error = '音效播放失败';
}

type PlaybackTimelineKind = 'speech' | 'sound';
type PlaybackTimelinePhase = 'start' | 'end' | 'skip';

function appendTimelineTrace(event: VoiceAudit['playback_timeline']['trace'][number]): void {
  if (voiceAudit.playback_timeline.trace.length < 24) voiceAudit.playback_timeline.trace.push(event);
}

export function markPlaybackTimelineBuilt(
  runId: number,
  counts: {
    speechCount: number;
    soundCount: number;
    ignoredSoundCount?: number;
    remoteSoundCount?: number;
    pinnedRemoteSoundCount?: number;
  },
): void {
  if (!isCurrentAuditRun(runId)) return;
  const speechCount = auditCount(counts.speechCount);
  const soundCount = auditCount(counts.soundCount);
  voiceAudit.playback_timeline = {
    ...emptyPlaybackTimelineAudit(),
    status: 'pending',
    total_count: auditCount(speechCount + soundCount),
    speech_count: speechCount,
    sound_count: soundCount,
    skipped_sound_count: auditCount(counts.ignoredSoundCount ?? 0),
    remote_sound_count: Math.min(soundCount, auditCount(counts.remoteSoundCount ?? 0)),
    pinned_remote_sound_count: Math.min(soundCount, auditCount(counts.pinnedRemoteSoundCount ?? 0)),
  };
  voiceAudit.sound_effect.status = soundCount > 0 ? 'pending' : 'idle';
}

export function markPlaybackTimelineStep(
  runId: number,
  kind: PlaybackTimelineKind,
  phase: PlaybackTimelinePhase,
): void {
  if (!isCurrentAuditRun(runId) || voiceAudit.playback_timeline.status !== 'pending') return;
  const timeline = voiceAudit.playback_timeline;
  if (phase === 'start') {
    timeline.max_active = Math.max(timeline.max_active, timeline.active_kind === null ? 1 : 2);
    timeline.active_kind = kind;
    appendTimelineTrace(`${kind}-start`);
    return;
  }
  timeline.completed_count = auditCount(timeline.completed_count + 1);
  timeline.active_kind = null;
  if (kind === 'sound' && phase === 'skip') {
    timeline.skipped_sound_count = auditCount(timeline.skipped_sound_count + 1);
    voiceAudit.sound_effect.status = 'fail';
    appendTimelineTrace('sound-skip');
    return;
  }
  if (kind === 'sound') voiceAudit.sound_effect.status = 'success';
  appendTimelineTrace(`${kind}-end`);
}

export function markPlaybackTimelineComplete(runId: number): void {
  if (!isCurrentAuditRun(runId) || voiceAudit.playback_timeline.status !== 'pending') return;
  voiceAudit.playback_timeline.status = 'success';
  voiceAudit.playback_timeline.active_kind = null;
}

export function isCurrentAuditRun(runId: number): boolean {
  return voiceAudit.run_id === runId;
}

export function beginVoiceCleanupAudit(reason: VoiceCleanupReason, castingGenerationId: string | null = null): number {
  const previousTimeline =
    voiceAudit.playback_timeline.status === 'pending' ? clonePlaybackTimelineAudit(voiceAudit.playback_timeline) : null;
  const runId = beginVoiceAudit('cleanup');
  voiceAudit.content_extracted = { status: 'idle', count: 0 };
  voiceAudit.route_built = { status: 'idle', count: 0 };
  voiceAudit.provider_ready = { status: 'idle', profile_id: null, network_verified: null };
  voiceAudit.audio_played = { status: 'pending', item_id: null };
  voiceAudit.request_cancelled = { status: 'pending' };
  voiceAudit.cleanup = {
    status: 'pending',
    reason: safeCleanupReason(reason),
    had_active_timeline: previousTimeline !== null,
  };
  if (castingGenerationId) {
    voiceAudit.ai_casting = {
      status: 'pending',
      count: 0,
      generation_id: safeCastingGenerationId(castingGenerationId),
    };
  }
  if (previousTimeline) voiceAudit.playback_timeline = previousTimeline;
  return runId;
}

export function markVoiceCleanup(runId: number, succeeded = true): void {
  if (!isCurrentAuditRun(runId) || voiceAudit.cleanup.status !== 'pending') return;
  voiceAudit.cleanup.status = succeeded ? 'success' : 'fail';
  markRequestCancelled(runId, succeeded ? 'success' : 'fail');
}

export function markContentExtracted(runId: number, count: number): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.content_extracted = { status: 'success', count };
}

export function markRouteBuilt(runId: number, count: number): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.route_built = { status: 'success', count };
}

export function markProviderReady(runId: number, profileId: string, networkVerified = true): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.provider_ready = { status: 'success', profile_id: profileId, network_verified: networkVerified };
}

export function markProviderFailed(runId: number, profileId: string): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.provider_ready = { status: 'fail', profile_id: profileId, network_verified: false };
}

export function markRequestCancelled(runId: number, nextStatus: 'success' | 'fail' = 'success'): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.request_cancelled = { status: nextStatus };
  if (nextStatus === 'success') {
    voiceAudit.audio_played = { status: 'cancelled', item_id: null };
    if (voiceAudit.playback_timeline.status === 'pending') {
      voiceAudit.playback_timeline.status = 'cancelled';
      voiceAudit.playback_timeline.active_kind = null;
      appendTimelineTrace('cancelled');
    }
  }
}

export function markCastingStopped(runId: number, stopped: boolean): void {
  markAiCasting(runId, stopped ? 'cancelled' : 'fail');
  markRequestCancelled(runId, stopped ? 'success' : 'fail');
}

export function markAudioPlayed(runId: number, itemId: string): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.audio_played = { status: 'success', item_id: itemId };
}

export function markRecentCount(count: number): void {
  voiceAudit.recent_count = count;
}

export function markVoiceAuditError(runId: number, _error: unknown): void {
  if (!isCurrentAuditRun(runId)) return;
  voiceAudit.last_error = 'operation-failed';
  if (voiceAudit.content_extracted.status === 'pending') voiceAudit.content_extracted.status = 'fail';
  if (voiceAudit.route_built.status === 'pending') voiceAudit.route_built.status = 'fail';
  if (voiceAudit.provider_ready.status === 'pending') voiceAudit.provider_ready.status = 'fail';
  if (voiceAudit.playback_timeline.status === 'pending') {
    voiceAudit.playback_timeline.status = 'fail';
    voiceAudit.playback_timeline.active_kind = null;
  }
  if (voiceAudit.audio_played.status !== 'cancelled') voiceAudit.audio_played.status = 'fail';
}
