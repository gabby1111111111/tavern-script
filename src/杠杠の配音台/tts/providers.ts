import type { SynthesisRequest, SynthesizedAudio, TtsProviderProfile, TtsProviderKind, VoiceOption } from '../types';
import { DEFAULT_DOUBAO_RESOURCE_ID } from './doubao-request';
import {
  buildMimoRequest,
  buildMinimaxRequest,
  buildMinimaxVoiceListRequest,
  parseMimoResponse,
  parseMinimaxResponse,
  parseMinimaxVoiceListResponse,
} from './cloud-request';
import { getStaticVoiceCatalog, normalizeDiscoveredMinimaxVoices } from './voice-catalog';

export const MAX_TTS_RESPONSE_BYTES = 80 * 1024 * 1024;
export const DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT = '/api/plugins/ganggang-tts-bridge/doubao/synthesize';
export const DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT = '/api/plugins/ganggang-tts-bridge/capabilities';
export const DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE = 'application/vnd.ganggang-tts+json';

export type ProviderProbeResult = {
  ok: true;
  mode?: 'direct' | 'plugin';
  configured?: boolean;
  unverified?: boolean;
  voiceCount?: number;
};

export type TtsProviderAdapter = {
  probe: (profile: TtsProviderProfile, signal?: AbortSignal) => Promise<ProviderProbeResult>;
  listVoices: (profile: TtsProviderProfile, signal?: AbortSignal) => Promise<VoiceOption[]>;
  synthesize: (profile: TtsProviderProfile, request: SynthesisRequest) => Promise<SynthesizedAudio>;
};

export type ProviderRegistry = {
  get: (profile: TtsProviderProfile) => TtsProviderAdapter;
  probe: (profile: TtsProviderProfile, signal?: AbortSignal) => Promise<ProviderProbeResult>;
  listVoices: (profile: TtsProviderProfile, signal?: AbortSignal) => Promise<VoiceOption[]>;
  synthesize: (profile: TtsProviderProfile, request: SynthesisRequest) => Promise<SynthesizedAudio>;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function assertProfile(profile: TtsProviderProfile, expectedType?: TtsProviderKind): void {
  if (!profile || typeof profile !== 'object') throw new Error('TTS Provider Profile 不存在');
  if (profile.enabled === false) throw new Error(`TTS Profile 已禁用: ${profile.name || profile.id || 'unknown'}`);
  if (expectedType && profile.type !== expectedType) {
    throw new Error(`TTS Profile 类型不匹配: ${profile.type || 'unknown'}`);
  }
}

function ensureText(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) throw new Error('TTS 文本为空');
  return text;
}

function getCredentials(profile: TtsProviderProfile): string[] {
  return [profile.apiKey, profile.appId, profile.accessKey, profile.groupId]
    .map(value => String(value || '').trim())
    .filter(Boolean);
}

/** Redact credential-shaped profile fields before an error leaves this module. */
export function redactProviderSecrets(value: unknown, profile: TtsProviderProfile): string {
  let text = String(value || '');
  for (const secret of getCredentials(profile)) text = text.split(secret).join('[redacted]');
  return text;
}

async function readLimitedBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_TTS_RESPONSE_BYTES) throw new Error('TTS response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_TTS_RESPONSE_BYTES) throw new Error('TTS response is too large');
  return bytes;
}

async function throwResponseError(response: Response, label: string, profile: TtsProviderProfile): Promise<never> {
  const message = await response.text().catch(() => '');
  throw new Error(
    redactProviderSecrets(`${label} HTTP ${response.status}${message ? ` ${message.slice(0, 300)}` : ''}`, profile),
  );
}

async function readAudioResponse(
  response: Response,
  label: string,
  profile: TtsProviderProfile,
): Promise<SynthesizedAudio> {
  if (!response.ok) await throwResponseError(response, label, profile);
  const bytes = await readLimitedBytes(response);
  if (!bytes.length) throw new Error(`${label} 返回了空音频`);
  const mimeType = response.headers?.get?.('content-type') || 'audio/wav';
  if (/json|text\/html/i.test(mimeType)) {
    const message = new TextDecoder().decode(bytes).slice(0, 300);
    throw new Error(redactProviderSecrets(`${label} 未返回音频${message ? `: ${message}` : ''}`, profile));
  }
  return { blob: blobFromBytes(bytes, mimeType), mimeType };
}

function blobFromBytes(bytes: Uint8Array, mimeType: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mimeType });
}

async function readStructuredResponse(
  response: Response,
  label: string,
  profile: TtsProviderProfile,
): Promise<Uint8Array> {
  if (!response.ok) await throwResponseError(response, label, profile);
  return readLimitedBytes(response);
}

function withRedactedError(error: unknown, profile: TtsProviderProfile): never {
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') throw error;
  throw new Error(redactProviderSecrets(error instanceof Error ? error.message : error, profile));
}

export type OpenAiSpeechPayload = {
  model: string;
  input: string;
  voice: string;
  response_format: string;
  speed: number;
  [key: string]: unknown;
};

export function buildOpenAiSpeechPayload(profile: TtsProviderProfile, request: SynthesisRequest): OpenAiSpeechPayload {
  assertProfile(profile, 'openai-compatible');
  const text = ensureText(request?.text);
  const model = String(profile.model || '').trim();
  const voice = String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim();
  if (!model) throw new Error('OpenAI 兼容 Profile 缺少 model');
  if (!voice) throw new Error('OpenAI 兼容 Profile 缺少 voice');
  const extraBody = profile.extraBody && typeof profile.extraBody === 'object' ? profile.extraBody : {};
  const speed = Number.isFinite(Number(request?.voice?.speed)) ? Number(request.voice.speed) : 1;
  return {
    model,
    input: text,
    voice,
    response_format: String(profile.responseFormat || 'wav'),
    speed,
    ...extraBody,
  };
}

export function buildDoubaoPayload(profile: TtsProviderProfile, request: SynthesisRequest) {
  assertProfile(profile, 'doubao');
  const apiKey = String(profile.apiKey || '').trim();
  const appId = apiKey ? '' : String(profile.appId || '').trim();
  const accessKey = apiKey ? '' : String(profile.accessKey || '').trim();
  const resourceId = String(profile.resourceId || DEFAULT_DOUBAO_RESOURCE_ID).trim();
  const speaker = String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim();
  const text = ensureText(request?.text);
  if (apiKey.length > 2_048 || accessKey.length > 2_048) throw new Error('豆包 TTS 凭据过长');
  if (!apiKey && (!appId || !accessKey)) throw new Error('豆包 TTS 缺少旧版 APP ID 或 Access Key');
  if (!resourceId) throw new Error('豆包 TTS 缺少 Resource ID');
  if (!speaker) throw new Error('豆包 TTS 缺少 Speaker ID');
  if (text.length > 10_000) throw new Error('豆包 TTS 文本过长');
  const payload = {
    apiKey,
    appId,
    accessKey,
    resourceId,
    speaker,
    text,
    contextText: String(request?.contextText || '')
      .trim()
      .slice(0, 2_000),
  };
  return payload;
}

type DoubaoBridgeErrorCode =
  | 'VALIDATION_ERROR'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_RATE_LIMIT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INVALID_UPSTREAM_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'CLIENT_ABORTED';

function doubaoBridgeErrorMessage(status: number, code: DoubaoBridgeErrorCode | ''): string {
  if (status === 404) return '豆包桥接不可用（未安装或版本过旧）';
  if (code === 'UPSTREAM_AUTH') return '豆包鉴权失败';
  if (code === 'UPSTREAM_RATE_LIMIT') return '豆包服务繁忙，请稍后重试';
  if (code === 'UPSTREAM_TIMEOUT') return '豆包服务响应超时';
  if (status === 413 || code === 'RESPONSE_TOO_LARGE') return '豆包音频超过大小限制';
  if (status === 400 || code === 'VALIDATION_ERROR') return '豆包请求配置无效';
  if (code === 'INVALID_UPSTREAM_RESPONSE') return '豆包桥接未返回有效音频';
  if (status === 499 || code === 'CLIENT_ABORTED') return '豆包请求已取消';
  return '豆包合成失败';
}

async function throwDoubaoBridgeError(response: Response): Promise<never> {
  let code: DoubaoBridgeErrorCode | '' = '';
  try {
    const contentType = response.headers?.get?.('content-type') || '';
    if (/application\/json/i.test(contentType)) {
      const body = (await response.json()) as { error?: { code?: unknown } | unknown };
      const rawCode =
        typeof body?.error === 'object' && body.error !== null ? (body.error as { code?: unknown }).code : '';
      code = String(rawCode || '')
        .trim()
        .toUpperCase() as DoubaoBridgeErrorCode;
    }
  } catch {
    // The bridge response body is deliberately not reflected into browser errors.
  }
  throw new Error(doubaoBridgeErrorMessage(response.status, code));
}

async function readDoubaoBridgeAudio(response: Response): Promise<SynthesizedAudio> {
  if (!response.ok) await throwDoubaoBridgeError(response);
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/^audio\/mpeg(?:\s*;|$)/i.test(contentType)) throw new Error('豆包桥接未返回有效音频');
  let bytes: Uint8Array;
  try {
    bytes = await readLimitedBytes(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'TTS response is too large') {
      throw new Error('豆包音频超过大小限制', { cause: error });
    }
    throw error;
  }
  if (!bytes.length) throw new Error('豆包桥接返回了空音频');
  return { blob: blobFromBytes(bytes, 'audio/mpeg'), mimeType: 'audio/mpeg' };
}

async function readDoubaoBridgeCapabilities(response: Response): Promise<void> {
  if (!response.ok) await throwDoubaoBridgeError(response);
  let body: {
    pluginId?: unknown;
    doubao?: {
      available?: unknown;
      synthesizePath?: unknown;
      requestContentType?: unknown;
      responseContentType?: unknown;
    };
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error('豆包桥接版本过旧');
  }
  const supported =
    body.pluginId === 'ganggang-tts-bridge' &&
    body.doubao?.available === true &&
    body.doubao.synthesizePath === DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT &&
    body.doubao.requestContentType === DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE &&
    body.doubao.responseContentType === 'audio/mpeg';
  if (!supported) throw new Error('豆包桥接版本过旧');
}

export function buildMinimaxPayload(profile: TtsProviderProfile, request: SynthesisRequest) {
  assertProfile(profile, 'minimax');
  const payload = {
    apiKey: String(profile.apiKey || '').trim(),
    platform: String(profile.platform || 'cn').trim(),
    model: String(profile.model || 'speech-2.8-hd').trim(),
    voiceId: String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim(),
    text: ensureText(request?.text),
    format: String(profile.responseFormat || 'mp3').trim(),
    emotion: String(request?.voice?.emotion || profile.style || '').trim(),
    speed: Number.isFinite(Number(request?.voice?.speed)) ? Number(request.voice.speed) : 1,
  };
  buildMinimaxRequest(payload);
  return payload;
}

export function buildMimoPayload(profile: TtsProviderProfile, request: SynthesisRequest) {
  assertProfile(profile, 'xiaomi-mimo');
  const payload = {
    apiKey: String(profile.apiKey || '').trim(),
    model: String(profile.model || 'mimo-v2.5-tts').trim(),
    voiceId: String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim(),
    text: ensureText(request?.text),
    format: String(profile.responseFormat || 'wav').trim(),
    style: String(profile.style || '').trim(),
  };
  buildMimoRequest(payload);
  return payload;
}

// Compatibility names retained for the small amount of routing code that was
// ported from HybridAudiobookStage.  They still return request-only payloads;
// no credential is ever included in a cache descriptor or synthesis result.
export const buildDoubaoProxyPayload = buildDoubaoPayload;
export const buildMinimaxProxyPayload = buildMinimaxPayload;
export const buildXiaomiMimoProxyPayload = buildMimoPayload;

export function createProviderRegistry({
  fetchImpl = globalThis.fetch,
  getSillyTavernHeaders = () => ({ 'Content-Type': 'application/json' }),
}: {
  fetchImpl?: FetchLike;
  getSillyTavernHeaders?: () => Record<string, string>;
} = {}): ProviderRegistry {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const fetcher = fetchImpl;

  const adapters: Record<TtsProviderKind, TtsProviderAdapter> = {
    'openai-compatible': {
      async probe(profile) {
        assertProfile(profile, 'openai-compatible');
        if (!String(profile.endpoint || '').trim()) throw new Error('OpenAI 兼容 Profile 缺少 endpoint');
        buildOpenAiSpeechPayload(profile, {
          text: '配置检查',
          voice: { providerProfileId: profile.id, voiceId: profile.defaultVoiceId },
          signal: new AbortController().signal,
        });
        return { ok: true, mode: 'direct', unverified: true };
      },
      async listVoices(profile) {
        assertProfile(profile, 'openai-compatible');
        return getStaticVoiceCatalog(profile);
      },
      async synthesize(profile, request) {
        assertProfile(profile, 'openai-compatible');
        const endpoint = String(profile.endpoint || '').trim();
        if (!endpoint) throw new Error('OpenAI 兼容 Profile 缺少 endpoint');
        const payload = buildOpenAiSpeechPayload(profile, request);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
        const response = await fetcher(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: request.signal,
        });
        return readAudioResponse(response, profile.name || 'OpenAI-compatible TTS', profile);
      },
    },
    edge: {
      async probe(profile, signal) {
        assertProfile(profile, 'edge');
        const response = await fetcher('/api/plugins/edge-tts/probe', {
          method: 'POST',
          headers: getSillyTavernHeaders(),
          signal,
        });
        if (!response.ok && response.status !== 204) throw new Error(`Edge TTS HTTP ${response.status}`);
        return { ok: true, mode: 'plugin' };
      },
      async listVoices(profile) {
        assertProfile(profile, 'edge');
        return getStaticVoiceCatalog(profile);
      },
      async synthesize(profile, request) {
        assertProfile(profile, 'edge');
        const text = ensureText(request?.text);
        const voice = String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim();
        if (!voice) throw new Error('Edge Profile 缺少 voice');
        const rate = Number.isFinite(Number(profile.edgeRate)) ? Number(profile.edgeRate) : 0;
        const response = await fetcher('/api/plugins/edge-tts/generate', {
          method: 'POST',
          headers: getSillyTavernHeaders(),
          body: JSON.stringify({ text, voice, rate }),
          signal: request.signal,
        });
        return readAudioResponse(response, profile.name || 'Edge TTS', profile);
      },
    },
    doubao: {
      async probe(profile, signal) {
        buildDoubaoPayload(profile, {
          text: '配置检查',
          voice: { providerProfileId: profile.id, voiceId: profile.defaultVoiceId },
          signal: signal ?? new AbortController().signal,
        });
        const response = await fetcher(DOUBAO_BRIDGE_CAPABILITIES_ENDPOINT, {
          method: 'GET',
          headers: getSillyTavernHeaders(),
          signal,
        });
        await readDoubaoBridgeCapabilities(response);
        return { ok: true, mode: 'plugin', configured: true, unverified: true };
      },
      async listVoices(profile) {
        assertProfile(profile, 'doubao');
        return getStaticVoiceCatalog(profile);
      },
      async synthesize(profile, request) {
        const payload = buildDoubaoPayload(profile, request);
        try {
          const response = await fetcher(DOUBAO_BRIDGE_SYNTHESIS_ENDPOINT, {
            method: 'POST',
            headers: {
              ...getSillyTavernHeaders(),
              'Content-Type': DOUBAO_BRIDGE_REQUEST_CONTENT_TYPE,
            },
            body: JSON.stringify(payload),
            signal: request.signal,
          });
          return await readDoubaoBridgeAudio(response);
        } catch (error) {
          return withRedactedError(error, profile);
        }
      },
    },
    minimax: {
      async probe(profile, signal) {
        const voices = await this.listVoices(profile, signal);
        return { ok: true, mode: 'direct', configured: true, voiceCount: voices.length };
      },
      async listVoices(profile, signal) {
        assertProfile(profile, 'minimax');
        try {
          const upstream = buildMinimaxVoiceListRequest(profile);
          const response = await fetcher(upstream.url, {
            method: 'POST',
            headers: upstream.headers,
            body: JSON.stringify(upstream.payload),
            signal,
          });
          const bytes = await readStructuredResponse(response, 'MiniMax 音色列表', profile);
          return normalizeDiscoveredMinimaxVoices(parseMinimaxVoiceListResponse(bytes), profile.id);
        } catch (error) {
          return withRedactedError(error, profile);
        }
      },
      async synthesize(profile, request) {
        const payload = buildMinimaxPayload(profile, request);
        try {
          const upstream = buildMinimaxRequest(payload);
          const response = await fetcher(upstream.url, {
            method: 'POST',
            headers: upstream.headers,
            body: JSON.stringify(upstream.payload),
            signal: request.signal,
          });
          const responseBytes = await readStructuredResponse(response, profile.name || 'MiniMax TTS', profile);
          const audioBytes = parseMinimaxResponse(responseBytes, MAX_TTS_RESPONSE_BYTES);
          const mimeType = upstream.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
          return { blob: blobFromBytes(audioBytes, mimeType), mimeType };
        } catch (error) {
          return withRedactedError(error, profile);
        }
      },
    },
    'xiaomi-mimo': {
      async probe(profile) {
        buildMimoPayload(profile, {
          text: '配置检查',
          voice: { providerProfileId: profile.id, voiceId: profile.defaultVoiceId },
          signal: new AbortController().signal,
        });
        return { ok: true, mode: 'direct', configured: true, unverified: true };
      },
      async listVoices(profile) {
        assertProfile(profile, 'xiaomi-mimo');
        return getStaticVoiceCatalog(profile);
      },
      async synthesize(profile, request) {
        const payload = buildMimoPayload(profile, request);
        try {
          const upstream = buildMimoRequest(payload);
          const response = await fetcher(upstream.url, {
            method: 'POST',
            headers: upstream.headers,
            body: JSON.stringify(upstream.payload),
            signal: request.signal,
          });
          const responseBytes = await readStructuredResponse(response, profile.name || '小米 MiMo TTS', profile);
          const audioBytes = parseMimoResponse(responseBytes, MAX_TTS_RESPONSE_BYTES);
          const mimeType = upstream.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
          return { blob: blobFromBytes(audioBytes, mimeType), mimeType };
        } catch (error) {
          return withRedactedError(error, profile);
        }
      },
    },
  };

  const get = (profile: TtsProviderProfile): TtsProviderAdapter => {
    assertProfile(profile);
    const adapter = adapters[profile.type];
    if (!adapter) throw new Error(`不支持的 TTS Provider: ${profile.type || 'unknown'}`);
    return adapter;
  };

  return {
    get,
    probe: (profile, signal) => get(profile).probe(profile, signal),
    listVoices: (profile, signal) => get(profile).listVoices(profile, signal),
    synthesize: (profile, request) => get(profile).synthesize(profile, request),
  };
}
