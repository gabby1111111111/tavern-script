import type { RoutedSegment, SoundCue } from './types';

export type ReadingTimelineItem = { kind: 'speech'; segment: RoutedSegment } | { kind: 'sound'; cue: SoundCue };

export type ReadingTimeline = {
  items: ReadingTimelineItem[];
  speechCount: number;
  soundCount: number;
  ignoredCueCount: number;
};

export type ReadingTimelineOptions = {
  eligibleEffectIds?: ReadonlySet<string>;
};

type PositionedCue = {
  cue: SoundCue;
  boundary: number;
  order: number;
};

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

function speechFragment(segment: RoutedSegment, text: string, index: number): ReadingTimelineItem | null {
  const normalized = text.trim();
  if (!normalized) return null;
  return {
    kind: 'speech',
    segment: {
      ...segment,
      id: `${segment.id}-timeline-${index}`,
      text: normalized,
      voice: { ...segment.voice },
    },
  };
}

export function buildReadingTimeline(
  segments: readonly RoutedSegment[],
  cues: readonly SoundCue[] = [],
  options: ReadingTimelineOptions = {},
): ReadingTimeline {
  const items: ReadingTimelineItem[] = [];
  const cuesBySegment = new Map<string, Array<{ cue: SoundCue; order: number }>>();
  let ignoredCueCount = 0;

  cues.forEach((cue, order) => {
    if (options.eligibleEffectIds && !options.eligibleEffectIds.has(cue.effectId)) {
      ignoredCueCount += 1;
      return;
    }
    if (!cue.sourceSegmentId) {
      ignoredCueCount += 1;
      return;
    }
    const entries = cuesBySegment.get(cue.sourceSegmentId) ?? [];
    entries.push({ cue, order });
    cuesBySegment.set(cue.sourceSegmentId, entries);
  });

  for (const segment of segments) {
    const candidates = cuesBySegment.get(segment.id) ?? [];
    const positioned: PositionedCue[] = [];
    for (const candidate of candidates) {
      const cue = candidate.cue;
      if (cue.sourceMessageId !== null && cue.sourceMessageId !== segment.sourceMessageId) {
        ignoredCueCount += 1;
        continue;
      }
      const anchorIndex = occurrenceIndex(segment.text, cue.anchorText, Math.max(0, cue.anchorOccurrence));
      if (anchorIndex < 0) {
        ignoredCueCount += 1;
        continue;
      }
      positioned.push({
        cue,
        boundary: cue.placement === 'before' ? anchorIndex : anchorIndex + cue.anchorText.length,
        order: candidate.order,
      });
    }

    if (positioned.length === 0) {
      items.push({ kind: 'speech', segment });
      continue;
    }
    positioned.sort((left, right) => left.boundary - right.boundary || left.order - right.order);
    let cursor = 0;
    let fragmentIndex = 0;
    for (const positionedCue of positioned) {
      const boundary = Math.min(segment.text.length, Math.max(cursor, positionedCue.boundary));
      const fragment = speechFragment(segment, segment.text.slice(cursor, boundary), fragmentIndex++);
      if (fragment) items.push(fragment);
      items.push({ kind: 'sound', cue: positionedCue.cue });
      cursor = boundary;
    }
    const tail = speechFragment(segment, segment.text.slice(cursor), fragmentIndex);
    if (tail) items.push(tail);
  }

  const speechCount = items.filter(item => item.kind === 'speech').length;
  const soundCount = items.length - speechCount;
  return { items, speechCount, soundCount, ignoredCueCount };
}
