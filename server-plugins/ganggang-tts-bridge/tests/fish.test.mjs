import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { createJsonBodyParser, DOUBAO_REQUEST_CONTENT_TYPE } from '../doubao.mjs';
import { buildFishUpstreamRequest, createFishBridge, normalizeFishRequest } from '../fish.mjs';
import { capabilities, init, version } from '../index.mjs';

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
        apiKey: 'fish-key-value',
        text: 'test text',
        referenceId: 'fish-ref-id',
        format: 'mp3',
        ...overrides,
    };
}

function binaryResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                if (name === 'content-type') return 'audio/mpeg';
                if (name === 'content-length') return String(body.length);
                return null;
            },
        },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
}

function responseJson(res) {
    return JSON.parse(res.body.toString('utf8'));
}

async function withFishBridge(fetchImpl, callback) {
    const fishBridge = createFishBridge({ fetchImpl });
    const parser = createJsonBodyParser();
    const server = createServer((req, res) => {
        req.body = {};
        parser(req, res, () => fishBridge.synthesize(req, res));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/fish/synthesize`;
    try {
        return await callback(url);
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    }
}

test('plugin contract registers fish synthesis route and capabilities', async () => {
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

    assert.equal(version, '1.1.0');
    assert.ok(routes.has('POST /fish/synthesize'), '必须注册 fish 同源合成路由');

    const capabilitiesResponse = new FakeResponse();
    routes.get('GET /capabilities')[0](new FakeRequest(undefined), capabilitiesResponse);
    assert.deepEqual(responseJson(capabilitiesResponse).fish, capabilities.fish);
    assert.deepEqual(capabilities.fish, {
        available: true,
        synthesizePath: '/api/plugins/ganggang-tts-bridge/fish/synthesize',
        requestContentType: DOUBAO_REQUEST_CONTENT_TYPE,
        responseContentType: 'audio/mpeg',
        limits: {
            maxTextCharacters: 10_000,
            maxAudioBytes: 80 * 1024 * 1024,
            timeoutMs: 45_000,
        },
    });
});

test('normalizeFishRequest rejects unknown fields and missing credentials', () => {
    assert.deepEqual(normalizeFishRequest(validRequest()), {
        apiKey: 'fish-key-value',
        text: 'test text',
        referenceId: 'fish-ref-id',
        format: 'mp3',
        model: 's2.1-pro-free',
    });
    assert.throws(() => normalizeFishRequest(validRequest({ endpoint: 'https://evil.invalid' })), /VALIDATION_ERROR/);
    assert.throws(() => normalizeFishRequest(validRequest({ apiKey: '' })), /VALIDATION_ERROR/);
    assert.throws(() => normalizeFishRequest(validRequest({ referenceId: '' })), /VALIDATION_ERROR/);
    assert.throws(() => normalizeFishRequest(validRequest({ format: 'ogg' })), /VALIDATION_ERROR/);
    assert.throws(() => normalizeFishRequest(validRequest({ model: 'gpt-x' })), /VALIDATION_ERROR/);
});

test('buildFishUpstreamRequest puts credentials in the Authorization header only', () => {
    const upstream = buildFishUpstreamRequest(validRequest({ format: 'wav' }));
    assert.equal(upstream.url, 'https://api.fish.audio/v1/tts');
    assert.equal(upstream.headers.Authorization, 'Bearer fish-key-value');
    assert.equal(upstream.headers.model, 's2.1-pro-free', '模型必须放在请求头 model 里');
    assert.deepEqual(upstream.payload, {
        text: 'test text',
        reference_id: 'fish-ref-id',
        format: 'wav',
        latency: 'normal',
    });
    assert.equal(upstream.payload.apiKey, undefined, '凭据不得进入上游请求体');
});

test('fish bridge synthesizes through the upstream and returns audio/mpeg', async () => {
    const captured = { url: '', headers: null, body: '' };
    await withFishBridge(
        async (url, init) => {
            captured.url = String(url);
            captured.headers = init.headers;
            captured.body = String(init.body);
            return binaryResponse(Buffer.from('mp3audio'));
        },
        async url => {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE },
                body: JSON.stringify(validRequest()),
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'audio/mpeg');
            assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), 'mp3audio');
            assert.equal(captured.url, 'https://api.fish.audio/v1/tts');
            assert.equal(captured.headers.Authorization, 'Bearer fish-key-value');
            const upstreamBody = JSON.parse(captured.body);
            assert.equal(upstreamBody.reference_id, 'fish-ref-id');
            assert.equal(upstreamBody.apiKey, undefined, '凭据不得进入上游请求体');
        },
    );
});

test('fish bridge maps upstream failures to stable error codes', async () => {
    const upstreamStatus = { status: 200 };
    await withFishBridge(
        async () => binaryResponse(Buffer.from('mp3audio'), upstreamStatus.status),
        async url => {
            for (const [status, expectedCode, expectedStatus] of [
                [401, 'UPSTREAM_AUTH', 502],
                [429, 'UPSTREAM_RATE_LIMIT', 503],
            ]) {
                upstreamStatus.status = status;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE },
                    body: JSON.stringify(validRequest()),
                });
                assert.equal(response.status, expectedStatus);
                assert.equal((await response.json()).error.code, expectedCode);
            }
        },
    );
});

test('fish bridge rejects empty upstream audio', async () => {
    await withFishBridge(
        async () => binaryResponse(Buffer.alloc(0)),
        async url => {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': DOUBAO_REQUEST_CONTENT_TYPE },
                body: JSON.stringify(validRequest()),
            });
            assert.equal(response.status, 502);
            assert.equal((await response.json()).error.code, 'INVALID_UPSTREAM_RESPONSE');
        },
    );
});
