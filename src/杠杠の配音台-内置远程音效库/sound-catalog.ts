import type { SoundEffectEntry } from '../杠杠の配音台/types';

const REPOSITORY = 'gabby1111111111/ST-Audio-Assets';
const API_BASE = `https://api.github.com/repos/${REPOSITORY}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPOSITORY}`;
const MAX_CATALOG_ENTRIES = 512;

export const ST_AUDIO_ASSETS_REVISION = 'f800e5e4f23508b3336d63a7274f4108b84e30c1';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SoundCatalogSnapshot = {
  revision: string;
  effects: SoundEffectEntry[];
  sfxCount: number;
  ambienceCount: number;
};

export type LoadSoundCatalogOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）`);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`${label}没有返回有效 JSON`);
  }
}

function stableEffectId(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash = Math.imul(hash ^ path.charCodeAt(index), 0x01000193);
  }
  return `st-audio-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function catalogPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 240 || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) return null;
  if (parts[0] !== 'SFX' && parts[0] !== 'Ambience') return null;
  return /\.ogg$/i.test(parts.at(-1) ?? '') ? value : null;
}

function rawUrl(path: string): string {
  return `${RAW_BASE}/${ST_AUDIO_ASSETS_REVISION}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function isStAudioAssetsRemoteSound(entry: SoundEffectEntry): boolean {
  return entry.url.startsWith(`${RAW_BASE}/`);
}

export function isStAudioAssetsPinnedSound(entry: SoundEffectEntry): boolean {
  return entry.url.startsWith(`${RAW_BASE}/${ST_AUDIO_ASSETS_REVISION}/`);
}

export async function loadDefaultSoundCatalog(options: LoadSoundCatalogOptions = {}): Promise<SoundCatalogSnapshot> {
  const fetcher = options.fetchImpl ?? fetch;
  const headers = { Accept: 'application/vnd.github+json' };
  const treeResponse = await fetcher(`${API_BASE}/git/trees/${ST_AUDIO_ASSETS_REVISION}?recursive=1`, {
    cache: 'no-store',
    headers,
    signal: options.signal,
  });
  const treePayload = await readJson(treeResponse, '音效库目录读取');
  if (!isRecord(treePayload) || treePayload.truncated === true || !Array.isArray(treePayload.tree)) {
    throw new Error('音效库目录不完整');
  }

  const paths = [
    ...new Set(
      treePayload.tree.flatMap(item => {
        if (!isRecord(item) || item.type !== 'blob') return [];
        const path = catalogPath(item.path);
        return path ? [path] : [];
      }),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || paths.length > MAX_CATALOG_ENTRIES) throw new Error('音效库条目数量异常');

  const idOwners = new Map<string, string>();
  const effects = paths.map(path => {
    const parts = path.split('/');
    const kind = parts[0];
    const id = stableEffectId(path);
    const owner = idOwners.get(id);
    if (owner && owner !== path) throw new Error('音效库存在重复资源标识');
    idOwners.set(id, path);
    const filename = parts.at(-1) ?? path;
    const category = parts.slice(1, -1).join(' / ') || kind;
    return {
      id,
      name: filename.replace(/\.ogg$/i, ''),
      kind: kind === 'SFX' ? 'sfx' : 'ambience',
      category: `${kind} / ${category}`,
      url: rawUrl(path),
      description: kind === 'SFX' ? `短音效；${category}` : `环境音；${category}`,
      enabled: true,
      volume: kind === 'SFX' ? 0.8 : 0.55,
    } satisfies SoundEffectEntry;
  });

  return {
    revision: ST_AUDIO_ASSETS_REVISION,
    effects,
    sfxCount: paths.filter(path => path.startsWith('SFX/')).length,
    ambienceCount: paths.filter(path => path.startsWith('Ambience/')).length,
  };
}

export const ST_AUDIO_ASSETS_CATALOG_CAPABILITY = {
  presentation: {
    title: 'ST-Audio-Assets',
    loadLabel: '读取 GitHub 音效库',
    loadingLabel: '读取中…',
    hints: [
      '短音效可进入整段朗读；较长的环境音暂时只通过原文小喇叭独立播放。',
      '当前仓库未声明可识别许可证，仅作个人开发预览；插件不会复制音频，也不会把这批 URL 写进酒馆设置。',
    ],
  },
  load: loadDefaultSoundCatalog,
  isRemote: isStAudioAssetsRemoteSound,
  isPinned: isStAudioAssetsPinnedSound,
};
