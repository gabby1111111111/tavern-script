import type { SpokenSegment } from '../types';

export type SpokenSegmentOptions = {
  sourceMessageId?: number | null;
  defaultCharacterName?: string | null;
};

type ParsedDialogueLine = {
  character: string;
  emotionLabel: string;
  emotion: string | null;
  rawContent: string;
  text: string;
};

function decodeVisibleText(value: string): string {
  return normalizeWhitespace(
    String(value || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&'),
  );
}

export function stripTtsMarkdownMarkers(text: string): string {
  let result = String(text || '');
  result = result
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|\/)[^)\s]+\)/g, '$1')
    .replace(/(^|\n)[ \t]{0,3}(?:#{1,6}|>)\s+/g, '$1')
    .replace(/(^|\n)[ \t]*[*+-]\s+/g, '$1');

  for (let pass = 0; pass < 3; pass += 1) {
    result = result
      .replace(/(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/`{1,3}([^`\n]+?)`{1,3}/g, '$1');
  }
  return result;
}

export function normalizeWhitespace(text: string): string {
  return stripTtsMarkdownMarkers(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract only the visible `<content>` payload.  Deliberately returning an
 * empty string for untagged input prevents hidden reasoning or metadata from
 * being sent to a speech provider.
 */
export function extractContentText(raw: string): string {
  const source = String(raw || '');
  const match = source.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);
  return match ? decodeVisibleText(match[1]) : '';
}

export function parseDialogueLine(line: string): ParsedDialogueLine | null {
  const trimmed = String(line || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!trimmed) return null;
  const match = trimmed.match(/^\[([^\]|\n]+)(?:\|([^\]\n]*))?\](?:\[([\d.,\s-]+)\])?\s*\|\s*([「“"](.*?)[」”"])\s*$/);
  if (!match) return null;

  const character = (match[1] || '').trim();
  const emotionLabel = (match[2] || '').trim();
  const emotion = match[3] ? match[3].replace(/\s/g, '') : null;
  const rawContent = (match[4] || '').trim();
  const spokenText = (match[5] || '').trim();
  if (!character || !spokenText) return null;
  return { character, emotionLabel, emotion, rawContent, text: spokenText };
}

const NESTED_TTS_PATTERN = /\[[^|\n\x5b\x5d]+(?:\|[^|\n\x5b\x5d]*)?\](?:\[[\d.,\s-]+\])?\s*\|\s*[「“"](?:.*?)[」”"]/;

export function extractNestedTtsLine(line: string): string {
  const source = String(line || '');
  if (parseDialogueLine(source)) return source;
  return source.match(NESTED_TTS_PATTERN)?.[0] || source;
}

export function splitNarrationText(text: string): string[] {
  const normalized = normalizeWhitespace(text).replace(/[ \t]+/g, ' ');
  if (!normalized) return [];

  const chunks: string[] = [];
  for (const paragraph of normalized.split(/\n+/)) {
    let buffer = '';
    for (const character of paragraph.trim()) {
      buffer += character;
      if (/[。！？；!?;]/.test(character)) {
        chunks.push(buffer.trim());
        buffer = '';
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
  }
  return chunks.filter(Boolean);
}

type DialogueRange = ParsedDialogueLine & {
  start: number;
  end: number;
  originalLine: string;
};

function findDialogueRanges(content: string): DialogueRange[] {
  const ranges: DialogueRange[] = [];
  const linePattern = /[^\n]*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(content)) !== null) {
    if (!match[0] && linePattern.lastIndex >= content.length) break;
    const lineWithBreak = match[0];
    const line = lineWithBreak.replace(/\n$/, '');
    const ttsLine = extractNestedTtsLine(line);
    const parsed = parseDialogueLine(ttsLine);
    if (parsed) {
      const leading = line.length - line.trimStart().length;
      const trailing = line.length - line.trimEnd().length;
      ranges.push({
        start: match.index + leading,
        end: match.index + line.length - trailing,
        originalLine: line.trim(),
        ...parsed,
      });
    }
    if (linePattern.lastIndex >= content.length) break;
  }
  return ranges;
}

function buildMixedSegments(content: string, options: SpokenSegmentOptions): SpokenSegment[] {
  const dialogueRanges = findDialogueRanges(content);
  const segments: SpokenSegment[] = [];
  let cursor = 0;
  let sequence = 0;

  const addSegment = (segment: Omit<SpokenSegment, 'id'>) => {
    segments.push({ ...segment, id: `voice-${options.sourceMessageId ?? 'local'}-${sequence++}` });
  };

  const pushNarrationRange = (start: number, end: number) => {
    for (const text of splitNarrationText(content.slice(start, end))) {
      addSegment({
        kind: 'narration',
        text,
        characterName: null,
        sourceMessageId: options.sourceMessageId ?? null,
      });
    }
  };

  for (const dialogue of dialogueRanges) {
    pushNarrationRange(cursor, dialogue.start);
    addSegment({
      kind: 'dialogue',
      text: dialogue.text,
      characterName: dialogue.character || options.defaultCharacterName || null,
      sourceMessageId: options.sourceMessageId ?? null,
    });
    cursor = dialogue.end;
  }
  pushNarrationRange(cursor, content.length);
  return segments;
}

/**
 * Parse mixed narration and the established tagged dialogue format into the
 * small contract consumed by routing and playback.  A content block is
 * extracted when present; callers may also pass an already extracted body.
 */
export function parseSpokenSegments(text: string, options: SpokenSegmentOptions = {}): SpokenSegment[] {
  const source = String(text || '');
  const content = /<content\b/i.test(source) ? extractContentText(source) : normalizeWhitespace(source);
  if (!content) return [];
  return buildMixedSegments(content, options);
}
