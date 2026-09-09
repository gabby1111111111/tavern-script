import {
  buildCastingContext,
  buildCastingRequestPayload,
  createCastingInputSignature,
  readCurrentCastingContext,
  readCurrentCastingContextSync,
  sanitizeVoiceOptions,
} from '../src/杠杠の配音室/context';
import type { VoiceOption } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const voices: VoiceOption[] = [
  { providerProfileId: 'profile-1', voiceId: 'zh-female', name: '清亮女声', locale: 'zh-CN' },
];

const baseRuntime = {
  getCharData: () => ({
    avatar: 'card.png',
    data: {
      name: '懒加载角色',
      description: '从 v2 data 读取的描述',
      personality: '温柔',
      scenario: '雨夜',
      first_mes: '你好。',
      mes_example: '<START>你好。',
    },
    json_data: '{"apiKey":"never-copy"}',
  }),
  getCurrentCharacterName: () => '懒加载角色',
  getCurrentCharacterId: () => 'card.png',
  getLastMessageId: () => 6,
  getChatMessages: () => [
    { message_id: 0, role: 'assistant', name: '角色', message: '第零楼' },
    { message_id: 1, role: 'assistant', name: '角色', message: '第一楼' },
    { message_id: 2, role: 'assistant', name: '角色', message: '第二楼', is_hidden: true },
    { message_id: 3, role: 'assistant', name: '角色', message: '第三楼' },
    { message_id: 4, role: 'assistant', name: '角色', message: '第四楼' },
    { message_id: 5, role: 'assistant', name: '角色', message: '第五楼' },
    { message_id: 6, role: 'assistant', name: '角色', message: '第六楼' },
  ],
  getPersona: () => ({ name: '玩家', title: '旅人', description: '普通话用户' }),
};

const runContextPayloadTests = async (): Promise<void> => {
  const context = await readCurrentCastingContext(5, {
    ...baseRuntime,
    getActivatedBoundWorldbooks: async () => ({
      personaWorldbook: [{ name: '用户条目', content: '用户绑定且本轮激活' }],
      characterWorldbook: ['角色绑定且本轮激活'],
    }),
  });
  equal(context.characterKey, 'character:card.png', '本地上下文必须保留稳定 characterKey');
  equal(context.characterDescription, '从 v2 data 读取的描述', 'shallow card 应回退到 data 字段');
  equal(
    context.recentMessages.map(message => message.message),
    ['第一楼', '第三楼', '第四楼', '第五楼', '第六楼'],
    '只保留最近可见消息',
  );
  equal(context.personaWorldbook, ['用户绑定且本轮激活'], '应接受 source-restricted persona lore adapter');
  equal(context.characterWorldbook, ['角色绑定且本轮激活'], '应接受 source-restricted character lore adapter');

  const payload = buildCastingRequestPayload(context, voices);
  assert(!('characterKey' in payload.context), 'characterKey 不能进入 outbound payload');
  equal(
    payload.context.recentChat?.map(message => message.message),
    ['第一楼', '第三楼', '第四楼', '第五楼', '第六楼'],
    'outbound recentChat 只能包含可见当前 swipe',
  );
  const signature = createCastingInputSignature(context, voices, 5, [{ id: 'profile-1', type: 'edge' }]);
  assert(signature.includes('character:card.png'), 'signature 必须保留本地 characterKey');
  assert(!JSON.stringify(payload).includes('never-copy'), 'payload 不能复制原始 json_data 或凭据');

  const noChat = await readCurrentCastingContext(5, {
    ...baseRuntime,
    getLastMessageId: () => -1,
    getChatMessages: () => {
      throw new Error('无聊天楼层时不应请求聊天 API');
    },
  });
  const noChatPayload = buildCastingRequestPayload(noChat, voices);
  assert(!('recentChat' in noChatPayload.context), '没有聊天楼层时应省略 recentChat');

  const noAdapter = await readCurrentCastingContext(5, baseRuntime);
  equal(noAdapter.personaWorldbook, [], '没有 adapter 时 persona lore 必须安全为空');
  equal(noAdapter.characterWorldbook, [], '没有 adapter 时 character lore 必须安全为空');

  const failedAdapter = await readCurrentCastingContext(5, {
    ...baseRuntime,
    getActivatedBoundWorldbooks: async () => {
      throw new Error('adapter unavailable');
    },
  });
  equal(failedAdapter.personaWorldbook, [], 'adapter 失败时 persona lore 必须安全为空');
  equal(failedAdapter.characterWorldbook, [], 'adapter 失败时 character lore 必须安全为空');

  const syncContext = readCurrentCastingContextSync(5, {
    ...baseRuntime,
    getActivatedBoundWorldbooks: async () => ({ personaWorldbook: ['不得在 sync capture 读取'] }),
  });
  equal(syncContext.characterKey, 'character:card.png', 'sync compatibility capture 也必须保留 characterKey');
  equal(syncContext.personaWorldbook, [], 'sync compatibility capture 不得伪造异步 lore');

  const built = buildCastingContext({ avatar: 'direct.png', name: '角色' }, [], {
    personaWorldbook: ['enabled but not proven active'],
    characterWorldbook: ['active'],
  });
  const builtPayload = buildCastingRequestPayload(built, voices);
  equal(
    builtPayload.context.personaWorldbook,
    ['enabled but not proven active'],
    '显式 adapter 数据应可被 payload 使用',
  );

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let scanChat: string[] = [];
  let scanData: Record<string, string> | undefined;
  const defaultWorldbookContext = await readCurrentCastingContext(5, {
    ...baseRuntime,
    getPersona: () => ({ name: '玩家', title: '旅人', description: '普通话用户', lorebook: 'persona-book' }),
    getCharWorldbookNames: () => ({ primary: 'character-book', additional: ['character-extra-book'] }),
    getWorldInfoMaxContext: 8_192,
    getWorldInfoEventTypes: {
      WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
      WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
    },
    getWorldInfoEventOn: (eventType, listener) => {
      const eventListeners = listeners.get(eventType) ?? new Set();
      eventListeners.add(listener);
      listeners.set(eventType, eventListeners);
      return { stop: () => eventListeners.delete(listener) };
    },
    getWorldInfoPrompt: async (chat, maxContext, isDryRun, globalScanData) => {
      assert(isDryRun, '默认世界书 adapter 必须只调用 dry-run');
      equal(maxContext, 8_192, 'dry-run 应使用宿主 maxContext');
      scanChat = chat;
      scanData = globalScanData;
      const emit = (eventType: string, payload: unknown) => {
        for (const listener of listeners.get(eventType) ?? []) listener(payload);
      };
      emit('worldinfo_entries_loaded', {
        personaLore: [
          { world: 'persona-book', uid: 1, name: '玩家信息', content: 'persona active' },
          { world: 'persona-book', uid: 2, name: '未激活', content: 'persona inactive' },
        ],
        characterLore: [
          { world: 'character-book', uid: 3, name: '角色信息', content: 'character active' },
          { world: 'character-extra-book', uid: 4, name: '额外角色信息', content: 'character extra active' },
        ],
        globalLore: [{ world: 'global-book', uid: 5, name: '全局', content: 'global must not leak' }],
        chatLore: [{ world: 'chat-book', uid: 6, name: '聊天', content: 'chat must not leak' }],
      });
      emit('worldinfo_scan_done', {
        state: { next: 1 },
        activated: {
          entries: new Map([['persona-book.1', { world: 'persona-book', uid: 1, content: 'persona active' }]]),
        },
      });
      emit('worldinfo_scan_done', {
        state: { next: 0 },
        activated: {
          entries: new Map([
            ['persona-book.1', { world: 'persona-book', uid: 1, content: 'persona active' }],
            ['character-book.3', { world: 'character-book', uid: 3, content: 'character active' }],
            ['character-extra-book.4', { world: 'character-extra-book', uid: 4, content: 'character extra active' }],
            ['global-book.5', { world: 'global-book', uid: 5, content: 'global must not leak' }],
            ['chat-book.6', { world: 'chat-book', uid: 6, content: 'chat must not leak' }],
          ]),
        },
      });
    },
  });
  equal(
    defaultWorldbookContext.personaWorldbook,
    ['persona active'],
    '默认 adapter 只能返回实际激活的 Persona 绑定条目内容',
  );
  equal(
    defaultWorldbookContext.characterWorldbook,
    ['character active', 'character extra active'],
    '默认 adapter 只能返回实际激活的角色绑定条目内容',
  );
  assert(scanChat[0]?.includes('第六楼'), '世界书 dry-run 应扫描当前可见聊天并从最新楼层开始');
  equal(scanData?.personaDescription, '普通话用户', '世界书 dry-run 应收到本地 Persona 扫描文本');
  equal(scanData?.characterDescription, '从 v2 data 读取的描述', '世界书 dry-run 应收到本地角色扫描文本');
  const defaultPayload = buildCastingRequestPayload(defaultWorldbookContext, voices);
  const defaultPayloadText = JSON.stringify(defaultPayload);
  assert(!defaultPayloadText.includes('persona-book'), 'outbound payload 不得包含世界书名称');
  assert(!defaultPayloadText.includes('global must not leak'), 'outbound payload 不得包含全局世界书');
  assert(!defaultPayloadText.includes('chat must not leak'), 'outbound payload 不得包含聊天世界书');

  const globalRuntime = globalThis as typeof globalThis & Record<string, unknown>;
  const savedGlobalSillyTavern = globalRuntime.SillyTavern;
  const savedGlobalEventOn = globalRuntime.eventOn;
  const savedGlobalCharWorldbooks = globalRuntime.getCharWorldbookNames;
  const globalListeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitGlobalWorldInfo = (eventType: string, payload: unknown) => {
    for (const listener of globalListeners.get(eventType) ?? []) listener(payload);
  };
  globalRuntime.getCharWorldbookNames = () => ({ primary: 'global-path-character-book', additional: [] });
  globalRuntime.eventOn = (eventType: string, listener: (payload: unknown) => void) => {
    const eventListeners = globalListeners.get(eventType) ?? new Set();
    eventListeners.add(listener);
    globalListeners.set(eventType, eventListeners);
    return { stop: () => eventListeners.delete(listener) };
  };
  globalRuntime.SillyTavern = {
    getContext: () => ({
      maxContext: 4_096,
      powerUserSettings: { world_info_include_names: true },
      eventTypes: {
        WORLDINFO_ENTRIES_LOADED: 'global_entries_loaded',
        WORLDINFO_SCAN_DONE: 'global_scan_done',
      },
      getWorldInfoPrompt: async () => {
        emitGlobalWorldInfo('global_entries_loaded', {
          personaLore: [{ world: 'global-path-persona-book', uid: 1, content: 'global path persona' }],
          characterLore: [{ world: 'global-path-character-book', uid: 2, content: 'global path character' }],
          globalLore: [],
          chatLore: [],
        });
        emitGlobalWorldInfo('global_scan_done', {
          state: { next: 0 },
          activated: {
            entries: new Map([
              [
                'global-path-persona-book.1',
                { world: 'global-path-persona-book', uid: 1, content: 'global path persona' },
              ],
              [
                'global-path-character-book.2',
                { world: 'global-path-character-book', uid: 2, content: 'global path character' },
              ],
            ]),
          },
        });
      },
    }),
  };
  try {
    const globalPathContext = await readCurrentCastingContext(5, {
      ...baseRuntime,
      getPersona: () => ({
        name: '玩家',
        title: '旅人',
        description: '普通话用户',
        lorebook: 'global-path-persona-book',
      }),
    });
    equal(
      globalPathContext.personaWorldbook,
      ['global path persona'],
      '默认路径应从 SillyTavern.getContext 获取扫描器',
    );
    equal(
      globalPathContext.characterWorldbook,
      ['global path character'],
      '默认路径应从 SillyTavern.getContext 获取事件与角色世界书结果',
    );
  } finally {
    if (savedGlobalSillyTavern === undefined) delete globalRuntime.SillyTavern;
    else globalRuntime.SillyTavern = savedGlobalSillyTavern;
    if (savedGlobalEventOn === undefined) delete globalRuntime.eventOn;
    else globalRuntime.eventOn = savedGlobalEventOn;
    if (savedGlobalCharWorldbooks === undefined) delete globalRuntime.getCharWorldbookNames;
    else globalRuntime.getCharWorldbookNames = savedGlobalCharWorldbooks;
  }

  const manyVoices = sanitizeVoiceOptions(
    Array.from({ length: 40 }, (_, index) => ({
      providerProfileId: `profile-${index}`,
      voiceId: `voice-${index}`,
      name: `音色 ${index}`,
      locale: 'zh-CN',
    })),
  );
  equal(manyVoices.length, 40, '音色资料不能静默截断到不足 32 人加旁白');

  console.info('<杠杠の配音室> context payload tests passed');
};

runContextPayloadTests().then(undefined, error => {
  throw error;
});
