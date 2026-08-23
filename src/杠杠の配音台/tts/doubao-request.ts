export const DOUBAO_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const DEFAULT_DOUBAO_RESOURCE_ID = 'seed-tts-2.0';

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
  apiKey?: string;
  appId?: string;
  accessKey?: string;
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
  const apiKey = String(input.apiKey || '').trim();
  if (apiKey.length > 2_048) throw new Error('豆包 TTS API Key 过长');
  const appId = apiKey ? '' : requiredText(input.appId, 'APP ID');
  const accessKey = apiKey ? '' : requiredText(input.accessKey, 'Access Key', 2_048);
  const resourceId = requiredText(input.resourceId || DEFAULT_DOUBAO_RESOURCE_ID, 'Resource ID');
  const requestId = requiredText(input.requestId || createDoubaoRequestId(), 'Request ID');
  const speaker = requiredText(input.speaker, 'Speaker ID');
  const text = requiredText(input.text, '文本', MAX_TEXT_LENGTH);
  const contextText = String(input.contextText || '')
    .trim()
    .slice(0, MAX_CONTEXT_LENGTH);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
  };
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  } else {
    headers['X-Api-App-Key'] = appId;
    headers['X-Api-Access-Key'] = accessKey;
  }

  return {
    url: DOUBAO_TTS_ENDPOINT,
    headers,
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
      const message = String(event.message || event.msg || event.error || '').slice(0, 300);
      throw new Error(`豆包 TTS 错误 ${code}${message ? `：${message}` : ''}`);
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
