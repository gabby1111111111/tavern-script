import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import {
    createDoubaoBridge,
    createJsonBodyParser,
    DOUBAO_REQUEST_CONTENT_TYPE,
    DOUBAO_TTS_ENDPOINT,
    MAX_AUDIO_BYTES,
    MAX_CONTEXT_CHARACTERS,
    MAX_JSON_BODY_BYTES,
    MAX_NDJSON_LINE_CHARACTERS,
    MAX_TEXT_CHARACTERS,
} from '../doubao.mjs';
import { capabilities, info, init, version } from '../index.mjs';

class FakeRequest extends EventEmitter {
    constructor(body) {
        super();
        this.body = body;
        this.aborted = false;
        this.complete = true;
        this.destroyed = false;
    }
}

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.body = Buffer.alloc(0);
        this.destroyed = false;
        this.headers = new Map();
        this.headersSent = false;
        this.statusCode = 200;
        this.writableEnded = false;
    }

    status(statusCode) {
        this.statusCode = statusCode;
        return this;
    }

    setHeader(name, value) {
        this.headers.set(name.toLowerCase(), String(value));
        return this;
    }

    getHeader(name) {
        return this.headers.get(name.toLowerCase());
    }

    json(value) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
        return this.end(Buffer.from(JSON.stringify(value)));
    }

    end(value) {
        if (value !== undefined) this.body = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.headersSent = true;
        this.writableEnded = true;
        return this;
    }
}

function validRequest(overrides = {}) {
    return {
        apiKey: 'api-key-value',
        appId: '',
        accessKey: '',
        resourceId: 'seed-tts-2.0',
        speaker: 'speaker-id',
        text: 'test text',
        contextText: 'calm',
        ...overrides,
    };
}

function streamResponse(chunks, status = 200) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
            }
            controller.close();
        },
    });
    return {
        ok: status >= 200 && status < 300,
        status,
        body,
    };
}

function successfulResponse(audio = Buffer.from([0x49, 0x44, 0x33])) {
    return streamResponse([
        `${JSON.stringify({ code: 0, data: audio.toString('base64') })}\n`,
        `${JSON.stringify({ code: 20_000_000 })}\n`,
    ]);
}

function responseJson(res) {
    return JSON.parse(res.body.toString('utf8'));
}

async function withJsonRoute(bridge, callback) {
    const parser = createJsonBodyParser();
    const server = createServer((req, res) => {
        // body-parser 1.20 initializes req.body to {} even when its application/json
        // matcher skips the vendor +json media type used by this route.
        req.body = {};
        parser(req, res, () => bridge.synthesize(req, res));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/doubao/synthesize`;
    try {
        return await callback(url);
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    }
}

test('plugin contract registers uncredentialed capabilities/probe and synthesis routes', async () => {
    const routes = new Map();
    const router = {
        get(path, ...handlers) {
            routes.set(`GET ${path}`, handlers);
        },
        post(path, ...handlers) {
            routes.set(`POST ${path}`, handlers);
        },
    };

    await init(router);

    assert.deepEqual(info, {
        id: 'ganggang-tts-bridge',
        name: 'Ganggang TTS Bridge',
        description: 'Narrow same-origin bridge for native Doubao TTS synthesis.',
    });
    assert.equal(version, '1.0.0');
    assert.deepEqual([...routes.keys()].sort(), [
        'GET /capabilities',
        'POST /doubao/synthesize',
        'POST /probe',
    ]);

    const capabilitiesResponse = new FakeResponse();
    routes.get('GET /capabilities')[0](new FakeRequest(undefined), capabilitiesResponse);
    assert.equal(capabilitiesResponse.statusCode, 200);
    assert.deepEqual(responseJson(capabilitiesResponse), capabilities);
    assert.deepEqual(responseJson(capabilitiesResponse), {
        pluginId: 'ganggang-tts-bridge',
        version: '1.0.0',
        doubao: {
            available: true,
            synthesizePath: '/api/plugins/ganggang-tts-bridge/doubao/synthesize',
            requestContentType: 'application/vnd.ganggang-tts+json',
            credentialModes: ['api-key', 'app-id-access-key'],
            responseContentType: 'audio/mpeg',
            limits: {
                maxTextCharacters: 10_000,
                maxContextCharacters: 2_000,
                maxAudioBytes: 80 * 1024 * 1024,
                timeoutMs: 45_000,
            },
        },
    });

    const probeResponse = new FakeResponse();
    routes.get('POST /probe')[0](new FakeRequest(undefined), probeResponse);
    assert.equal(probeResponse.statusCode, 204);
    assert.equal(probeResponse.body.length, 0);
    assert.equal(routes.get('POST /doubao/synthesize').length, 2);
});

test('active-order vendor JSON parser admits valid JSON and controls malformed, missing, non-JSON, and oversized bodies', async t => {
    let upstreamCalls = 0;
    const bridge = createDoubaoBridge({
        fetchImpl: async () => {
            upstreamCalls += 1;
            return successfulResponse();
        },
    });

    await withJsonRoute(bridge, async url => {
        await t.test('valid vendor JSON reaches synthesis', async () => {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE },
                body: JSON.stringify(validRequest()),
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'audio/mpeg');
            assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x49, 0x44, 0x33]);
        });

        for (const [name, headers, body] of [
            ['malformed JSON', { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE }, '{"apiKey":'],
            ['missing body', { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE }, undefined],
            ['generic application/json', { 'Content-Type': 'application/json' }, JSON.stringify(validRequest())],
            ['non-JSON content type', { 'Content-Type': 'text/plain' }, JSON.stringify(validRequest())],
            [
                'body over 128 KiB',
                { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE },
                JSON.stringify({ padding: 'x'.repeat(MAX_JSON_BODY_BYTES) }),
            ],
        ]) {
            await t.test(name, async () => {
                const response = await fetch(url, { method: 'POST', headers, body });
                assert.equal(response.status, 400);
                assert.deepEqual(await response.json(), { error: { code: 'VALIDATION_ERROR' } });
            });
        }
    });

    assert.equal(upstreamCalls, 1);
});

test('API key mode uses the fixed endpoint and never sends legacy credential headers', async () => {
    let fetchCall;
    const bridge = createDoubaoBridge({
        fetchImpl: async (url, options) => {
            fetchCall = { url, options };
            return successfulResponse();
        },
        requestIdFactory: () => 'request-id-new-mode',
    });
    const response = new FakeResponse();

    await bridge.synthesize(new FakeRequest(validRequest()), response);

    assert.equal(fetchCall.url, DOUBAO_TTS_ENDPOINT);
    assert.equal(fetchCall.options.method, 'POST');
    assert.equal(fetchCall.options.redirect, 'error');
    assert.equal(fetchCall.options.headers['X-Api-Key'], 'api-key-value');
    assert.equal(fetchCall.options.headers['X-Api-Request-Id'], 'request-id-new-mode');
    assert.equal(fetchCall.options.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.equal(Object.hasOwn(fetchCall.options.headers, 'X-Api-App-Key'), false);
    assert.equal(Object.hasOwn(fetchCall.options.headers, 'X-Api-Access-Key'), false);
    assert.equal(response.statusCode, 200);
    assert.equal(response.getHeader('Content-Type'), 'audio/mpeg');
    assert.deepEqual(response.body, Buffer.from([0x49, 0x44, 0x33]));

    const payload = JSON.parse(fetchCall.options.body);
    assert.deepEqual(payload, {
        user: { uid: 'ganggang-tts-bridge' },
        req_params: {
            text: 'test text',
            speaker: 'speaker-id',
            audio_params: { format: 'mp3', sample_rate: 24_000 },
            additions: JSON.stringify({ context_texts: ['calm'] }),
        },
    });
});

test('legacy mode requires both fields and never sends X-Api-Key', async () => {
    let fetchCall;
    const bridge = createDoubaoBridge({
        fetchImpl: async (url, options) => {
            fetchCall = { url, options };
            return successfulResponse();
        },
        requestIdFactory: () => 'request-id-legacy-mode',
    });
    const response = new FakeResponse();

    await bridge.synthesize(new FakeRequest(validRequest({
        apiKey: '',
        appId: 'legacy-app-id',
        accessKey: 'legacy-access-key',
    })), response);

    assert.equal(fetchCall.options.headers['X-Api-App-Key'], 'legacy-app-id');
    assert.equal(fetchCall.options.headers['X-Api-Access-Key'], 'legacy-access-key');
    assert.equal(fetchCall.options.headers['X-Api-Request-Id'], 'request-id-legacy-mode');
    assert.equal(Object.hasOwn(fetchCall.options.headers, 'X-Api-Key'), false);
    assert.equal(response.statusCode, 200);

    let fetchCount = 0;
    const rejectingBridge = createDoubaoBridge({
        fetchImpl: async () => {
            fetchCount += 1;
            return successfulResponse();
        },
    });
    const rejectedResponse = new FakeResponse();
    await rejectingBridge.synthesize(
        new FakeRequest(validRequest({ apiKey: '', appId: 'legacy-app-id', accessKey: '' })),
        rejectedResponse,
    );
    assert.equal(fetchCount, 0);
    assert.equal(rejectedResponse.statusCode, 400);
    assert.deepEqual(responseJson(rejectedResponse), { error: { code: 'VALIDATION_ERROR' } });
});

test('API key and legacy credential fields are rejected when submitted together', async () => {
    let fetchCount = 0;
    const bridge = createDoubaoBridge({
        fetchImpl: async () => {
            fetchCount += 1;
            return successfulResponse();
        },
    });
    const response = new FakeResponse();

    await bridge.synthesize(new FakeRequest(validRequest({
        appId: 'legacy-app-id',
        accessKey: 'legacy-access-key',
    })), response);

    assert.equal(fetchCount, 0);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(responseJson(response), { error: { code: 'VALIDATION_ERROR' } });
});

test('every synthesis call receives a fresh X-Api-Request-Id', async () => {
    const requestIds = [];
    let sequence = 0;
    const bridge = createDoubaoBridge({
        fetchImpl: async (_url, options) => {
            requestIds.push(options.headers['X-Api-Request-Id']);
            return successfulResponse();
        },
        requestIdFactory: () => `request-${++sequence}`,
    });

    await bridge.synthesize(new FakeRequest(validRequest()), new FakeResponse());
    await bridge.synthesize(new FakeRequest(validRequest()), new FakeResponse());

    assert.deepEqual(requestIds, ['request-1', 'request-2']);
});

test('request allowlist rejects endpoint, headers, and non-string fields before fetch', async t => {
    for (const [name, request] of [
        ['endpoint', validRequest({ endpoint: 'https://attacker.invalid/tts' })],
        ['headers', validRequest({ headers: { Authorization: 'secret' } })],
        ['non-string field', validRequest({ speaker: { value: 'speaker-id' } })],
    ]) {
        await t.test(name, async () => {
            let fetchCount = 0;
            const bridge = createDoubaoBridge({
                fetchImpl: async () => {
                    fetchCount += 1;
                    return successfulResponse();
                },
            });
            const response = new FakeResponse();
            await bridge.synthesize(new FakeRequest(request), response);
            assert.equal(fetchCount, 0);
            assert.equal(response.statusCode, 400);
            assert.deepEqual(responseJson(response), { error: { code: 'VALIDATION_ERROR' } });
        });
    }
});

test('text and context inputs have explicit character limits', async () => {
    let fetchCount = 0;
    const bridge = createDoubaoBridge({
        fetchImpl: async () => {
            fetchCount += 1;
            return successfulResponse();
        },
    });

    for (const request of [
        validRequest({ text: 'x'.repeat(MAX_TEXT_CHARACTERS + 1) }),
        validRequest({ contextText: 'x'.repeat(MAX_CONTEXT_CHARACTERS + 1) }),
    ]) {
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(request), response);
        assert.equal(response.statusCode, 400);
        assert.deepEqual(responseJson(response), { error: { code: 'VALIDATION_ERROR' } });
    }
    assert.equal(fetchCount, 0);
    assert.equal(MAX_AUDIO_BYTES, 80 * 1024 * 1024);
});

test('incremental NDJSON parsing accepts split multi-chunk audio and final event', async () => {
    const bridge = createDoubaoBridge({
        fetchImpl: async () => streamResponse([
            '{"code":0,"data":"AQ',
            'I="}\r\n{"code":0,"data":"AwQ="}\n{"code":2000',
            '0000}\n',
        ]),
    });
    const response = new FakeResponse();

    await bridge.synthesize(new FakeRequest(validRequest()), response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.getHeader('Content-Type'), 'audio/mpeg');
    assert.deepEqual([...response.body], [1, 2, 3, 4]);
});

test('upstream error events are returned as small controlled errors', async () => {
    const secretUpstreamText = 'do-not-reflect-upstream-secret';
    const bridge = createDoubaoBridge({
        fetchImpl: async () => streamResponse([
            `${JSON.stringify({ code: 3001, message: secretUpstreamText })}\n`,
        ]),
    });
    const response = new FakeResponse();

    await bridge.synthesize(
        new FakeRequest(validRequest({ text: 'private request text', apiKey: 'private-api-key' })),
        response,
    );

    const serialized = response.body.toString('utf8');
    assert.equal(response.statusCode, 502);
    assert.deepEqual(responseJson(response), { error: { code: 'UPSTREAM_ERROR' } });
    assert.equal(serialized.includes(secretUpstreamText), false);
    assert.equal(serialized.includes('private request text'), false);
    assert.equal(serialized.includes('private-api-key'), false);
    assert.ok(response.body.length < 256);
});

test('empty, truncated, malformed, post-final, and invalid Base64 streams are controlled failures', async t => {
    await t.test('empty audio', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => streamResponse(['{"code":20000000}\n']),
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'INVALID_UPSTREAM_RESPONSE' } });
    });

    await t.test('invalid Base64', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => streamResponse(['{"code":0,"data":"%%%="}\n']),
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'INVALID_UPSTREAM_RESPONSE' } });
    });

    await t.test('malformed NDJSON', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => streamResponse(['{"code":0,not-json}\n']),
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'INVALID_UPSTREAM_RESPONSE' } });
    });

    await t.test('audio without final event', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => streamResponse(['{"code":0,"data":"AQI="}\n']),
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'INVALID_UPSTREAM_RESPONSE' } });
    });

    await t.test('event after final', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => streamResponse([
                '{"code":0,"data":"AQI="}\n',
                '{"code":20000000}\n',
                '{"code":0,"data":"AwQ="}\n',
            ]),
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'INVALID_UPSTREAM_RESPONSE' } });
    });
});

test('raw response and decoded audio limits are enforced independently', async t => {
    await t.test('raw response limit', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => successfulResponse(),
            maxRawResponseBytes: 8,
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'RESPONSE_TOO_LARGE' } });
    });

    await t.test('decoded audio limit', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => successfulResponse(Buffer.from([1, 2, 3])),
            maxAudioBytes: 2,
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'RESPONSE_TOO_LARGE' } });
    });

    await t.test('NDJSON single-line limit', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => streamResponse(Array.from({ length: 17 }, () => 'x')),
            maxNdjsonLineCharacters: 16,
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'RESPONSE_TOO_LARGE' } });
    });

    assert.equal(MAX_NDJSON_LINE_CHARACTERS, 16 * 1024 * 1024);
});

test('timeout aborts the injected fetch signal and returns a controlled 504', async () => {
    let observedSignal;
    let clearCount = 0;
    const bridge = createDoubaoBridge({
        fetchImpl: async (_url, options) => {
            observedSignal = options.signal;
            return await new Promise((resolve, reject) => {
                const rejectAbort = () => reject(options.signal.reason);
                if (options.signal.aborted) rejectAbort();
                else options.signal.addEventListener('abort', rejectAbort, { once: true });
            });
        },
        timeoutMs: 1,
        setTimeoutImpl: callback => {
            queueMicrotask(callback);
            return 1;
        },
        clearTimeoutImpl: () => {
            clearCount += 1;
        },
    });
    const response = new FakeResponse();

    await bridge.synthesize(new FakeRequest(validRequest()), response);

    assert.equal(observedSignal.aborted, true);
    assert.equal(clearCount, 1);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(responseJson(response), { error: { code: 'UPSTREAM_TIMEOUT' } });
});

test('client abort propagates to upstream without exposing request data', async () => {
    let observedSignal;
    let fetchStartedResolve;
    const fetchStarted = new Promise(resolve => {
        fetchStartedResolve = resolve;
    });
    const bridge = createDoubaoBridge({
        fetchImpl: async (_url, options) => {
            observedSignal = options.signal;
            fetchStartedResolve();
            return await new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
        },
    });
    const request = new FakeRequest(validRequest({ text: 'private abort text' }));
    const response = new FakeResponse();
    const synthesis = bridge.synthesize(request, response);

    await fetchStarted;
    request.aborted = true;
    request.emit('aborted');
    await synthesis;

    assert.equal(observedSignal.aborted, true);
    assert.equal(response.statusCode, 499);
    assert.deepEqual(responseJson(response), { error: { code: 'CLIENT_ABORTED' } });
    assert.equal(response.body.toString('utf8').includes('private abort text'), false);
});

test('response close aborts upstream and does not write a late response', async () => {
    let observedSignal;
    let fetchStartedResolve;
    const fetchStarted = new Promise(resolve => {
        fetchStartedResolve = resolve;
    });
    const bridge = createDoubaoBridge({
        fetchImpl: async (_url, options) => {
            observedSignal = options.signal;
            fetchStartedResolve();
            return await new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
        },
    });
    const request = new FakeRequest(validRequest());
    const response = new FakeResponse();
    const synthesis = bridge.synthesize(request, response);

    await fetchStarted;
    response.destroyed = true;
    response.emit('close');
    await synthesis;

    assert.equal(observedSignal.aborted, true);
    assert.equal(response.writableEnded, false);
    assert.equal(response.headersSent, false);
    assert.equal(response.body.length, 0);
});

test('network and HTTP failures never reflect upstream error text', async t => {
    await t.test('network failure', async () => {
        const bridge = createDoubaoBridge({
            fetchImpl: async () => {
                throw new Error('sensitive network diagnostic');
            },
        });
        const response = new FakeResponse();
        await bridge.synthesize(new FakeRequest(validRequest()), response);
        assert.equal(response.statusCode, 502);
        assert.deepEqual(responseJson(response), { error: { code: 'UPSTREAM_ERROR' } });
        assert.equal(response.body.toString('utf8').includes('sensitive network diagnostic'), false);
    });

    for (const [status, expectedStatus, code] of [
        [401, 502, 'UPSTREAM_AUTH'],
        [403, 502, 'UPSTREAM_AUTH'],
        [429, 503, 'UPSTREAM_RATE_LIMIT'],
        [500, 502, 'UPSTREAM_ERROR'],
    ]) {
        await t.test(`HTTP ${status}`, async () => {
            const bridge = createDoubaoBridge({
                fetchImpl: async () => ({ ok: false, status, body: null }),
            });
            const response = new FakeResponse();
            await bridge.synthesize(new FakeRequest(validRequest()), response);
            assert.equal(response.statusCode, expectedStatus);
            assert.deepEqual(responseJson(response), { error: { code } });
        });
    }
});
