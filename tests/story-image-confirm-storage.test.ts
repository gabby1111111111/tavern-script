import {
  CONFIRMED_SHOT_FOLDER_NAME,
  CONFIRMED_SHOT_STORAGE_KEY,
  ShotStorageError,
  getChatConfirmedShots,
  readConfirmedShotIndex,
  type ShotStorageOptions,
} from '../src/杠杠の生图机/shot-storage';
import { ShotWorkflow } from '../src/杠杠の生图机/shot-workflow';
import type { ImagePlacement } from '../src/杠杠の生图机/image-placement';

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

function makePlacement(
  id: string,
  revisionIndex: number,
  identity: { messageId: number; swipeId: number; imageIndex: number },
  url: string,
  prompt = '',
): ImagePlacement {
  return {
    id,
    artifactId: `artifact-${id}`,
    target: {
      kind: 'inline-anchor',
      messageId: identity.messageId,
      swipeId: identity.swipeId,
      imageIndex: identity.imageIndex,
      paragraphIndex: 0,
      anchorTextBefore: '',
      anchorTextAfter: '',
    },
    caption: '',
    variantIndex: 0,
    revisionIndex,
    prompt,
    url,
    createdAt: revisionIndex,
  };
}

const PNG_DATA_URL_A = 'data:image/png;base64, YWJj';
const PNG_DATA_URL_B = 'data:image/png;base64, ZGVm';
const TEST_NOW_BASE = 1_700_000_000_000;

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

async function run(): Promise<void> {
  // 场景一：确认 → 上传 → 索引更新（确认状态同步先行，不等待存储）。
  const harness = createVariableHarness({ other: 'keep' });
  let uploadCount = 0;
  let uploadBody: Record<string, unknown> | null = null;
  let uploadHeaders: Record<string, unknown> | null = null;
  const uploadedEntries: unknown[] = [];
  const storageErrorSink: unknown[] = [];
  const workflow = new ShotWorkflow();
  const placementA = makePlacement(
    'a',
    0,
    { messageId: 3, swipeId: 0, imageIndex: 1 },
    PNG_DATA_URL_A,
    ' 一只坐在窗边的猫 ',
  );
  const placementB = makePlacement('b', 1, { messageId: 3, swipeId: 0, imageIndex: 1 }, PNG_DATA_URL_B);
  const persisting = workflow.confirmAndPersist(placementA, [placementA, placementB], { chatId: 'chat-1' }, {
    storageOptions: {
      readVariables: harness.readVariables,
      updateVariables: harness.updateVariables,
      now: () => TEST_NOW_BASE,
      getRequestHeaders: () => ({ 'X-CSRF-TOKEN': 'csrf-test' }),
      fetchImpl: async (input, init) => {
        uploadCount += 1;
        assert(input === '/api/images/upload', '确认即存应请求 SillyTavern 图片上传端点');
        uploadHeaders = init?.headers as Record<string, unknown>;
        uploadBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ path: '/user/images/杠杠の生图机/chat-1_3_0_1.png' });
      },
    },
    onUploaded: entry => uploadedEntries.push(entry),
    onStorageError: error => storageErrorSink.push(error),
  });
  assert(workflow.isConfirmed(placementA.id), '确认状态应在等待上传前同步生效，不阻塞确认交互');
  assert(!workflow.isConfirmed(placementB.id), '同镜 siblings 不应被误标记为已确认');
  await persisting;
  assert(workflow.isConfirmed(placementA.id), '上传完成后本地确认状态保持');
  equal(uploadCount, 1, '确认即存默认只应发起一次上传请求');
  equal(
    uploadBody,
    { image: 'YWJj', format: 'png', ch_name: CONFIRMED_SHOT_FOLDER_NAME, filename: 'chat-1_3_0_1.png' },
    '上传 body 应只含纯 base64、格式、专用文件夹与身份文件名',
  );
  equal(uploadHeaders, { 'X-CSRF-TOKEN': 'csrf-test', 'Content-Type': 'application/json' }, '上传应合并请求头');
  equal(uploadedEntries.length, 1, '上传成功应通过 onUploaded 侧通道上报一次');
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
        confirmedAt: TEST_NOW_BASE,
      },
    ],
    '上传成功应把条目写入索引（默认记录镜头提示词）',
  );
  assert(!JSON.stringify(harness.state.variables).includes('YWJj'), '索引变量不得包含 base64 图片数据');
  assert(JSON.stringify(harness.state.variables).includes('"other":"keep"'), '索引写入不得动脚本变量的其他键');
  equal(storageErrorSink.length, 0, '成功路径不应触发 onStorageError');

  // 场景二：上传失败 → 确认仍成功、不写索引、仅警告，且默认不重试。
  const failHarness = createVariableHarness();
  let httpFailCount = 0;
  const failedWorkflow = new ShotWorkflow();
  const failPlacement = makePlacement('fail', 0, { messageId: 3, swipeId: 0, imageIndex: 1 }, PNG_DATA_URL_A);
  const failErrors: unknown[] = [];
  const failUploads: unknown[] = [];
  const httpFailWarn = await captureWarn(async () => {
    await failedWorkflow.confirmAndPersist(failPlacement, [failPlacement], { chatId: 'chat-1' }, {
      storageOptions: {
        readVariables: failHarness.readVariables,
        updateVariables: failHarness.updateVariables,
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          httpFailCount += 1;
          return response({ error: 'boom /api/images/upload YWJj chat-1' }, 500);
        },
      },
      onUploaded: entry => failUploads.push(entry),
      onStorageError: error => failErrors.push(error),
    });
  });
  assert(failedWorkflow.isConfirmed(failPlacement.id), '上传失败后本地确认状态必须保持成功');
  equal(httpFailCount, 1, '上传失败不应重试');
  equal(failUploads.length, 0, '上传失败不应触发 onUploaded');
  equal(failHarness.state.writes, 0, '上传失败不得写索引');
  equal(
    getChatConfirmedShots(readConfirmedShotIndex({ readVariables: failHarness.readVariables }), 'chat-1'),
    [],
    '上传失败后索引应为空',
  );
  equal(failErrors.length, 1, '上传失败应通过 onStorageError 上报一次');
  assert(failErrors[0] instanceof ShotStorageError, 'onStorageError 应收到 ShotStorageError');
  assert((failErrors[0] as ShotStorageError).status === 500, 'onStorageError 错误应携带状态码');
  assert(httpFailWarn.includes('<杠杠の生图机>'), '上传失败应留下脚本前缀警告');
  assert(
    !httpFailWarn.includes('chat-1') &&
      !httpFailWarn.includes('YWJj') &&
      !httpFailWarn.includes('/api/images') &&
      !httpFailWarn.includes('data:image'),
    '上传失败警告不得包含图片路径、端点或图片数据',
  );

  let networkFailCount = 0;
  const networkWorkflow = new ShotWorkflow();
  const networkPlacement = makePlacement('net', 0, { messageId: 4, swipeId: 0, imageIndex: 0 }, PNG_DATA_URL_A);
  const networkErrors: unknown[] = [];
  const networkWarn = await captureWarn(async () => {
    await networkWorkflow.confirmAndPersist(networkPlacement, [networkPlacement], { chatId: 'chat-1' }, {
      storageOptions: {
        readVariables: failHarness.readVariables,
        updateVariables: failHarness.updateVariables,
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          networkFailCount += 1;
          throw new Error('ECONNREFUSED https://192.168.1.5:8000/api/images/upload');
        },
      },
      onStorageError: error => networkErrors.push(error),
    });
  });
  assert(networkWorkflow.isConfirmed(networkPlacement.id), '网络异常后本地确认状态必须保持成功');
  equal(networkFailCount, 1, '网络异常不应重试');
  assert(networkErrors[0] instanceof ShotStorageError, '网络异常应归一为 ShotStorageError 上报');
  assert(!(networkErrors[0] as ShotStorageError).message.includes('192.168.1.5'), '上报错误消息不得泄露请求地址');
  assert(networkWarn.includes('<杠杠の生图机>') && !networkWarn.includes('192.168.1.5'), '网络异常警告应有前缀且不得泄露地址');

  // 场景二补充：底图 URL 无法解析为 data URL 时不发起上传，同样只警告。
  const resolveWorkflow = new ShotWorkflow();
  const revokedPlacement = makePlacement(
    'revoked',
    0,
    { messageId: 5, swipeId: 0, imageIndex: 0 },
    'blob:revoked-object-url',
  );
  let revokedFetchCount = 0;
  const revokedErrors: unknown[] = [];
  const revokedWarn = await captureWarn(async () => {
    await resolveWorkflow.confirmAndPersist(revokedPlacement, [revokedPlacement], { chatId: 'chat-1' }, {
      storageOptions: {
        readVariables: failHarness.readVariables,
        updateVariables: failHarness.updateVariables,
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          revokedFetchCount += 1;
          throw new Error('object url revoked');
        },
      },
      onStorageError: error => revokedErrors.push(error),
    });
  });
  assert(resolveWorkflow.isConfirmed(revokedPlacement.id), '底图 URL 解析失败后本地确认状态必须保持成功');
  equal(revokedFetchCount, 1, '失败只应发生在解析底图 URL 的一次读取上，不应再发起上传');
  equal(revokedErrors.length, 1, 'URL 解析失败应通过 onStorageError 上报一次');
  equal((revokedErrors[0] as ShotStorageError).message, '无法读取待保存图片', 'URL 解析失败应上报有界错误消息');
  assert(revokedWarn.includes('<杠杠の生图机>') && !revokedWarn.includes('blob:'), 'URL 解析失败警告不得包含图片地址');

  // 场景三：同一镜头重确认 → 同名覆盖，索引仍只有一条且指向最新确认。
  const overwriteHarness = createVariableHarness();
  const overwriteFilenames: string[] = [];
  const overwriteRequests: string[] = [];
  const overwriteFetch: Pick<ShotStorageOptions, 'fetchImpl' | 'getRequestHeaders'> = {
    getRequestHeaders: () => ({}),
    fetchImpl: async (_input, init) => {
      overwriteRequests.push(String(_input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      overwriteFilenames.push(String(body.filename));
      return response({ path: `/user/images/杠杠の生图机/${String(body.filename)}` });
    },
  };
  const overwriteWorkflow = new ShotWorkflow();
  const firstPlacement = makePlacement(
    'v0',
    0,
    { messageId: 6, swipeId: 0, imageIndex: 0 },
    PNG_DATA_URL_A,
    '第一版提示词',
  );
  const redrawnPlacement = makePlacement('v1', 1, { messageId: 6, swipeId: 0, imageIndex: 0 }, PNG_DATA_URL_B);
  await overwriteWorkflow.confirmAndPersist(firstPlacement, [firstPlacement, redrawnPlacement], { chatId: 'chat-2' }, {
    storageOptions: {
      ...overwriteFetch,
      readVariables: overwriteHarness.readVariables,
      updateVariables: overwriteHarness.updateVariables,
      now: () => TEST_NOW_BASE,
    },
  });
  assert(overwriteWorkflow.isConfirmed(firstPlacement.id), '首次确认应成功');
  await overwriteWorkflow.confirmAndPersist(
    redrawnPlacement,
    [firstPlacement, redrawnPlacement],
    { chatId: 'chat-2', shotPrompt: ' 重绘后的提示词 ' },
    {
      storageOptions: {
        ...overwriteFetch,
        readVariables: overwriteHarness.readVariables,
        updateVariables: overwriteHarness.updateVariables,
        now: () => TEST_NOW_BASE + 5,
      },
    },
  );
  assert(overwriteWorkflow.isConfirmed(redrawnPlacement.id), '重确认应确认新底图');
  assert(!overwriteWorkflow.isConfirmed(firstPlacement.id), '重确认应取消旧底图的确认状态');
  equal(overwriteRequests, ['/api/images/upload', '/api/images/upload'], '同格式重确认只应再次上传，交由服务器同名覆盖');
  equal(overwriteFilenames, ['chat-2_6_0_0.png', 'chat-2_6_0_0.png'], '同一身份重确认应得到同一文件名');
  equal(overwriteHarness.state.writes, 2, '两次确认应各写一次索引');
  const overwriteShots = getChatConfirmedShots(
    readConfirmedShotIndex({ readVariables: overwriteHarness.readVariables }),
    'chat-2',
  );
  equal(overwriteShots.length, 1, '重确认后索引应只有一条该镜头条目');
  equal(
    overwriteShots[0],
    {
      messageId: 6,
      swipeId: 0,
      imageIndex: 0,
      filename: 'chat-2_6_0_0.png',
      path: '/user/images/杠杠の生图机/chat-2_6_0_0.png',
      shotPrompt: '重绘后的提示词',
      confirmedAt: TEST_NOW_BASE + 5,
    },
    '重确认应替换旧条目并更新确认时间与提示词',
  );

  // 场景四：上传成功但索引写入失败（未知版本）→ 仍按失败路径处理，原数据保留。
  const foreignHarness = createVariableHarness({
    [CONFIRMED_SHOT_STORAGE_KEY]: { version: 2, chats: {} },
  });
  let foreignUploadCount = 0;
  const foreignWorkflow = new ShotWorkflow();
  const foreignPlacement = makePlacement('foreign', 0, { messageId: 7, swipeId: 0, imageIndex: 0 }, PNG_DATA_URL_A);
  const foreignErrors: unknown[] = [];
  const foreignUploads: unknown[] = [];
  const foreignWarn = await captureWarn(async () => {
    await foreignWorkflow.confirmAndPersist(foreignPlacement, [foreignPlacement], { chatId: 'chat-9' }, {
      storageOptions: {
        readVariables: foreignHarness.readVariables,
        updateVariables: foreignHarness.updateVariables,
        getRequestHeaders: () => ({}),
        fetchImpl: async () => {
          foreignUploadCount += 1;
          return response({ path: '/user/images/杠杠の生图机/chat-9_7_0_0.png' });
        },
      },
      onUploaded: entry => foreignUploads.push(entry),
      onStorageError: error => foreignErrors.push(error),
    });
  });
  assert(foreignWorkflow.isConfirmed(foreignPlacement.id), '索引写入失败后本地确认状态必须保持成功');
  equal(foreignUploadCount, 1, '索引拒绝不回溯已完成的图库上传');
  equal(foreignUploads.length, 0, '索引写入失败不应触发 onUploaded');
  equal(foreignErrors.length, 1, '索引写入失败应通过 onStorageError 上报一次');
  assert(foreignErrors[0] instanceof ShotStorageError, '索引写入失败应上报 ShotStorageError');
  assert(foreignWarn.includes('<杠杠の生图机>'), '索引写入失败应留下脚本前缀警告');
  const foreignRaw = JSON.stringify(foreignHarness.state.variables[CONFIRMED_SHOT_STORAGE_KEY]);
  assert(foreignRaw.includes('"version":2'), '未知版本的原始索引数据必须原样保留');

  // 场景五：无提示词时条目不记录 shotPrompt 字段。
  const noPromptHarness = createVariableHarness();
  const noPromptWorkflow = new ShotWorkflow();
  const noPromptPlacement = makePlacement('no-prompt', 0, { messageId: 8, swipeId: 0, imageIndex: 0 }, PNG_DATA_URL_A);
  await noPromptWorkflow.confirmAndPersist(noPromptPlacement, [noPromptPlacement], { chatId: 'chat-4' }, {
    storageOptions: {
      readVariables: noPromptHarness.readVariables,
      updateVariables: noPromptHarness.updateVariables,
      getRequestHeaders: () => ({}),
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ path: `/user/images/杠杠の生图机/${String(body.filename)}` });
      },
    },
  });
  const noPromptShots = getChatConfirmedShots(
    readConfirmedShotIndex({ readVariables: noPromptHarness.readVariables }),
    'chat-4',
  );
  equal(noPromptShots.length, 1, '无提示词确认仍应写入索引条目');
  assert(!('shotPrompt' in noPromptShots[0]), '无提示词时条目不得携带 shotPrompt 字段');

  console.info('<杠杠の生图机> story image confirm storage tests passed');
}

void run().catch(error => {
  throw error;
});
