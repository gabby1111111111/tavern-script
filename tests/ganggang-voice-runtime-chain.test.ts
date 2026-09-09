import { createVoiceRuntime } from '../src/杠杠の配音室/runtime';
import type { CastRole } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// A real module import keeps the async runtime chain in the TypeScript/ts-node
// graph. The factory is intentionally not instantiated here because its host
// APIs belong to a live Tavern Helper page, not a Node test process.
const factory: typeof createVoiceRuntime = createVoiceRuntime;
const supportedRoles: CastRole[] = ['narrator', 'user', 'character', 'fallback'];

assert(typeof factory === 'function', 'runtime module must export createVoiceRuntime');
assert(supportedRoles.includes('user'), 'runtime chain must compile with the user cast role');
console.info('<杠杠の配音室> runtime import chain tests passed');
