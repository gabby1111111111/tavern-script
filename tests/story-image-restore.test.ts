import {
  confirmedShotImageUrl,
  planConfirmedShotRestore,
  type ConfirmedShotRestorePlanEntry,
  type RestorableMessageSnapshot,
  type ShotMessageReader,
} from '../src/杠杠の生图机/restore';
import {
  CONFIRMED_SHOT_STORAGE_KEY,
  getChatConfirmedShots,
  readConfirmedShotIndex,
  type ConfirmedShotEntry,
} from '../src/杠杠の生图机/shot-storage';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

type VariableHarness = {
  state: { variables: Record<string, unknown>; writes: number };
  readVariables: () => Record<string, unknown>;
  updateVariables: (
    updater: (variables: Record<string, unknown>) => Record<string, unknown>,
  ) => Record<string, unknown>;
};

function createVariableHarness(initial: Record<string, unknown> = {}): VariableHarness {
  const state = { variables: initial, writes: 0 };
  return {
    state,
    readVariables: () => state.variables,
    updateVariables: updater => {
      state.writes += 1;
      state.variables = updater(state.variables);
      return state.variables;
    },
  };
}

function makeEntry(messageId: number, swipeId: number, imageIndex: number, path: string): ConfirmedShotEntry {
  return {
    messageId,
    swipeId,
    imageIndex,
    filename: `shot_${messageId}_${swipeId}_${imageIndex}.png`,
    path,
    confirmedAt: TEST_NOW,
  };
}

function seedIndex(shots: Record<string, ConfirmedShotEntry[]>): Record<string, unknown> {
  const chats: Record<string, { shots: ConfirmedShotEntry[] }> = {};
  for (const [chatId, entries] of Object.entries(shots)) chats[chatId] = { shots: entries };
  return { [CONFIRMED_SHOT_STORAGE_KEY]: { version: 1, chats }, other: 'keep' };
}

const TEST_NOW = 1_700_000_000_000;
const CHAT = 'chat-restore';

function assistantMessage(swipeId: number, swipeCount: number): RestorableMessageSnapshot {
  return { role: 'assistant', swipeId, swipeCount };
}

/** Live floor snapshot table keyed by messageId; missing keys mean the floor is gone. */
function messageTable(table: Record<number, RestorableMessageSnapshot>, visited: number[] = []): ShotMessageReader {
  return messageId => {
    visited.push(messageId);
    return table[messageId] ?? null;
  };
}

function chatOptions(harness: VariableHarness, readMessage: ShotMessageReader) {
  return { chatId: CHAT, readVariables: harness.readVariables, updateVariables: harness.updateVariables, readMessage };
}

function planIdentities(plan: ConfirmedShotRestorePlanEntry[]): unknown {
  return plan.map(entry => entry.identity);
}

function keptPaths(report: { kept: Array<{ entry: ConfirmedShotEntry }> }): string[] {
  return report.kept.map(item => item.entry.path);
}

/** Run an action while capturing console output and counting its lines. */
function captureConsole(action: () => void): { output: string; infoCount: number; warnCount: number } {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  let output = '';
  let infoCount = 0;
  let warnCount = 0;
  console.info = (...parts: unknown[]) => {
    infoCount += 1;
    output += `${parts.map(String).join(' ')}\n`;
  };
  console.warn = (...parts: unknown[]) => {
    warnCount += 1;
    output += `${parts.map(String).join(' ')}\n`;
  };
  try {
    action();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  return { output, infoCount, warnCount };
}

equal(
  confirmedShotImageUrl('/user/images/杠杠の生图机/chat-1_3_0_1.png'),
  '/user/images/杠杠の生图机/chat-1_3_0_1.png',
  '服务器返回的带根路径应原样作为图片 URL',
);
equal(
  confirmedShotImageUrl('杠杠の生图机/chat-1_3_0_1.png'),
  '/user/images/杠杠の生图机/chat-1_3_0_1.png',
  '专用文件夹内的相对路径应补全 user images 根路径',
);
equal(confirmedShotImageUrl('/user/images/其他文件夹/x.png'), null, '专用文件夹之外的路径不应生成图片 URL');
equal(confirmedShotImageUrl('/user/images/杠杠の生图机/../secret.png'), null, '包含 .. 穿越的路径不应生成图片 URL');
equal(confirmedShotImageUrl('杠杠の生图机'), null, '缺少文件名的路径不应生成图片 URL');
equal(confirmedShotImageUrl('   '), null, '空白路径不应生成图片 URL');

function run(): void {
  // 整个恢复模块不发任何网络请求：恢复阶段绝不删服务器文件（简报 §4.4/§4.5）。
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error('恢复阶段不应发起网络请求');
  };
  try {
    runRestoreCases(fetchCalls);
  } finally {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  }
  console.info('<杠杠の生图机> story image restore tests passed');
}

function runRestoreCases(fetchCalls: unknown[]): void {
  // 有效身份恢复：条目应生成完整恢复计划数据，索引不动、不发请求。
  const validHarness = createVariableHarness(
    seedIndex({
      [CHAT]: [
        { ...makeEntry(3, 0, 0, '杠杠の生图机/chat_3_0_0.png'), shotPrompt: '一只坐在窗边的猫' },
        makeEntry(5, 1, 1, '/user/images/杠杠の生图机/chat_5_1_1.png'),
      ],
      'chat-other': [makeEntry(1, 0, 0, '杠杠の生图机/other.png')],
    }),
  );
  const validVisited: number[] = [];
  const validReport = planConfirmedShotRestore(
    chatOptions(
      validHarness,
      messageTable({ 3: assistantMessage(0, 2), 5: assistantMessage(1, 3), 1: assistantMessage(0, 1) }, validVisited),
    ),
  );
  equal(validReport.chatId, CHAT, '恢复报告应携带当前聊天标识');
  equal(validReport.lastError, null, '有效恢复不应报错');
  equal(validReport.pruned, [], '有效身份不应剪除任何条目');
  equal(validReport.kept, [], '有效身份不应有条目被搁置');
  equal(
    planIdentities(validReport.plan),
    [
      { chatId: CHAT, messageId: 3, swipeId: 0, imageIndex: 0 },
      { chatId: CHAT, messageId: 5, swipeId: 1, imageIndex: 1 },
    ],
    '恢复计划应携带完整页面内存身份',
  );
  equal(
    validReport.plan.map(entry => entry.url),
    ['/user/images/杠杠の生图机/chat_3_0_0.png', '/user/images/杠杠の生图机/chat_5_1_1.png'],
    '恢复计划应把索引路径解析为可加载的图片 URL',
  );
  equal(validReport.plan[0]?.shotPrompt, '一只坐在窗边的猫', '恢复计划应保留镜头提示词');
  equal(validReport.plan[0]?.confirmedAt, TEST_NOW, '恢复计划应保留确认时间');
  equal(validReport.plan[0]?.filename, 'shot_3_0_0.png', '恢复计划应保留文件名');
  equal(validReport.plan[1]?.shotPrompt, undefined, '无提示词条目不应虚构提示词');
  equal(validHarness.state.writes, 0, '无失效条目时不得写索引变量');
  equal(fetchCalls.length, 0, '有效恢复不应发起任何网络请求');
  assert(
    !JSON.stringify(validReport).includes('data:image') && !JSON.stringify(validReport).includes('base64'),
    '恢复计划不得携带图片数据',
  );
  assert(JSON.stringify(validHarness.state.variables).includes('"other":"keep"'), '恢复不得动脚本变量的其他键');

  // 失效条目剪除且不删服务器文件：楼没了、变成玩家楼层、Swipe 越界、身份字段损坏。
  const dirtyHarness = createVariableHarness(
    seedIndex({
      [CHAT]: [
        makeEntry(7, 0, 0, '杠杠の生图机/gone-floor.png'), // 楼层不存在
        makeEntry(8, 0, 0, '杠杠の生图机/user-floor.png'), // 现在是玩家楼层
        makeEntry(9, 3, 0, '杠杠の生图机/swipe-gone.png'), // Swipe 已不存在
        makeEntry(10, 0, -1, '杠杠の生图机/negative.png'), // 身份字段损坏
        makeEntry(11, 0, 1, '杠杠の生图机/inactive.png'), // Swipe 仍存在但未显示 → 保留
        makeEntry(12, 1, 0, '杠杠の生图机/alive.png'), // 有效
        { ...makeEntry(13, 0, 0, '杠杠の生图机/dead-dup.png'), imageIndex: 0, messageId: 7 }, // 同身份重复损坏条目
      ],
    }),
  );
  const dirtyVisited: number[] = [];
  const dirtyReport = planConfirmedShotRestore(
    chatOptions(
      dirtyHarness,
      messageTable(
        {
          8: { role: 'user', swipeId: 0, swipeCount: 1 },
          9: assistantMessage(0, 3),
          11: assistantMessage(1, 2),
          12: assistantMessage(1, 2),
        },
        dirtyVisited,
      ),
    ),
  );
  equal(
    dirtyReport.pruned.map(entry => entry.path),
    [
      '杠杠の生图机/gone-floor.png',
      '杠杠の生图机/user-floor.png',
      '杠杠の生图机/swipe-gone.png',
      '杠杠の生图机/negative.png',
      '杠杠の生图机/dead-dup.png',
    ],
    '失效条目应从索引剪除并逐条返回',
  );
  equal(
    planIdentities(dirtyReport.plan),
    [{ chatId: CHAT, messageId: 12, swipeId: 1, imageIndex: 0 }],
    '剪除后有效条目仍应进入恢复计划',
  );
  equal(keptPaths(dirtyReport), ['杠杠の生图机/inactive.png'], 'Swipe 仍存在的未显示条目应保留在索引中');
  equal(dirtyReport.kept[0]?.reason, 'inactive-swipe', '未显示 Swipe 的搁置原因应可审计');
  equal(dirtyHarness.state.writes, 1, '失效条目剪除应只写一次索引');
  const dirtyAfter = readConfirmedShotIndex({ readVariables: dirtyHarness.readVariables });
  equal(
    getChatConfirmedShots(dirtyAfter, CHAT).map(entry => entry.path),
    ['杠杠の生图机/inactive.png', '杠杠の生图机/alive.png'],
    '剪除后索引应只剩保留与有效条目',
  );
  equal(fetchCalls.length, 0, '剪除失效条目绝不发起服务器文件删除请求');

  // 负数 messageId 不得进入楼层查询：getChatMessages 的负数是深度语义，会造成假阳性。
  const negativeHarness = createVariableHarness(
    seedIndex({ [CHAT]: [{ ...makeEntry(7, 0, 0, '杠杠の生图机/x.png'), messageId: -1 }] }),
  );
  const negativeVisited: number[] = [];
  const negativeReport = planConfirmedShotRestore(
    chatOptions(negativeHarness, messageTable({ 0: assistantMessage(0, 1) }, negativeVisited)),
  );
  equal(negativeReport.pruned.length, 1, '负数 messageId 的损坏条目应剪除');
  assert(!negativeVisited.includes(-1), '负数 messageId 不得传入楼层查询');

  // 当前 Swipe 缺失时按运行时同款回退为 0。
  const fallbackHarness = createVariableHarness(
    seedIndex({ [CHAT]: [makeEntry(3, 0, 0, '杠杠の生图机/fallback.png')] }),
  );
  const fallbackReport = planConfirmedShotRestore(
    chatOptions(fallbackHarness, () => ({ role: 'assistant', swipeId: 0, swipeCount: 1 })),
  );
  equal(fallbackReport.plan.length, 1, '无显式 Swipe 数据的楼层应按运行时回退语义恢复 swipe 0');

  // 路径不在专用文件夹内：不恢复、不剪除、仅警告并保留索引。
  const outsideHarness = createVariableHarness(
    seedIndex({ [CHAT]: [makeEntry(3, 0, 0, '/user/images/其他文件夹/x.png')] }),
  );
  const outsideCapture = captureConsole(() => {
    const outsideReport = planConfirmedShotRestore(chatOptions(outsideHarness, () => assistantMessage(0, 1)));
    equal(outsideReport.plan, [], '专用文件夹之外的路径不得进入恢复计划');
    equal(outsideReport.pruned, [], '路径可疑的条目不得剪除（绝不删服务器文件）');
    equal(keptPaths(outsideReport), ['/user/images/其他文件夹/x.png'], '路径可疑条目应保留在索引中');
    equal(outsideReport.kept[0]?.reason, 'unrestorable-path', '路径可疑的搁置原因应可审计');
  });
  assert(outsideCapture.warnCount > 0, '路径可疑应留下警告');
  assert(
    !outsideCapture.output.includes('其他文件夹') && !outsideCapture.output.includes('x.png'),
    '警告不得包含图片路径',
  );
  equal(outsideHarness.state.writes, 0, '路径可疑条目保留时不得写索引');

  // 消息读取抛错：整次恢复放弃，不剪除、不计划、不写索引。
  const throwingHarness = createVariableHarness(
    seedIndex({ [CHAT]: [makeEntry(3, 0, 0, '杠杠の生图机/a.png'), makeEntry(99, 0, 0, '杠杠の生图机/b.png')] }),
  );
  const throwingCapture = captureConsole(() => {
    const throwingReport = planConfirmedShotRestore({
      chatId: CHAT,
      readVariables: throwingHarness.readVariables,
      updateVariables: throwingHarness.updateVariables,
      readMessage: messageId => {
        if (messageId === 3) throw new Error('getChatMessages exploded');
        return assistantMessage(0, 1);
      },
    });
    equal(throwingReport.plan, [], '校验失败时不得给出恢复计划');
    equal(throwingReport.pruned, [], '校验失败时不得剪除');
    equal(throwingReport.kept, [], '校验失败时不得给搁置清单');
    assert(throwingReport.lastError !== null, '校验失败应留下有界错误消息');
    assert(!String(throwingReport.lastError).includes('exploded'), '错误消息不得包含底层异常细节');
  });
  equal(throwingHarness.state.writes, 0, '校验失败不得写索引');
  assert(throwingCapture.warnCount > 0, '校验失败应留下警告');

  // 索引读取失败：空报告 + 有界错误，不写索引。
  let readFailUpdated = 0;
  const readFailCapture = captureConsole(() => {
    const readFailReport = planConfirmedShotRestore({
      chatId: CHAT,
      readVariables: () => {
        throw new Error('变量表不可用');
      },
      updateVariables: updater => {
        readFailUpdated += 1;
        return updater({});
      },
      readMessage: () => assistantMessage(0, 1),
    });
    equal(readFailReport.plan, [], '索引读取失败应返回空计划');
    equal(readFailReport.pruned, [], '索引读取失败不得剪除');
    assert(readFailReport.lastError !== null, '索引读取失败应留下有界错误消息');
  });
  equal(readFailUpdated, 0, '索引读取失败不得写索引');
  assert(readFailCapture.warnCount > 0, '索引读取失败应留下警告');

  // 剪除写回失败：恢复计划仍应返回，聊天不受影响。
  const pruneFailHarness = createVariableHarness(
    seedIndex({
      [CHAT]: [makeEntry(7, 0, 0, '杠杠の生图机/gone.png'), makeEntry(3, 0, 0, '杠杠の生图机/alive.png')],
    }),
  );
  const pruneFailCapture = captureConsole(() => {
    const pruneFailReport = planConfirmedShotRestore({
      chatId: CHAT,
      readVariables: pruneFailHarness.readVariables,
      updateVariables: () => {
        throw new Error('写回失败');
      },
      readMessage: messageTable({ 3: assistantMessage(0, 1) }),
    });
    equal(
      planIdentities(pruneFailReport.plan),
      [{ chatId: CHAT, messageId: 3, swipeId: 0, imageIndex: 0 }],
      '剪除失败不得阻塞恢复计划',
    );
    equal(pruneFailReport.pruned, [], '剪除失败时无剪除结果');
    assert(pruneFailReport.lastError !== null, '剪除失败应留下有界错误消息');
  });
  assert(pruneFailCapture.warnCount > 0, '剪除失败应留下警告');

  // 空聊天与无索引聊天：空报告、零写入、零请求。
  const emptyHarness = createVariableHarness(seedIndex({ 'chat-other': [makeEntry(1, 0, 0, '杠杠の生图机/a.png')] }));
  const emptyReport = planConfirmedShotRestore(chatOptions(emptyHarness, () => assistantMessage(0, 1)));
  equal(emptyReport.plan, [], '无索引聊天应返回空计划');
  equal(emptyReport.lastError, null, '无索引聊天不是错误');
  equal(emptyHarness.state.writes, 0, '无索引聊天不得写索引');
  const blankIdReport = planConfirmedShotRestore({
    ...chatOptions(emptyHarness, () => assistantMessage(0, 1)),
    chatId: '   ',
  });
  equal(blankIdReport.plan, [], '空白聊天标识应返回空计划');

  // 恢复日志只含计数，不得携带聊天标识或路径。
  const logHarness = createVariableHarness(
    seedIndex({
      [CHAT]: [makeEntry(7, 0, 0, '杠杠の生图机/gone.png'), makeEntry(3, 0, 0, '杠杠の生图机/secret-name.png')],
    }),
  );
  const logCapture = captureConsole(() => {
    planConfirmedShotRestore(chatOptions(logHarness, messageTable({ 3: assistantMessage(0, 1) })));
  });
  assert(logCapture.infoCount > 0, '恢复应留下脚本前缀的运行记录');
  assert(logCapture.output.includes('<杠杠の生图机>'), '恢复日志必须带 <杠杠の生图机> 前缀');
  assert(
    !logCapture.output.includes('gone.png') &&
      !logCapture.output.includes('secret-name.png') &&
      !logCapture.output.includes(CHAT),
    '恢复日志不得包含图片路径或聊天标识',
  );

  // 生产默认连线：默认 chatId / 楼层读取 / 变量表全部来自酒馆全局。
  const defaultHarness = createVariableHarness(
    seedIndex({ 'chat-default': [makeEntry(3, 0, 0, '杠杠の生图机/default.png')] }),
  );
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const previousGlobals = {
    SillyTavern: globalScope.SillyTavern,
    getChatMessages: globalScope.getChatMessages,
    getVariables: globalScope.getVariables,
    getScriptId: globalScope.getScriptId,
    updateVariablesWith: globalScope.updateVariablesWith,
  };
  globalScope.SillyTavern = { getCurrentChatId: () => 'chat-default' };
  globalScope.getChatMessages = (messageId: number) =>
    messageId === 3 ? [{ role: 'assistant', swipe_id: 0, swipes: ['一', '二'] }] : [];
  globalScope.getScriptId = () => 'script-test';
  globalScope.getVariables = defaultHarness.readVariables;
  globalScope.updateVariablesWith = (updater: (variables: Record<string, unknown>) => Record<string, unknown>) => {
    defaultHarness.state.writes += 1;
    defaultHarness.state.variables = updater(defaultHarness.state.variables);
    return defaultHarness.state.variables;
  };
  try {
    const defaultReport = planConfirmedShotRestore();
    equal(defaultReport.chatId, 'chat-default', '默认应取当前聊天标识');
    equal(
      planIdentities(defaultReport.plan),
      [{ chatId: 'chat-default', messageId: 3, swipeId: 0, imageIndex: 0 }],
      '默认连线应按当前聊天生成恢复计划',
    );
    equal(defaultHarness.state.writes, 0, '默认连线无失效条目时不得写索引');

    // 当前 Swipe 来自 swipe_id 字段；swipeId 1 的条目在显示第 2 页时应保留。
    globalScope.getChatMessages = () => [{ role: 'assistant', swipe_id: 1, swipes: ['一', '二'] }];
    const defaultHarness2 = createVariableHarness(
      seedIndex({
        'chat-default': [makeEntry(3, 0, 0, '杠杠の生图机/behind.png'), makeEntry(3, 1, 0, '杠杠の生图机/current.png')],
      }),
    );
    globalScope.getVariables = defaultHarness2.readVariables;
    globalScope.updateVariablesWith = (updater: (variables: Record<string, unknown>) => Record<string, unknown>) => {
      defaultHarness2.state.writes += 1;
      defaultHarness2.state.variables = updater(defaultHarness2.state.variables);
      return defaultHarness2.state.variables;
    };
    const defaultReport2 = planConfirmedShotRestore();
    equal(
      planIdentities(defaultReport2.plan),
      [{ chatId: 'chat-default', messageId: 3, swipeId: 1, imageIndex: 0 }],
      '默认连线应只恢复当前显示的 Swipe',
    );
    equal(keptPaths(defaultReport2), ['杠杠の生图机/behind.png'], '未显示 Swipe 的条目应保留并给出原因');
    equal(defaultReport2.kept[0]?.reason, 'inactive-swipe', '未显示 Swipe 的原因应可审计');
  } finally {
    globalScope.SillyTavern = previousGlobals.SillyTavern;
    globalScope.getChatMessages = previousGlobals.getChatMessages;
    globalScope.getVariables = previousGlobals.getVariables;
    globalScope.getScriptId = previousGlobals.getScriptId;
    globalScope.updateVariablesWith = previousGlobals.updateVariablesWith;
  }
}

run();
