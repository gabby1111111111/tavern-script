const MUSIC_API_BASE = 'https://music-api.gdstudio.xyz/api.php';
const MUSIC_PROXY_BASE = 'https://music-proxy.gdstudio.org/';
const SEARCH_ATTEMPTS = 1;
const MAX_SEARCH_CANDIDATES = 2;
const MAX_FALLBACK_CANDIDATES = 1;
const REQUEST_TIMEOUT_MS = 8_000;

export type AmbientAudioSource = 'search' | 'fallback';

export type AmbientAudioResult = {
  url: string;
  bvid: string;
  source: AmbientAudioSource;
  searchAttempt: number;
};

export type ResolveAmbientAudioOptions = {
  shouldContinue?: () => boolean;
  onSearchAttempt?: (attempt: number, query: string) => void;
  signal?: AbortSignal;
};

export function extractBilibiliVideoIds(input: string): string[] {
  const matches = input.match(/BV[0-9A-Za-z]{10}/gi) ?? [];
  return [...new Set(matches.map(match => `BV${match.slice(2)}`))];
}

function shuffle<T>(items: T[]) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function getBilibiliIdsFromSearchData(data: unknown): string[] {
  if (!Array.isArray(data)) return [];

  return [
    ...new Set(
      data.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        return ['id', 'bvid', 'url', 'link'].flatMap(key => {
          const value = record[key];
          return typeof value === 'string' ? extractBilibiliVideoIds(value) : [];
        });
      }),
    ),
  ];
}

function assertNotCancelled(options: ResolveAmbientAudioOptions) {
  if (options.signal?.aborted || (options.shouldContinue && !options.shouldContinue())) {
    throw new Error('环境音搜索已取消');
  }
}

async function withRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) throw new Error('环境音搜索已取消');

  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  externalSignal?.addEventListener('abort', abortRequest, { once: true });
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await request(controller.signal);
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortRequest);
  }
}

async function fetchBilibiliJson(url: string, signal?: AbortSignal) {
  return withRequestTimeout(async requestSignal => {
    const response = await fetch(url, { cache: 'no-store', signal: requestSignal });
    if (!response.ok) throw new Error('B站请求失败');
    return (await response.json()) as unknown;
  }, signal);
}

async function probeBilibiliAudioUrl(url: string, signal?: AbortSignal) {
  await withRequestTimeout(async requestSignal => {
    const response = await fetch(`${MUSIC_PROXY_BASE}${url}`, {
      cache: 'no-store',
      headers: { Range: 'bytes=0-1' },
      signal: requestSignal,
    });
    if (!response.ok) throw new Error('B站候选音频不可用');
    await response.body?.cancel();
  }, signal);
}

async function fetchBilibiliAudioUrl(bvid: string, signal?: AbortSignal) {
  const data = await fetchBilibiliJson(
    `${MUSIC_API_BASE}?types=url&source=bilibili&id=${encodeURIComponent(bvid)}&br=999`,
    signal,
  );

  const url =
    data && typeof data === 'object' && typeof (data as { url?: unknown }).url === 'string'
      ? (data as { url: string }).url.trim()
      : '';
  if (!url) throw new Error(`BV${bvid.slice(2)} 没有可用音源`);
  await probeBilibiliAudioUrl(url, signal);
  return url;
}

async function searchBilibiliAudio(location: string, attempt: number, options: ResolveAmbientAudioOptions) {
  const query = `白噪音 ${location}`.trim();
  options.onSearchAttempt?.(attempt, query);

  const data = await fetchBilibiliJson(
    `${MUSIC_API_BASE}?types=search&source=bilibili&name=${encodeURIComponent(query)}&count=10&pages=1`,
    options.signal,
  );
  const bvids = shuffle(getBilibiliIdsFromSearchData(data)).slice(0, MAX_SEARCH_CANDIDATES);
  if (!bvids.length) throw new Error('B站搜索结果中没有可用 BV 号');

  for (const bvid of bvids) {
    assertNotCancelled(options);
    try {
      return {
        url: await fetchBilibiliAudioUrl(bvid, options.signal),
        bvid,
        source: 'search' as const,
        searchAttempt: attempt,
      };
    } catch {
      assertNotCancelled(options);
    }
  }

  throw new Error('搜索结果中的音源不可用');
}

export async function resolveBilibiliAmbientAudio(
  location: string,
  fallbackBvids: string[],
  options: ResolveAmbientAudioOptions = {},
): Promise<AmbientAudioResult> {
  const normalizedLocation = location.trim();
  if (!normalizedLocation) throw new Error('环境音地点为空');

  assertNotCancelled(options);
  try {
    return await searchBilibiliAudio(normalizedLocation, SEARCH_ATTEMPTS, options);
  } catch {
    assertNotCancelled(options);
  }

  const fallbackCandidates = shuffle(extractBilibiliVideoIds(fallbackBvids.join('\n'))).slice(0, MAX_FALLBACK_CANDIDATES);
  for (const bvid of fallbackCandidates) {
    assertNotCancelled(options);
    try {
      return {
        url: await fetchBilibiliAudioUrl(bvid, options.signal),
        bvid,
        source: 'fallback',
        searchAttempt: SEARCH_ATTEMPTS,
      };
    } catch {
      assertNotCancelled(options);
    }
  }

  throw new Error('环境音暂不可用');
}
