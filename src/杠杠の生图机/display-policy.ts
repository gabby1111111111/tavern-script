import type { DisplaySettings, FloorTriggerDecision } from './pipeline-types';

/**
 * The display policy deliberately has no counter of its own.  Runtime owns the
 * number of normal assistant floors, and passes the post-increment value here.
 * Keeping this function stateless makes swipe/regenerate and chat-switch
 * handling explicit at the runtime boundary.
 */
export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = Object.freeze({
  displayMode: 'inline',
  skipFloors: 0,
});

export const MAX_SAFE_SKIP_FLOORS = Number.MAX_SAFE_INTEGER - 1;

export type FloorTriggerInput = {
  /** Number of eligible normal assistant floors seen, after this floor is counted. */
  normalAssistantFloorCount: number;
  displaySettings?: Pick<DisplaySettings, 'skipFloors'>;
  /** The drawing feature switch is kept outside DisplaySettings for compatibility with v0.2 settings. */
  enabled?: boolean;
  /** False for swipes, regenerations, quiet generations, history loads, etc. */
  isNormalGeneration?: boolean;
  /** Group chats are intentionally skipped until speaker identity is explicit. */
  isGroupChat?: boolean;
};

export function normalizeSkipFloors(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_SAFE_SKIP_FLOORS, Math.max(0, Math.floor(value)));
}

export function normalizeDisplaySettings(value: Partial<DisplaySettings> | null | undefined): DisplaySettings {
  const displayMode = value?.displayMode === 'gift' ? 'gift' : 'inline';
  return {
    displayMode,
    skipFloors: normalizeSkipFloors(value?.skipFloors),
  };
}

/** Convert “skip N floors” into the generation interval. */
export function floorInterval(skipFloors: unknown): number {
  return normalizeSkipFloors(skipFloors) + 1;
}

/** Alias kept descriptive at call sites that deal with assistant-floor counts. */
export const getFloorInterval = floorInterval;

function normalizeFloorCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

/**
 * Decide whether the current normal assistant floor opens an image attempt.
 *
 * `skipFloors = 0` means counts 1, 2, 3, … are eligible.  `skipFloors = 1`
 * means counts 1, 3, 5, … are eligible, and `skipFloors = 2` means counts 1,
 * 4, 7, … are eligible.  A count of zero is never eligible; the runtime should
 * increment its counter before calling this function for a newly received
 * normal assistant reply.
 */
export function decideFloorTrigger(input: FloorTriggerInput): FloorTriggerDecision {
  const count = normalizeFloorCount(input.normalAssistantFloorCount);
  const interval = floorInterval(input.displaySettings?.skipFloors);

  if (input.enabled === false) {
    return { shouldTrigger: false, normalAssistantFloorCount: count, interval, reason: 'disabled' };
  }
  if (input.isNormalGeneration === false) {
    return { shouldTrigger: false, normalAssistantFloorCount: count, interval, reason: 'non-normal-generation' };
  }
  if (input.isGroupChat === true) {
    return { shouldTrigger: false, normalAssistantFloorCount: count, interval, reason: 'group-chat' };
  }
  if (count > 0 && (count - 1) % interval === 0) {
    return { shouldTrigger: true, normalAssistantFloorCount: count, interval, reason: 'eligible' };
  }
  return { shouldTrigger: false, normalAssistantFloorCount: count, interval, reason: 'skipped-by-frequency' };
}

/** Small boolean adapter for code paths that do not need the audit decision. */
export function shouldTriggerAtAssistantFloor(input: FloorTriggerInput): boolean {
  return decideFloorTrigger(input).shouldTrigger;
}
