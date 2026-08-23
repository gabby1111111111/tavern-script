export const MINIMAX_ENDPOINTS = Object.freeze({
  cn: 'https://api.minimaxi.com/v1/t2a_v2',
  io: 'https://api.minimax.io/v1/t2a_v2',
} as const);

export const MINIMAX_VOICE_ENDPOINTS = Object.freeze({
  cn: 'https://api.minimaxi.com/v1/get_voice',
  io: 'https://api.minimax.io/v1/get_voice',
} as const);

export const XIAOMI_MIMO_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';

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
  const url = MINIMAX_ENDPOINTS[platform];
  if (!url) throw new Error('MiniMax 平台必须是 cn 或 io');
  const apiKey = requiredString(input.apiKey, 'MiniMax API Key', 4_096);
  const text = requiredString(input.text, '朗读文本', 20_000);
  const voiceId = requiredString(input.voiceId, 'MiniMax Voice ID', 500);
  const model = requiredString(input.model || 'speech-2.8-hd', 'MiniMax 模型', 200);
  const format = normalizeFormat(input.format, 'mp3');
  const speed = Math.max(0.5, Math.min(2, Number(input.speed) || 1));
  const emotion = normalizeMinimaxEmotion(input.emotion);
  const voiceSetting: Record<string, unknown> = { voice_id: voiceId, speed, vol: 1, pitch: 0 };
  if (emotion) voiceSetting.emotion = emotion;
  return {
    url,
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

export function buildMinimaxVoiceListRequest(input: { platform?: string; apiKey: string }) {
  const platform = String(input.platform || 'cn')
    .trim()
    .toLowerCase() as keyof typeof MINIMAX_VOICE_ENDPOINTS;
  const url = MINIMAX_VOICE_ENDPOINTS[platform];
  if (!url) throw new Error('MiniMax 平台必须是 cn 或 io');
  const apiKey = requiredString(input.apiKey, 'MiniMax API Key', 4_096);
  return {
    url,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    payload: { voice_type: 'all' },
  };
}

export type DiscoveredMinimaxVoice = {
  voiceId: string;
  name: string;
  description: string;
  kind: 'system' | 'voice_cloning' | 'voice_generation';
};

function normalizeMinimaxVoice(value: any, kind: DiscoveredMinimaxVoice['kind']): DiscoveredMinimaxVoice | null {
  const voiceId = optionalString(value?.voice_id, 500);
  if (!voiceId) return null;
  const description = Array.isArray(value?.description)
    ? value.description
        .map((item: unknown) => optionalString(item, 300))
        .filter(Boolean)
        .join('；')
        .slice(0, 1_000)
    : optionalString(value?.description, 1_000);
  return {
    voiceId,
    name: optionalString(value?.voice_name, 300) || voiceId,
    description,
    kind,
  };
}

export function parseMinimaxVoiceListResponse(value: unknown, maxVoices = 2_000): DiscoveredMinimaxVoice[] {
  const data = parseJson(value, 'MiniMax 音色列表');
  const code = Number(data?.base_resp?.status_code || 0);
  if (code !== 0) {
    throw new Error(`MiniMax 服务错误 ${code}: ${String(data?.base_resp?.status_msg || '未知错误').slice(0, 200)}`);
  }
  const groups: Array<[DiscoveredMinimaxVoice['kind'], unknown]> = [
    ['system', data?.system_voice],
    ['voice_cloning', data?.voice_cloning],
    ['voice_generation', data?.voice_generation],
  ];
  const voices: DiscoveredMinimaxVoice[] = [];
  const seen = new Set<string>();
  for (const [kind, items] of groups) {
    for (const item of Array.isArray(items) ? items : []) {
      const voice = normalizeMinimaxVoice(item, kind);
      if (!voice || seen.has(voice.voiceId)) continue;
      seen.add(voice.voiceId);
      voices.push(voice);
      if (voices.length >= maxVoices) return voices;
    }
  }
  return voices;
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
