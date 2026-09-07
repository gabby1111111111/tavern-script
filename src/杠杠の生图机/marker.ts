export type InlineImagePrompt = {
  index: number;
  prompt: string;
  start: number;
  end: number;
  paragraphIndex: number;
  anchorTextBefore: string;
  anchorTextAfter: string;
};

export type InlineImagePromptScan = {
  markers: InlineImagePrompt[];
  totalValid: number;
  truncated: boolean;
  allRanges: Array<{ start: number; end: number }>;
};

const PIC_MARKER_PATTERN = /<pic\b[^>]*\bprompt\s*=\s*"([^"]*)"\s*[^>]*\/?>/gi;
const PIC_SOURCE_CONTROL_PATTERN = /<pic\b[^>]*\bprompt\s*=\s*(?:"[^"]*"|'[^']*')[^>]*\/?>/gi;
const CONTENT_SOURCE_CONTROL_PATTERN = /<\/?content\b[^>]*>/gi;

function blankNonLineBreaks(value: string): string {
  return value.replace(/[^\r\n]/g, ' ');
}

type TextRange = { start: number; end: number };

function collectCodeRanges(value: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const pattern of [/```[\s\S]*?```/g, /`[^`\r\n]*`/g]) {
    for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }
  }

  ranges.sort((lhs, rhs) => lhs.start - rhs.start || lhs.end - rhs.end);
  return ranges.reduce<TextRange[]>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
    return merged;
  }, []);
}

function maskCodeBlocks(value: string): string {
  const ranges = collectCodeRanges(value);
  let masked = '';
  let cursor = 0;
  for (const range of ranges) {
    masked += value.slice(cursor, range.start);
    masked += blankNonLineBreaks(value.slice(range.start, range.end));
    cursor = range.end;
  }
  return masked + value.slice(cursor);
}

function replaceOutsideCode(value: string, pattern: RegExp, replacement: string): string {
  const ranges = collectCodeRanges(value);
  const replace = (segment: string): string => segment.replace(new RegExp(pattern.source, pattern.flags), replacement);
  let result = '';
  let cursor = 0;
  for (const range of ranges) {
    result += replace(value.slice(cursor, range.start));
    result += value.slice(range.start, range.end);
    cursor = range.end;
  }
  return result + replace(value.slice(cursor));
}

function decodeHtmlEntities(value: string): string {
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  return value.replace(/&(#x[\da-f]+|#\d+|quot|apos|amp|lt|gt|nbsp);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'nbsp') return ' ';

    const radix = normalized.startsWith('#x') ? 16 : 10;
    const digits = normalized.startsWith('#x') ? normalized.slice(2) : normalized.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _match;
  });
}

function normalizeAnchor(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 72);
}

function paragraphIndexAt(value: string, start: number): number {
  const prefix = value.slice(0, start);
  return Math.max(0, prefix.split(/\r?\n\s*\r?\n/).length - 1);
}

function collectMatches(value: string) {
  const masked = maskCodeBlocks(value);
  const regex = new RegExp(PIC_MARKER_PATTERN.source, PIC_MARKER_PATTERN.flags);
  const matches: Array<{ start: number; end: number; prompt: string }> = [];

  for (let match = regex.exec(masked); match; match = regex.exec(masked)) {
    const prompt = decodeHtmlEntities(match[1] ?? '').trim();
    matches.push({ start: match.index, end: match.index + match[0].length, prompt });
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }

  return matches;
}

export function scanInlineImagePrompts(value: string): InlineImagePromptScan {
  const matches = collectMatches(value);
  const valid = matches.filter(match => Boolean(match.prompt));
  const markers = valid.slice(0, 2).map((match, index) => ({
    index,
    prompt: match.prompt,
    start: match.start,
    end: match.end,
    paragraphIndex: paragraphIndexAt(value, match.start),
    anchorTextBefore: normalizeAnchor(value.slice(Math.max(0, match.start - 72), match.start)),
    anchorTextAfter: normalizeAnchor(value.slice(match.end, match.end + 72)),
  }));

  return {
    markers,
    totalValid: valid.length,
    truncated: valid.length > markers.length,
    allRanges: matches.map(({ start, end }) => ({ start, end })),
  };
}

export function extractInlineImagePrompts(value: string): InlineImagePrompt[] {
  return scanInlineImagePrompts(value).markers;
}

/** 只移除显示层/临时文本中的标记，不修改聊天消息源数据。 */
export function cleanInlineImageMarkers(value: string): string {
  const ranges = scanInlineImagePrompts(value).allRanges;
  return ranges
    .slice()
    .sort((lhs, rhs) => rhs.start - lhs.start)
    .reduce((result, range) => result.slice(0, range.start) + result.slice(range.end), value);
}

/** 清理聊天消息源数据中的生图控制标签，但保留标签内部的正文和原始换行。 */
export function cleanInlineImageMessage(value: string): string {
  return replaceOutsideCode(
    replaceOutsideCode(value, PIC_SOURCE_CONTROL_PATTERN, ''),
    CONTENT_SOURCE_CONTROL_PATTERN,
    '',
  );
}
