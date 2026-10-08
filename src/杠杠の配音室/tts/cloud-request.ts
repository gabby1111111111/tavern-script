export const MINIMAX_ENDPOINTS = Object.freeze({
  cn: 'https://api.minimaxi.com/v1/t2a_v2',
  io: 'https://api.minimax.io/v1/t2a_v2',
} as const);

export const XIAOMI_MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';

export const FISH_TTS_ENDPOINT = 'https://api.fish.audio/v1/tts';
export const FISH_MODEL_ENDPOINT = 'https://api.fish.audio/model';
/** Fish 合成必须经酒馆同源 `/proxy`：上游 `POST /v1/tts` 的 CORS 预检 404，浏览器直连必死。 */
export const FISH_TTS_PROXY_PATH = '/proxy/' + FISH_TTS_ENDPOINT;
/** 免费档模型。Fish 的模型选择在请求头 `model` 里，漏头会默认走付费模型并报 402。 */
export const FISH_DEFAULT_MODEL = 's2.1-pro-free';

/**
 * 把供应商 HTTP 状态映射为面向用户的可读失败原因。
 * 供应商响应正文只用于识别审核类拒绝，不回显原文。
 */
export function classifyProviderHttpStatus(status: number, bodyHead = ''): string {
  const body = String(bodyHead || '').slice(0, 300);
  const audited = /审核|敏感|违规|risk|content[_ -]?filter|moderat|policy/i.test(body);
  if (status === 401 || status === 403) return '鉴权失败：凭据无效或未授权';
  if (status === 402) return '额度不足';
  if (status === 429) return '额度不足或请求过于频繁';
  if (audited) return '内容被审核拒绝';
  if (status === 400) return '请求无效（参数或音色不被接受）';
  if (status >= 500) return '服务暂时不可用';
  return `服务错误 (HTTP ${status})`;
}

function requiredString(value: unknown, label: string, maxLength = 2_000): string {
  const text = String(value || '').trim();
  if (!text) throw new Error(`缺少 ${label}`);
  if (text.length > maxLength) throw new Error(`${label} 过长`);
  return text;
}

function optionalString(value: unknown, maxLength = 2_000): string {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw new Error('可选参数过长');
  return text;
}

function normalizeFormat(value: unknown, fallback: 'mp3' | 'wav'): 'mp3' | 'wav' {
  const format = String(value || fallback)
    .trim()
    .toLowerCase();
  if (format !== 'mp3' && format !== 'wav') throw new Error('不支持的音频格式');
  return format;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return String(value || '');
}

function parseJson(value: unknown, label: string): Record<string, any> {
  try {
    return JSON.parse(toText(value)) as Record<string, any>;
  } catch {
    throw new Error(`${label}返回了无效 JSON`);
  }
}

function decodeBase64(value: unknown, label: string): Uint8Array {
  let binary: string;
  try {
    binary = globalThis.atob(String(value || ''));
  } catch {
    throw new Error(`${label}返回了无效 Base64 音频`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const MINIMAX_EMOTION_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['happy', ['happy', '开心', '高兴', '喜悦', '兴奋', '愉快']],
  ['sad', ['sad', '悲伤', '难过', '伤心', '低落']],
  ['angry', ['angry', '愤怒', '生气', '恼怒']],
  ['fearful', ['fearful', '害怕', '恐惧', '惊恐']],
  ['disgusted', ['disgusted', '厌恶', '嫌弃', '反感']],
  ['surprised', ['surprised', '惊讶', '震惊', '吃惊']],
  ['neutral', ['neutral', '中性', '平静', '自然']],
];

export function normalizeMinimaxEmotion(value: unknown): string {
  const input = optionalString(value, 100).toLowerCase();
  if (!input) return '';
  for (const [emotion, aliases] of MINIMAX_EMOTION_ALIASES) {
    if (aliases.some(alias => input.includes(alias))) return emotion;
  }
  return '';
}

export type MinimaxRequestInput = {
  platform?: string;
  apiKey: string;
  /** MiniMax 控制台的 GroupId，t2a_v2 必须作为 URL 查询参数发送 */
  groupId?: string;
  text: string;
  voiceId: string;
  model?: string;
  format?: string;
  speed?: number;
  emotion?: string;
};

export function buildMinimaxRequest(input: MinimaxRequestInput) {
  const platform = String(input.platform || 'cn')
    .trim()
    .toLowerCase() as keyof typeof MINIMAX_ENDPOINTS;
  const baseUrl = MINIMAX_ENDPOINTS[platform];
  if (!baseUrl) throw new Error('MiniMax 平台必须是 cn 或 io');
  const apiKey = requiredString(input.apiKey, 'MiniMax API Key', 4_096);
  const groupId = requiredString(input.groupId, 'MiniMax Group ID', 64);
  const text = requiredString(input.text, '朗读文本', 20_000);
  const voiceId = requiredString(input.voiceId, 'MiniMax Voice ID', 500);
  const model = requiredString(input.model || 'speech-2.8-hd', 'MiniMax 模型', 200);
  const format = normalizeFormat(input.format, 'mp3');
  const speed = Math.max(0.5, Math.min(2, Number(input.speed) || 1));
  const emotion = normalizeMinimaxEmotion(input.emotion);
  const voiceSetting: Record<string, unknown> = { voice_id: voiceId, speed, vol: 1, pitch: 0 };
  if (emotion) voiceSetting.emotion = emotion;
  return {
    url: `${baseUrl}?GroupId=${encodeURIComponent(groupId)}`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    payload: {
      model,
      text,
      stream: false,
      voice_setting: voiceSetting,
      audio_setting: {
        format,
        sample_rate: format === 'mp3' ? 32_000 : 24_000,
        channel: 1,
        ...(format === 'mp3' ? { bitrate: 128_000 } : {}),
      },
      language_boost: 'auto',
      output_format: 'hex',
    },
    format,
  };
}

export function parseMinimaxResponse(value: unknown, maxBytes: number): Uint8Array {
  const data = parseJson(value, 'MiniMax ');
  const code = Number(data?.base_resp?.status_code || 0);
  if (code !== 0) {
    throw new Error(`MiniMax 服务错误 ${code}: ${String(data?.base_resp?.status_msg || '未知错误').slice(0, 200)}`);
  }
  const hex = String(data?.data?.audio || '').trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('MiniMax 返回中没有有效音频');
  const audio = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    audio[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  if (!audio.length || audio.length > maxBytes) throw new Error('MiniMax 音频为空或过大');
  return audio;
}

export type MimoRequestInput = {
  apiKey: string;
  text: string;
  voiceId: string;
  model?: string;
  format?: string;
  style?: string;
};

export function buildMimoRequest(input: MimoRequestInput) {
  const apiKey = requiredString(input.apiKey, '小米 MiMo API Key', 4_096);
  const text = requiredString(input.text, '朗读文本', 20_000);
  const voiceId = requiredString(input.voiceId, '小米 MiMo Voice', 2_000);
  const model = requiredString(input.model || 'mimo-v2.5-tts', '小米 MiMo 模型', 200);
  const format = normalizeFormat(input.format, 'wav');
  const style = optionalString(input.style, 1_000);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (style) messages.push({ role: 'user', content: style });
  messages.push({ role: 'assistant', content: text });
  return {
    url: XIAOMI_MIMO_ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    payload: { model, messages, audio: { format, voice: voiceId } },
    format,
  };
}

export function parseMimoResponse(value: unknown, maxBytes: number): Uint8Array {
  const data = parseJson(value, '小米 MiMo ');
  const encoded = String(data?.choices?.[0]?.message?.audio?.data || '').trim();
  if (!encoded) throw new Error('小米 MiMo 返回中没有音频数据');
  const audio = decodeBase64(encoded, '小米 MiMo ');
  if (!audio.length || audio.length > maxBytes) throw new Error('小米 MiMo 音频为空或过大');
  return audio;
}

export function buildFishModelListRequest(input: { page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(input.pageSize) || 100)));
  const page = Math.min(50, Math.max(1, Math.floor(Number(input.page) || 1)));
  return { url: `${FISH_MODEL_ENDPOINT}?page_size=${pageSize}&page_number=${page}` };
}

export type FishSynthesisRequestInput = {
  apiKey: string;
  /** 缺省免费档 `s2.1-pro-free`；模型走请求头而不是请求体 */
  model?: string;
  voiceId: string;
  text: string;
  format?: string;
};

/**
 * Fish 合成的 `/proxy` 请求配方（对齐 Fishdialogue `browser-audio.mjs` 的 `ttsRequest()`）：
 * - URL 必须是**相对路径** `/proxy/` + 完整目标 URL，且不做 encode；
 * - `Authorization` 与 `model` 都放在请求头，酒馆 `/proxy` 会透传（只剔除 host/origin/cookie 等）；
 * - 请求体只放文本、音色、格式与延迟档。
 */
export function buildFishSynthesisRequest(input: FishSynthesisRequestInput) {
  const apiKey = requiredString(input.apiKey, 'Fish API Key', 4_096);
  if (/[\r\n]/.test(apiKey)) throw new Error('Fish API Key 无效');
  const model = optionalString(input.model, 100) || FISH_DEFAULT_MODEL;
  if (/[\r\n]/.test(model)) throw new Error('Fish 模型名称无效');
  const voiceId = requiredString(input.voiceId, 'Fish 音色 ID', 500);
  const text = requiredString(input.text, '朗读文本', 20_000);
  const format = normalizeFormat(input.format, 'mp3');

  return {
    url: FISH_TTS_PROXY_PATH,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      model,
      'Content-Type': 'application/json',
    },
    payload: { text, reference_id: voiceId, format, latency: 'normal' },
  };
}

export type DiscoveredFishVoice = {
  voiceId: string;
  name: string;
  description: string;
};

function normalizeFishVoice(value: any): DiscoveredFishVoice | null {
  const voiceId = optionalString(value?._id ?? value?.id, 500);
  if (!voiceId) return null;
  // 音色市场的标题/描述可能很长：解析目录时截断，不让单条脏数据失败整个目录。
  const title = String(value?.title || "")
    .trim()
    .slice(0, 300);
  const description = String(value?.description || "")
    .trim()
    .slice(0, 500);
  return {
    voiceId,
    name: title || voiceId,
    description,
  };
}

/** Fish 音色市场是公开接口；响应形状按 items/_id/title 宽容解析，兼容数组或 {items:[…]}。 */
export function parseFishVoiceListResponse(value: unknown, maxVoices = 500): DiscoveredFishVoice[] {
  const data = parseJson(value, 'Fish 音色列表');
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const voices: DiscoveredFishVoice[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const voice = normalizeFishVoice(item);
    if (!voice || seen.has(voice.voiceId)) continue;
    seen.add(voice.voiceId);
    voices.push(voice);
    if (voices.length >= maxVoices) break;
  }
  return voices;
}
