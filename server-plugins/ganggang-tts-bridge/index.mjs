import {
    createDoubaoBridge,
    createJsonBodyParser,
    DEFAULT_TIMEOUT_MS,
    DOUBAO_REQUEST_CONTENT_TYPE,
    MAX_AUDIO_BYTES,
    MAX_CONTEXT_CHARACTERS,
    MAX_TEXT_CHARACTERS,
} from './doubao.mjs';
import { createFishBridge } from './fish.mjs';

export const info = Object.freeze({
    id: 'ganggang-tts-bridge',
    name: 'Ganggang TTS Bridge',
    description: 'Narrow same-origin bridge for native Doubao TTS and Fish Audio synthesis.',
});

export const version = '1.1.0';

export const capabilities = Object.freeze({
    pluginId: info.id,
    version,
    doubao: Object.freeze({
        available: true,
        synthesizePath: '/api/plugins/ganggang-tts-bridge/doubao/synthesize',
        requestContentType: DOUBAO_REQUEST_CONTENT_TYPE,
        credentialModes: Object.freeze(['api-key', 'app-id-access-key']),
        responseContentType: 'audio/mpeg',
        limits: Object.freeze({
            maxTextCharacters: MAX_TEXT_CHARACTERS,
            maxContextCharacters: MAX_CONTEXT_CHARACTERS,
            maxAudioBytes: MAX_AUDIO_BYTES,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
    }),
    fish: Object.freeze({
        available: true,
        synthesizePath: '/api/plugins/ganggang-tts-bridge/fish/synthesize',
        requestContentType: DOUBAO_REQUEST_CONTENT_TYPE,
        responseContentType: 'audio/mpeg',
        limits: Object.freeze({
            maxTextCharacters: MAX_TEXT_CHARACTERS,
            maxAudioBytes: MAX_AUDIO_BYTES,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
    }),
});

const bridge = createDoubaoBridge();
const fishBridge = createFishBridge();
const jsonBodyParser = createJsonBodyParser();

function sendCapabilities(_req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(capabilities);
}

function probe(_req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
}

export async function init(router) {
    router.get('/capabilities', sendCapabilities);
    router.post('/probe', probe);
    router.post('/doubao/synthesize', jsonBodyParser, bridge.synthesize);
    router.post('/fish/synthesize', jsonBodyParser, fishBridge.synthesize);
    console.info('[ganggang-tts-bridge] Plugin loaded.');
}

export async function exit() {
    console.info('[ganggang-tts-bridge] Plugin exited.');
}

const plugin = Object.freeze({
    info,
    init,
    exit,
});

export default plugin;
