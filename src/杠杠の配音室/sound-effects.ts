import type { SoundCue, SoundEffectEntry, SpokenSegment } from './types';

export const MAX_SOUND_CUES_PER_MESSAGE = 24;

export type SoundCueValidation = {
  cue: SoundCue | null;
  error: string | null;
};

export type SoundCueParseResult = {
  cues: SoundCue[];
  errors: string[];
};

export type SoundCueParseOptions = {
  sourceMessageId?: number | null;
  sourceSegments?: readonly SpokenSegment[];
  maxCues?: number;
};

export type SoundEffectPlayerOptions = {
  audioFactory?: () => HTMLAudioElement;
};

export type SoundEffectPlaybackResult = {
  effectId: string | null;
  played: boolean;
  error?: string;
};

export type SoundEffectPlaybackOutcome = 'ended' | 'failed' | 'cancelled';

export type SoundEffectCompletionResult = SoundEffectPlaybackResult & {
  outcome: SoundEffectPlaybackOutcome;
};

type ActiveEffectPlayback = {
  effectId: string;
  token: number;
  audio: HTMLAudioElement;
  onEnded: () => void;
  onError: () => void;
  completion: Promise<{ outcome: SoundEffectPlaybackOutcome; error?: string }>;
  resolveCompletion: (result: { outcome: SoundEffectPlaybackOutcome; error?: string }) => void;
  outcome: SoundEffectPlaybackOutcome | null;
};

function defaultAudioFactory(): HTMLAudioElement {
  const AudioConstructor = globalThis.Audio;
  if (typeof AudioConstructor !== 'function') {
    throw new Error('当前环境没有可用的 HTMLAudioElement');
  }
  return new AudioConstructor();
}

function textValue(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 300);
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 300);
  return '音效播放失败';
}

function normalizeCueInput(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const cues = (value as { cues?: unknown }).cues;
    if (Array.isArray(cues)) return cues;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      return normalizeCueInput(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function cueId(value: unknown, index: number): string {
  const explicit = textValue(value, 100);
  return explicit || `sound-cue-${index + 1}`;
}

function occurrenceIndex(text: string, anchor: string, occurrence: number): number {
  let from = 0;
  for (let current = 0; current <= occurrence; current += 1) {
    const index = text.indexOf(anchor, from);
    if (index < 0) return -1;
    if (current === occurrence) return index;
    from = index + Math.max(1, anchor.length);
  }
  return -1;
}

/** Find an enabled catalog entry by its stable effect id. */
export function findSoundEffect(catalog: readonly SoundEffectEntry[], effectId: string): SoundEffectEntry | null {
  const normalizedId = textValue(effectId, 160);
  if (!normalizedId) return null;
  return catalog.find(entry => entry.id === normalizedId && entry.enabled && Boolean(entry.url.trim())) ?? null;
}

/**
 * Validate one AI-produced cue against the local effect catalog.
 * This only returns metadata; it never edits the source message or the chat record.
 */
export function validateSoundCue(
  value: unknown,
  catalog: readonly SoundEffectEntry[],
  options: SoundCueParseOptions = {},
): SoundCueValidation {
  if (typeof value !== 'object' || value === null) return { cue: null, error: '音效标记不是对象' };
  const record = value as Record<string, unknown>;
  const effectId = textValue(record.effectId ?? record.effect_id, 160);
  if (!effectId) return { cue: null, error: '缺少 effectId' };
  if (!findSoundEffect(catalog, effectId)) return { cue: null, error: `音效不存在或已禁用：${effectId}` };

  const anchorText = textValue(record.anchorText ?? record.anchor_text, 400);
  if (!anchorText) return { cue: null, error: `音效 ${effectId} 缺少 anchorText` };
  const sourceSegmentId = textValue(record.sourceSegmentId ?? record.source_segment_id, 160) || null;
  const rawAnchorOccurrence = record.anchorOccurrence ?? record.anchor_occurrence;
  const anchorOccurrence = rawAnchorOccurrence === undefined ? 0 : numberValue(rawAnchorOccurrence);
  if (anchorOccurrence === null || anchorOccurrence < 0 || anchorOccurrence > 31) {
    return { cue: null, error: `音效 ${effectId} 的 anchorOccurrence 无效` };
  }

  const placement = record.placement;
  if (placement !== 'before' && placement !== 'after') {
    return { cue: null, error: `音效 ${effectId} 的 placement 无效` };
  }

  const rawMessageId = record.sourceMessageId ?? record.source_message_id;
  const sourceMessageId =
    rawMessageId === null
      ? null
      : (numberValue(rawMessageId) ?? (options.sourceMessageId === undefined ? null : options.sourceMessageId));
  if (sourceMessageId !== null && sourceMessageId !== undefined && sourceMessageId < 0) {
    return { cue: null, error: `音效 ${effectId} 的 sourceMessageId 无效` };
  }
  if (options.sourceSegments) {
    const sourceSegment = options.sourceSegments.find(segment => segment.id === sourceSegmentId);
    if (!sourceSegment) return { cue: null, error: `音效 ${effectId} 的 sourceSegmentId 无效` };
    if (sourceSegment.sourceMessageId !== (sourceMessageId ?? null)) {
      return { cue: null, error: `音效 ${effectId} 的来源楼层与语音段不一致` };
    }
    if (occurrenceIndex(sourceSegment.text, anchorText, anchorOccurrence) < 0) {
      return { cue: null, error: `音效 ${effectId} 的锚点不在指定语音段中` };
    }
  }

  return {
    cue: {
      id: cueId(record.id ?? record.cueId ?? record.cue_id, 0),
      effectId,
      sourceMessageId: sourceMessageId ?? null,
      sourceSegmentId,
      anchorText,
      anchorOccurrence,
      placement,
    },
    error: null,
  };
}

/** Parse and validate a JSON array (or { cues: [] }) returned by an AI casting/read-aloud pass. */
export function parseSoundCuesDetailed(
  input: unknown,
  catalog: readonly SoundEffectEntry[],
  options: SoundCueParseOptions = {},
): SoundCueParseResult {
  const values = normalizeCueInput(input);
  const maxCues = Math.max(0, Math.floor(options.maxCues ?? MAX_SOUND_CUES_PER_MESSAGE));
  const cues: SoundCue[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const [index, value] of values.slice(0, maxCues).entries()) {
    const result = validateSoundCue(value, catalog, options);
    if (!result.cue) {
      errors.push(`第 ${index + 1} 项：${result.error ?? '音效标记无效'}`);
      continue;
    }
    let stableId = result.cue.id;
    if (ids.has(stableId)) stableId = `${stableId}-${index + 1}`;
    ids.add(stableId);
    cues.push({ ...result.cue, id: stableId });
  }
  if (values.length > maxCues) errors.push(`音效标记超过上限 ${maxCues}，多余项目已忽略`);
  return { cues, errors };
}

export function parseSoundCues(
  input: unknown,
  catalog: readonly SoundEffectEntry[],
  options: SoundCueParseOptions = {},
): SoundCue[] {
  return parseSoundCuesDetailed(input, catalog, options).cues;
}

export function isSoundCueValid(value: unknown, catalog: readonly SoundEffectEntry[]): value is SoundCue {
  return validateSoundCue(value, catalog).cue !== null;
}

/**
 * Independent one-channel effect player. It intentionally does not call Tavern Helper audio
 * helpers or any shared mixer channel.
 */
export class SoundEffectPlayer {
  private readonly audioFactory: () => HTMLAudioElement;
  private audio: HTMLAudioElement | null = null;
  private active: ActiveEffectPlayback | null = null;
  private sequence = 0;
  private catalog: readonly SoundEffectEntry[];

  constructor(catalog: readonly SoundEffectEntry[] = [], options: SoundEffectPlayerOptions = {}) {
    this.catalog = catalog;
    this.audioFactory = options.audioFactory ?? defaultAudioFactory;
  }

  setCatalog(catalog: readonly SoundEffectEntry[]): void {
    this.catalog = catalog;
  }

  get activeEffectId(): string | null {
    return this.active?.effectId ?? null;
  }

  async play(effectId: string, catalog = this.catalog): Promise<SoundEffectPlaybackResult> {
    return (await this.startEffect(effectId, catalog)).result;
  }

  async playCueToEnd(cue: SoundCue, catalog = this.catalog): Promise<SoundEffectCompletionResult> {
    const validation = validateSoundCue(cue, catalog);
    if (!validation.cue) {
      return {
        effectId: cue.effectId ?? null,
        played: false,
        outcome: 'failed',
        error: validation.error ?? '音效标记无效',
      };
    }
    const started = await this.startEffect(validation.cue.effectId, catalog);
    if (!started.active) return { ...started.result, outcome: 'failed' };
    const completion = await started.active.completion;
    return {
      effectId: started.result.effectId,
      played: started.result.played,
      outcome: completion.outcome,
      ...(completion.error ? { error: completion.error } : {}),
    };
  }

  private async startEffect(
    effectId: string,
    catalog = this.catalog,
  ): Promise<{ result: SoundEffectPlaybackResult; active: ActiveEffectPlayback | null }> {
    const entry = findSoundEffect(catalog, effectId);
    if (!entry) {
      return {
        result: { effectId, played: false, error: '音效不存在、未启用或没有音频地址' },
        active: null,
      };
    }
    this.catalog = catalog;
    this.stop();

    let audio: HTMLAudioElement;
    try {
      audio = this.getAudio();
    } catch (error) {
      return { result: { effectId: entry.id, played: false, error: errorMessage(error) }, active: null };
    }
    const token = ++this.sequence;
    let resolveCompletion!: (result: { outcome: SoundEffectPlaybackOutcome; error?: string }) => void;
    const completion = new Promise<{ outcome: SoundEffectPlaybackOutcome; error?: string }>(resolve => {
      resolveCompletion = resolve;
    });
    const active: ActiveEffectPlayback = {
      effectId: entry.id,
      token,
      audio,
      onEnded: () => this.handleEnded(active),
      onError: () => this.handleError(active),
      completion,
      resolveCompletion,
      outcome: null,
    };
    this.active = active;
    audio.addEventListener('ended', active.onEnded);
    audio.addEventListener('error', active.onError);
    audio.src = entry.url;
    audio.currentTime = 0;
    const volume = Number.isFinite(entry.volume) ? Math.min(1, Math.max(0, entry.volume)) : 1;
    audio.volume = volume;

    let playPromise: Promise<void>;
    try {
      playPromise = audio.play();
    } catch (error) {
      const message = errorMessage(error);
      if (this.isCurrent(active)) this.finishActive(active, 'failed', message);
      return { result: { effectId: entry.id, played: false, error: message }, active };
    }
    let playStarted = false;
    const startResult = await Promise.race([
      playPromise.then(
        () => {
          playStarted = true;
          return { kind: 'started' as const };
        },
        error => ({ kind: 'failed' as const, error }),
      ),
      active.completion.then(completion => ({ kind: 'completed' as const, completion })),
    ]);
    if (startResult.kind === 'completed') {
      return {
        result: {
          effectId: entry.id,
          played: startResult.completion.outcome !== 'cancelled' || playStarted,
          ...(startResult.completion.error ? { error: startResult.completion.error } : {}),
        },
        active,
      };
    }
    if (startResult.kind === 'failed') {
      if (active.outcome) {
        return {
          result: {
            effectId: entry.id,
            played: active.outcome !== 'cancelled',
            ...(active.outcome === 'failed' ? { error: '音效播放失败' } : {}),
          },
          active,
        };
      }
      const message = errorMessage(startResult.error);
      if (this.isCurrent(active)) this.finishActive(active, 'failed', message);
      return { result: { effectId: entry.id, played: false, error: message }, active };
    }
    if (active.outcome === 'ended') return { result: { effectId: entry.id, played: true }, active };
    if (active.outcome) {
      return {
        result: {
          effectId: entry.id,
          played: active.outcome !== 'cancelled' || playStarted,
          error: active.outcome === 'failed' ? '音效播放失败' : undefined,
        },
        active,
      };
    }
    if (!this.isCurrent(active) || active.audio.paused) {
      if (this.isCurrent(active)) this.finishActive(active, 'cancelled');
      return { result: { effectId: entry.id, played: false, error: '音效播放已被替换或停止' }, active };
    }
    return { result: { effectId: entry.id, played: true }, active };
  }

  async playCue(cue: SoundCue, catalog = this.catalog): Promise<SoundEffectPlaybackResult> {
    const validation = validateSoundCue(cue, catalog);
    if (!validation.cue)
      return { effectId: cue.effectId ?? null, played: false, error: validation.error ?? '音效标记无效' };
    return this.play(validation.cue.effectId, catalog);
  }

  stop(): boolean {
    const active = this.active;
    if (!active) return false;
    this.finishActive(active, 'cancelled');
    return true;
  }

  unload(): void {
    this.stop();
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load?.();
      } catch {
        // Best-effort cleanup for browser media and injected test doubles.
      }
    }
    this.audio = null;
  }

  dispose(): void {
    this.unload();
  }

  private getAudio(): HTMLAudioElement {
    if (!this.audio) this.audio = this.audioFactory();
    return this.audio;
  }

  private isCurrent(active: ActiveEffectPlayback): boolean {
    return this.active?.token === active.token && this.active.audio === active.audio;
  }

  private finishActive(active: ActiveEffectPlayback, outcome: SoundEffectPlaybackOutcome, error?: string): void {
    if (active.outcome) return;
    active.outcome = outcome;
    active.audio.removeEventListener('ended', active.onEnded);
    active.audio.removeEventListener('error', active.onError);
    if (this.isCurrent(active)) this.active = null;
    try {
      active.audio.pause();
      active.audio.removeAttribute('src');
      active.audio.load?.();
    } catch {
      // Best-effort cleanup.
    }
    active.resolveCompletion({ outcome, ...(error ? { error } : {}) });
  }

  private handleEnded(active: ActiveEffectPlayback): void {
    this.finishActive(active, 'ended');
  }

  private handleError(active: ActiveEffectPlayback): void {
    this.finishActive(active, 'failed', '音效播放失败');
  }
}
