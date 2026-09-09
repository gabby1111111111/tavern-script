import {
  loadVoiceSettings,
  normalizeVoiceSettings,
  saveCastingTable,
  SCRIPT_VARIABLE_OPTION,
} from '../src/杠杠の配音室/settings';
import type { CastRole, CastingTable } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const table: CastingTable = {
  characterKey: 'character:storage-test',
  characterName: '存储测试角色',
  generatedAt: 1700000000000,
  entries: [
    {
      id: 'narrator-1',
      role: 'narrator',
      displayName: '旁白',
      aliases: [],
      voice: { providerProfileId: 'profile-1', voiceId: 'narrator' },
    },
    {
      id: 'user-1',
      role: 'user',
      displayName: '玩家小明',
      aliases: ['小明'],
      voice: { providerProfileId: 'profile-1', voiceId: 'user' },
    },
    {
      id: 'character-1',
      role: 'character',
      displayName: '角色甲',
      aliases: [],
      voice: { providerProfileId: 'profile-1', voiceId: 'character' },
    },
  ],
};

let variables: Record<string, unknown> = {};
let lastOption: unknown;
const api = {
  getVariables: (option: typeof SCRIPT_VARIABLE_OPTION) => {
    lastOption = option;
    return variables;
  },
  updateVariablesWith: (
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
    option: typeof SCRIPT_VARIABLE_OPTION,
  ) => {
    lastOption = option;
    variables = updater(variables);
    return variables;
  },
};

const runRuntimeStorageTests = (): void => {
  const normalized = normalizeVoiceSettings({ castingByCharacter: { [table.characterKey]: table } });
  equal(
    normalized.castingByCharacter[table.characterKey].entries.map(entry => entry.role),
    ['narrator', 'user', 'character'],
    'normalizeCastingTable 必须保留 user role',
  );

  saveCastingTable(table, api);
  const reloaded = loadVoiceSettings(api);
  equal(
    reloaded.castingByCharacter[table.characterKey].entries.map(entry => entry.role),
    ['narrator', 'user', 'character'],
    '脚本变量保存并重载后必须保留 user role',
  );
  equal(lastOption, { type: 'script' }, '配音表存储必须使用脚本变量范围');

  const role: CastRole = reloaded.castingByCharacter[table.characterKey].entries[1].role;
  assert(role === 'user', 'CastRole 类型必须包含 user');
  console.info('<杠杠の配音室> runtime storage tests passed');
};

runRuntimeStorageTests();
