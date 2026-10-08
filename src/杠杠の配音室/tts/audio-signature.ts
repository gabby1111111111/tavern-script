/**
 * 音频文件魔数识别。
 *
 * 酒馆自带的 `/proxy` 会把上游响应体原样流回，但可能丢掉上游 `Content-Type`
 * （2026-10-08 在 8000 实例实测：Fish 合成 `HTTP 200` 返回真 MP3，而
 * `content-type` 是 `null`）。因此经 `/proxy` 拿到的音频不能只信响应头，
 * 必须按文件签名兜底识别，否则会被当成"未返回音频"而误报。
 *
 * 识别范围对齐 Fishdialogue 的 `detectAudioType()`：ID3 头、MP3 帧同步、
 * RIFF/WAVE、OggS、fLaC。
 */
export type AudioSignature = 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/flac';

function asciiRange(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

/** @returns 识别出的 MIME；无法识别返回 null。只需传入响应体开头的若干字节。 */
export function detectAudioType(bytes: Uint8Array): AudioSignature | null {
  if (!bytes || !bytes.length) return null;

  // ID3 v2 容器：'ID3' + 版本 2..4 + 标志/长度高位必须为 0
  if (
    bytes.length >= 10 &&
    asciiRange(bytes, 0, 3) === 'ID3' &&
    bytes[3] >= 2 &&
    bytes[3] <= 4 &&
    bytes.slice(6, 10).every(value => value < 128)
  ) {
    return 'audio/mpeg';
  }

  // 裸 MP3 帧同步：0xFFEx，排除保留的 bitrate/采样率/声道组合
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0 &&
    (bytes[1] & 0x18) !== 0x08 &&
    (bytes[1] & 0x06) !== 0 &&
    (bytes[2] & 0xf0) !== 0 &&
    (bytes[2] & 0xf0) !== 0xf0 &&
    (bytes[2] & 0x0c) !== 0x0c
  ) {
    return 'audio/mpeg';
  }

  if (bytes.length >= 12 && asciiRange(bytes, 0, 4) === 'RIFF' && asciiRange(bytes, 8, 12) === 'WAVE') {
    return 'audio/wav';
  }

  if (bytes.length >= 27 && asciiRange(bytes, 0, 4) === 'OggS' && bytes[4] === 0) return 'audio/ogg';

  if (bytes.length >= 8 && asciiRange(bytes, 0, 4) === 'fLaC') return 'audio/flac';

  return null;
}
