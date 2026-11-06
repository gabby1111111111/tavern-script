import type { CastingTable, ReadingMode, RoutedSegment, SpokenSegment, VoiceRef } from './types';

export type ReadingRouteOptions = {
  mode: ReadingMode;
  casting: CastingTable | null;
  singleVoice: VoiceRef | null;
  fallbackVoice: VoiceRef | null;
  characterName?: string;
};

function normalizedName(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function sameCharacter(candidate: string | null, expected: string): boolean {
  return normalizedName(candidate) === normalizedName(expected);
}

function castForSegment(segment: SpokenSegment, casting: CastingTable | null) {
  if (!casting) return undefined;
  if (segment.kind === 'narration') return casting.entries.find(entry => entry.role === 'narrator');

  const characterName = normalizedName(segment.characterName);
  return casting.entries.find(
    entry =>
      entry.role === 'character' &&
      [entry.displayName, ...entry.aliases].some(alias => normalizedName(alias) === characterName),
  );
}

function fallbackCast(casting: CastingTable | null) {
  return casting?.entries.find(entry => entry.role === 'fallback');
}

export function filterSegmentsForMode(
  segments: SpokenSegment[],
  mode: ReadingMode,
  characterName = '',
): SpokenSegment[] {
  switch (mode) {
    case 'dialogue-only':
      return segments.filter(segment => segment.kind === 'dialogue');
    case 'character-only':
      return segments.filter(
        segment => segment.kind === 'dialogue' && sameCharacter(segment.characterName, characterName),
      );
    case 'full':
    case 'single-voice':
    case 'selected-text':
      return segments;
  }
}

export function mapSelectionToSegments(
  selection: string,
  sourceSegments: SpokenSegment[],
  sourceMessageId: number | null,
): SpokenSegment[] {
  const text = selection.trim();
  if (!text) return [];

  const exactOrContained = sourceSegments.filter(segment => {
    const segmentText = segment.text.trim();
    return segmentText === text || segmentText.includes(text) || text.includes(segmentText);
  });
  if (exactOrContained.length > 0) {
    return exactOrContained.map(segment => ({
      ...segment,
      id: `${segment.id}-selection`,
      text: segment.text.includes(text) ? text : segment.text,
    }));
  }

  return [
    {
      id: `selection-${sourceMessageId ?? 'none'}-${text.length}`,
      kind: 'dialogue',
      text,
      characterName: null,
      sourceMessageId,
    },
  ];
}

export function routeSpokenSegments(segments: SpokenSegment[], options: ReadingRouteOptions): RoutedSegment[] {
  const filtered = filterSegmentsForMode(segments, options.mode, options.characterName);
  return filtered.map(segment => {
    const explicitSingleVoice = options.mode === 'single-voice' ? options.singleVoice : null;
    const cast = castForSegment(segment, options.casting) ?? fallbackCast(options.casting);
    const voice = explicitSingleVoice ?? cast?.voice ?? options.fallbackVoice;
    if (!voice) throw new Error(`“${segment.characterName ?? '旁白'}”还没有可用音色`);
    return { ...segment, voice: { ...voice } };
  });
}

export function voiceRouteKey(segment: RoutedSegment): string {
  return [
    segment.voice.providerProfileId,
    segment.voice.voiceId,
    segment.voice.speed ?? '',
    segment.voice.emotion ?? '',
  ].join('\u0000');
}
