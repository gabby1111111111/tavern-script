import type { ImageRequestInput } from './pipeline-types';
import type { ImageApiProfile } from './settings';

/** v0.3 统一入口支持的参考图请求形态。 */
export type ImageRequestMode = 'auto' | 'multipart-edit' | 'chat-multimodal' | 'json-reference';
export type MultipartImageField = 'auto' | 'image' | 'image[]';

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

export type ResolvedImageRequestMode = Exclude<ImageRequestMode, 'auto'>;

export function resolveImageRequestMode(serviceUrl: string, configured: ImageRequestMode): ResolvedImageRequestMode {
  if (configured !== 'auto') return configured;
  const normalized = serviceUrl.toLowerCase();
  if (normalized.includes('/images/edits')) return 'multipart-edit';
  if (normalized.includes('/chat/completions')) return 'chat-multimodal';
  return 'multipart-edit';
}

function serviceHostname(serviceUrl: string): string {
  try {
    const baseUrl = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    return new URL(serviceUrl.trim(), baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function resolveMultipartImageField(
  serviceUrl: string,
  configured: MultipartImageField,
): Exclude<MultipartImageField, 'auto'> {
  if (configured !== 'auto') return configured;
  return serviceHostname(serviceUrl) === 'api.openai.com' ? 'image[]' : 'image';
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
    if (timedOut || isAbortError(error)) throw new ImageApiError(`图片 API 请求超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    window.clearTimeout(timer);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
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

function dataUrlToBlob(value: string): Blob {
  const match = value.match(/^data:(image\/[\w.+-]+);base64,(.*)$/is);
  if (!match) throw new ImageApiError('参考图数据格式无效');
  const decode = typeof window !== 'undefined' && typeof window.atob === 'function' ? window.atob.bind(window) : atob;
  const binary = decode(match[2].replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const mimeType = blob.type.startsWith('image/') ? blob.type : 'image/png';
  if (typeof FileReader !== 'undefined') {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string' && result.startsWith('data:')) resolve(result);
        else reject(new ImageApiError('参考图读取结果无效'));
      };
      reader.onerror = () => reject(new ImageApiError('参考图读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  // FileReader is a browser API, but this fallback keeps the adapter testable in
  // a non-DOM harness. The resulting data URL is still request-local only.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const encode = typeof window !== 'undefined' && typeof window.btoa === 'function' ? window.btoa.bind(window) : btoa;
  return `data:${mimeType};base64,${encode(binary)}`;
}

function referenceFilename(value: string, index: number): string {
  try {
    const baseUrl = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    const pathname = new URL(value, baseUrl).pathname;
    const candidate = pathname.split('/').pop()?.trim() ?? '';
    const safe = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (safe) return safe;
  } catch {
    // Use a deterministic fallback for data URLs and malformed relative paths.
  }
  return `reference-${index + 1}.png`;
}

async function referenceStringToInput(
  value: string,
  index: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ImageEditInput> {
  const normalized = value.trim();
  if (!normalized) throw new ImageApiError('参考图地址为空');
  if (isDataImageUrl(normalized)) {
    return { file: dataUrlToBlob(normalized), filename: referenceFilename(normalized, index) };
  }
  const response = await fetchWithTimeout(normalized, { method: 'GET' }, timeoutMs, signal);
  if (!response.ok) throw new ImageApiError(`参考图读取失败（HTTP ${response.status}）`);
  return { file: await response.blob(), filename: referenceFilename(normalized, index) };
}

function isHttpReference(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isSameOriginReference(value: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const pageUrl = new URL(window.location.href);
    return new URL(value, pageUrl).origin === pageUrl.origin;
  } catch {
    return false;
  }
}

function shouldUseReferenceDirectly(value: string): boolean {
  if (isDataImageUrl(value)) return true;
  // A remote provider can fetch a genuinely remote HTTPS URL itself. Relative,
  // blob, and same-origin URLs point back to ST and must be uploaded inline.
  return isHttpReference(value) && !isSameOriginReference(value);
}

async function resolveJsonReference(value: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const normalized = value.trim();
  if (!normalized) throw new ImageApiError('参考图地址为空');
  if (shouldUseReferenceDirectly(normalized)) return normalized;

  const sourceUrl = typeof window !== 'undefined' ? new URL(normalized, window.location.href).toString() : normalized;
  const response = await fetchWithTimeout(sourceUrl, { method: 'GET' }, timeoutMs, signal);
  if (!response.ok) throw new ImageApiError(`参考图读取失败（HTTP ${response.status}）`);
  if (signal.aborted) throw makeAbortError('图片请求已取消');
  const dataUrl = await blobToDataUrl(await response.blob());
  if (signal.aborted) throw makeAbortError('图片请求已取消');
  return dataUrl;
}

async function resolveJsonReferences(values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
  const resolved: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    resolved.push(await resolveJsonReference(values[index], timeoutMs, signal));
  }
  return resolved;
}

export type ImageApiProfileWithMode = ImageApiProfile & {
  requestMode?: ImageRequestMode;
  multipartImageField?: MultipartImageField;
  jsonReferenceField?: 'images' | 'reference_images' | 'image';
};

function profileRequestMode(profile: ImageApiProfileWithMode): ImageRequestMode {
  return profile.requestMode ?? 'auto';
}

function profileMultipartImageField(profile: ImageApiProfileWithMode): MultipartImageField {
  return profile.multipartImageField ?? 'auto';
}

function profileJsonReferenceField(profile: ImageApiProfileWithMode): 'images' | 'reference_images' | 'image' {
  return profile.jsonReferenceField ?? 'images';
}

function jsonBodyWithoutReferenceFields(
  profile: ImageApiProfileWithMode,
  includeReferenceField: string | null,
): Record<string, unknown> {
  const referenceFields = new Set(['images', 'reference_images', 'image']);
  const body: Record<string, unknown> = {};
  Object.entries(profile.extraBody).forEach(([key, value]) => {
    if (referenceFields.has(key) && key !== includeReferenceField) return;
    body[key] = value;
  });
  return body;
}

type ImageValueOptions = {
  allowMarkdown?: boolean;
  allowBase64?: boolean;
};

export function collectImageResources(payload: unknown, responseText = ''): ImageResource[] {
  const resources: ImageResource[] = [];
  const seen = new Set<string>();

  const pushRemote = (value: string): void => {
    const url = value.trim();
    if (!url || !isRemoteUrl(url) || seen.has(url)) return;
    seen.add(url);
    resources.push({ url, kind: 'remote-url' });
  };

  const pushData = (value: string): void => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    try {
      const resource = createObjectUrlFromBase64(normalized);
      seen.add(normalized);
      resources.push(resource);
    } catch {
      // Ignore malformed candidate fields and continue looking for another result.
    }
  };

  function collectImageField(value: unknown, options: ImageValueOptions = {}): void {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      if (isDataImageUrl(text)) pushData(text);
      else if (isRemoteUrl(text)) pushRemote(text);
      else if (options.allowBase64) pushData(`data:image/png;base64,${text}`);
      if (options.allowMarkdown) markdownImageUrls(text).forEach(pushRemote);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(item => collectImageField(item, options));
      return;
    }

    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if ('url' in record) collectImageField(record.url);
    if ('b64_json' in record) collectImageField(record.b64_json, { allowBase64: true });
    if ('base64' in record) collectImageField(record.base64, { allowBase64: true });
    if ('base64_json' in record) collectImageField(record.base64_json, { allowBase64: true });
    if ('image_url' in record) collectImageField(record.image_url);
    if ('image' in record) collectImageField(record.image, { ...options, allowBase64: true });
    if ('images' in record) collectImageField(record.images, { ...options, allowBase64: true });
  }

  function collectChatContent(value: unknown): void {
    if (typeof value === 'string') {
      const text = value.trim();
      if (isDataImageUrl(text)) pushData(text);
      markdownImageUrls(text).forEach(pushRemote);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(item => collectChatContent(item));
      return;
    }

    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'image_url') {
      collectImageField(record.image_url);
      return;
    }
    if (record.type === 'image') {
      collectImageField(record.image ?? record.source, { allowBase64: true });
      return;
    }
    if ('image_url' in record) collectImageField(record.image_url);
    if ('image' in record) collectImageField(record.image, { allowBase64: true });
    if ('text' in record) collectChatContent(record.text);
    if ('content' in record) collectChatContent(record.content);
  }

  function collectOutputField(value: unknown): void {
    collectImageField(value, { allowMarkdown: true });
    if (Array.isArray(value)) {
      value.forEach(item => collectOutputField(item));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if ('content' in record) collectChatContent(record.content);
    if ('text' in record) collectChatContent(record.text);
    if ('output' in record) collectOutputField(record.output);
    if ('result' in record) collectOutputField(record.result);
  }

  function collectChatChoices(value: unknown): void {
    if (!Array.isArray(value)) return;
    value.forEach(choice => {
      if (!choice || typeof choice !== 'object') return;
      const record = choice as Record<string, unknown>;
      if ('message' in record) collectChatContent(record.message);
      if ('delta' in record) collectChatContent(record.delta);
      if ('text' in record) collectChatContent(record.text);
    });
  }

  if (typeof payload === 'string') {
    collectImageField(payload, { allowMarkdown: true });
    if (responseText && responseText !== payload) markdownImageUrls(responseText).forEach(pushRemote);
  } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    collectImageField(record.data);
    collectOutputField(record.output);
    collectImageField(record.image, { allowMarkdown: true, allowBase64: true });
    collectImageField(record.images, { allowMarkdown: true, allowBase64: true });
    collectOutputField(record.result);
    collectImageField(record.url);
    collectImageField(record.image_url);
    collectImageField(record.b64_json, { allowBase64: true });
    collectImageField(record.base64, { allowBase64: true });
    collectImageField(record.base64_json, { allowBase64: true });
    collectChatChoices(record.choices);
    if ('message' in record) collectChatContent(record.message);
    if ('content' in record) collectChatContent(record.content);
  } else if (Array.isArray(payload)) {
    collectImageField(payload);
  }

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
  profile: ImageApiProfileWithMode,
  input: ImageRequestInput,
  signal: AbortSignal,
): Promise<ImageResource> {
  const prompt = input.prompt;
  const referenceImages = (input.referenceImages ?? []).map(reference => reference.trim()).filter(Boolean);
  const url = profile.serviceUrl.trim();
  if (!url) throw new ImageApiError('图片服务地址为空');
  if (!prompt.trim()) throw new ImageApiError('绘图提示词为空');
  if (!profile.model.trim()) throw new ImageApiError('当前 API 配置尚未选择模型');

  const timeoutMs = Number.isFinite(profile.timeoutMs) ? Math.max(1_000, profile.timeoutMs) : 120_000;
  const configuredMode = profileRequestMode(profile);
  // An empty reference list must remain a normal generation request. In particular,
  // An output preset with avatar references disabled must never accidentally turn into an edit request.
  const resolvedMode =
    referenceImages.length === 0 && configuredMode === 'auto'
      ? 'generation'
      : configuredMode === 'auto'
        ? resolveImageRequestMode(url, configuredMode)
        : configuredMode;

  try {
    const apiKey = profile.apiKey.trim();
    const authHeaders: Record<string, string> = {};
    if (apiKey) authHeaders.Authorization = `Bearer ${apiKey}`;

    const jsonReferences =
      referenceImages.length > 0 && (resolvedMode === 'chat-multimodal' || resolvedMode === 'json-reference')
        ? await resolveJsonReferences(referenceImages, timeoutMs, signal)
        : referenceImages;

    let requestUrl = url;
    let request: RequestInit;

    if (resolvedMode === 'multipart-edit' && referenceImages.length > 0) {
      requestUrl = inferImageEditUrl(url);
      const form = new FormData();
      form.append('model', profile.model.trim());
      form.append('prompt', prompt.trim());
      form.append('n', '1');
      form.append('size', profile.imageSize);
      const imageField = resolveMultipartImageField(requestUrl, profileMultipartImageField(profile));
      for (let index = 0; index < referenceImages.length; index += 1) {
        const inputImage = await referenceStringToInput(referenceImages[index], index, timeoutMs, signal);
        form.append(imageField, inputImage.file, inputImage.filename);
      }
      appendExtraBody(form, profile.extraBody);
      const headers = { ...authHeaders };
      if (apiKey && serviceHostname(requestUrl) !== 'api.openai.com') headers['X-Api-Key'] = apiKey;
      request = { method: 'POST', headers, body: form };
    } else if (resolvedMode === 'chat-multimodal') {
      const content = [
        { type: 'text', text: prompt.trim() },
        ...jsonReferences.map(reference => ({ type: 'image_url', image_url: { url: reference } })),
      ];
      request = {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...jsonBodyWithoutReferenceFields(profile, null),
          model: profile.model.trim(),
          messages: [{ role: 'user', content }],
          n: 1,
          size: profile.imageSize,
        }),
      };
    } else {
      const includeReferenceField =
        resolvedMode === 'json-reference' && referenceImages.length > 0 ? profileJsonReferenceField(profile) : null;
      const body: Record<string, unknown> = {
        ...jsonBodyWithoutReferenceFields(profile, includeReferenceField),
        model: profile.model.trim(),
        prompt: prompt.trim(),
        n: 1,
        size: profile.imageSize,
      };
      if (includeReferenceField) body[includeReferenceField] = jsonReferences;
      request = {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
    }

    const response = await fetchWithTimeout(requestUrl, request, timeoutMs, signal);
    const responseText = await response.text();
    if (!response.ok) {
      throw new ImageApiError(`图片 API 返回 HTTP ${response.status}`, { status: response.status });
    }

    const resources = collectImageResources(parseResponsePayload(responseText), responseText);
    const resource = resources[0];
    resources.slice(1).forEach(item => item.revoke?.());
    if (!resource) throw new ImageApiError('图片 API 响应中没有可显示的图片');
    return resource;
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw makeAbortError('图片请求已取消');
    if (error instanceof ImageApiError) throw error;
    // Do not include prompt, URL, response body, or authentication data in errors.
    throw new ImageApiError('图片 API 请求失败');
  }
}
