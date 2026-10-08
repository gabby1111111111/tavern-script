import type { SynthesisRequest, SynthesizedAudio, TtsProviderProfile, TtsProviderKind, VoiceOption } from '../types';
import { detectAudioType } from './audio-signature';
import { buildDoubaoUpstreamRequest, DEFAULT_DOUBAO_RESOURCE_ID, parseDoubaoNdjson } from './doubao-request';
import {
  buildFishModelListRequest,
  buildFishSynthesisRequest,
  buildMimoRequest,
  buildMinimaxRequest,
  classifyProviderHttpStatus,
  parseFishVoiceListResponse,
  parseMimoResponse,
  parseMinimaxResponse,
} from './cloud-request';
import { getStaticVoiceCatalog, normalizeDiscoveredFishVoices } from './voice-catalog';

export const MAX_TTS_RESPONSE_BYTES = 80 * 1024 * 1024;
/** 豆包返回 base64 分片流，线上字节数必然大于解码后的音频，用解码上限的 4/3 加余量做线上闸门。 */
export const MAX_TTS_WIRE_BYTES = Math.ceil((MAX_TTS_RESPONSE_BYTES * 4) / 3) + 4_096;
/** 酒馆 `/proxy` 自己不设上限，浏览器侧给 Fish 兜 25MB。 */
export const MAX_PROXY_AUDIO_BYTES = 25 * 1024 * 1024;
/** Fish 经 `/proxy` 合成的硬超时，避免上游不响应时永远转圈。 */
export const PROXY_SYNTHESIS_TIMEOUT_MS = 120_000;
const TTS_RESPONSE_TOO_LARGE = 'TTS response is too large';

export type ProviderProbeResult = {
  ok: true;
  /** `direct` 浏览器直连上游；`proxy` 经酒馆同源 `/proxy` 转发；`plugin` 经 SillyTavern server 插件 */
  mode?: 'direct' | 'plugin' | 'proxy';
  configured?: boolean;
  /** `synthesis` 表示该 probe 完成了一次真实合成（联网验证）；缺省表示仅配置/目录检查 */
  checked?: 'synthesis';
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

async function readLimitedBytes(response: Response, maxBytes = MAX_TTS_RESPONSE_BYTES): Promise<Uint8Array> {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error(TTS_RESPONSE_TOO_LARGE);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(TTS_RESPONSE_TOO_LARGE);
  return bytes;
}

/** 把内部英文超限错误翻成带供应商标签的中文原因，避免英文内部标识外泄到界面。 */
async function readBoundedBytes(response: Response, label: string, maxBytes: number): Promise<Uint8Array> {
  try {
    return await readLimitedBytes(response, maxBytes);
  } catch (error) {
    if (error instanceof Error && error.message === TTS_RESPONSE_TOO_LARGE) {
      throw new Error(`${label}数据超过大小限制`, { cause: error });
    }
    throw error;
  }
}

async function throwResponseError(response: Response, label: string, profile: TtsProviderProfile): Promise<never> {
  const message = await response.text().catch(() => '');
  throw new Error(
    redactProviderSecrets(
      `${label} ${classifyProviderHttpStatus(response.status, message)}（HTTP ${response.status}）`,
      profile,
    ),
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
  if (error instanceof TypeError) {
    throw new Error(redactProviderSecrets(`${profile.name || 'TTS'} 网络错误：无法连接服务`, profile));
  }
  throw new Error(redactProviderSecrets(error instanceof Error ? error.message : error, profile));
}

/** probe 用的兜底音色：优先 Profile 默认音色，否则取该 kind 内置目录第一个。 */
function probeVoiceFor(profile: TtsProviderProfile): string {
  const explicit = String(profile.defaultVoiceId || '').trim();
  if (explicit) return explicit;
  return getStaticVoiceCatalog(profile)[0]?.voiceId || '';
}

/**
 * 以一次真实合成（"你好"）作为 probe：验证凭据、额度与连通性。
 * adapter 内部错误已按"凭据/额度/审核/网络"分类并脱敏；此处补充网络层 TypeError 分类。
 * 探针自带 45 秒超时，上游不响应时给出可读失败而不是永远转圈。
 */
async function probeBySynthesis(
  profile: TtsProviderProfile,
  synthesize: (request: SynthesisRequest) => Promise<SynthesizedAudio>,
  signal?: AbortSignal,
  voiceIdOverride = "",
): Promise<ProviderProbeResult> {
  const voiceId = String(voiceIdOverride || probeVoiceFor(profile)).trim();
  if (!voiceId) throw new Error(`${profile.name || 'TTS'} 缺少可用的默认音色，无法联网验证`);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("timeout")), 45_000);
  let signal_: AbortSignal = timeoutController.signal;
  if (signal) {
    signal_ = typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutController.signal]) : signal;
  }
  try {
    await synthesize({
      text: "你好",
      voice: { providerProfileId: profile.id, voiceId },
      signal: signal_,
    });
    return { ok: true, configured: true, checked: "synthesis" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw new Error(redactProviderSecrets(`${profile.name || "TTS"} 探针超时（45 秒无响应）`, profile), {
        cause: error,
      });
    }
    if (error instanceof TypeError) {
      throw new Error(redactProviderSecrets(`${profile.name || "TTS"} 网络错误：无法连接服务`, profile), {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

/** 中文标签直接接中文；以 ASCII 结尾的标签补一个空格，避免出现 "Fish音频" 这类粘字。 */
function withLabel(label: string, text: string): string {
  return `${label}${/[A-Za-z0-9]$/.test(label) ? ' ' : ''}${text}`;
}

/**
 * `/proxy` 失败分类。酒馆在 `enableCorsProxy: false` 时返回 404 "CORS proxy is disabled"，
 * 402 在本项目里等同于"漏了 model 请求头 → 走了付费模型"，都要直接点出修法。
 */
export function describeProxyFailure(label: string, status: number, bodyHead = ''): string {
  if (status === 404) {
    return withLabel(label, '酒馆 /proxy 不可用：请在 config.yaml 打开 enableCorsProxy 并重启酒馆');
  }
  if (status === 402) {
    return withLabel(label, '额度不足：请确认请求头 model 是免费档（默认 s2.1-pro-free）');
  }
  if (status === 401 || status === 403) return withLabel(label, '鉴权失败：凭据无效或未授权');
  if (status === 413) return withLabel(label, '音频超过大小限制');
  if (status === 400) return withLabel(label, '请求配置无效');
  return withLabel(label, `${classifyProviderHttpStatus(status, bodyHead)}（HTTP ${status}）`);
}

/**
 * 读取经酒馆 `/proxy` 流回的音频。
 * 关键点（2026-10-08 在 8000 实测）：`/proxy` 会丢掉上游 `Content-Type`，
 * 所以 MIME 必须先用文件魔数识别，再退回响应头，否则真音频会被误判成"未返回音频"。
 */
async function readProxyAudio(
  response: Response,
  label: string,
  profile: TtsProviderProfile,
): Promise<SynthesizedAudio> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(redactProviderSecrets(describeProxyFailure(label, response.status, body), profile));
  }
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_PROXY_AUDIO_BYTES) throw new Error(withLabel(label, '音频超过大小限制'));
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(withLabel(label, '未返回音频'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_PROXY_AUDIO_BYTES) throw new Error(withLabel(label, '音频超过大小限制'));
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已读完或已被上游终止：取消只是收尾，不覆盖真正的失败原因。
    }
  }
  if (!total) throw new Error(withLabel(label, '返回了空音频'));
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const declaredType = String(response.headers?.get?.('content-type') || '')
    .split(';')[0]
    .trim();
  const mimeType =
    detectAudioType(bytes.subarray(0, 32)) || (/^audio\//i.test(declaredType) ? declaredType : '');
  if (!mimeType) {
    throw new Error(
      redactProviderSecrets(withLabel(label, '未返回音频：/proxy 拼法错误、酒馆未登录或上游返回了文本'), profile),
    );
  }
  return { blob: blobFromBytes(bytes, mimeType), mimeType };
}

/** 把调用方取消与硬超时合成同一个 signal；超时用可读原因 abort，而不是静默挂死。 */
function withSynthesisTimeout(signal: AbortSignal, label: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${label}合成超时（${PROXY_SYNTHESIS_TIMEOUT_MS / 1000} 秒）`)),
    PROXY_SYNTHESIS_TIMEOUT_MS,
  );
  const combined =
    typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return { signal: combined, dispose: () => clearTimeout(timer) };
}

/**
 * 豆包 HTTP 层失败分类。`403` 与 `45000000` 在豆包语义里是"音色与资源 ID 不配套"，
 * 既不是 CORS 问题，也不该报成通用鉴权失败 —— 必须单独点出修法。
 */
async function throwDoubaoResponseError(response: Response, profile: TtsProviderProfile): Promise<never> {
  const body = await response.text().catch(() => '');
  if (response.status === 403 || body.includes('45000000')) {
    throw new Error(
      redactProviderSecrets('豆包 音色与资源 ID 不配套：2.0 音色必须配 X-Api-Resource-Id: seed-tts-2.0', profile),
    );
  }
  throw new Error(
    redactProviderSecrets(`豆包 ${classifyProviderHttpStatus(response.status, body)}（HTTP ${response.status}）`, profile),
  );
}

export function buildMinimaxPayload(profile: TtsProviderProfile, request: SynthesisRequest) {
  assertProfile(profile, 'minimax');
  const payload = {
    apiKey: String(profile.apiKey || '').trim(),
    groupId: String(profile.groupId || '').trim(),
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
    // 导演指令：请求级 instruction（试音台）优先，Profile style 作为常驻兜底
    style: String(request?.instruction || profile.style || '').trim(),
  };
  buildMimoRequest(payload);
  return payload;
}

// Compatibility names retained for the small amount of routing code that was
// ported from HybridAudiobookStage.  They still return request-only payloads;
// no credential is ever included in a cache descriptor or synthesis result.
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
        // 豆包 HTTP 合成支持浏览器直连（2026-10-08 三重实测 + 真实出声），不再依赖同源桥接。
        // 探针音色固定用内置豆包目录第一条：默认音色可能是误填的其他引擎音色，音色不匹配会污染凭据验证结论。
        const result = await probeBySynthesis(
          profile,
          request => this.synthesize(profile, request),
          signal,
          getStaticVoiceCatalog(profile)[0]?.voiceId || '',
        );
        return { ...result, mode: 'direct' as const };
      },
      async listVoices(profile) {
        assertProfile(profile, 'doubao');
        return getStaticVoiceCatalog(profile);
      },
      async synthesize(profile, request) {
        assertProfile(profile, 'doubao');
        try {
          const upstream = buildDoubaoUpstreamRequest({
            apiKey: String(profile.apiKey || '').trim(),
            appId: String(profile.appId || '').trim(),
            accessKey: String(profile.accessKey || '').trim(),
            resourceId: String(profile.resourceId || DEFAULT_DOUBAO_RESOURCE_ID).trim(),
            speaker: String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim(),
            text: ensureText(request?.text),
            contextText: request?.contextText,
          });
          const response = await fetcher(upstream.url, {
            method: 'POST',
            headers: upstream.headers,
            body: JSON.stringify(upstream.payload),
            signal: request.signal,
          });
          if (!response.ok) await throwDoubaoResponseError(response, profile);
          // 响应是连续的 JSON 对象流（base64 音频分片），线上字节数必然大于解码后的音频。
          const wireBytes = await readBoundedBytes(response, '豆包', MAX_TTS_WIRE_BYTES);
          const audioBytes = parseDoubaoNdjson(new TextDecoder().decode(wireBytes), MAX_TTS_RESPONSE_BYTES);
          return { blob: blobFromBytes(audioBytes, 'audio/mpeg'), mimeType: 'audio/mpeg' };
        } catch (error) {
          return withRedactedError(error, profile);
        }
      },
    },
    minimax: {
      async probe(profile, signal) {
        // get_voice 目录接口已改版 404（2026-09-27 实测），probe 改用真实合成验证凭据与额度。
        const result = await probeBySynthesis(profile, request => this.synthesize(profile, request), signal);
        return { ...result, mode: 'direct' as const };
      },
      async listVoices(profile) {
        assertProfile(profile, 'minimax');
        return getStaticVoiceCatalog(profile);
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
      async probe(profile, signal) {
        const result = await probeBySynthesis(profile, request => this.synthesize(profile, request), signal);
        return { ...result, mode: 'direct' as const };
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
    fish: {
      async probe(profile, signal) {
        assertProfile(profile, 'fish');
        // 上游 `POST /v1/tts` 的 CORS 预检 404，合成只能经酒馆同源 /proxy，所以 probe 直接真实合成"你好"。
        // 音色优先 Profile 默认，否则回落到公开音色市场第一条（`GET /model` 可浏览器直连）。
        let voiceId = String(profile.defaultVoiceId || '').trim();
        if (!voiceId) {
          const voices = await this.listVoices(profile, signal);
          voiceId = voices[0]?.voiceId || '';
        }
        if (!voiceId) throw new Error('Fish 音色目录为空，请先在 Profile 里填写默认音色 ID');
        const result = await probeBySynthesis(profile, request => this.synthesize(profile, request), signal, voiceId);
        return { ...result, mode: 'proxy' as const };
      },
      async listVoices(profile, signal) {
        assertProfile(profile, 'fish');
        try {
          const upstream = buildFishModelListRequest();
          const response = await fetcher(upstream.url, { method: 'GET', signal });
          const bytes = await readStructuredResponse(response, 'Fish 音色列表', profile);
          return normalizeDiscoveredFishVoices(parseFishVoiceListResponse(bytes), profile.id);
        } catch (error) {
          return withRedactedError(error, profile);
        }
      },
      async synthesize(profile, request) {
        assertProfile(profile, 'fish');
        const timeout = withSynthesisTimeout(request.signal, 'Fish');
        try {
          const upstream = buildFishSynthesisRequest({
            apiKey: String(profile.apiKey || '').trim(),
            model: String(profile.model || '').trim(),
            voiceId: String(request?.voice?.voiceId || profile.defaultVoiceId || '').trim(),
            text: ensureText(request?.text),
            format: String(profile.responseFormat || 'mp3').trim(),
          });
          const response = await fetcher(upstream.url, {
            method: 'POST',
            headers: upstream.headers,
            body: JSON.stringify(upstream.payload),
            signal: timeout.signal,
          });
          return await readProxyAudio(response, 'Fish', profile);
        } catch (error) {
          if (error instanceof TypeError) {
            throw new Error(
              redactProviderSecrets('Fish 网络错误：无法连接酒馆 /proxy（检查酒馆是否运行、页面是否已登录）', profile),
              { cause: error },
            );
          }
          return withRedactedError(error, profile);
        } finally {
          timeout.dispose();
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
