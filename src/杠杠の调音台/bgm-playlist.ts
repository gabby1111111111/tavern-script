import { z } from 'zod';
import { ref } from 'vue';

export const DEFAULT_NETEASE_PLAYLISTS = [
  { id: '14360676526', name: 'kpop i like' },
  { id: '3778678', name: '热歌榜' },
  { id: '19723756', name: '飙升榜' },
  { id: '3779629', name: '新歌榜' },
  { id: '4395559', name: '华语金曲榜' },
  { id: '13864181070', name: '没killed之前的噪音' },
] as const;

const NeteasePlaylistTrackSchema = z.object({
  name: z.string().trim().min(1),
  artist: z.array(z.union([z.string(), z.number()])).transform(artists =>
    artists
      .map(String)
      .map(artist => artist.trim())
      .filter(Boolean),
  ),
});

export type NeteasePlaylistTrack = z.infer<typeof NeteasePlaylistTrackSchema>;

const NeteasePlaylistInfoSchema = z.object({
  playlist: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().trim().min(1),
  }),
});

export type NeteasePlaylistInfo = z.infer<typeof NeteasePlaylistInfoSchema>['playlist'];

const NETEASE_REQUEST_TIMEOUT_MS = 8_000;

export const currentNeteaseSampleTracks = ref<NeteasePlaylistTrack[]>([]);

let cachedPlaylist: {
  playlistId: string;
  tracks: NeteasePlaylistTrack[];
  sampledTracks: NeteasePlaylistTrack[];
  sampledCount: number;
} | null = null;
let manualLoadPending = false;

function normalizeSampleCount(count: number) {
  const normalized = Math.floor(Number(count));
  return Number.isFinite(normalized) ? Math.max(1, Math.min(20, normalized)) : 5;
}

function assertPlaylistId(playlistId: string) {
  const normalized = playlistId.trim();
  if (!/^\d+$/.test(normalized)) throw new Error('网易云歌单 ID 必须是数字');
  return normalized;
}

function createAbortError() {
  const error = new Error('网易云歌单请求已取消');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

async function fetchNeteaseJson(endpoint: string, errorLabel: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, NETEASE_REQUEST_TIMEOUT_MS);

  if (signal?.aborted) {
    window.clearTimeout(timer);
    throw createAbortError();
  }
  signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`${errorLabel}请求失败 (${response.status})`);
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (timedOut) throw new Error(`${errorLabel}请求超时（8 秒）`, { cause: error });
    if (error instanceof SyntaxError) throw new Error(`${errorLabel}返回数据无效`, { cause: error });
    if (error instanceof Error && error.message.startsWith(`${errorLabel}请求失败 (`)) throw error;
    throw new Error(`${errorLabel}请求失败，请检查网络`, { cause: error });
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

export async function fetchNeteasePlaylist(
  playlistId: string,
  signal?: AbortSignal,
): Promise<NeteasePlaylistTrack[]> {
  const normalizedPlaylistId = assertPlaylistId(playlistId);
  const endpoint =
    'https://music-api.gdstudio.xyz/api.php?types=search_playlist&count=20&source=netease&name=' +
    encodeURIComponent(normalizedPlaylistId);
  const rawData = await fetchNeteaseJson(endpoint, '网易云歌单', signal);
  assertNotAborted(signal);
  if (!Array.isArray(rawData)) throw new Error('网易云歌单接口返回格式异常');

  const tracks = rawData
    .map(item => NeteasePlaylistTrackSchema.safeParse(item))
    .filter((result): result is { success: true; data: NeteasePlaylistTrack } => result.success)
    .map(result => result.data)
    .filter(
      (track, index, allTracks) =>
        allTracks.findIndex(item => item.name === track.name && item.artist.join('、') === track.artist.join('、')) ===
        index,
    );
  if (tracks.length === 0) throw new Error('网易云歌单中没有可用歌曲');
  return tracks;
}

export async function fetchNeteasePlaylistInfo(playlistId: string, signal?: AbortSignal): Promise<NeteasePlaylistInfo> {
  const normalizedPlaylistId = assertPlaylistId(playlistId);
  const endpoint =
    'https://music-api.gdstudio.xyz/api.php?types=playlist&source=netease&id=' +
    encodeURIComponent(normalizedPlaylistId);
  const rawData = await fetchNeteaseJson(endpoint, '网易云歌单详情', signal);
  assertNotAborted(signal);
  const parsed = NeteasePlaylistInfoSchema.safeParse(rawData);
  if (!parsed.success) throw new Error('网易云歌单详情中没有可用名称');
  return parsed.data.playlist;
}

export async function refreshNeteasePlaylist(
  playlistId: string,
  options: { manual?: boolean; sampleCount?: number; signal?: AbortSignal } = {},
) {
  const normalizedPlaylistId = assertPlaylistId(playlistId);
  const sampleCount = normalizeSampleCount(options.sampleCount ?? 5);
  const tracks = await fetchNeteasePlaylist(normalizedPlaylistId, options.signal);
  assertNotAborted(options.signal);
  cachedPlaylist = {
    playlistId: normalizedPlaylistId,
    tracks,
    sampledTracks: sampleNeteaseTracks(tracks, sampleCount),
    sampledCount: sampleCount,
  };
  manualLoadPending = options.manual ?? true;
  currentNeteaseSampleTracks.value = cachedPlaylist.sampledTracks;
  return tracks;
}

export function getCachedNeteasePlaylist(playlistId: string) {
  const normalizedPlaylistId = playlistId.trim();
  return cachedPlaylist?.playlistId === normalizedPlaylistId ? cachedPlaylist : null;
}

export function getNeteaseCandidatesForGeneration(playlistId: string, sampleCount = 5) {
  const cached = getCachedNeteasePlaylist(playlistId);
  if (!cached) return [];
  const normalizedSampleCount = normalizeSampleCount(sampleCount);
  if (!manualLoadPending || cached.sampledCount !== normalizedSampleCount) {
    cached.sampledTracks = sampleNeteaseTracks(cached.tracks, normalizedSampleCount);
    cached.sampledCount = normalizedSampleCount;
  }
  manualLoadPending = false;
  currentNeteaseSampleTracks.value = cached.sampledTracks;
  return cached.sampledTracks;
}

export function sampleNeteaseTracks(tracks: NeteasePlaylistTrack[], count = 5) {
  const shuffled = tracks.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled.slice(0, normalizeSampleCount(count));
}

export function createNeteaseCandidatePrompt(tracks: NeteasePlaylistTrack[], playlistId: string) {
  const candidates = tracks.map(track => `- ${track.name}-${track.artist.join('、')}`).join('\n');
  return `【指定网易云歌单候选（本轮必选列表）】本轮只能从网易云歌单 ${playlistId} 的以下随机候选中选一首符合当前场景的歌曲，不得选择候选列表之外的歌曲：\n${candidates}\n选择后最终只输出唯一标记：<杠杠-BGM=歌曲名-歌手>。歌曲名和歌手必须使用候选列表中的原文，不要输出额外字段、分析过程或选曲理由。`;
}
