import {
  CASTING_JSON_SCHEMA,
  CastingValidationError,
  buildCastingPrompt,
  buildCastingUserInput,
  generateCastingTable,
  parseCastingResult,
} from '../src/杠杠の配音室/casting';
import type { CastingContext, VoiceOption } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + ': actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
  }
}

function expectCode(action: () => unknown, code: string, message: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof CastingValidationError && error.code === code) return;
    throw new Error(message + ': 收到错误 ' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  throw new Error(message + ': 未拒绝');
}

function context(overrides: Record<string, unknown> = {}): CastingContext {
  return {
    characterKey: 'character:test-only',
    characterName: 'Alice',
    characterDescription: 'synthetic fixture',
    characterPersonality: 'synthetic fixture',
    scenario: 'synthetic fixture',
    recentMessages: [],
    ...overrides,
  } as CastingContext;
}

function voice(providerProfileId: string, voiceId: string, name: string, locale: string): VoiceOption {
  return { providerProfileId, voiceId, name, locale };
}

function entry(
  role: 'narrator' | 'user' | 'character' | 'fallback',
  displayName: string,
  providerProfileId: string,
  voiceId: string,
  aliases: string[] = [],
): Record<string, unknown> {
  return { role, displayName, aliases, providerProfileId, voiceId };
}

const baseVoices: VoiceOption[] = [
  voice('profile-1', 'narrator-en', 'Narrator English', 'en-US'),
  voice('profile-1', 'user-en', 'User English', 'en-GB'),
  voice('profile-1', 'character-zh', 'Character Chinese', 'zh-CN'),
];

const personaContext = context({
  persona: { name: 'Bob', title: '', description: '', language: 'English' },
  characters: [{ name: 'Alice', language: 'Chinese' }],
});

const personaEntries = {
  entries: [
    entry('narrator', '旁白', 'profile-1', 'narrator-en'),
    entry('user', 'Bob', 'profile-1', 'user-en'),
    entry('character', 'Alice', 'profile-1', 'character-zh'),
  ],
};

const runCastingContractTests = async (): Promise<void> => {
  const schemaValue = CASTING_JSON_SCHEMA.value as Record<string, unknown>;
  const schemaProperties = schemaValue.properties as Record<string, unknown>;
  const entrySchema = (schemaProperties.entries as Record<string, unknown>).items as Record<string, unknown>;
  const entryProperties = entrySchema.properties as Record<string, unknown>;
  equal(
    (entryProperties.role as Record<string, unknown>).enum,
    ['narrator', 'user', 'character', 'fallback'],
    'schema 必须声明四种角色',
  );
  equal(entrySchema.additionalProperties, false, 'schema 必须拒绝条目额外字段');
  equal(schemaValue.additionalProperties, false, 'schema 必须拒绝根额外字段');
  equal((schemaProperties.entries as Record<string, unknown>).maxItems, 32, 'schema 必须保留 32 项技术上限');

  const prompt = buildCastingPrompt({ context: personaContext, voices: baseVoices });
  equal(prompt.length, 1, 'ordered_prompts 只能保留一个 system prompt');
  equal(prompt[0].role, 'system', '唯一 ordered prompt 必须是 system');
  assert(prompt[0].content.includes('user'), 'system prompt 必须声明 user role');
  assert(prompt[0].content.includes('不能听到音频'), 'system prompt 必须声明模型不能听音频');

  const input = buildCastingUserInput({ context: personaContext, voices: baseVoices });
  assert(!input.includes('characterKey'), 'AI 资料包不能外发本地 characterKey');
  assert(!input.includes('profile-1/narrator-en'), 'AI 资料包不能重复拼接 voicePairs');
  const providerOccurrences = input.split('"providerProfileId": "profile-1"').length - 1;
  equal(providerOccurrences, 3, '每个音色 profile pair 只能在 JSON voices 清单中出现一次');

  const parsedPersona = parseCastingResult(JSON.stringify(personaEntries), personaContext, baseVoices);
  equal(
    parsedPersona.entries.map(item => item.role),
    ['narrator', 'user', 'character'],
    'user role 必须被保留',
  );

  let captured: Record<string, unknown> | undefined;
  const generated = await generateCastingTable({
    context: personaContext,
    voices: baseVoices,
    generationId: 'casting-contract-test',
    runtime: {
      generateRaw: async config => {
        captured = config as unknown as Record<string, unknown>;
        return JSON.stringify(personaEntries);
      },
      stopGenerationById: () => true,
    },
  });
  equal(generated.entries.length, 3, 'generateCastingTable 应返回完整 user/character/narrator 表');
  assert(captured !== undefined, '应捕获 generateRaw 配置');
  equal((captured.ordered_prompts as unknown[]).length, 1, 'generateRaw 只能收到一个自定义 system prompt');
  assert(
    typeof captured.user_input === 'string' && captured.user_input.length > 0,
    'generateRaw 必须收到非空 user_input',
  );
  assert(!(captured as Record<string, unknown>).voicePairs, 'generateRaw 不得新增重复 voicePairs 字段');
  assert(!(captured as Record<string, unknown>).custom_api, '生成配音表不应携带 custom_api/key');

  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({ entries: [entry('narrator', '旁白', 'profile-1', 'narrator-en')] }),
        personaContext,
        baseVoices,
      ),
    'PERSONA_USER_REQUIRED',
    '存在 Persona 时缺少 user 必须拒绝',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('user', 'Bob', 'profile-1', 'user-en', ['你']),
            entry('character', 'Alice', 'profile-1', 'character-zh'),
          ],
        }),
        personaContext,
        baseVoices,
      ),
    'GENERIC_ALIAS',
    'aliases 不得使用泛代词',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('user', 'Bob', 'profile-1', 'not-requested'),
            entry('character', 'Alice', 'profile-1', 'character-zh'),
          ],
        }),
        personaContext,
        baseVoices,
      ),
    'UNKNOWN_VOICE',
    'providerProfileId+voiceId 不在清单中必须拒绝',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('user', 'Bob', 'profile-1', 'character-zh'),
            entry('character', 'Alice', 'profile-1', 'character-zh'),
          ],
        }),
        personaContext,
        baseVoices,
      ),
    'VOICE_LANGUAGE_MISMATCH',
    '人物语言与音色 locale 不匹配必须拒绝',
  );

  const personaOnlyContext = context({
    persona: { name: 'Bob', title: '', description: '' },
  });
  const personaOnlyTable = parseCastingResult(
    JSON.stringify({
      entries: [
        entry('narrator', '旁白', 'profile-1', 'narrator-en'),
        entry('user', 'Bob', 'profile-1', 'user-en'),
        entry('character', 'Alice', 'profile-1', 'character-zh'),
      ],
    }),
    personaOnlyContext,
    baseVoices,
  );
  equal(personaOnlyTable.entries.length, 3, '只有 Persona 名称时不能强制要求语言元数据');

  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('user', 'Bob', 'profile-1', 'user-en'),
            entry('character', 'Carol', 'profile-1', 'character-zh'),
          ],
        }),
        context({
          persona: { name: 'Bob', title: '', description: '', language: 'English' },
          characters: [{ name: 'Alice', language: 'Chinese' }],
        }),
        baseVoices,
      ),
    'UNKNOWN_PERSON',
    '人物不在输入资料时必须优先报告 unknown person',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('character', 'Alice', 'profile-1', 'character-zh'),
          ],
        }),
        context({ characters: [{ name: 'Alice' }] }),
        baseVoices,
      ),
    'LANGUAGE_INFO_MISSING',
    '已识别人物但没有语言资料时必须报告缺少语言元数据',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('user', 'User', 'profile-1', 'user-en'),
          ],
        }),
        personaOnlyContext,
        baseVoices,
      ),
    'GENERIC_ALIAS',
    'User 不能作为稳定配音身份名称',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('user', 'Bob', 'profile-1', 'user-en'),
            entry('character', 'Jean', 'profile-1', 'character-zh'),
          ],
        }),
        context({
          persona: { name: 'Bob', title: '', description: '', language: 'English' },
          characters: [{ name: 'Jean', language: 'French', description: '中文设定文字，但人物说法语。' }],
        }),
        [...baseVoices, voice('profile-1', 'character-fr', 'French voice', 'fr-FR')],
      ),
    'VOICE_LANGUAGE_MISMATCH',
    '中文设定文字不能覆盖人物明确的法语语言',
  );

  const noPersonaContext = context();
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('character', 'A', 'profile-1', 'user-en'),
            entry('character', 'B', 'profile-1', 'user-en'),
          ],
        }),
        noPersonaContext,
        [...baseVoices, voice('profile-1', 'other-en', 'Other English', 'en-US')],
      ),
    'DUPLICATE_PRIORITY_VOICE',
    '前五个优先人物在兼容音色充足时不得重复',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('character', 'A', 'profile-1', 'narrator-en'),
          ],
        }),
        noPersonaContext,
        baseVoices,
      ),
    'NARRATOR_VOICE_NOT_INDEPENDENT',
    '旁白音色必须独立于人物',
  );
  const crowdedChineseContext = context({
    characters: [
      { name: 'A', language: 'Chinese' },
      { name: 'B', language: 'Chinese' },
    ],
  });
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({
          entries: [
            entry('narrator', '旁白', 'profile-1', 'narrator-en'),
            entry('character', 'A', 'profile-1', 'character-zh'),
            entry('character', 'B', 'profile-1', 'character-zh'),
          ],
        }),
        crowdedChineseContext,
        [baseVoices[0], baseVoices[2]],
      ),
    'COMPATIBLE_VOICE_INSUFFICIENT',
    '兼容音色不足必须抛出明确安全错误',
  );
  expectCode(
    () =>
      parseCastingResult(
        JSON.stringify({ entries: [entry('narrator', '旁白', 'profile-1', 'narrator-en')], extra: true }),
        noPersonaContext,
        baseVoices,
      ),
    'INVALID_ROOT',
    '根对象额外字段必须拒绝',
  );

  const tooManyEntries = Array.from({ length: 33 }, (_, index) =>
    entry(
      index === 0 ? 'narrator' : 'character',
      index === 0 ? '旁白' : 'Character' + index,
      'profile-1',
      'narrator-en',
    ),
  );
  expectCode(
    () => parseCastingResult(JSON.stringify({ entries: tooManyEntries }), noPersonaContext, baseVoices),
    'ROLE_COUNT',
    '超过 32 项必须拒绝而不是静默截断',
  );

  console.info('<杠杠の配音室> casting contract tests passed');
};

runCastingContractTests().then(undefined, error => {
  throw error;
});
