import type { ImageApiProfile } from './settings';

export class ModelListApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelListApiError';
  }
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function inferModelListUrl(serviceUrl: string): string {
  const value = serviceUrl.trim();
  if (!value) return '';

  try {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const url = new URL(value, base);
    const path = normalizePath(url.pathname);
    if (/\/images\/generations$/i.test(path)) url.pathname = path.replace(/\/images\/generations$/i, '/models');
    else if (/\/images$/i.test(path)) url.pathname = path.replace(/\/images$/i, '/models');
    else if (/\/v1$/i.test(path)) url.pathname = `${path}/models`;
    else if (!/\/models$/i.test(path)) url.pathname = `${path}/models`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `${value.replace(/\/+$/, '')}/models`;
  }
}

function resolveModelListUrl(profile: ImageApiProfile): string {
  const value = profile.modelListUrl.trim() || inferModelListUrl(profile.serviceUrl);
  if (!value) throw new ModelListApiError('模型列表地址为空，请填写图片 API 地址或模型列表 API 地址。');
  try {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    return new URL(value, base).toString();
  } catch {
    throw new ModelListApiError('模型列表地址无效，请检查地址格式。');
  }
}

function readModelId(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'model']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  return null;
}

function parseModelList(payload: unknown): string[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).data ??
        (payload as Record<string, unknown>).models ??
        (payload as Record<string, unknown>).results)
      : null;
  if (!Array.isArray(candidates)) return [];
  return Array.from(new Set(candidates.map(readModelId).filter((model): model is string => Boolean(model))));
}

export async function fetchModelList(profile: ImageApiProfile, signal: AbortSignal): Promise<string[]> {
  const url = resolveModelListUrl(profile);
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  const timeoutMs = Number.isFinite(profile.timeoutMs) ? Math.max(1_000, profile.timeoutMs) : 120_000;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (signal.aborted) throw new ModelListApiError('模型列表请求已取消。');
  signal.addEventListener('abort', forwardAbort, { once: true });
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new ModelListApiError(`模型列表请求失败（HTTP ${response.status}）。`);
    const models = parseModelList((await response.json()) as unknown);
    if (models.length === 0) throw new ModelListApiError('模型列表响应中没有可用模型。');
    return models;
  } catch (error) {
    if (error instanceof ModelListApiError) throw error;
    if (signal.aborted) throw new ModelListApiError('模型列表请求已取消。');
    if (timedOut) throw new ModelListApiError(`模型列表请求超时（${timeoutMs}ms）。`);
    throw new ModelListApiError('模型列表拉取失败，请检查地址、API Key 或跨域设置。');
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}
