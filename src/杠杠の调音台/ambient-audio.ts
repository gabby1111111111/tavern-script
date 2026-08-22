const MUSIC_API_BASE = 'https://music-api.gdstudio.xyz/api.php';
const SEARCH_ATTEMPTS = 4;
const SEARCH_RETRY_DELAY_MS = 2_000;

export type AmbientAudioSource = 'search' | 'fallback';

export type AmbientAudioResult = {
  url: string;
  bvid: string;
  source: AmbientAudioSource;
  searchAttempt: number;
};

type ResolveAmbientAudioOptions = {
  shouldContinue?: () => boolean;
  onSearchAttempt?: (attempt: number, query: string) => void;
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

async function fetchBilibiliAudioUrl(bvid: string) {
  const response = await fetch(
    `${MUSIC_API_BASE}?types=url&source=bilibili&id=${encodeURIComponent(bvid)}&br=999`,
  );
  if (!response.ok) throw new Error(`B站音源请求失败 (${response.status})`);

  const data: unknown = await response.json();
  const url = data && typeof data === 'object' && typeof (data as { url?: unknown }).url === 'string' ? (data as { url: string }).url : '';
  if (!url) throw new Error(`BV${bvid.slice(2)} 没有可用音源`);
  return url;
}

async function searchBilibiliAudio(location: string, attempt: number, options: ResolveAmbientAudioOptions) {
  const query = `白噪音 ${location}`.trim();
  options.onSearchAttempt?.(attempt, query);

  const response = await fetch(
    `${MUSIC_API_BASE}?types=search&source=bilibili&name=${encodeURIComponent(query)}&count=10&pages=1`,
  );
  if (!response.ok) throw new Error(`B站搜索请求失败 (${response.status})`);

  const data: unknown = await response.json();
  const bvids = shuffle(getBilibiliIdsFromSearchData(data));
  if (!bvids.length) throw new Error('B站搜索结果中没有可用 BV 号');

  let lastError = '搜索结果中的 BV 音源均不可用';
  for (const bvid of bvids) {
    if (options.shouldContinue && !options.shouldContinue()) throw new Error('环境音搜索已取消');
    try {
      return {
        url: await fetchBilibiliAudioUrl(bvid),
        bvid,
        source: 'search' as const,
        searchAttempt: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError);
}

export async function resolveBilibiliAmbientAudio(
  location: string,
  fallbackBvids: string[],
  options: ResolveAmbientAudioOptions = {},
): Promise<AmbientAudioResult> {
  const normalizedLocation = location.trim();
  if (!normalizedLocation) throw new Error('环境音地点为空');

  let lastSearchError = 'B站没有可用环境音搜索结果';
  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt += 1) {
    if (options.shouldContinue && !options.shouldContinue()) throw new Error('环境音搜索已取消');
    try {
      return await searchBilibiliAudio(normalizedLocation, attempt, options);
    } catch (error) {
      lastSearchError = error instanceof Error ? error.message : String(error);
      if (attempt < SEARCH_ATTEMPTS) {
        await new Promise<void>(resolve => window.setTimeout(resolve, SEARCH_RETRY_DELAY_MS));
      }
    }
  }

  const fallbackCandidates = shuffle(extractBilibiliVideoIds(fallbackBvids.join('\n')));
  let lastFallbackError = '没有配置可用的 BV 保底音源';
  for (const bvid of fallbackCandidates) {
    if (options.shouldContinue && !options.shouldContinue()) throw new Error('环境音搜索已取消');
    try {
      return {
        url: await fetchBilibiliAudioUrl(bvid),
        bvid,
        source: 'fallback',
        searchAttempt: SEARCH_ATTEMPTS,
      };
    } catch (error) {
      lastFallbackError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`${lastSearchError}；保底音源也不可用：${lastFallbackError}`);
}
