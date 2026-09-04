import type { ImageResource } from './image-api';
import type { GallerySaveInput, GallerySaveResult } from './pipeline-types';

declare const SillyTavern: {
  getRequestHeaders: () => Record<string, string>;
};

const DATA_IMAGE_PATTERN = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/i;
const DEFAULT_IMAGE_FORMAT = 'png';

export type GalleryStorageOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Injected for tests; production defaults to SillyTavern's request headers. */
  getRequestHeaders?: () => Record<string, string>;
  now?: () => number;
};

export class GalleryStorageError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GalleryStorageError';
    this.status = status;
  }
}

export type DecodedImageDataUrl = {
  base64: string;
  format: string;
};

function normalizedFormat(value: string): string {
  const format = value.trim().replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]{0,15}$/.test(format)) return DEFAULT_IMAGE_FORMAT;
  return format === 'jpeg' ? 'jpg' : format;
}

/** Parse a browser data URL without retaining it in any module-level state. */
export function decodeImageDataUrl(dataUrl: string): DecodedImageDataUrl {
  const value = dataUrl.trim();
  const match = DATA_IMAGE_PATTERN.exec(value);
  if (!match) throw new GalleryStorageError('待保存图片不是有效的图片 data URL');
  const base64 = match[2].replace(/\s/g, '');
  if (!base64) throw new GalleryStorageError('待保存图片为空');
  return { base64, format: normalizedFormat(match[1].slice('image/'.length)) };
}

function safePathPart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .split('')
    .map(character => {
      const code = character.charCodeAt(0);
      return character === '/' || character === '\\' || code < 0x20 || code === 0x7f ? '_' : character;
    })
    .join('')
    .replace(/^\.+$/, '')
    .slice(0, 160);
  return normalized || fallback;
}

export function normalizeGalleryFilename(filename: string, format: string, now = Date.now()): string {
  const extension = normalizedFormat(format);
  const fallback = `story-image-${now}.${extension}`;
  const safe = safePathPart(filename, fallback);
  return /\.[a-z0-9][a-z0-9.+-]{0,15}$/i.test(safe) ? safe : `${safe}.${extension}`;
}

function defaultRequestHeaders(): Record<string, string> {
  try {
    return { ...SillyTavern.getRequestHeaders() };
  } catch {
    throw new GalleryStorageError('未找到 SillyTavern 请求上下文');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parsePath(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GalleryStorageError('图库保存响应不是有效 JSON', response.status || null);
  }
  const path = isRecord(payload) && typeof payload.path === 'string' ? payload.path.trim() : '';
  if (!path) throw new GalleryStorageError('图库保存响应缺少图片路径', response.status || null);
  return path;
}

/**
 * Save only after an explicit user action.  The server stores the image in
 * SillyTavern's character gallery; this adapter does not persist data locally.
 */
export async function saveImageToCharacterGallery(
  input: GallerySaveInput,
  options: GalleryStorageOptions = {},
): Promise<GallerySaveResult> {
  const decoded = decodeImageDataUrl(input.dataUrl);
  const characterName = safePathPart(input.characterName, 'uploads');
  if (characterName === 'uploads' && !input.characterName.trim()) {
    throw new GalleryStorageError('当前角色卡名称为空');
  }
  const filename = normalizeGalleryFilename(input.filename, decoded.format, options.now?.() ?? Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? '/api/images/upload';

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ...(options.getRequestHeaders ?? defaultRequestHeaders)(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: decoded.base64,
        format: decoded.format,
        ch_name: characterName,
        filename,
      }),
    });
    if (!response.ok) throw new GalleryStorageError('图库保存请求失败', response.status || null);
    return { path: await parsePath(response) };
  } catch (error) {
    if (error instanceof GalleryStorageError) throw error;
    // Do not expose the request URL, response body, or implementation detail in
    // the user-facing error.  Runtime may show this message while retaining the
    // in-memory artifact for another explicit save attempt.
    throw new GalleryStorageError('图库保存请求失败');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Resolve a generated object/remote URL into a data URL when the user clicks Save. */
export async function imageResourceToDataUrl(
  resource: Pick<ImageResource, 'url'>,
  options: Pick<GalleryStorageOptions, 'fetchImpl'> = {},
): Promise<string> {
  if (resource.url.trim().startsWith('data:')) return resource.url.trim();
  try {
    const response = await (options.fetchImpl ?? fetch)(resource.url);
    if (!response.ok) throw new Error('image fetch failed');
    const blob = await response.blob();
    const mime = blob.type.startsWith('image/') ? blob.type : 'image/png';
    return `data:${mime};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } catch {
    throw new GalleryStorageError('无法读取待保存图片');
  }
}

export async function saveImageResourceToCharacterGallery(
  resource: Pick<ImageResource, 'url'>,
  input: Omit<GallerySaveInput, 'dataUrl'>,
  options: GalleryStorageOptions = {},
): Promise<GallerySaveResult> {
  const dataUrl = await imageResourceToDataUrl(resource, options);
  return saveImageToCharacterGallery({ ...input, dataUrl }, options);
}

/** Descriptive alias for callers that model this operation as an upload. */
export const uploadImageToCharacterGallery = saveImageToCharacterGallery;
