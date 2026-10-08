export const DOUBAO_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const DEFAULT_DOUBAO_RESOURCE_ID = 'seed-tts-2.0';

/**
 * 豆包合成必须经酒馆同源 `/proxy`（2026-10-08 在 8000 实测，CDP 抓原始预检响应头）：
 * 豆包 `Access-Control-Allow-Headers` 放行的是 **旧版** `X-Api-App-Key` / `X-Api-Access-Key`，
 * **不放行**新版 `X-Api-Key` —— 同一个新版 key 在 Node（无跨域）里 200 出声，在浏览器里必被拦
 * （`TypeError: Failed to fetch`）。经 `/proxy` 转发不受浏览器跨域限制，新版凭据才可用；
 * 而本项目已为 Fish 打开了 `enableCorsProxy`，不额外增加安装步骤。
 * 旧版 APP ID + Access Key 自 v0.2.0 起弃用（界面不再提供，代码不再发送）。
 */
export const DOUBAO_TTS_PROXY_PATH = '/proxy/' + DOUBAO_TTS_ENDPOINT;

const MAX_TEXT_LENGTH = 10_000;
const MAX_CONTEXT_LENGTH = 2_000;

function requiredText(value: unknown, label: string, maxLength = 512): string {
  const text = String(value || '').trim();
  if (!text) throw new Error(`豆包 TTS 缺少 ${label}`);
  if (text.length > maxLength) throw new Error(`豆包 TTS ${label} 过长`);
  return text;
}

function decodeBase64(value: unknown): Uint8Array {
  let binary: string;
  try {
    binary = globalThis.atob(String(value || ''));
  } catch {
    throw new Error('豆包 TTS 返回了无效 Base64 音频');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export type DoubaoRequestInput = {
  apiKey: string;
  resourceId?: string;
  requestId?: string;
  speaker: string;
  text: string;
  contextText?: string;
};

function createDoubaoRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? 'ganggang-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

export function buildDoubaoUpstreamRequest(input: DoubaoRequestInput) {
  const apiKey = requiredText(input.apiKey, 'API Key', 2_048);
  const resourceId = requiredText(input.resourceId || DEFAULT_DOUBAO_RESOURCE_ID, 'Resource ID');
  const requestId = requiredText(input.requestId || createDoubaoRequestId(), 'Request ID');
  const speaker = requiredText(input.speaker, 'Speaker ID');
  const text = requiredText(input.text, '文本', MAX_TEXT_LENGTH);
  const contextText = String(input.contextText || '')
    .trim()
    .slice(0, MAX_CONTEXT_LENGTH);

  return {
    url: DOUBAO_TTS_PROXY_PATH,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    },
    payload: {
      user: { uid: 'ganggang-voice-stage' },
      req_params: {
        text,
        speaker,
        audio_params: { format: 'mp3', sample_rate: 24_000 },
        additions: JSON.stringify({ context_texts: contextText ? [contextText] : [] }),
      },
    },
  };
}

/**
 * 豆包错误码 → 用户可读原因。
 * `45000000` / `55000000` 是"音色与资源 ID 不配套"的同一族错误码
 * （2.0 音色混用 1.0 资源，或拿非豆包音色配 `seed-tts-2.0`），与跨域无关 ——
 * 遇到它们不要往 CORS 方向排查（2026-10-08 8000 实测：拿 Edge 音色配 seed-tts-2.0 即 55000000）。
 */
const DOUBAO_ERROR_HINTS: Readonly<Record<number, string>> = {
  45000000: '音色与资源 ID 不配套（2.0 音色必须配 seed-tts-2.0）',
  55000000: '音色与资源 ID 不配套（所选音色与当前 Resource ID 不属于同一代）',
};

export function parseDoubaoNdjson(value: string, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let event: { code?: unknown; data?: unknown; message?: unknown; msg?: unknown; error?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      throw new Error('豆包 TTS 返回了无法解析的流数据');
    }
    const code = Number(event?.code);
    if (code === 0 && event.data) {
      const chunk = decodeBase64(event.data);
      if (!chunk.length) continue;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) throw new Error('豆包 TTS 音频超过大小限制');
      chunks.push(chunk);
      continue;
    }
    if (code === 0 || code === 20_000_000) continue;
    if (Number.isFinite(code) && code > 0) {
      const hint = DOUBAO_ERROR_HINTS[code] || '';
      const message = String(event.message || event.msg || event.error || '').slice(0, 300);
      const detail = [hint, message].filter(Boolean).join('；');
      throw new Error(`豆包 TTS 错误 ${code}${detail ? `：${detail}` : ''}`);
    }
  }

  if (!chunks.length) throw new Error('豆包 TTS 没有返回音频');
  const audio = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  return audio;
}
