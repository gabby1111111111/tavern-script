import {
  CONFIRMED_SHOT_FOLDER_NAME,
  CONFIRMED_SHOT_STORAGE_KEY,
  ShotStorageError,
  buildConfirmedShotFilename,
  deleteConfirmedShotFile,
  findConfirmedShotEntry,
  getChatConfirmedShots,
  pruneConfirmedShots,
  readConfirmedShotIndex,
  removeConfirmedShotEntry,
  uploadConfirmedShot,
  upsertConfirmedShot,
  type ConfirmedShotEntry,
  type ConfirmedShotUploadInput,
} from '../src/杠杠の生图机/shot-storage';

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
  return { [CONFIRMED_SHOT_STORAGE_KEY]: { version: 1, chats } };
}

const PNG_DATA_URL = 'data:image/png;base64, YWJj';
const JPEG_DATA_URL = 'data:image/jpeg;base64, YWJj';
const TEST_NOW = 1_700_000_000_000;
const SHOT_OPTIONS = (harness: VariableHarness) => ({
  readVariables: harness.readVariables,
  updateVariables: harness.updateVariables,
  now: () => TEST_NOW,
});

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

equal(
  buildConfirmedShotFilename({ chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }),
  'chat-1_3_0_1.png',
  '身份编码应生成确定性 PNG 文件名',
);
equal(
  buildConfirmedShotFilename({ chatId: '../a\\b\n\tc', messageId: 0, swipeId: 2, imageIndex: 3 }),
  '.._a_b__c_0_2_3.png',
  '文件名应按 safePathPart 同款规则清洗路径分隔符与控制字符',
);
equal(
  buildConfirmedShotFilename({ chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }, 'jpeg'),
  'chat-1_3_0_1.jpg',
  '扩展名应跟随上传格式（jpeg 标准化为 jpg）',
);
equal(
  buildConfirmedShotFilename({ chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }, 'not valid!'),
  'chat-1_3_0_1.png',
  '无法识别的格式应回退为 png',
);
equal(
  buildConfirmedShotFilename({ chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }),
  buildConfirmedShotFilename({ chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }),
  '同一身份应得到同一文件名，从而由服务器覆盖旧文件',
);
equal(CONFIRMED_SHOT_FOLDER_NAME, '杠杠の生图机', '专用文件夹常量必须保持为杠杠の生图机，防止被误改');

async function run(): Promise<void> {
  const empty = createVariableHarness();
  equal(
    readConfirmedShotIndex({ readVariables: empty.readVariables }),
    { version: 1, chats: {} },
    '空变量应解析为默认索引',
  );
  const corrupt = createVariableHarness({ [CONFIRMED_SHOT_STORAGE_KEY]: '垃圾数据' });
  equal(
    readConfirmedShotIndex({ readVariables: corrupt.readVariables }),
    { version: 1, chats: {} },
    '非对象的索引值无可打捞数据，应容错回退为空索引',
  );
  const partial = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: { version: 1, chats: { c1: { shots: [makeEntry(1, 0, 0, 'p1.png')] } } },
  });
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: partial.readVariables }), 'c1').length,
    1,
    '索引读写往返应保留既有条目',
  );

  const dirtyChat = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: {
      version: 1,
      chats: { c1: null, c2: { shots: [makeEntry(1, 0, 0, 'p1.png')] } },
    },
  });
  const dirtyChatRead = readConfirmedShotIndex({ readVariables: dirtyChat.readVariables });
  equal(getChatConfirmedShots(dirtyChatRead, 'c1'), [], '为 null 的聊天节应被剪除且不影响读取');
  equal(
    getChatConfirmedShots(dirtyChatRead, 'c2').map(entry => entry.path),
    ['p1.png'],
    '为 null 的聊天节不得拖垮其他聊天的有效条目',
  );
  upsertConfirmedShot('c3', makeEntry(7, 0, 0, 'p7.png'), SHOT_OPTIONS(dirtyChat));
  const dirtyChatAfter = readConfirmedShotIndex({ readVariables: dirtyChat.readVariables });
  equal(
    getChatConfirmedShots(dirtyChatAfter, 'c2').map(entry => entry.path),
    ['p1.png'],
    '损坏解析后的写回应保留其他聊天的有效条目',
  );
  equal(
    getChatConfirmedShots(dirtyChatAfter, 'c3').map(entry => entry.path),
    ['p7.png'],
    '损坏解析后的写入应正常落盘',
  );
  assert(!('c1' in dirtyChatAfter.chats), '已损坏的聊天节不应被写回');

  const dirtyEntry = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: {
      version: 1,
      chats: {
        c1: {
          shots: [
            makeEntry(1, 0, 0, 'p1.png'),
            { messageId: 'bad', swipeId: 0, imageIndex: 2, filename: 'bad.png', path: 'p2.png', confirmedAt: TEST_NOW },
            makeEntry(9, 0, 0, 'p9.png'),
          ],
        },
        c2: { shots: [{ confirmedAt: 'bad' }] },
      },
    },
  });
  const dirtyEntryRead = readConfirmedShotIndex({ readVariables: dirtyEntry.readVariables });
  equal(
    getChatConfirmedShots(dirtyEntryRead, 'c1').map(entry => entry.path),
    ['p1.png', 'p9.png'],
    '损坏条目应被逐条剪除，同聊天的有效条目保留',
  );
  equal(getChatConfirmedShots(dirtyEntryRead, 'c2'), [], '其他聊天中的损坏条目同样只剪除自身');
  upsertConfirmedShot('c1', makeEntry(5, 0, 0, 'p5.png'), SHOT_OPTIONS(dirtyEntry));
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: dirtyEntry.readVariables }), 'c1').map(
      entry => entry.path,
    ),
    ['p1.png', 'p9.png', 'p5.png'],
    '损坏条目打捞后的写回应保留全部有效条目',
  );

  const emptySalvage = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: {
      version: 1,
      chats: {
        c1: { shots: [{ confirmedAt: 'bad' }] },
        c2: { shots: [] },
        c3: { shots: [makeEntry(1, 0, 0, 'p1.png')] },
      },
    },
  });
  const emptySalvageRead = readConfirmedShotIndex({ readVariables: emptySalvage.readVariables });
  assert(!('c1' in emptySalvageRead.chats), '条目全部损坏的聊天打捞后应跳过该聊天键');
  assert(!('c2' in emptySalvageRead.chats), 'shots 为空的聊天键同样应被跳过');
  equal(getChatConfirmedShots(emptySalvageRead, 'c3').length, 1, '空聊天键跳过不得影响有效聊天');
  upsertConfirmedShot('c3', makeEntry(2, 0, 0, 'p2.png'), SHOT_OPTIONS(emptySalvage));
  const emptySalvageAfter = readConfirmedShotIndex({ readVariables: emptySalvage.readVariables });
  assert(!('c1' in emptySalvageAfter.chats) && !('c2' in emptySalvageAfter.chats), '打捞后的写回不得复活空聊天键');
  equal(
    getChatConfirmedShots(emptySalvageAfter, 'c3').map(entry => entry.path),
    ['p1.png', 'p2.png'],
    '打捞后的写回应保留有效聊天的条目',
  );

  const foreignVersion = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: {
      version: 2,
      chats: { c1: { shots: [makeEntry(1, 0, 0, 'p1.png')] } },
    },
  });
  equal(
    readConfirmedShotIndex({ readVariables: foreignVersion.readVariables }),
    { version: 1, chats: {} },
    '未知版本应按空索引读取，不解释未知数据',
  );
  let foreignWriteError: unknown = null;
  try {
    upsertConfirmedShot('c3', makeEntry(7, 0, 0, 'p7.png'), SHOT_OPTIONS(foreignVersion));
  } catch (error) {
    foreignWriteError = error;
  }
  assert(foreignWriteError instanceof ShotStorageError, '未知版本的索引应拒绝写入');
  assert(
    !(foreignWriteError as ShotStorageError).message.includes('c1') &&
      !(foreignWriteError as ShotStorageError).message.includes('p1.png'),
    '版本错误消息不得泄露索引内容',
  );
  const foreignRaw = JSON.stringify(foreignVersion.state.variables[CONFIRMED_SHOT_STORAGE_KEY]);
  assert(foreignRaw.includes('"version":2') && foreignRaw.includes('p1.png'), '未知版本的原始数据必须原样保留');
  let foreignRemoveError: unknown = null;
  try {
    removeConfirmedShotEntry('c1', { messageId: 1, swipeId: 0, imageIndex: 0 }, SHOT_OPTIONS(foreignVersion));
  } catch (error) {
    foreignRemoveError = error;
  }
  assert(foreignRemoveError instanceof ShotStorageError, '未知版本下移除条目同样应拒绝');
  let foreignPruneError: unknown = null;
  try {
    pruneConfirmedShots('c1', () => true, SHOT_OPTIONS(foreignVersion));
  } catch (error) {
    foreignPruneError = error;
  }
  assert(foreignPruneError instanceof ShotStorageError, '未知版本下剪除同样应拒绝');
  let foreignUploadCount = 0;
  let foreignUploadError: unknown = null;
  try {
    await uploadConfirmedShot(
      { identity: { chatId: 'c9', messageId: 1, swipeId: 0, imageIndex: 0 }, dataUrl: PNG_DATA_URL },
      {
        ...SHOT_OPTIONS(foreignVersion),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          foreignUploadCount += 1;
          return response({ path: '/user/images/杠杠の生图机/c9_1_0_0.png' });
        },
      },
    );
  } catch (error) {
    foreignUploadError = error;
  }
  assert(foreignUploadError instanceof ShotStorageError, '未知版本下上传成功但索引写入应报错');
  equal(foreignUploadCount, 1, '索引拒绝不回溯已完成的图库上传');

  const missingVersion = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: { chats: { c1: { shots: [makeEntry(1, 0, 0, 'p1.png')] } } },
  });
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: missingVersion.readVariables }), 'c1').length,
    1,
    '缺少版本字段的索引应按当前版本打捞有效条目',
  );

  const harness = createVariableHarness({ other: 'keep' });
  let uploadCount = 0;
  let uploadBody: Record<string, unknown> | null = null;
  const uploaded = await uploadConfirmedShot(
    {
      identity: { chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 },
      dataUrl: PNG_DATA_URL,
      shotPrompt: ' 一只坐在窗边的猫 ',
    },
    {
      ...SHOT_OPTIONS(harness),
      getRequestHeaders: () => ({ 'X-CSRF-TOKEN': 'csrf-test' }),
      fetchImpl: async (input, init) => {
        uploadCount += 1;
        assert(input === '/api/images/upload', '上传应请求 SillyTavern 图片上传端点');
        equal(init?.method, 'POST', '上传应使用 POST');
        equal(init?.headers, { 'X-CSRF-TOKEN': 'csrf-test', 'Content-Type': 'application/json' }, '上传应合并请求头');
        uploadBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ path: '/user/images/杠杠の生图机/chat-1_3_0_1.png' });
      },
    },
  );
  equal(uploadCount, 1, '确认上传应只请求一次');
  equal(
    uploadBody,
    { image: 'YWJj', format: 'png', ch_name: CONFIRMED_SHOT_FOLDER_NAME, filename: 'chat-1_3_0_1.png' },
    '上传 body 应只含纯 base64、推断格式、专用文件夹与身份文件名',
  );
  equal(uploaded.path, '/user/images/杠杠の生图机/chat-1_3_0_1.png', '上传成功应返回服务器路径');
  equal(uploaded.filename, 'chat-1_3_0_1.png', '上传成功应返回身份文件名');
  equal(uploaded.confirmedAt, TEST_NOW, '确认时间应来自注入的时钟');
  equal(uploaded.shotPrompt, '一只坐在窗边的猫', '确认提示词应去空白后记录');
  equal(harness.state.writes, 1, '上传成功应只写一次索引');
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: harness.readVariables }), 'chat-1'),
    [
      {
        messageId: 3,
        swipeId: 0,
        imageIndex: 1,
        filename: 'chat-1_3_0_1.png',
        path: '/user/images/杠杠の生图机/chat-1_3_0_1.png',
        shotPrompt: '一只坐在窗边的猫',
        confirmedAt: TEST_NOW,
      },
    ],
    '上传成功应把条目写入索引',
  );
  assert(!JSON.stringify(harness.state.variables).includes('YWJj'), '索引变量不得包含 base64 图片数据');
  assert(JSON.stringify(harness.state.variables).includes('"other":"keep"'), '索引写入不得动脚本变量的其他键');

  let overwriteFilename = '';
  const overwritten = await uploadConfirmedShot(
    { identity: { chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }, dataUrl: PNG_DATA_URL },
    {
      ...SHOT_OPTIONS(harness),
      now: () => TEST_NOW + 1,
      getRequestHeaders: () => ({}),
      fetchImpl: async (_input, init) => {
        overwriteFilename = (JSON.parse(String(init?.body)) as Record<string, unknown>).filename as string;
        return response({ path: '/user/images/杠杠の生图机/chat-1_3_0_1.png' });
      },
    },
  );
  equal(overwriteFilename, 'chat-1_3_0_1.png', '重确认应生成同一文件名，交由服务器同名覆盖');
  equal(overwritten.confirmedAt, TEST_NOW + 1, '重确认应更新确认时间');
  const overwriteShots = getChatConfirmedShots(
    readConfirmedShotIndex({ readVariables: harness.readVariables }),
    'chat-1',
  );
  equal(overwriteShots.length, 1, '重确认后索引应只有一条该镜头条目');
  equal(overwriteShots[0]?.confirmedAt, TEST_NOW + 1, '重确认应替换旧条目');
  equal(overwriteShots[0]?.shotPrompt, undefined, '重确认未提供提示词时应清除旧提示词');

  const formatChangeCalls: Array<{ input: unknown; body: Record<string, unknown> }> = [];
  const formatChangeHarness = createVariableHarness();
  const confirmWithFormat = (dataUrl: string) =>
    uploadConfirmedShot(
      { identity: { chatId: 'chat-4', messageId: 2, swipeId: 1, imageIndex: 0 }, dataUrl },
      {
        ...SHOT_OPTIONS(formatChangeHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async (input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          formatChangeCalls.push({ input, body });
          return response({ path: `/user/images/杠杠の生图机/${String(body.filename)}` });
        },
      },
    );
  await confirmWithFormat(PNG_DATA_URL);
  equal(formatChangeCalls.length, 1, '首次确认不应有旧文件删除请求');
  equal(formatChangeCalls[0]?.input, '/api/images/upload', '首次确认应只发起上传');
  await confirmWithFormat(JPEG_DATA_URL);
  equal(formatChangeCalls.length, 3, '格式变化的重确认应先删旧扩展名文件再上传');
  equal(formatChangeCalls[1]?.input, '/api/images/delete', '格式变化重确认应先删除旧扩展名的服务器文件');
  equal(
    formatChangeCalls[1]?.body,
    { path: '/user/images/杠杠の生图机/chat-4_2_1_0.png' },
    '旧文件删除应使用索引中记录的旧扩展名路径',
  );
  equal(formatChangeCalls[2]?.input, '/api/images/upload', '旧文件删除后应上传新格式图片');
  equal(formatChangeCalls[2]?.body?.filename, 'chat-4_2_1_0.jpg', '新上传应使用新扩展名文件名');
  const formatChangeShots = getChatConfirmedShots(
    readConfirmedShotIndex({ readVariables: formatChangeHarness.readVariables }),
    'chat-4',
  );
  equal(formatChangeShots.length, 1, '格式变化重确认后索引仍应只有一条该镜头');
  equal(formatChangeShots[0]?.filename, 'chat-4_2_1_0.jpg', '索引应指向新扩展名文件');
  await confirmWithFormat(JPEG_DATA_URL);
  equal(formatChangeCalls.length, 4, '同格式重确认应交由服务器同名覆盖，不再删除');
  equal(formatChangeCalls[3]?.input, '/api/images/upload', '同格式重确认只应发起上传');

  const staleCleanupCalls: string[] = [];
  const staleCleanupHarness = createVariableHarness();
  const staleCleanupOptions = (fetchImpl: typeof fetch) => ({
    ...SHOT_OPTIONS(staleCleanupHarness),
    getRequestHeaders: () => ({}),
    fetchImpl,
  });
  await uploadConfirmedShot(
    { identity: { chatId: 'chat-5', messageId: 4, swipeId: 0, imageIndex: 0 }, dataUrl: PNG_DATA_URL },
    staleCleanupOptions(async input => {
      staleCleanupCalls.push(String(input));
      return response({ path: '/user/images/杠杠の生图机/chat-5_4_0_0.png' });
    }),
  );
  const staleCleanupWarn = await captureWarn(async () => {
    await uploadConfirmedShot(
      { identity: { chatId: 'chat-5', messageId: 4, swipeId: 0, imageIndex: 0 }, dataUrl: JPEG_DATA_URL },
      staleCleanupOptions(async input => {
        staleCleanupCalls.push(String(input));
        return String(input) === '/api/images/delete'
          ? response(null, 500)
          : response({ path: '/user/images/杠杠の生图机/chat-5_4_0_0.jpg' });
      }),
    );
  });
  equal(
    staleCleanupCalls,
    ['/api/images/upload', '/api/images/delete', '/api/images/upload'],
    '旧文件删除失败应仅警告并继续完成新格式上传',
  );
  assert(staleCleanupWarn.includes('<杠杠の生图机>'), '旧文件删除失败应留下脚本前缀警告');
  assert(!staleCleanupWarn.includes('chat-5'), '删除失败警告不得包含图片路径');
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: staleCleanupHarness.readVariables }), 'chat-5')[0]
      ?.filename,
    'chat-5_4_0_0.jpg',
    '删除失败后索引仍应指向新上传的文件',
  );

  const failHarness = createVariableHarness({ [CONFIRMED_SHOT_STORAGE_KEY]: { version: 1, chats: {} } });
  let httpUploadError: unknown = null;
  let httpFailCount = 0;
  try {
    await uploadConfirmedShot(
      { identity: { chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }, dataUrl: PNG_DATA_URL },
      {
        ...SHOT_OPTIONS(failHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          httpFailCount += 1;
          return response({ error: 'boom /api/images/upload YWJj' }, 500);
        },
      },
    );
  } catch (error) {
    httpUploadError = error;
  }
  assert(httpUploadError instanceof ShotStorageError, 'HTTP 失败应抛出 ShotStorageError');
  assert((httpUploadError as ShotStorageError).status === 500, 'HTTP 失败应携带状态码');
  assert(
    !(httpUploadError as ShotStorageError).message.includes('/api/images') &&
      !(httpUploadError as ShotStorageError).message.includes('YWJj'),
    '上传错误消息不得泄露端点或图片数据',
  );
  equal(httpFailCount, 1, '上传失败不应重试');
  equal(failHarness.state.writes, 0, '上传失败不得写索引');
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: failHarness.readVariables }), 'chat-1'),
    [],
    '上传失败后索引应保持为空',
  );

  let networkError: unknown = null;
  try {
    await uploadConfirmedShot(
      { identity: { chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }, dataUrl: PNG_DATA_URL },
      {
        ...SHOT_OPTIONS(failHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED https://192.168.1.5:8000/api/images/upload');
        },
      },
    );
  } catch (error) {
    networkError = error;
  }
  assert(networkError instanceof ShotStorageError, '网络异常应抛出 ShotStorageError');
  assert((networkError as ShotStorageError).status === null, '网络异常不应携带状态码');
  assert(!(networkError as ShotStorageError).message.includes('192.168.1.5'), '网络异常消息不得泄露请求地址');

  let invalidDataUrlCalled = 0;
  let invalidDataUrlError: unknown = null;
  try {
    await uploadConfirmedShot(
      {
        identity: { chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 },
        dataUrl: 'data:text/plain;base64,YWJj',
      },
      {
        ...SHOT_OPTIONS(failHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          invalidDataUrlCalled += 1;
          return response({ path: 'x.png' });
        },
      },
    );
  } catch (error) {
    invalidDataUrlError = error;
  }
  assert(invalidDataUrlError instanceof ShotStorageError, '非图片 data URL 应抛出 ShotStorageError');
  equal(invalidDataUrlCalled, 0, '无效 data URL 不应发起请求');

  let badIdentityCalls = 0;
  let badIdentityError: unknown = null;
  try {
    await uploadConfirmedShot(
      { identity: { chatId: 'chat-1', messageId: 1.5, swipeId: 0, imageIndex: 0 }, dataUrl: PNG_DATA_URL },
      {
        ...SHOT_OPTIONS(failHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          badIdentityCalls += 1;
          return response({ path: 'x.png' });
        },
      },
    );
  } catch (error) {
    badIdentityError = error;
  }
  assert(badIdentityError instanceof ShotStorageError, '非整数身份应抛出 ShotStorageError');
  equal(badIdentityCalls, 0, '非整数身份不应发起上传请求');

  let nonNumberIdentityError: unknown = null;
  try {
    await uploadConfirmedShot(
      {
        identity: { chatId: 'chat-1', messageId: '3', swipeId: 0, imageIndex: 0 } as unknown as ConfirmedShotUploadInput['identity'],
        dataUrl: PNG_DATA_URL,
      },
      {
        ...SHOT_OPTIONS(failHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => response({ path: 'x.png' }),
      },
    );
  } catch (error) {
    nonNumberIdentityError = error;
  }
  assert(nonNumberIdentityError instanceof ShotStorageError, '非数字身份应抛出 ShotStorageError');

  let missingPathError: unknown = null;
  try {
    await uploadConfirmedShot(
      { identity: { chatId: 'chat-1', messageId: 3, swipeId: 0, imageIndex: 1 }, dataUrl: PNG_DATA_URL },
      {
        ...SHOT_OPTIONS(failHarness),
        getRequestHeaders: () => ({}),
        fetchImpl: async () => response({}),
      },
    );
  } catch (error) {
    missingPathError = error;
  }
  assert(missingPathError instanceof ShotStorageError, '响应缺少路径应抛出 ShotStorageError');

  const stripHarness = createVariableHarness();
  upsertConfirmedShot(
    'chat-1',
    {
      ...makeEntry(1, 0, 0, '/user/images/杠杠の生图机/chat-1_1_0_0.png'),
      dataUrl: PNG_DATA_URL,
    } as ConfirmedShotEntry,
    SHOT_OPTIONS(stripHarness),
  );
  assert(!JSON.stringify(stripHarness.state.variables).includes('YWJj'), '索引写入必须剥离条目外的字段（含图片数据）');
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: stripHarness.readVariables }), 'chat-1'),
    [makeEntry(1, 0, 0, '/user/images/杠杠の生图机/chat-1_1_0_0.png')],
    '索引读写应往返一致并剥离额外字段',
  );

  const removeHarness = createVariableHarness(
    seedIndex({
      'chat-1': [makeEntry(1, 0, 0, 'p1.png'), makeEntry(2, 0, 0, 'p2.png')],
      'chat-2': [makeEntry(1, 0, 0, 'p3.png')],
    }),
  );
  const removed = removeConfirmedShotEntry(
    'chat-1',
    { messageId: 1, swipeId: 0, imageIndex: 0 },
    SHOT_OPTIONS(removeHarness),
  );
  equal(removed?.path, 'p1.png', '移除应返回被删条目供调用方删除服务器文件');
  const removeIndex = readConfirmedShotIndex({ readVariables: removeHarness.readVariables });
  equal(
    getChatConfirmedShots(removeIndex, 'chat-1').map(entry => entry.path),
    ['p2.png'],
    '移除只应影响该镜头',
  );
  equal(getChatConfirmedShots(removeIndex, 'chat-2').length, 1, '移除不得影响其他聊天');
  equal(
    removeConfirmedShotEntry('chat-9', { messageId: 1, swipeId: 0, imageIndex: 0 }, SHOT_OPTIONS(removeHarness)),
    null,
    '移除不存在的镜头应返回 null',
  );
  const beforeRemoveIdle = removeHarness.state.variables;
  removeConfirmedShotEntry('chat-9', { messageId: 1, swipeId: 0, imageIndex: 0 }, SHOT_OPTIONS(removeHarness));
  assert(removeHarness.state.variables === beforeRemoveIdle, '无变化时不得写变量');
  equal(
    removeConfirmedShotEntry('chat-2', { messageId: 1, swipeId: 0, imageIndex: 0 }, SHOT_OPTIONS(removeHarness))?.path,
    'p3.png',
    '移除聊天内最后一条应返回该条目',
  );
  assert(
    !('chat-2' in readConfirmedShotIndex({ readVariables: removeHarness.readVariables }).chats),
    '聊天清空后应移除该聊天键',
  );

  const pruneHarness = createVariableHarness(
    seedIndex({
      'chat-1': [makeEntry(1, 0, 0, 'p1.png'), makeEntry(5, 0, 0, 'p5.png'), makeEntry(9, 1, 0, 'p9.png')],
      'chat-2': [makeEntry(2, 0, 0, 'p3.png')],
    }),
  );
  const pruned = pruneConfirmedShots('chat-1', entry => entry.messageId === 5, SHOT_OPTIONS(pruneHarness));
  equal(
    pruned.map(entry => entry.path),
    ['p1.png', 'p9.png'],
    '剪除应返回失效条目',
  );
  const pruneIndex = readConfirmedShotIndex({ readVariables: pruneHarness.readVariables });
  equal(
    getChatConfirmedShots(pruneIndex, 'chat-1').map(entry => entry.path),
    ['p5.png'],
    '剪除应保留有效条目',
  );
  equal(getChatConfirmedShots(pruneIndex, 'chat-2').length, 1, '剪除不得影响其他聊天');
  equal(
    findConfirmedShotEntry(pruneIndex, 'chat-1', { messageId: 5, swipeId: 0, imageIndex: 0 })?.path,
    'p5.png',
    '应能按身份查找条目',
  );
  equal(
    findConfirmedShotEntry(pruneIndex, 'chat-1', { messageId: 99, swipeId: 0, imageIndex: 0 }),
    undefined,
    '查不到的镜头应返回 undefined',
  );
  const beforePruneIdle = pruneHarness.state.variables;
  equal(
    pruneConfirmedShots('chat-1', () => true, SHOT_OPTIONS(pruneHarness)),
    [],
    '无失效条目时应返回空',
  );
  assert(pruneHarness.state.variables === beforePruneIdle, '无失效条目时不得写变量');
  equal(
    pruneConfirmedShots('chat-2', () => false, SHOT_OPTIONS(pruneHarness)).map(entry => entry.path),
    ['p3.png'],
    '全部失效时也应剪除',
  );
  assert(
    !('chat-2' in readConfirmedShotIndex({ readVariables: pruneHarness.readVariables }).chats),
    '聊天清空后应移除该聊天键',
  );

  let deleteCount = 0;
  let deleteBody: Record<string, unknown> | null = null;
  await deleteConfirmedShotFile('/user/images/杠杠の生图机/chat-1_3_0_1.png', {
    getRequestHeaders: () => ({ 'X-CSRF-TOKEN': 'csrf-test' }),
    fetchImpl: async (input, init) => {
      deleteCount += 1;
      assert(input === '/api/images/delete', '删除应请求 SillyTavern 图片删除端点');
      equal(init?.method, 'POST', '删除应使用 POST');
      equal(init?.headers, { 'X-CSRF-TOKEN': 'csrf-test', 'Content-Type': 'application/json' }, '删除应合并请求头');
      deleteBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(null);
    },
  });
  equal(deleteCount, 1, '删除应只请求一次');
  equal(deleteBody, { path: '/user/images/杠杠の生图机/chat-1_3_0_1.png' }, '删除应把索引中的路径原样回传');
  await deleteConfirmedShotFile('/user/images/杠杠の生图机/gone.png', {
    getRequestHeaders: () => ({}),
    fetchImpl: async () => response(null, 404),
  });

  let deleteHttpError: unknown = null;
  try {
    await deleteConfirmedShotFile('/user/images/杠杠の生图机/stuck.png', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => response('server said /api/images/delete stuck.png failed', 500),
    });
  } catch (error) {
    deleteHttpError = error;
  }
  assert(deleteHttpError instanceof ShotStorageError, '删除失败应抛出 ShotStorageError');
  assert((deleteHttpError as ShotStorageError).status === 500, '删除失败应携带状态码');
  assert(
    !(deleteHttpError as ShotStorageError).message.includes('stuck.png') &&
      !(deleteHttpError as ShotStorageError).message.includes('/api/images'),
    '删除错误消息不得泄露路径或端点',
  );

  let deleteNetworkError: unknown = null;
  try {
    await deleteConfirmedShotFile('/user/images/杠杠の生图机/x.png', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
  } catch (error) {
    deleteNetworkError = error;
  }
  assert(deleteNetworkError instanceof ShotStorageError, '删除网络异常应抛出 ShotStorageError');

  let emptyPathCalled = 0;
  let emptyPathError: unknown = null;
  try {
    await deleteConfirmedShotFile('   ', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => {
        emptyPathCalled += 1;
        return response(null);
      },
    });
  } catch (error) {
    emptyPathError = error;
  }
  assert(emptyPathError instanceof ShotStorageError, '空路径应抛出 ShotStorageError');
  equal(emptyPathCalled, 0, '空路径不应发起请求');

  // 防误删：专用文件夹之外的路径（含 `..` 穿越伪装）只警告、不发起删除请求。
  let outsideFolderCalled = 0;
  const outsideFolderWarn = await captureWarn(async () => {
    for (const outsidePath of ['/user/images/其他文件夹/chat-1_3_0_1.png', '/user/images/杠杠の生图机/../secret.png']) {
      await deleteConfirmedShotFile(outsidePath, {
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          outsideFolderCalled += 1;
          return response(null);
        },
      });
    }
  });
  equal(outsideFolderCalled, 0, '专用文件夹之外的路径不应发起删除请求');
  assert(outsideFolderWarn.includes('<杠杠の生图机>'), '路径越界应留下脚本前缀警告');
  assert(
    !outsideFolderWarn.includes('chat-1') && !outsideFolderWarn.includes('secret') && !outsideFolderWarn.includes('其他文件夹'),
    '路径越界警告不得包含图片路径',
  );

  let relativeDeleteCount = 0;
  await deleteConfirmedShotFile('杠杠の生图机/chat-1_3_0_1.png', {
    getRequestHeaders: () => ({}),
    fetchImpl: async (_input, init) => {
      relativeDeleteCount += 1;
      equal(JSON.parse(String(init?.body)), { path: '杠杠の生图机/chat-1_3_0_1.png' }, '专用文件夹内的相对路径应原样回传');
      return response(null);
    },
  });
  equal(relativeDeleteCount, 1, '专用文件夹内的相对路径仍应正常删除');

  console.info('<杠杠の生图机> story image shot storage tests passed');
}

void run().catch(error => {
  throw error;
});
