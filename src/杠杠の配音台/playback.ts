import type { RecentVoiceItem, RecentVoiceStatus, SynthesizedAudio, VoiceRef } from './types';

export const MAX_RECENT_VOICES = 10;

export type AudioUrlApi = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};

export type RecentVoiceInput = {
  textPreview: string;
  characterName?: string | null;
  voice: VoiceRef;
};

export type VoiceSynthesisResult = SynthesizedAudio | Blob;

export type VoiceSynthesis = (request: { signal: AbortSignal; item: RecentVoiceItem }) => Promise<VoiceSynthesisResult>;

export type PlaybackResult = {
  itemId: string | null;
  played: boolean;
  status: RecentVoiceStatus | 'missing';
  error?: string;
};

export type RecentVoiceStoreOptions = {
  maxEntries?: number;
  audioFactory?: () => HTMLAudioElement;
  urlApi?: AudioUrlApi;
  document?: Document;
  now?: () => number;
  idFactory?: (sequence: number, createdAt: number) => string;
};

type GenerationRecord = {
  controller: AbortController;
};

type ActivePlayback = {
  itemId: string;
  token: number;
  audio: HTMLAudioElement;
  onEnded: () => void;
  onError: () => void;
  interruption: Promise<void>;
  resolveInterruption: () => void;
  settled: boolean;
};

type VoiceListener = (items: readonly RecentVoiceItem[]) => void;

function defaultAudioFactory(): HTMLAudioElement {
  const AudioConstructor = globalThis.Audio;
  if (typeof AudioConstructor !== 'function') {
    throw new Error('当前环境没有可用的 HTMLAudioElement');
  }
  return new AudioConstructor();
}

function defaultUrlApi(): AudioUrlApi {
  const browserUrl = globalThis.URL;
  if (typeof browserUrl?.createObjectURL !== 'function' || typeof browserUrl.revokeObjectURL !== 'function') {
    throw new Error('当前环境没有可用的 Object URL API');
  }
  return {
    createObjectURL: blob => browserUrl.createObjectURL(blob),
    revokeObjectURL: url => browserUrl.revokeObjectURL(url),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 300);
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 300);
  return '音频处理失败';
}

function isSynthesizedAudio(value: VoiceSynthesisResult): value is SynthesizedAudio {
  return typeof value === 'object' && value !== null && 'blob' in value;
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { size?: unknown }).size === 'number' &&
    typeof (value as { slice?: unknown }).slice === 'function'
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Page-memory-only voice clip storage and playback.
 *
 * The store deliberately owns neither persistence nor provider calls. The caller supplies a
 * synthesis function, while this class owns generation cancellation, the ten-item recent list,
 * the one active HTMLAudioElement, and all object URL cleanup.
 */
export class RecentVoiceStore {
  readonly maxEntries: number;

  private readonly audioFactory: () => HTMLAudioElement;
  private readonly urlApi: AudioUrlApi;
  private readonly document: Document | null;
  private readonly now: () => number;
  private readonly idFactory: (sequence: number, createdAt: number) => string;
  private readonly entries: RecentVoiceItem[] = [];
  private readonly generations = new Map<string, GenerationRecord>();
  private readonly listeners = new Set<VoiceListener>();
  private audio: HTMLAudioElement | null = null;
  private active: ActivePlayback | null = null;
  private sequence = 0;
  private playbackSequence = 0;

  constructor(options: RecentVoiceStoreOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? MAX_RECENT_VOICES));
    this.audioFactory = options.audioFactory ?? defaultAudioFactory;
    this.urlApi = options.urlApi ?? defaultUrlApi();
    this.document = options.document ?? (typeof document === 'undefined' ? null : document);
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? ((sequence, createdAt) => `voice-${createdAt}-${sequence}`);
  }

  get items(): readonly RecentVoiceItem[] {
    return this.entries;
  }

  get activeItemId(): string | null {
    return this.active?.itemId ?? null;
  }

  subscribe(listener: VoiceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): RecentVoiceItem[] {
    return this.entries.map(item => ({ ...item, voice: { ...item.voice } }));
  }

  get(id: string): RecentVoiceItem | null {
    return this.entries.find(item => item.id === id) ?? null;
  }

  beginGeneration(input: RecentVoiceInput): { item: RecentVoiceItem; signal: AbortSignal } {
    const createdAt = this.now();
    const item: RecentVoiceItem = {
      id: this.idFactory(this.sequence++, createdAt),
      textPreview: input.textPreview.trim().slice(0, 160),
      characterName: input.characterName?.trim() || null,
      voice: { ...input.voice },
      createdAt,
      status: 'generating',
      blob: null,
      objectUrl: null,
      error: null,
    };
    const controller = new AbortController();
    this.generations.set(item.id, { controller });
    this.entries.unshift(item);
    this.pruneOverflow();
    this.notify();
    return { item, signal: controller.signal };
  }

  async generate(input: RecentVoiceInput, synthesize: VoiceSynthesis): Promise<RecentVoiceItem> {
    const generation = this.beginGeneration(input);
    try {
      const result = await synthesize({ signal: generation.signal, item: generation.item });
      if (generation.signal.aborted || this.get(generation.item.id)?.status === 'cancelled') {
        this.markCancelled(generation.item.id, '已取消');
      } else {
        this.markReady(generation.item.id, result);
      }
    } catch (error) {
      if (generation.signal.aborted || isAbortError(error)) {
        this.markCancelled(generation.item.id, '已取消');
      } else {
        this.markFailed(generation.item.id, error);
      }
    }
    return this.get(generation.item.id) ?? generation.item;
  }

  markReady(id: string, result: VoiceSynthesisResult): boolean {
    const item = this.get(id);
    const generation = this.generations.get(id);
    if (!item || item.status === 'cancelled' || generation?.controller.signal.aborted) return false;

    const candidate: unknown = isSynthesizedAudio(result) ? result.blob : result;
    if (!isBlobLike(candidate)) {
      this.markFailed(id, '合成结果不是有效音频 Blob');
      return false;
    }
    const blob = candidate;
    try {
      item.blob = blob;
      item.objectUrl = this.urlApi.createObjectURL(blob);
      item.status = 'ready';
      item.error = null;
      this.generations.delete(id);
      this.notify();
      return true;
    } catch (error) {
      item.blob = null;
      item.objectUrl = null;
      this.generations.delete(id);
      item.status = 'failed';
      item.error = errorMessage(error);
      this.notify();
      return false;
    }
  }

  markFailed(id: string, error: unknown): boolean {
    const item = this.get(id);
    if (!item) return false;
    this.abortGeneration(id, errorMessage(error));
    if (this.active?.itemId === id) this.stopActive('ready');
    item.status = 'failed';
    item.error = errorMessage(error);
    this.notify();
    return true;
  }

  markCancelled(id: string, reason = '已取消'): boolean {
    const item = this.get(id);
    if (!item) return false;
    this.abortGeneration(id, reason);
    if (this.active?.itemId === id) this.stopActive('ready');
    item.status = 'cancelled';
    item.error = reason;
    this.notify();
    return true;
  }

  cancelGeneration(id: string, reason = '已取消'): boolean {
    const item = this.get(id);
    if (!item || item.status !== 'generating') return false;
    return this.markCancelled(id, reason);
  }

  async play(id: string): Promise<PlaybackResult> {
    const item = this.get(id);
    if (!item) return { itemId: id, played: false, status: 'missing', error: '音频不存在' };
    if (!item.objectUrl || !item.blob) {
      return { itemId: id, played: false, status: item.status, error: item.error ?? '音频尚未准备好' };
    }

    if (this.active?.itemId === id && item.status === 'playing') {
      return { itemId: id, played: true, status: 'playing' };
    }

    if (this.active && this.active.itemId !== id) this.stopActive('ready');
    if (!this.active || this.active.itemId !== id) {
      try {
        this.startActive(item);
      } catch (error) {
        item.status = 'failed';
        item.error = errorMessage(error);
        this.notify();
        return { itemId: id, played: false, status: 'failed', error: item.error };
      }
    }

    const active = this.active;
    if (!active) return { itemId: id, played: false, status: item.status, error: '播放会话未建立' };
    item.error = null;
    if (item.status === 'failed') item.status = 'ready';
    let playPromise: Promise<void>;
    try {
      playPromise = active.audio.play();
    } catch (error) {
      const message = errorMessage(error);
      this.detachActive(active);
      this.settleActive(active);
      this.active = null;
      item.status = isAbortError(error) ? 'cancelled' : 'failed';
      item.error = message;
      this.notify();
      return { itemId: id, played: false, status: item.status, error: message };
    }
    const startResult = await Promise.race([
      playPromise.then(
        () => ({ kind: 'started' as const }),
        error => ({ kind: 'failed' as const, error }),
      ),
      active.interruption.then(() => ({ kind: 'interrupted' as const })),
    ]);
    if (startResult.kind === 'interrupted') {
      return { itemId: id, played: false, status: item.status };
    }
    if (startResult.kind === 'failed') {
      const error = startResult.error;
      if (!this.isCurrent(active)) {
        return { itemId: id, played: false, status: item.status };
      }
      const message = errorMessage(error);
      this.detachActive(active);
      this.settleActive(active);
      this.active = null;
      item.status = isAbortError(error) ? 'cancelled' : 'failed';
      item.error = message;
      this.notify();
      return { itemId: id, played: false, status: item.status, error: message };
    }

    if (!this.isCurrent(active) || active.audio.paused) {
      return { itemId: id, played: false, status: item.status };
    }
    item.status = 'playing';
    item.error = null;
    this.notify();
    return { itemId: id, played: true, status: 'playing' };
  }

  async toggle(id: string): Promise<PlaybackResult> {
    const item = this.get(id);
    if (!item) return { itemId: id, played: false, status: 'missing', error: '音频不存在' };
    if (this.active?.itemId === id && item.status === 'playing') {
      this.pause(id);
      return { itemId: id, played: false, status: 'paused' };
    }
    return this.play(id);
  }

  pause(id = this.active?.itemId ?? ''): boolean {
    const item = this.get(id);
    const active = this.active;
    if (!item || !active || active.itemId !== id || item.status !== 'playing') return false;
    active.audio.pause();
    item.status = 'paused';
    this.notify();
    return true;
  }

  stop(): boolean {
    return this.stopActive('ready');
  }

  download(id: string, filename?: string): boolean {
    const item = this.get(id);
    if (!item?.objectUrl || !item.blob || !this.document) return false;
    const anchor = this.document.createElement('a');
    const extension = item.blob.type.split('/')[1]?.split(';')[0] || 'mp3';
    anchor.href = item.objectUrl;
    anchor.download = filename?.trim() || `${item.characterName || 'voice'}-${item.id}.${extension}`;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    this.document.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [item] = this.entries.splice(index, 1);
    if (this.active?.itemId === id) this.stopActive('ready');
    this.disposeItem(item);
    this.notify();
    return true;
  }

  clear(): void {
    this.stopActive('ready');
    for (const item of this.entries.splice(0)) this.disposeItem(item);
    this.notify();
  }

  /** Release listeners, abort in-flight synthesis, and revoke all page-owned object URLs. */
  unload(): void {
    this.clear();
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load?.();
      } catch {
        // A test double or browser media implementation may not support resetting src.
      }
    }
    this.audio = null;
    this.listeners.clear();
  }

  dispose(): void {
    this.unload();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private pruneOverflow(): void {
    while (this.entries.length > this.maxEntries) {
      const oldest = this.entries.pop();
      if (oldest) this.disposeItem(oldest);
    }
  }

  private abortGeneration(id: string, reason: string): void {
    const generation = this.generations.get(id);
    if (!generation) return;
    if (!generation.controller.signal.aborted) generation.controller.abort(reason);
    this.generations.delete(id);
  }

  private disposeItem(item: RecentVoiceItem): void {
    if (this.active?.itemId === item.id) this.stopActive('ready');
    this.abortGeneration(item.id, '已移除');
    if (item.objectUrl) {
      try {
        this.urlApi.revokeObjectURL(item.objectUrl);
      } catch {
        // Releasing an already-invalid URL should not prevent other entries from cleaning up.
      }
    }
    item.objectUrl = null;
    item.blob = null;
  }

  private getAudio(): HTMLAudioElement {
    if (!this.audio) this.audio = this.audioFactory();
    return this.audio;
  }

  private startActive(item: RecentVoiceItem): void {
    const audio = this.getAudio();
    const token = ++this.playbackSequence;
    let resolveInterruption!: () => void;
    const interruption = new Promise<void>(resolve => {
      resolveInterruption = resolve;
    });
    const active: ActivePlayback = {
      itemId: item.id,
      token,
      audio,
      onEnded: () => this.handleEnded(active),
      onError: () => this.handleError(active),
      interruption,
      resolveInterruption,
      settled: false,
    };
    this.active = active;
    audio.addEventListener('ended', active.onEnded);
    audio.addEventListener('error', active.onError);
    audio.src = item.objectUrl as string;
    audio.currentTime = 0;
  }

  private isCurrent(active: ActivePlayback): boolean {
    return this.active?.token === active.token && this.active.audio === active.audio;
  }

  private detachActive(active: ActivePlayback): void {
    active.audio.removeEventListener('ended', active.onEnded);
    active.audio.removeEventListener('error', active.onError);
  }

  private settleActive(active: ActivePlayback): void {
    if (active.settled) return;
    active.settled = true;
    active.resolveInterruption();
  }

  private stopActive(nextStatus: 'ready' | 'cancelled'): boolean {
    const active = this.active;
    if (!active) return false;
    this.detachActive(active);
    this.settleActive(active);
    this.active = null;
    try {
      active.audio.pause();
      active.audio.removeAttribute('src');
      active.audio.load?.();
    } catch {
      // Best-effort cleanup for browser media and injected test doubles.
    }
    const item = this.get(active.itemId);
    if (item && (item.status === 'playing' || item.status === 'paused')) {
      item.status = nextStatus;
    }
    this.notify();
    return true;
  }

  private handleEnded(active: ActivePlayback): void {
    if (!this.isCurrent(active)) return;
    this.detachActive(active);
    this.settleActive(active);
    this.active = null;
    const item = this.get(active.itemId);
    if (item) item.status = 'ready';
    this.notify();
  }

  private handleError(active: ActivePlayback): void {
    if (!this.isCurrent(active)) return;
    this.detachActive(active);
    this.settleActive(active);
    this.active = null;
    const item = this.get(active.itemId);
    if (item) {
      item.status = 'failed';
      item.error = '音频播放失败';
    }
    this.notify();
  }
}

export function createRecentVoiceStore(options: RecentVoiceStoreOptions = {}): RecentVoiceStore {
  return new RecentVoiceStore(options);
}
