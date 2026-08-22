import type { GiftRequestMode, ImageApiProfile } from './settings';
import { referenceToBlob, type GiftImageReference } from './reference-image-memory';

export type ImageResource = {
  url: string;
  kind: 'remote-url' | 'object-url';
  revoke?: () => void;
  clone?: () => ImageResource;
};

export type ImageEditInput = {
  file: Blob;
  filename: string;
};

export type GiftImageRequestMode = Exclude<GiftRequestMode, 'auto'>;

export function resolveGiftRequestMode(serviceUrl: string, configured: GiftRequestMode): GiftImageRequestMode {
  if (configured !== 'auto') return configured;
  const normalized = serviceUrl.toLowerCase();
  if (normalized.includes('/images/edits')) return 'multipart-edit';
  if (normalized.includes('/chat/completions')) return 'chat-multimodal';
  return 'json-reference';
}

export class ImageApiError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: { retryable?: boolean; status?: number | null } = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function makeAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    const abort = () => {
      window.clearTimeout(timer);
      reject(makeAbortError('图片请求已取消'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (parentSignal.aborted) {
    window.clearTimeout(timer);
    throw makeAbortError('图片请求已取消');
  }

  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (parentSignal.aborted) throw makeAbortError('图片请求已取消');
    if (timedOut || isAbortError(error))
      throw new ImageApiError(`图片 API 请求超时（${timeoutMs}ms）`, { retryable: true });
    throw error;
  } finally {
    window.clearTimeout(timer);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
}

function isRetryableStatus(status: number): boolean {
  return [408, 409, 429, 500, 502, 503, 504].includes(status);
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^blob:/i.test(value);
}

function isDataImageUrl(value: string): boolean {
  return /^data:image\/[\w.+-]+;base64,/i.test(value);
}

function createObjectUrlFromBase64(value: string): ImageResource {
  const match = value.match(/^data:(image\/[\w.+-]+);base64,(.*)$/is);
  const mime = match?.[1] ?? 'image/png';
  const base64 = (match?.[2] ?? value).replace(/\s/g, '');
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const blob = new Blob([bytes], { type: mime });
  const createResource = (): ImageResource => {
    const objectUrl = URL.createObjectURL(blob);
    let revoked = false;
    return {
      url: objectUrl,
      kind: 'object-url',
      revoke: () => {
        if (!revoked) {
          revoked = true;
          URL.revokeObjectURL(objectUrl);
        }
      },
      clone: createResource,
    };
  };

  return createResource();
}

function markdownImageUrls(value: string): string[] {
  return Array.from(value.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g), match => match[1]).filter(isRemoteUrl);
}

export function inferImageEditUrl(serviceUrl: string): string {
  const baseUrl = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
  const url = new URL(serviceUrl.trim(), baseUrl);
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/generations')) {
    url.pathname = `${pathname.slice(0, -'/generations'.length)}/edits`;
  } else if (!pathname.endsWith('/edits')) {
    url.pathname = `${pathname}/edits`;
  }
  return url.toString();
}

function appendExtraBody(form: FormData, extraBody: Record<string, unknown>): void {
  Object.entries(extraBody).forEach(([key, value]) => {
    if (['model', 'prompt', 'n', 'size', 'image', 'image[]'].includes(key)) return;
    if (typeof value === 'undefined' || value === null) return;
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  });
}

async function referenceToInput(
  reference: GiftImageReference,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ImageEditInput> {
  if (reference.dataUrl) {
    return { file: referenceToBlob(reference), filename: reference.fileName };
  }
  if (!reference.url) throw new ImageApiError(`参考图“${reference.name}”没有可用地址`);
  const response = await fetchWithTimeout(reference.url, { method: 'GET' }, timeoutMs, signal);
  if (!response.ok) throw new ImageApiError(`参考图“${reference.name}”读取失败（HTTP ${response.status}）`);
  return { file: await response.blob(), filename: reference.fileName };
}

function referenceUrl(reference: GiftImageReference): string {
  return reference.dataUrl || reference.url || '';
}

function collectGiftResponse(responseText: string): ImageResource {
  const resources = collectImageResources(parseResponsePayload(responseText), responseText);
  const resource = resources[0];
  resources.slice(1).forEach(item => item.revoke?.());
  if (!resource) throw new ImageApiError('图生图 API 响应中没有可显示的图片');
  return resource;
}

export function collectImageResources(payload: unknown, responseText = ''): ImageResource[] {
  const resources: ImageResource[] = [];
  const seen = new Set<string>();

  const pushRemote = (value: string) => {
    const url = value.trim();
    if (!url || !isRemoteUrl(url) || seen.has(url)) return;
    seen.add(url);
    resources.push({ url, kind: 'remote-url' });
  };

  const pushData = (value: string) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    const resource = createObjectUrlFromBase64(normalized);
    seen.add(normalized);
    resources.push(resource);
  };

  const walk = (value: unknown, keyHint = ''): void => {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      if (isDataImageUrl(text) || /base64|b64/i.test(keyHint)) {
        try {
          pushData(isDataImageUrl(text) ? text : `data:image/png;base64,${text}`);
        } catch {
          // Ignore malformed candidate fields and continue looking for another result.
        }
      } else {
        pushRemote(text);
        markdownImageUrls(text).forEach(pushRemote);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(item => walk(item, keyHint));
      return;
    }

    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, nested]) => walk(nested, key));
    }
  };

  walk(payload);
  markdownImageUrls(responseText).forEach(pushRemote);
  return resources;
}

function parseResponsePayload(responseText: string): unknown {
  if (!responseText.trim()) return null;
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
}

export async function requestImage(
  prompt: string,
  profile: ImageApiProfile,
  signal: AbortSignal,
): Promise<ImageResource> {
  const url = profile.serviceUrl.trim();
  if (!url) throw new ImageApiError('图片服务地址为空');
  if (!prompt.trim()) throw new ImageApiError('绘图提示词为空');

  const body = {
    ...profile.extraBody,
    model: profile.model.trim(),
    prompt: prompt.trim(),
    n: 1,
    size: profile.imageSize,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;

  const timeoutMs = Number.isFinite(profile.timeoutMs) ? Math.max(1_000, profile.timeoutMs) : 120_000;
  const totalAttempts = Number.isFinite(profile.retryAttempts) ? Math.max(1, profile.retryAttempts + 1) : 1;
  const retryDelayMs = Number.isFinite(profile.retryDelayMs) ? Math.max(0, profile.retryDelayMs) : 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        timeoutMs,
        signal,
      );
      const responseText = await response.text();
      if (!response.ok) {
        throw new ImageApiError(`图片 API 返回 HTTP ${response.status}`, {
          retryable: isRetryableStatus(response.status),
          status: response.status,
        });
      }

      const resources = collectImageResources(parseResponsePayload(responseText), responseText);
      const resource = resources[0];
      resources.slice(1).forEach(item => item.revoke?.());
      if (!resource) throw new ImageApiError('图片 API 响应中没有可显示的图片');
      return resource;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw makeAbortError('图片请求已取消');
      lastError = error;
      const retryable = error instanceof ImageApiError ? error.retryable : true;
      if (!retryable || attempt >= totalAttempts) break;
      await sleep(retryDelayMs, signal);
    }
  }

  if (lastError instanceof ImageApiError) throw lastError;
  throw new ImageApiError('图片 API 请求失败', { retryable: false });
}

export async function requestImageEdit(
  prompt: string,
  profile: ImageApiProfile,
  inputs: ImageEditInput[],
  signal: AbortSignal,
): Promise<ImageResource> {
  const url = inferImageEditUrl(profile.serviceUrl);
  if (!profile.serviceUrl.trim()) throw new ImageApiError('图片服务地址为空');
  if (!prompt.trim()) throw new ImageApiError('礼物 CG 绘图提示词为空');
  if (inputs.length < 2) throw new ImageApiError('礼物 CG 至少需要角色参考图和模板图');
  if (!profile.model.trim()) throw new ImageApiError('当前 API 配置尚未选择模型');

  const form = new FormData();
  form.append('model', profile.model.trim());
  form.append('prompt', prompt.trim());
  form.append('n', '1');
  form.append('size', profile.imageSize);
  inputs.forEach(input => form.append('image', input.file, input.filename));
  appendExtraBody(form, profile.extraBody);

  const headers: Record<string, string> = {};
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
  const timeoutMs = Number.isFinite(profile.timeoutMs) ? Math.max(1_000, profile.timeoutMs) : 120_000;
  const totalAttempts = Number.isFinite(profile.retryAttempts) ? Math.max(1, profile.retryAttempts + 1) : 1;
  const retryDelayMs = Number.isFinite(profile.retryDelayMs) ? Math.max(0, profile.retryDelayMs) : 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { method: 'POST', headers, body: form }, timeoutMs, signal);
      const responseText = await response.text();
      if (!response.ok) {
        throw new ImageApiError(`图生图 API 返回 HTTP ${response.status}`, {
          retryable: isRetryableStatus(response.status),
          status: response.status,
        });
      }
      const resources = collectImageResources(parseResponsePayload(responseText), responseText);
      const resource = resources[0];
      resources.slice(1).forEach(item => item.revoke?.());
      if (!resource) throw new ImageApiError('图生图 API 响应中没有可显示的图片');
      return resource;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw makeAbortError('礼物 CG 请求已取消');
      lastError = error;
      const retryable = error instanceof ImageApiError ? error.retryable : true;
      if (!retryable || attempt >= totalAttempts) break;
      await sleep(retryDelayMs, signal);
    }
  }

  if (lastError instanceof ImageApiError) throw lastError;
  throw new ImageApiError('图生图 API 请求失败', { retryable: false });
}

export async function requestGiftImage({
  prompt,
  references,
  profile,
  requestMode,
  jsonReferenceField,
  signal,
}: {
  prompt: string;
  references: GiftImageReference[];
  profile: ImageApiProfile;
  requestMode: GiftRequestMode;
  jsonReferenceField: 'images' | 'reference_images' | 'image';
  signal: AbortSignal;
}): Promise<ImageResource> {
  const url = profile.serviceUrl.trim();
  if (!url) throw new ImageApiError('图片服务地址为空');
  if (!prompt.trim()) throw new ImageApiError('礼物 CG 绘图提示词为空');
  if (references.length < 3) throw new ImageApiError('礼物 CG 需要角色 1、角色 2 和模板图');
  if (!profile.model.trim()) throw new ImageApiError('当前 API 配置尚未选择模型');

  const resolvedMode = resolveGiftRequestMode(url, requestMode);
  const timeoutMs = Number.isFinite(profile.timeoutMs) ? Math.max(1_000, profile.timeoutMs) : 120_000;
  const totalAttempts = Number.isFinite(profile.retryAttempts) ? Math.max(1, profile.retryAttempts + 1) : 1;
  const retryDelayMs = Number.isFinite(profile.retryDelayMs) ? Math.max(0, profile.retryDelayMs) : 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const headers: Record<string, string> = {};
      if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
      let request: RequestInit;

      if (resolvedMode === 'multipart-edit') {
        const form = new FormData();
        form.append('model', profile.model.trim());
        form.append('prompt', prompt.trim());
        form.append('n', '1');
        form.append('size', profile.imageSize);
        for (const reference of references) {
          const input = await referenceToInput(reference, timeoutMs, signal);
          form.append('image', input.file, input.filename);
        }
        appendExtraBody(form, profile.extraBody);
        request = { method: 'POST', headers, body: form };
      } else if (resolvedMode === 'chat-multimodal') {
        const content = [
          { type: 'text', text: prompt.trim() },
          ...references.map(reference => ({
            type: 'image_url',
            image_url: { url: referenceUrl(reference) },
          })),
        ];
        request = {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...profile.extraBody,
            model: profile.model.trim(),
            messages: [{ role: 'user', content }],
            n: 1,
            size: profile.imageSize,
          }),
        };
      } else {
        request = {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...profile.extraBody,
            model: profile.model.trim(),
            prompt: prompt.trim(),
            n: 1,
            size: profile.imageSize,
            [jsonReferenceField]: references.map(referenceUrl),
            reference_characters: references
              .filter(reference => reference.kind === 'character')
              .map(reference => reference.name),
          }),
        };
      }

      const response = await fetchWithTimeout(url, request, timeoutMs, signal);
      const responseText = await response.text();
      if (!response.ok) {
        throw new ImageApiError(`图生图 API 返回 HTTP ${response.status}`, {
          retryable: isRetryableStatus(response.status),
          status: response.status,
        });
      }
      return collectGiftResponse(responseText);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw makeAbortError('礼物 CG 请求已取消');
      lastError = error;
      const retryable = error instanceof ImageApiError ? error.retryable : true;
      if (!retryable || attempt >= totalAttempts) break;
      await sleep(retryDelayMs, signal);
    }
  }

  if (lastError instanceof ImageApiError) throw lastError;
  throw new ImageApiError('图生图 API 请求失败', { retryable: false });
}
