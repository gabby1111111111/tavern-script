import { randomUUID } from 'node:crypto';

export const DOUBAO_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const DOUBAO_REQUEST_CONTENT_TYPE = 'application/vnd.ganggang-tts+json';
export const DEFAULT_TIMEOUT_MS = 45_000;
export const MAX_TEXT_CHARACTERS = 10_000;
export const MAX_CONTEXT_CHARACTERS = 2_000;
export const MAX_AUDIO_BYTES = 80 * 1024 * 1024;
export const MAX_RAW_RESPONSE_BYTES = 112 * 1024 * 1024;
export const MAX_NDJSON_LINE_CHARACTERS = 16 * 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 128 * 1024;

const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_APP_ID_CHARACTERS = 512;
const MAX_ACCESS_KEY_CHARACTERS = 4_096;
const MAX_RESOURCE_ID_CHARACTERS = 256;
const MAX_SPEAKER_CHARACTERS = 256;
const ALLOWED_REQUEST_FIELDS = new Set([
    'apiKey',
    'appId',
    'accessKey',
    'resourceId',
    'speaker',
    'text',
    'contextText',
]);

const ERROR_CODES = new Set([
    'VALIDATION_ERROR',
    'UPSTREAM_AUTH',
    'UPSTREAM_RATE_LIMIT',
    'UPSTREAM_TIMEOUT',
    'UPSTREAM_ERROR',
    'INVALID_UPSTREAM_RESPONSE',
    'RESPONSE_TOO_LARGE',
    'CLIENT_ABORTED',
]);

export class DoubaoBridgeError extends Error {
    constructor(code, statusCode) {
        const safeCode = ERROR_CODES.has(code) ? code : 'UPSTREAM_ERROR';
        super(safeCode);
        this.name = 'DoubaoBridgeError';
        this.code = safeCode;
        this.statusCode = statusCode;
    }
}

function bridgeError(code, statusCode) {
    return new DoubaoBridgeError(code, statusCode);
}

function positiveInteger(value, fallback, name) {
    const candidate = value ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return candidate;
}

function readStringField(body, field, options = {}) {
    const { required = false, maxCharacters = 512, trim = true } = options;
    const value = body[field];
    if (value === undefined || value === null) {
        if (required) throw bridgeError('VALIDATION_ERROR', 400);
        return '';
    }
    if (typeof value !== 'string') throw bridgeError('VALIDATION_ERROR', 400);
    const normalized = trim ? value.trim() : value;
    if (required && !normalized) throw bridgeError('VALIDATION_ERROR', 400);
    if (normalized.length > maxCharacters) throw bridgeError('VALIDATION_ERROR', 400);
    return normalized;
}

export function normalizeDoubaoRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw bridgeError('VALIDATION_ERROR', 400);
    }

    for (const field of Object.keys(body)) {
        if (!ALLOWED_REQUEST_FIELDS.has(field)) throw bridgeError('VALIDATION_ERROR', 400);
    }

    const apiKey = readStringField(body, 'apiKey', { maxCharacters: MAX_API_KEY_CHARACTERS });
    const appId = readStringField(body, 'appId', { maxCharacters: MAX_APP_ID_CHARACTERS });
    const accessKey = readStringField(body, 'accessKey', { maxCharacters: MAX_ACCESS_KEY_CHARACTERS });
    const resourceId = readStringField(body, 'resourceId', {
        required: true,
        maxCharacters: MAX_RESOURCE_ID_CHARACTERS,
    });
    const speaker = readStringField(body, 'speaker', {
        required: true,
        maxCharacters: MAX_SPEAKER_CHARACTERS,
    });
    const text = readStringField(body, 'text', {
        required: true,
        maxCharacters: MAX_TEXT_CHARACTERS,
    });
    const contextText = readStringField(body, 'contextText', {
        maxCharacters: MAX_CONTEXT_CHARACTERS,
    });

    if (apiKey && (appId || accessKey)) throw bridgeError('VALIDATION_ERROR', 400);
    if (!apiKey && (!appId || !accessKey)) throw bridgeError('VALIDATION_ERROR', 400);

    return {
        apiKey,
        appId,
        accessKey,
        resourceId,
        speaker,
        text,
        contextText,
    };
}

function readContentType(req) {
    const header = req?.headers?.['content-type'] ?? req?.get?.('content-type') ?? '';
    return String(header).trim().toLowerCase();
}

function isJsonContentType(value) {
    const [mediaType, ...parameters] = value.split(';').map(part => part.trim());
    if (mediaType !== DOUBAO_REQUEST_CONTENT_TYPE) return false;

    for (const parameter of parameters) {
        if (!parameter) continue;
        const charsetMatch = /^charset=(?:"([^"]+)"|([^\s]+))$/.exec(parameter);
        if (charsetMatch && String(charsetMatch[1] || charsetMatch[2]).toLowerCase() !== 'utf-8') return false;
    }
    return true;
}

function bodyByteLength(body) {
    let serialized;
    try {
        serialized = JSON.stringify(body);
    } catch {
        throw bridgeError('VALIDATION_ERROR', 400);
    }
    if (serialized === undefined) throw bridgeError('VALIDATION_ERROR', 400);
    return Buffer.byteLength(serialized, 'utf8');
}

export function createJsonBodyParser(options = {}) {
    const maxBytes = positiveInteger(options.maxBytes, MAX_JSON_BODY_BYTES, 'maxBytes');

    return function parseJsonBody(req, res, next) {
        const failValidation = () => sendJsonError(res, bridgeError('VALIDATION_ERROR', 400));
        if (!isJsonContentType(readContentType(req))) {
            req?.resume?.();
            failValidation();
            return;
        }

        const contentEncoding = String(req?.headers?.['content-encoding'] || 'identity').toLowerCase();
        if (contentEncoding !== 'identity') {
            req?.resume?.();
            failValidation();
            return;
        }

        const contentLength = Number(req?.headers?.['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            req?.resume?.();
            failValidation();
            return;
        }

        const bodyWasParsed = req?._body === true || req?.readableEnded === true;
        if (req?.body !== undefined && bodyWasParsed) {
            try {
                if (bodyByteLength(req.body) > maxBytes) throw bridgeError('VALIDATION_ERROR', 400);
            } catch {
                failValidation();
                return;
            }
            next();
            return;
        }

        if (req?.readableEnded || typeof req?.on !== 'function') {
            failValidation();
            return;
        }

        const chunks = [];
        let totalBytes = 0;
        let settled = false;

        const cleanup = () => {
            req.off?.('data', onData);
            req.off?.('end', onEnd);
            req.off?.('error', onError);
            req.off?.('aborted', onAborted);
        };
        const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            req.resume?.();
            failValidation();
        };
        const onData = rawChunk => {
            if (settled) return;
            const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                fail();
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                const decoder = new TextDecoder('utf-8', { fatal: true });
                let source = decoder.decode(Buffer.concat(chunks, totalBytes));
                if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1);
                if (!source.trim()) throw bridgeError('VALIDATION_ERROR', 400);
                const body = JSON.parse(source);
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    throw bridgeError('VALIDATION_ERROR', 400);
                }
                req.body = body;
            } catch {
                failValidation();
                return;
            }
            next();
        };
        const onError = () => fail();
        const onAborted = () => {
            if (settled) return;
            settled = true;
            cleanup();
        };

        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('aborted', onAborted);
    };
}

function createRequestId(requestIdFactory) {
    const requestId = String(requestIdFactory() || '');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
        throw bridgeError('UPSTREAM_ERROR', 500);
    }
    return requestId;
}

export function buildDoubaoUpstreamRequest(body, options = {}) {
    const input = normalizeDoubaoRequest(body);
    const requestIdFactory = options.requestIdFactory || randomUUID;
    const requestId = createRequestId(requestIdFactory);
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Request-Id': requestId,
        'X-Api-Resource-Id': input.resourceId,
    };

    if (input.apiKey) {
        headers['X-Api-Key'] = input.apiKey;
    } else {
        headers['X-Api-App-Key'] = input.appId;
        headers['X-Api-Access-Key'] = input.accessKey;
    }

    return {
        url: DOUBAO_TTS_ENDPOINT,
        requestId,
        headers,
        payload: {
            user: { uid: 'ganggang-tts-bridge' },
            req_params: {
                text: input.text,
                speaker: input.speaker,
                audio_params: {
                    format: 'mp3',
                    sample_rate: 24_000,
                },
                additions: JSON.stringify({
                    context_texts: input.contextText ? [input.contextText] : [],
                }),
            },
        },
    };
}

function decodeBase64Audio(value) {
    if (typeof value !== 'string' || !value) throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    if (value.length % 4 !== 0) throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    }

    const decoded = Buffer.from(value, 'base64');
    if (!decoded.length || decoded.toString('base64') !== value) {
        throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    }
    return decoded;
}

function consumeNdjsonLine(line, state) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (state.sawFinalEvent) throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);

    let event;
    try {
        event = JSON.parse(trimmed);
    } catch {
        throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    }

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    }

    const code = Number(event.code);
    if (!Number.isFinite(code)) throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);

    if (code === 0) {
        if (event.data === undefined || event.data === null || event.data === '') return;
        const audioChunk = decodeBase64Audio(event.data);
        state.audioBytes += audioChunk.length;
        if (state.audioBytes > state.maxAudioBytes) {
            throw bridgeError('RESPONSE_TOO_LARGE', 502);
        }
        state.audioChunks.push(audioChunk);
        return;
    }

    if (code === 20_000_000) {
        state.sawFinalEvent = true;
        return;
    }

    throw bridgeError('UPSTREAM_ERROR', 502);
}

function normalizeStreamChunk(chunk) {
    if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
}

async function* iterateResponseBody(body) {
    if (!body) return;

    if (typeof body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body) yield chunk;
        return;
    }

    if (typeof body.getReader === 'function') {
        const reader = body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                yield value;
            }
        } finally {
            reader.releaseLock();
        }
        return;
    }

    throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
}

export async function parseDoubaoNdjsonStream(body, options = {}) {
    const maxRawResponseBytes = positiveInteger(
        options.maxRawResponseBytes,
        MAX_RAW_RESPONSE_BYTES,
        'maxRawResponseBytes',
    );
    const maxAudioBytes = positiveInteger(options.maxAudioBytes, MAX_AUDIO_BYTES, 'maxAudioBytes');
    const maxNdjsonLineCharacters = positiveInteger(
        options.maxNdjsonLineCharacters,
        MAX_NDJSON_LINE_CHARACTERS,
        'maxNdjsonLineCharacters',
    );
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const state = {
        audioBytes: 0,
        audioChunks: [],
        maxAudioBytes,
        sawFinalEvent: false,
    };
    let rawBytes = 0;
    let pendingText = '';

    try {
        for await (const rawChunk of iterateResponseBody(body)) {
            const chunk = normalizeStreamChunk(rawChunk);
            rawBytes += chunk.byteLength;
            if (rawBytes > maxRawResponseBytes) {
                throw bridgeError('RESPONSE_TOO_LARGE', 502);
            }

            const searchFrom = pendingText.length;
            pendingText += decoder.decode(chunk, { stream: true });
            let newlineIndex;
            let nextSearchFrom = searchFrom;
            while ((newlineIndex = pendingText.indexOf('\n', nextSearchFrom)) !== -1) {
                const line = pendingText.slice(0, newlineIndex).replace(/\r$/, '');
                pendingText = pendingText.slice(newlineIndex + 1);
                consumeNdjsonLine(line, state);
                nextSearchFrom = 0;
            }
            if (pendingText.length > maxNdjsonLineCharacters) {
                throw bridgeError('RESPONSE_TOO_LARGE', 502);
            }
        }
        pendingText += decoder.decode();
        if (pendingText.length > maxNdjsonLineCharacters) {
            throw bridgeError('RESPONSE_TOO_LARGE', 502);
        }
        consumeNdjsonLine(pendingText.replace(/\r$/, ''), state);
    } catch (error) {
        if (error instanceof DoubaoBridgeError) throw error;
        throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    }

    if (!state.sawFinalEvent || !state.audioChunks.length) {
        throw bridgeError('INVALID_UPSTREAM_RESPONSE', 502);
    }
    return Buffer.concat(state.audioChunks, state.audioBytes);
}

function createAbortContext(req, res, options) {
    const controller = new AbortController();
    let abortCause = null;

    const abort = cause => {
        if (controller.signal.aborted) return;
        abortCause = cause;
        controller.abort(new Error(cause));
    };
    const onRequestAborted = () => abort('client');
    const onResponseClosed = () => {
        if (!res.writableEnded) abort('client');
    };

    req?.once?.('aborted', onRequestAborted);
    res?.once?.('close', onResponseClosed);
    const timeoutHandle = options.setTimeoutImpl(() => abort('timeout'), options.timeoutMs);
    timeoutHandle?.unref?.();

    if (
        req?.aborted
        || (req?.destroyed && !req?.complete)
        || (res?.destroyed && !res?.writableEnded)
    ) {
        abort('client');
    }

    return {
        controller,
        abort,
        get cause() {
            return abortCause;
        },
        cleanup() {
            options.clearTimeoutImpl(timeoutHandle);
            req?.off?.('aborted', onRequestAborted);
            res?.off?.('close', onResponseClosed);
        },
    };
}

function upstreamStatusError(statusCode) {
    if (statusCode === 401 || statusCode === 403) return bridgeError('UPSTREAM_AUTH', 502);
    if (statusCode === 429) return bridgeError('UPSTREAM_RATE_LIMIT', 503);
    return bridgeError('UPSTREAM_ERROR', 502);
}

function classifyFailure(error, abortContext) {
    if (error instanceof DoubaoBridgeError) return error;
    if (abortContext?.cause === 'timeout') return bridgeError('UPSTREAM_TIMEOUT', 504);
    if (abortContext?.cause === 'client') return bridgeError('CLIENT_ABORTED', 499);
    return bridgeError('UPSTREAM_ERROR', 502);
}

function canWriteResponse(res) {
    return Boolean(res) && !res.headersSent && !res.writableEnded && !res.destroyed;
}

function setStatus(res, statusCode) {
    if (typeof res.status === 'function') res.status(statusCode);
    else res.statusCode = statusCode;
}

function sendJsonError(res, error) {
    if (!canWriteResponse(res)) return;
    const body = Buffer.from(JSON.stringify({
        error: {
            code: error.code,
        },
    }));
    setStatus(res, error.statusCode);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
}

function sendAudio(res, audio) {
    if (!canWriteResponse(res)) return;
    setStatus(res, 200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(audio);
}

export function createDoubaoBridge(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    const maxRawResponseBytes = positiveInteger(
        options.maxRawResponseBytes,
        MAX_RAW_RESPONSE_BYTES,
        'maxRawResponseBytes',
    );
    const maxAudioBytes = positiveInteger(options.maxAudioBytes, MAX_AUDIO_BYTES, 'maxAudioBytes');
    const maxNdjsonLineCharacters = positiveInteger(
        options.maxNdjsonLineCharacters,
        MAX_NDJSON_LINE_CHARACTERS,
        'maxNdjsonLineCharacters',
    );
    const requestIdFactory = options.requestIdFactory || randomUUID;
    const setTimeoutImpl = options.setTimeoutImpl || globalThis.setTimeout;
    const clearTimeoutImpl = options.clearTimeoutImpl || globalThis.clearTimeout;
    if (typeof requestIdFactory !== 'function') throw new TypeError('requestIdFactory must be a function');
    if (typeof setTimeoutImpl !== 'function') throw new TypeError('setTimeoutImpl must be a function');
    if (typeof clearTimeoutImpl !== 'function') throw new TypeError('clearTimeoutImpl must be a function');

    async function synthesize(req, res) {
        let abortContext;
        try {
            const upstreamRequest = buildDoubaoUpstreamRequest(req?.body, { requestIdFactory });
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

            const audio = await parseDoubaoNdjsonStream(upstreamResponse.body, {
                maxRawResponseBytes,
                maxAudioBytes,
                maxNdjsonLineCharacters,
            });
            if (abortContext.cause === 'timeout') throw bridgeError('UPSTREAM_TIMEOUT', 504);
            if (abortContext.cause === 'client') throw bridgeError('CLIENT_ABORTED', 499);
            sendAudio(res, audio);
        } catch (error) {
            if (error instanceof DoubaoBridgeError) abortContext?.abort('internal');
            sendJsonError(res, classifyFailure(error, abortContext));
        } finally {
            abortContext?.cleanup();
        }
    }

    return Object.freeze({ synthesize });
}
