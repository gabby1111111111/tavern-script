import {
    DEFAULT_TIMEOUT_MS,
    DoubaoBridgeError,
    MAX_AUDIO_BYTES,
    MAX_TEXT_CHARACTERS,
    bridgeError,
    classifyFailure,
    createAbortContext,
    readStringField,
    sendAudio,
    sendJsonError,
    upstreamStatusError,
} from './doubao.mjs';

export const FISH_TTS_ENDPOINT = 'https://api.fish.audio/v1/tts';
const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_REFERENCE_ID_CHARACTERS = 500;
const MAX_MODEL_CHARACTERS = 100;
// api.fish.audio 官方网关只认这些模型名（2026-10-07 实测：不带 model 头会默认走付费模型 → 402）
const OFFICIAL_FISH_MODELS = new Set(['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1', 'drama-3-preview']);
const ALLOWED_FISH_REQUEST_FIELDS = new Set(['apiKey', 'text', 'referenceId', 'format', 'model']);

export function normalizeFishRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw bridgeError('VALIDATION_ERROR', 400);
    }

    for (const field of Object.keys(body)) {
        if (!ALLOWED_FISH_REQUEST_FIELDS.has(field)) throw bridgeError('VALIDATION_ERROR', 400);
    }

    const apiKey = readStringField(body, 'apiKey', { required: true, maxCharacters: MAX_API_KEY_CHARACTERS });
    const text = readStringField(body, 'text', { required: true, maxCharacters: MAX_TEXT_CHARACTERS });
    const referenceId = readStringField(body, 'referenceId', { required: true, maxCharacters: 500 });
    const format = readStringField(body, 'format', { maxCharacters: 8 }) || 'mp3';
    if (format !== 'mp3' && format !== 'wav') throw bridgeError('VALIDATION_ERROR', 400);
    // Fish 的模型选择在请求头 model 里；缺省 s2.1-pro-free（免费档，不扣 API credit）
    const model = (readStringField(body, 'model', { maxCharacters: MAX_MODEL_CHARACTERS }) || 's2.1-pro-free').toLowerCase();
    if (/[\r\n]/.test(model)) throw bridgeError('VALIDATION_ERROR', 400);
    if (!OFFICIAL_FISH_MODELS.has(model)) throw bridgeError('VALIDATION_ERROR', 400);

    return { apiKey, text, referenceId, format, model };
}

export function buildFishUpstreamRequest(body) {
    const input = normalizeFishRequest(body);
    return {
        url: FISH_TTS_ENDPOINT,
        headers: {
            Accept: input.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${input.apiKey}`,
            model: input.model,
        },
        // FAS2 情绪标签（如 [happy]）随 text 原样透传，由 Fish 侧解析。
        payload: {
            text: input.text,
            reference_id: input.referenceId,
            format: input.format,
            latency: 'normal',
        },
    };
}

export function createFishBridge(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAudioBytes = options.maxAudioBytes ?? MAX_AUDIO_BYTES;
    const setTimeoutImpl = options.setTimeoutImpl || globalThis.setTimeout;
    const clearTimeoutImpl = options.clearTimeoutImpl || globalThis.clearTimeout;

    async function synthesize(req, res) {
        let abortContext;
        try {
            const upstreamRequest = buildFishUpstreamRequest(req?.body);
            abortContext = createAbortContext(req, res, {
                timeoutMs,
                setTimeoutImpl,
                clearTimeoutImpl,
            });

            const upstreamResponse = await fetchImpl(upstreamRequest.url, {
                method: 'POST',
                headers: upstreamRequest.headers,
                body: JSON.stringify(upstreamRequest.payload),
                redirect: 'error',
                signal: abortContext.controller.signal,
            });

            if (!upstreamResponse || typeof upstreamResponse.ok !== 'boolean') {
                throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
            }
            if (!upstreamResponse.ok) throw upstreamStatusError(Number(upstreamResponse.status));

            const declaredLength = Number(upstreamResponse.headers?.get?.('content-length') || 0);
            if (declaredLength > maxAudioBytes) throw bridgeError('RESPONSE_TOO_LARGE', 502);
            const audio = Buffer.from(await upstreamResponse.arrayBuffer());
            if (audio.length > maxAudioBytes) throw bridgeError('RESPONSE_TOO_LARGE', 502);
            if (!audio.length) throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
            if (abortContext.cause === 'timeout') throw bridgeError('UPSTREAM_TIMEOUT', 504);
            if (abortContext.cause === 'client') throw bridgeError('CLIENT_ABORTED', 499);
            sendAudio(res, audio, inputMimeType(upstreamRequest));
        } catch (error) {
            if (error instanceof DoubaoBridgeError) abortContext?.abort('internal');
            sendJsonError(res, classifyFailure(error, abortContext));
        } finally {
            abortContext?.cleanup();
        }
    }

    return Object.freeze({ synthesize });
}

function inputMimeType(upstreamRequest) {
    return upstreamRequest.payload.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
}
