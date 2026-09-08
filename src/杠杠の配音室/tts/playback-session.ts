export type PlaybackSegmentState = {
  synthesisStatus?: 'idle' | 'pending' | 'ready' | 'playing' | 'failed' | 'cancelled';
};

export type PlaybackSession<TSegment = unknown> = {
  id: string;
  source: string;
  status: 'preparing' | 'playing' | 'paused' | 'cancelled' | 'finished';
  segments: Array<TSegment & PlaybackSegmentState>;
  currentIndex: number;
  abortControllers: Map<string | number, AbortController>;
  objectUrls: Set<string>;
  cancelReason: string | null;
};

export type PlaybackSessionManager<TSegment = unknown> = {
  start: (options?: { source?: string; segments?: TSegment[] }) => PlaybackSession<TSegment>;
  cancel: (reason?: string) => { session: PlaybackSession<TSegment> | null; abortCount: number };
  isActive: (session: PlaybackSession<TSegment> | null | undefined) => boolean;
  createController: (session: PlaybackSession<TSegment>, key: string | number) => AbortController;
  finishController: (session: PlaybackSession<TSegment> | null | undefined, key: string | number) => void;
  registerObjectUrl: (session: PlaybackSession<TSegment>, url: string) => boolean;
  getActive: () => PlaybackSession<TSegment> | null;
};

export function createPlaybackSessionManager<TSegment = unknown>({
  revokeObjectUrl = url => URL.revokeObjectURL(url),
  onCancel,
}: {
  revokeObjectUrl?: (url: string) => void;
  onCancel?: (value: { session: PlaybackSession<TSegment>; abortCount: number; reason: string }) => void;
} = {}): PlaybackSessionManager<TSegment> {
  let active: PlaybackSession<TSegment> | null = null;
  let sequence = 0;

  const isActive = (session: PlaybackSession<TSegment> | null | undefined): boolean =>
    !!session && active === session && session.status !== 'cancelled';

  const cancel = (reason = 'stopped') => {
    const session = active;
    if (!session || session.status === 'cancelled') return { session: null, abortCount: 0 };
    session.status = 'cancelled';
    session.cancelReason = reason;
    let abortCount = 0;
    for (const controller of session.abortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
        abortCount += 1;
      }
    }
    session.abortControllers.clear();
    for (const url of session.objectUrls) {
      try {
        revokeObjectUrl(url);
      } catch {
        // A stale URL must not prevent cancellation of the rest of a session.
      }
    }
    session.objectUrls.clear();
    active = null;
    onCancel?.({ session, abortCount, reason });
    return { session, abortCount };
  };

  const start = ({ source = 'message', segments = [] }: { source?: string; segments?: TSegment[] } = {}) => {
    cancel('replaced');
    const nextSession: PlaybackSession<TSegment> = {
      id: `voice-session-${Date.now()}-${++sequence}`,
      source,
      status: 'preparing',
      segments: segments.map(segment => ({
        ...segment,
        synthesisStatus:
          segment && typeof segment === 'object' && 'synthesisStatus' in segment
            ? (segment as TSegment & PlaybackSegmentState).synthesisStatus
            : 'idle',
      })),
      currentIndex: 0,
      abortControllers: new Map(),
      objectUrls: new Set(),
      cancelReason: null,
    };
    active = nextSession;
    return nextSession;
  };

  const createController = (session: PlaybackSession<TSegment>, key: string | number): AbortController => {
    if (!isActive(session)) throw new DOMException('Session cancelled', 'AbortError');
    const existing = session.abortControllers.get(key);
    if (existing && !existing.signal.aborted) return existing;
    const controller = new AbortController();
    session.abortControllers.set(key, controller);
    return controller;
  };

  const finishController = (session: PlaybackSession<TSegment> | null | undefined, key: string | number): void => {
    session?.abortControllers?.delete(key);
  };

  const registerObjectUrl = (session: PlaybackSession<TSegment>, url: string): boolean => {
    if (!url) return false;
    if (!isActive(session)) {
      try {
        revokeObjectUrl(url);
      } catch {
        // Ignore a URL that was already revoked by the browser.
      }
      return false;
    }
    session.objectUrls.add(url);
    return true;
  };

  return {
    start,
    cancel,
    isActive,
    createController,
    finishController,
    registerObjectUrl,
    getActive: () => active,
  };
}
