import {
  CONFIRMED_SHOT_FOLDER_NAME,
  CONFIRMED_SHOT_STORAGE_KEY,
  pruneConfirmedShots,
  readConfirmedShotIndex,
  uploadConfirmedShot,
  type ConfirmedShotEntry,
} from '../src/杠杠の生图机/shot-storage';
import {
  executeConfirmedShotRemoval,
  resolveConfirmedShotRemovalAction,
  trackConfirmedShotUpload,
  type ConfirmedShotRemovalReason,
} from '../src/杠杠の生图机/delete-sync';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
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
  return {
    [CONFIRMED_SHOT_STORAGE_KEY]: { version: 1, chats },
    other: 'keep',
  };
}

const TEST_NOW = 1_700_000_000_000;
const FOLDER_PATH_PREFIX = `/user/images/${CONFIRMED_SHOT_FOLDER_NAME}/`;
const PNG_DATA_URL = 'data:image/png;base64, YWJj';

/** Run an action while capturing console.warn output for assertions. */
async function captureWarn(action: () => Promise<void>): Promise<string> {
  const originalWarn = console.warn;
  let captured = '';
  console.warn = (message?: unknown) => {
    captured += `${String(message)}\n`;
  };
  try {
    await action();
  } finally {
    console.warn = originalWarn;
  }
  return captured;
}

function shotOptions(
  harness: VariableHarness,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
) {
  return {
    readVariables: harness.readVariables,
    updateVariables: harness.updateVariables,
    getRequestHeaders: () => ({}),
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init),
  };
}

function chatPaths(harness: VariableHarness, chatId: string): string[] {
  return readConfirmedShotIndex({ readVariables: harness.readVariables }).chats[chatId]?.shots.map(
    entry => entry.path,
  ) ?? [];
}

async function run(): Promise<void> {
  // ---- resolveConfirmedShotRemovalAction:纯判定语义 ----
  const resolveIndex = readConfirmedShotIndex({
    readVariables: () =>
      seedIndex({
        'chat-1': [makeEntry(1, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png`)],
        'chat-2': [makeEntry(3, 1, 0, `${FOLDER_PATH_PREFIX}chat-2_3_1_0.png`)],
      }),
  });
  const identity = { messageId: 1, swipeId: 0, imageIndex: 0 };
  const removal = resolveConfirmedShotRemovalAction('chat-1', identity, 'message-deleted', resolveIndex);
  equal(removal.kind, 'delete-server-file', '索引中存在已确认条目时应判定为删除动作');
  assert(removal.kind === 'delete-server-file', '删除动作应携带条目');
  equal(removal.entry.path, `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png`, '删除动作应携带索引条目');
  equal(removal.reason, 'message-deleted', '删除动作应保留触发原因');

  equal(
    resolveConfirmedShotRemovalAction('chat-1', { messageId: 9, swipeId: 0, imageIndex: 0 }, 'image-removed', resolveIndex)
      .kind,
    'none',
    '未确认镜头身份应判定为 none',
  );
  equal(
    resolveConfirmedShotRemovalAction('chat-9', identity, 'shot-abandoned', resolveIndex).kind,
    'none',
    '其他聊天的条目不得影响本聊天判定',
  );
  equal(
    resolveConfirmedShotRemovalAction('   ', identity, 'message-deleted', resolveIndex).kind,
    'none',
    '缺少聊天标识时应判定为 none',
  );
  for (const reason of [
    'message-deleted',
    'swipe-deleted',
    'image-removed',
    'shot-abandoned',
  ] as ConfirmedShotRemovalReason[]) {
    equal(
      resolveConfirmedShotRemovalAction('chat-2', { messageId: 3, swipeId: 1, imageIndex: 0 }, reason, resolveIndex)
        .kind,
      'delete-server-file',
      `四种生命周期原因（${reason}）都应沿用同一判定语义`,
    );
  }

  // ---- 删楼 → delete ----
  const messageDeletedHarness = createVariableHarness(
    seedIndex({
      'chat-1': [
        makeEntry(1, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png`),
        makeEntry(5, 0, 1, `${FOLDER_PATH_PREFIX}chat-1_5_0_1.png`),
      ],
      'chat-2': [makeEntry(1, 0, 0, `${FOLDER_PATH_PREFIX}chat-2_1_0_0.png`)],
    }),
  );
  let messageDeletedCalls = 0;
  let messageDeletedBody: Record<string, unknown> | null = null;
  const messageDeletedOutcome = await executeConfirmedShotRemoval(
    'chat-1',
    { messageId: 1, swipeId: 0, imageIndex: 0 },
    'message-deleted',
    shotOptions(messageDeletedHarness, (input, init) => {
      messageDeletedCalls += 1;
      assert(input === '/api/images/delete', '删楼同步应请求 SillyTavern 图片删除端点');
      equal(init?.method, 'POST', '删楼同步应使用 POST');
      messageDeletedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(null);
    }),
  );
  equal(messageDeletedCalls, 1, '删楼同步应只请求一次，失败也不重试');
  equal(
    messageDeletedBody,
    { path: `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png` },
    '删楼同步应把索引中的路径原样回传给删除端点',
  );
  equal(messageDeletedOutcome.status, 'deleted', '删楼同步成功应报告 deleted');
  equal(messageDeletedOutcome.warning, null, '删楼同步成功不应产生警告');
  equal(messageDeletedOutcome.reason, 'message-deleted', '结果应保留触发原因');
  equal(
    chatPaths(messageDeletedHarness, 'chat-1'),
    [`${FOLDER_PATH_PREFIX}chat-1_5_0_1.png`],
    '删楼同步应剪除该镜头的索引条目并保留同聊天其他条目',
  );
  equal(
    chatPaths(messageDeletedHarness, 'chat-2').length,
    1,
    '删楼同步不得影响其他聊天的索引条目',
  );
  equal(messageDeletedHarness.state.variables.other, 'keep', '索引剪除不得动脚本变量的其他键');

  // ---- × 删除已确认图 → delete ----
  const imageRemovedHarness = createVariableHarness(
    seedIndex({ 'chat-1': [makeEntry(2, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_2_0_0.png`)] }),
  );
  let imageRemovedCalls = 0;
  const imageRemovedOutcome = await executeConfirmedShotRemoval(
    'chat-1',
    { messageId: 2, swipeId: 0, imageIndex: 0 },
    'image-removed',
    shotOptions(imageRemovedHarness, () => {
      imageRemovedCalls += 1;
      return response(null);
    }),
  );
  equal(imageRemovedCalls, 1, '× 删除已确认图应同步删除服务器文件');
  equal(imageRemovedOutcome.status, 'deleted', '× 删除成功应报告 deleted');
  equal(chatPaths(imageRemovedHarness, 'chat-1'), [], '× 删除后该聊天的索引条目应被剪除');
  assert(
    !('chat-1' in readConfirmedShotIndex({ readVariables: imageRemovedHarness.readVariables }).chats),
    '最后一条被剪除后应移除聊天键',
  );

  // ---- Swipe 覆盖 / 放弃已确认镜头 → delete ----
  for (const [reason, messageId] of [
    ['swipe-deleted', 3],
    ['shot-abandoned', 4],
  ] as Array<[ConfirmedShotRemovalReason, number]>) {
    const lifecycleHarness = createVariableHarness(
      seedIndex({ 'chat-1': [makeEntry(messageId, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_${messageId}_0_0.png`)] }),
    );
    let lifecycleCalls = 0;
    const lifecycleOutcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId, swipeId: 0, imageIndex: 0 },
      reason,
      shotOptions(lifecycleHarness, () => {
        lifecycleCalls += 1;
        return response(null);
      }),
    );
    equal(lifecycleCalls, 1, `${reason} 应同步删除服务器文件`);
    equal(lifecycleOutcome.status, 'deleted', `${reason} 成功应报告 deleted`);
    equal(lifecycleOutcome.reason, reason, `${reason} 结果应保留触发原因`);
    equal(chatPaths(lifecycleHarness, 'chat-1'), [], `${reason} 后索引条目应被剪除`);
  }

  // ---- 删除失败 → 仅警告（HTTP 500）----
  const failedDeleteHarness = createVariableHarness(
    seedIndex({ 'chat-1': [makeEntry(6, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_6_0_0.png`)] }),
  );
  let failedDeleteCalls = 0;
  const failedDeleteWarn = await captureWarn(async () => {
    const outcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId: 6, swipeId: 0, imageIndex: 0 },
      'message-deleted',
      shotOptions(failedDeleteHarness, () => {
        failedDeleteCalls += 1;
        return response('server said /api/images/delete chat-1_6_0_0.png failed', 500);
      }),
    );
    equal(outcome.status, 'index-pruned', '删除失败应报告 index-pruned');
    assert(outcome.warning !== null, '删除失败应产出有界警告供审计记录');
  });
  equal(failedDeleteCalls, 1, '删除失败不得重试');
  equal(chatPaths(failedDeleteHarness, 'chat-1'), [], '删除失败时索引剪除应保持生效（先剪后删）');
  assert(failedDeleteWarn.includes('<杠杠の生图机>'), '删除失败警告应带脚本前缀');
  assert(
    !failedDeleteWarn.includes('chat-1') &&
      !failedDeleteWarn.includes('/api/images') &&
      !failedDeleteWarn.includes('.png'),
    '删除失败警告不得包含图片路径或端点',
  );

  // ---- 删除失败 → 仅警告（网络异常）----
  const networkFailedHarness = createVariableHarness(
    seedIndex({ 'chat-1': [makeEntry(7, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_7_0_0.png`)] }),
  );
  let networkFailedCalls = 0;
  const networkFailedWarn = await captureWarn(async () => {
    const outcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId: 7, swipeId: 0, imageIndex: 0 },
      'image-removed',
      shotOptions(networkFailedHarness, () => {
        networkFailedCalls += 1;
        throw new TypeError('Failed to fetch https://192.168.1.5:8000/api/images/delete');
      }),
    );
    equal(outcome.status, 'index-pruned', '网络异常应报告 index-pruned');
    assert(outcome.warning !== null && outcome.warning.length <= 240, '网络异常警告应有界');
  });
  equal(networkFailedCalls, 1, '网络异常不得重试');
  equal(chatPaths(networkFailedHarness, 'chat-1'), [], '网络异常时索引剪除应保持生效');
  assert(networkFailedWarn.includes('<杠杠の生图机>'), '网络异常警告应带脚本前缀');
  assert(!networkFailedWarn.includes('192.168.1.5'), '网络异常警告不得泄露请求地址');

  // ---- 服务器文件已不存在（404）按删除成功处理 ----
  const missingFileHarness = createVariableHarness(
    seedIndex({ 'chat-1': [makeEntry(8, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_8_0_0.png`)] }),
  );
  let missingFileCalls = 0;
  const missingFileWarn = await captureWarn(async () => {
    const outcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId: 8, swipeId: 0, imageIndex: 0 },
      'shot-abandoned',
      shotOptions(missingFileHarness, () => {
        missingFileCalls += 1;
        return response(null, 404);
      }),
    );
    equal(outcome.status, 'deleted', '404 已是请求的终态，应按删除成功处理');
    equal(outcome.warning, null, '404 不应产生警告');
  });
  equal(missingFileCalls, 1, '404 场景仍应恰好请求一次');
  equal(missingFileWarn, '', '404 场景不应输出警告');

  // ---- 无已确认条目：不触碰服务器、不写索引 ----
  const noEntryHarness = createVariableHarness(seedIndex({ 'chat-1': [] }));
  let noEntryCalls = 0;
  const noEntryBefore = noEntryHarness.state.variables;
  const noEntryOutcome = await executeConfirmedShotRemoval(
    'chat-1',
    { messageId: 1, swipeId: 0, imageIndex: 0 },
    'message-deleted',
    shotOptions(noEntryHarness, () => {
      noEntryCalls += 1;
      return response(null);
    }),
  );
  equal(noEntryOutcome.status, 'none', '没有已确认条目时应报告 none');
  equal(noEntryCalls, 0, '未确认镜头的移除不得发起删除请求');
  assert(noEntryHarness.state.variables === noEntryBefore, 'none 结果不得写脚本变量');

  // ---- 防误删：恢复阶段的失配路径绝不删除服务器文件 ----
  // 恢复流程按简报 §4.4 只使用 pruneConfirmedShots 剪除失效条目（不触碰服务器）；
  // 此处证明剪除后即使再调用删除同步，也不会把恢复失配放大成服务器删除。
  const restoreMismatchHarness = createVariableHarness(
    seedIndex({
      'chat-1': [makeEntry(1, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png`)],
    }),
  );
  let restoreMismatchCalls = 0;
  const restoreMismatchWarn = await captureWarn(async () => {
    // 身份失配（消息前移后 messageId 变化）→ 仅剪索引，无删除请求。
    pruneConfirmedShots(
      'chat-1',
      entry => entry.messageId !== 1,
      { readVariables: restoreMismatchHarness.readVariables, updateVariables: restoreMismatchHarness.updateVariables },
    );
    const outcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId: 1, swipeId: 0, imageIndex: 0 },
      'message-deleted',
      shotOptions(restoreMismatchHarness, () => {
        restoreMismatchCalls += 1;
        return response(null);
      }),
    );
    equal(outcome.status, 'none', '恢复失配剪除后的镜头不得再触发服务器删除');
  });
  equal(restoreMismatchCalls, 0, '恢复失配路径不得发起删除请求');
  equal(restoreMismatchWarn, '', '恢复失配路径不应产生警告');
  assert(!restoreMismatchWarn.includes('user/images'), '恢复失配路径不得输出任何路径信息');
  // 纯判定层同样安全：对恢复失配后的索引做判定只能得到 none。
  equal(
    resolveConfirmedShotRemovalAction(
      'chat-1',
      { messageId: 1, swipeId: 0, imageIndex: 0 },
      'message-deleted',
      readConfirmedShotIndex({ readVariables: restoreMismatchHarness.readVariables }),
    ).kind,
    'none',
    '恢复剪除后的索引不应再产生删除动作',
  );

  // ---- 防误删：索引无法安全解读时保留服务器文件 ----
  const foreignVersionHarness = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: {
      version: 2,
      chats: { 'chat-1': { shots: [makeEntry(1, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png`)] } },
    },
    other: 'keep',
  });
  let foreignVersionCalls = 0;
  const foreignVersionWarn = await captureWarn(async () => {
    const outcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId: 1, swipeId: 0, imageIndex: 0 },
      'message-deleted',
      shotOptions(foreignVersionHarness, () => {
        foreignVersionCalls += 1;
        return response(null);
      }),
    );
    equal(outcome.status, 'blocked', '索引版本不受支持时应阻止删除');
    assert(outcome.warning !== null, '阻止删除应产出警告供审计记录');
  });
  equal(foreignVersionCalls, 0, '索引不可解读时不得发起删除请求');
  equal(
    JSON.stringify(foreignVersionHarness.state.variables[CONFIRMED_SHOT_STORAGE_KEY]).includes('"version":2'),
    true,
    '索引不可解读时原始数据必须原样保留',
  );
  assert(foreignVersionWarn.includes('<杠杠の生图机>'), '阻止删除警告应带脚本前缀');
  assert(!foreignVersionWarn.includes('chat-1') && !foreignVersionWarn.includes('.png'), '阻止删除警告不得包含图片路径');

  // ---- 防误删：变量写入失败时保留服务器文件 ----
  const brokenWriteHarness = createVariableHarness(
    seedIndex({ 'chat-1': [makeEntry(1, 0, 0, `${FOLDER_PATH_PREFIX}chat-1_1_0_0.png`)] }),
  );
  let brokenWriteCalls = 0;
  const brokenWriteWarn = await captureWarn(async () => {
    const outcome = await executeConfirmedShotRemoval(
      'chat-1',
      { messageId: 1, swipeId: 0, imageIndex: 0 },
      'image-removed',
      {
        readVariables: brokenWriteHarness.readVariables,
        updateVariables: () => {
          throw new Error('variable write refused');
        },
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          brokenWriteCalls += 1;
          return response(null);
        },
      },
    );
    equal(outcome.status, 'blocked', '变量写入失败时应阻止删除');
    assert(outcome.warning !== null && !outcome.warning.includes('user/images'), '阻止删除警告应有界且不含路径');
  });
  equal(brokenWriteCalls, 0, '变量写入失败时不得发起删除请求');
  assert(brokenWriteWarn.includes('<杠杠の生图机>'), '变量写入失败警告应带脚本前缀');
  equal(chatPaths(brokenWriteHarness, 'chat-1').length, 1, '变量写入失败时索引条目应原样保留');

  // ---- 缺少聊天标识：直接 no-op ----
  let missingChatCalls = 0;
  const missingChatOutcome = await executeConfirmedShotRemoval(
    '   ',
    { messageId: 1, swipeId: 0, imageIndex: 0 },
    'message-deleted',
    shotOptions(createVariableHarness(), () => {
      missingChatCalls += 1;
      return response(null);
    }),
  );
  equal(missingChatOutcome.status, 'none', '缺少聊天标识时应报告 none');
  equal(missingChatCalls, 0, '缺少聊天标识时不得发起删除请求');

  // ---- 竞态修复：确认上传在途时删除同镜头，必须等待上传落定后再判定 ----
  const settle = async (ticks = 8): Promise<void> => {
    for (let index = 0; index < ticks; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0));
  };
  const raceHarness = createVariableHarness({ other: 'keep' });
  let raceUploadCalls = 0;
  let releaseRaceUpload: () => void = () => undefined;
  const raceUploadGate = new Promise<void>(resolve => {
    releaseRaceUpload = resolve;
  });
  const raceIdentity = { messageId: 2, swipeId: 0, imageIndex: 0 };
  // 模拟确认接线：上传在途且经 trackConfirmedShotUpload 注册。
  const raceUpload = uploadConfirmedShot(
    { identity: { chatId: 'chat-1', ...raceIdentity }, dataUrl: PNG_DATA_URL },
    {
      readVariables: raceHarness.readVariables,
      updateVariables: raceHarness.updateVariables,
      getRequestHeaders: () => ({}),
      fetchImpl: async input => {
        raceUploadCalls += 1;
        if (String(input) === '/api/images/upload') await raceUploadGate;
        return response({ path: `${FOLDER_PATH_PREFIX}chat-1_2_0_0.png` });
      },
    },
  );
  trackConfirmedShotUpload('chat-1', raceIdentity, raceUpload);
  await settle();
  equal(raceUploadCalls, 1, '受控上传应已发出请求并停在挂起状态');

  let raceDeleteCalls = 0;
  const raceRemoval = executeConfirmedShotRemoval(
    'chat-1',
    raceIdentity,
    'image-removed',
    shotOptions(raceHarness, input => {
      if (String(input) === '/api/images/delete') raceDeleteCalls += 1;
      return response(null);
    }),
  );
  await settle();
  equal(raceDeleteCalls, 0, '上传在途时删除不得抢先执行（此刻索引尚无条目）');
  releaseRaceUpload();
  const raceOutcome = await raceRemoval;
  equal(raceOutcome.status, 'deleted', '等待在途上传落定后应完成删除');
  equal(raceDeleteCalls, 1, '删除同步应在上传写入索引后恰好发起一次删除请求');
  equal(chatPaths(raceHarness, 'chat-1'), [], '复活竞态修复：上传写入的条目应随删除被剪除');
  equal(raceHarness.state.variables.other, 'keep', '竞态路径不得动脚本变量的其他键');

  // 上传落定并删除后，再次删除同一身份应立即 no-op（注册表自清、条目已剪）。
  let againCalls = 0;
  const againOutcome = await executeConfirmedShotRemoval(
    'chat-1',
    raceIdentity,
    'image-removed',
    shotOptions(raceHarness, () => {
      againCalls += 1;
      return response(null);
    }),
  );
  equal(againOutcome.status, 'none', '条目已剪除且无在途上传时应报告 none');
  equal(againCalls, 0, 'no-op 删除不得发起请求');

  // 上传失败：等待落定后索引仍无条目，二次判定为 none，不发起删除。
  const failedUploadHarness = createVariableHarness();
  const failedUploadIdentity = { messageId: 3, swipeId: 0, imageIndex: 0 };
  const failedUpload = uploadConfirmedShot(
    { identity: { chatId: 'chat-1', ...failedUploadIdentity }, dataUrl: PNG_DATA_URL },
    {
      readVariables: failedUploadHarness.readVariables,
      updateVariables: failedUploadHarness.updateVariables,
      getRequestHeaders: () => ({}),
      fetchImpl: async () => response('upload rejected', 500),
    },
  );
  trackConfirmedShotUpload('chat-1', failedUploadIdentity, failedUpload);
  let failedUploadDeleteCalls = 0;
  const failedUploadRemoval = await executeConfirmedShotRemoval(
    'chat-1',
    failedUploadIdentity,
    'message-deleted',
    shotOptions(failedUploadHarness, () => {
      failedUploadDeleteCalls += 1;
      return response(null);
    }),
  );
  equal(failedUploadRemoval.status, 'none', '上传失败不写索引，删除等待后应为 none');
  equal(failedUploadDeleteCalls, 0, '上传失败路径不得发起删除请求');
  equal(chatPaths(failedUploadHarness, 'chat-1'), [], '上传失败后索引应保持为空');

  // 并发双删除同身份：共享同一次等待，只有先到者删除，请求恰好一次。
  const concurrentHarness = createVariableHarness();
  const concurrentIdentity = { messageId: 4, swipeId: 0, imageIndex: 0 };
  const concurrentUpload = uploadConfirmedShot(
    { identity: { chatId: 'chat-1', ...concurrentIdentity }, dataUrl: PNG_DATA_URL },
    {
      readVariables: concurrentHarness.readVariables,
      updateVariables: concurrentHarness.updateVariables,
      getRequestHeaders: () => ({}),
      fetchImpl: async () => response({ path: `${FOLDER_PATH_PREFIX}chat-1_4_0_0.png` }),
    },
  );
  trackConfirmedShotUpload('chat-1', concurrentIdentity, concurrentUpload);
  let concurrentDeleteCalls = 0;
  const [firstOutcome, secondOutcome] = await Promise.all([
    executeConfirmedShotRemoval(
      'chat-1',
      concurrentIdentity,
      'message-deleted',
      shotOptions(concurrentHarness, () => {
        concurrentDeleteCalls += 1;
        return response(null);
      }),
    ),
    executeConfirmedShotRemoval(
      'chat-1',
      concurrentIdentity,
      'image-removed',
      shotOptions(concurrentHarness, () => {
        concurrentDeleteCalls += 1;
        return response(null);
      }),
    ),
  ]);
  equal(concurrentDeleteCalls, 1, '并发双删除共享配对等待后应只发起一次删除请求');
  const concurrentStatuses = [firstOutcome.status, secondOutcome.status].sort().join(',');
  equal(concurrentStatuses, 'deleted,none', '并发双删除应恰好一个 deleted 一个 none');
  equal(chatPaths(concurrentHarness, 'chat-1'), [], '并发删除后索引条目应被剪除');

  // ---- 汇总日志红线：所有警告都不得携带路径、端点或图片数据 ----
  const allWarns = [
    failedDeleteWarn,
    networkFailedWarn,
    missingFileWarn,
    foreignVersionWarn,
    brokenWriteWarn,
    restoreMismatchWarn,
  ].join('');
  assert(allWarns.includes('<杠杠の生图机>'), '所有警告都应可定位到本脚本');
  assert(
    !allWarns.includes('user/images') &&
      !allWarns.includes('/api/images') &&
      !allWarns.includes('YWJj') &&
      !allWarns.includes('.png'),
    '所有警告不得包含图片路径、端点或图片数据',
  );

  console.info('<杠杠の生图机> story image delete sync tests passed');
}

void run().catch(error => {
  throw error;
});
