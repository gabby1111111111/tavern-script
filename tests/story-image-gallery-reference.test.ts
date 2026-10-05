import {
  buildGalleryAliasIndex,
  fetchGalleryFileNames,
  findStyleReference,
  matchGalleryReferences,
  parseDeclaredCharacters,
  scanPromptForAliases,
  type GalleryAliasEntry,
} from '../src/杠杠の生图机/gallery-reference';
import { CONFIRMED_SHOT_FOLDER_NAME } from '../src/杠杠の生图机/shot-storage';

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

function entry(filename: string, label: string, aliases: string[]): GalleryAliasEntry {
  return { filename, label, aliases };
}

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

// ---------------------------------------------------------------------------
// 声明解析变体与归一化
// ---------------------------------------------------------------------------

equal(parseDeclaredCharacters('当前出场角色：a2，b1；当前场景：夜晚'), ['a2', 'b1'], '全角冒号全角逗号应解析');
equal(parseDeclaredCharacters('当前出场角色: A2, b1 ;'), ['a2', 'b1'], '半角冒号逗号与空格应解析并 casefold');
equal(parseDeclaredCharacters('当前出场角色：a2、b1'), ['a2', 'b1'], '顿号分隔应解析');
equal(parseDeclaredCharacters('当前出场角色 ： ａ２ ， Ｂ１ '), ['a2', 'b1'], '冒号前空格与全角拉丁应归一化');
equal(parseDeclaredCharacters('当前出场角色：a2，b1\n下一段内容'), ['a2', 'b1'], '换行应截断声明');
equal(parseDeclaredCharacters('当前出场角色：a2；b1'), ['a2'], '半角分号应截断声明');
equal(parseDeclaredCharacters('当前出场角色：a2；b1；c3'), ['a2'], '全角分号应截断声明');
equal(parseDeclaredCharacters('正文里没有声明'), [], '解析不到声明应返回空数组');
equal(parseDeclaredCharacters('当前出场角色：'), [], '冒号后无内容应返回空数组');
equal(parseDeclaredCharacters('当前出场角色：；当前场景：白天'), [], '声明内容为空应返回空数组');
equal(parseDeclaredCharacters('当前出场角色：a2，，， a2 ， b1'), ['a2', 'b1'], '空项应剔除且重复别名应去重');
equal(
  parseDeclaredCharacters('前文\n当前出场角色：c1，a2\n后文\n当前出场角色：b9'),
  ['c1', 'a2'],
  '多次声明应只取第一处',
);
equal(parseDeclaredCharacters('当前出场角色：白月，凛'), ['白月', '凛'], '中日文别名应原样保留');
equal(parseDeclaredCharacters('当前出场角色：Ｌｕｎａ'), ['luna'], '全角拉丁字母应转半角并 casefold');
equal(parseDeclaredCharacters('当前出场角色：Ａ２'), ['a2'], '全角拉丁数字组合应归一化');
equal(parseDeclaredCharacters('当前出场角色：a2 ，ｂ1、c3'), ['a2', 'b1', 'c3'], '混合分隔符应全部支持');
equal(parseDeclaredCharacters('当前出场角色：  a2  '), ['a2'], '别名首尾空格应去除');

// ---------------------------------------------------------------------------
// 文件名解析容错
// ---------------------------------------------------------------------------

equal(
  buildGalleryAliasIndex(['参考-角色-a1,a2.png', '参考-风格-韩式线条风.png', '主图-角色-x.png', 'character-a9.png']),
  [entry('参考-角色-a1,a2.png', '角色', ['a1', 'a2']), entry('参考-风格-韩式线条风.png', '风格', ['韩式线条风'])],
  '应只收参考-前缀文件并解析标签与别名',
);
equal(
  buildGalleryAliasIndex(['参考--a1.png']),
  [entry('参考--a1.png', '', ['a1'])],
  '空标签条目应保留（标签不参与逻辑）',
);
equal(buildGalleryAliasIndex(['参考-a1.png']), [], '缺别名区（无第二个-）应跳过');
equal(buildGalleryAliasIndex(['参考-角色-.png']), [], '别名区为空应跳过');
equal(
  buildGalleryAliasIndex(['参考-角色-a1.PNG', '参考-风格-韩式.webp']),
  [entry('参考-角色-a1.PNG', '角色', ['a1']), entry('参考-风格-韩式.webp', '风格', ['韩式'])],
  '常见图片扩展名应剥离且大小写不敏感',
);
equal(
  buildGalleryAliasIndex(['参考-角色-a1,A1，ａ1.png']),
  [entry('参考-角色-a1,A1，ａ1.png', '角色', ['a1'])],
  '别名应归一化去重',
);
equal(
  buildGalleryAliasIndex(['参考-角色-a1.png', ' 参考-角色-a1.png ', '参考-角色-a1.jpg']),
  [entry('参考-角色-a1.png', '角色', ['a1']), entry('参考-角色-a1.jpg', '角色', ['a1'])],
  '重名（含首尾空白）应去重，不同扩展名是不同文件',
);
equal(
  buildGalleryAliasIndex(['参考-韩式-风格-a1.png']),
  [entry('参考-韩式-风格-a1.png', '韩式', ['风格-a1'])],
  '标签应取参考-后第一个-之前，别名可含-',
);
equal(
  buildGalleryAliasIndex([42 as unknown as string, '   ', '参考-角色-a1,b1.png']),
  [entry('参考-角色-a1,b1.png', '角色', ['a1', 'b1'])],
  '非字符串与空文件名应跳过',
);
equal(buildGalleryAliasIndex([]), [], '空列表应返回空索引');
equal(buildGalleryAliasIndex(undefined as unknown as string[]), [], '非法输入应容错返回空索引');

// ---------------------------------------------------------------------------
// 命中去重与排序（声明序）
// ---------------------------------------------------------------------------

const matchIndex = buildGalleryAliasIndex([
  '参考-角色-a1,a2.png',
  '参考-角色-b1.png',
  '参考-服装-c1.png',
  '参考-角色-x1.png',
]);

equal(
  matchGalleryReferences(['a2', 'c9', 'b1'], matchIndex),
  {
    matches: [
      { entry: matchIndex[0], matchedAliases: ['a2'], position: 0 },
      { entry: matchIndex[1], matchedAliases: ['b1'], position: 2 },
    ],
    unmatchedAliases: ['c9'],
  },
  '文件位置应取命中别名最早声明下标并按声明序排序，未命中声明应单列',
);
equal(
  matchGalleryReferences(['a1', 'a2'], matchIndex).matches.map(match => match.entry.filename),
  ['参考-角色-a1,a2.png'],
  '一文件多次命中只应附一次',
);
equal(
  matchGalleryReferences(['a1', 'a2'], matchIndex).matches[0].matchedAliases,
  ['a1', 'a2'],
  '命中别名应按声明位置排序',
);
equal(matchGalleryReferences([], matchIndex), { matches: [], unmatchedAliases: [] }, '空声明应零匹配');
equal(
  matchGalleryReferences(['nobody'], matchIndex),
  { matches: [], unmatchedAliases: ['nobody'] },
  '全部声明未命中应单列',
);
equal(
  matchGalleryReferences(['a2'], undefined as unknown as GalleryAliasEntry[]).matches,
  [],
  '非法索引应容错返回空匹配',
);
equal(
  matchGalleryReferences(['Ａ２', 'B1'], matchIndex).matches.map(match => match.entry.filename),
  ['参考-角色-a1,a2.png', '参考-角色-b1.png'],
  '声明入口应防御性归一化（全角拉丁与大小写）',
);
equal(
  matchGalleryReferences(['a2', 'a2', 'b1', 'a2'], matchIndex).matches.map(match => match.entry.filename),
  ['参考-角色-a1,a2.png', '参考-角色-b1.png'],
  '重复声明应去重且不影响排序',
);

const tieIndex = buildGalleryAliasIndex(['参考-角色-p1.png', '参考-角色-q1.png']);
equal(
  matchGalleryReferences(
    ['x1'],
    tieIndex.map(e => ({ ...e, aliases: ['x1'] })),
  ).matches.map(match => match.entry.filename),
  ['参考-角色-p1.png', '参考-角色-q1.png'],
  '同位置命中应保持索引中的文件顺序',
);

const wideIndex = buildGalleryAliasIndex([
  '参考-角色-a.png',
  '参考-角色-b.png',
  '参考-角色-c.png',
  '参考-角色-d.png',
  '参考-角色-e.png',
]);
equal(
  matchGalleryReferences(['a', 'b', 'c', 'd', 'e'], wideIndex).matches.length,
  5,
  '命中数量不设上限，声明几个附几个',
);

// ---------------------------------------------------------------------------
// 风格段精确查找
// ---------------------------------------------------------------------------

const styleIndex = buildGalleryAliasIndex([
  '参考-风格-韩式线条风.png',
  '参考-风格-LoFi.png',
  '参考-角色-韩式线条风.png',
  '参考-服装-韩式线条风.png',
]);

equal(
  findStyleReference(styleIndex, '韩式线条风')?.filename,
  '参考-风格-韩式线条风.png',
  '风格段应按标签=风格且别名=预设名精确查找',
);
equal(findStyleReference(styleIndex, 'lofi')?.filename, '参考-风格-LoFi.png', '预设名 casefold 后应命中');
equal(findStyleReference(styleIndex, 'ｌｏｆｉ')?.filename, '参考-风格-LoFi.png', '全角拉丁预设名应归一化命中');
equal(findStyleReference(styleIndex, '韩式'), null, '别名是子串不算精确匹配');
equal(findStyleReference(styleIndex, '不存在的预设'), null, '找不到应返回 null');
equal(findStyleReference(styleIndex, ''), null, '空预设名应返回 null');
equal(findStyleReference([], '韩式线条风'), null, '空索引应返回 null');
equal(findStyleReference(undefined as unknown as GalleryAliasEntry[], '韩式线条风'), null, '非法索引应容错返回 null');

// ---------------------------------------------------------------------------
// 兜底检测扫描（只检测不附图）
// ---------------------------------------------------------------------------

const scanIndex = buildGalleryAliasIndex(['参考-角色-a2.png', '参考-角色-b1,b3.png']);
equal(scanPromptForAliases('画面里 a2 站在窗边', scanIndex), ['a2'], '扫描应命中文本中出现的别名');
equal(scanPromptForAliases('画面里 A2 站在窗边', scanIndex), ['a2'], '扫描应 casefold 命中');
equal(scanPromptForAliases('画面里 Ａ２ 站在窗边', scanIndex), ['a2'], '扫描应支持全角拉丁命中');
equal(scanPromptForAliases('b1 在前，a2 在后', scanIndex), ['b1', 'a2'], '扫描结果应按首次出现位置排序');
equal(scanPromptForAliases('b1 与另一个 b3 同框', scanIndex), ['b1', 'b3'], '扫描应命中同文件多个别名并按位置排序');
equal(scanPromptForAliases('画面里没有认识的人', scanIndex), [], '零命中应返回空数组');
equal(scanPromptForAliases('', scanIndex), [], '空提示词应返回空数组');
equal(scanPromptForAliases('a2 站在窗边', []), [], '空索引应返回空数组');
equal(scanPromptForAliases('某个角色', undefined as unknown as GalleryAliasEntry[]), [], '非法索引应容错返回空数组');
equal(scanPromptForAliases('画面里有 z1 和 y9', scanIndex), [], '文本中的非图鉴别名不应命中');

// ---------------------------------------------------------------------------
// 图鉴文件名列表请求
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  let requestCount = 0;
  let requestBody: Record<string, unknown> | null = null;
  let requestHeaders: Record<string, unknown> | null = null;
  let requestEndpoint: unknown = null;
  let requestMethod: unknown = null;
  const listed = await fetchGalleryFileNames(CONFIRMED_SHOT_FOLDER_NAME, {
    getRequestHeaders: () => ({ 'X-CSRF-TOKEN': 'csrf-test' }),
    fetchImpl: async (input, init) => {
      requestCount += 1;
      requestEndpoint = input;
      requestMethod = init?.method;
      requestHeaders = init?.headers as Record<string, unknown>;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(['参考-角色-a1.png', 42, '主图-角色-x.png']);
    },
  });
  equal(requestCount, 1, '图鉴列表应只请求一次');
  equal(requestEndpoint, '/api/images/list', '应请求 SillyTavern 图片列表端点');
  equal(requestMethod, 'POST', '图鉴列表应使用 POST');
  equal(
    requestHeaders,
    { 'X-CSRF-TOKEN': 'csrf-test', 'Content-Type': 'application/json' },
    '应合并注入请求头与 JSON 内容类型',
  );
  equal(requestBody, { folder: CONFIRMED_SHOT_FOLDER_NAME }, '请求体应携带专用图库文件夹名（shot-storage 常量复用）');
  equal(listed, ['参考-角色-a1.png', '主图-角色-x.png'], '成功应返回纯文件名数组并剔除非字符串项');

  let defaultFolderBody: Record<string, unknown> | null = null;
  const defaultFolderListed = await fetchGalleryFileNames(undefined, {
    getRequestHeaders: () => ({}),
    fetchImpl: async (_input, init) => {
      defaultFolderBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response([]);
    },
  });
  equal(defaultFolderBody, { folder: '杠杠の生图机' }, '省略文件夹应默认使用专用图库文件夹常量');
  equal(defaultFolderListed, [], '空图鉴应返回空数组（不是 null）');

  const blankFolderWarn = await captureWarn(async () => {
    let blankCalled = 0;
    const blankListed = await fetchGalleryFileNames('   ', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => {
        blankCalled += 1;
        return response([]);
      },
    });
    equal(blankCalled, 0, '文件夹名为空不应发起请求');
    equal(blankListed, null, '文件夹名为空应返回 null');
  });
  assert(blankFolderWarn.includes('<杠杠の生图机>'), '文件夹名为空应留下脚本前缀警告');

  const httpFailWarn = await captureWarn(async () => {
    const failed = await fetchGalleryFileNames('f', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => response('server said /api/images/list f failed', 500),
    });
    equal(failed, null, 'HTTP 失败应返回 null');
  });
  assert(httpFailWarn.includes('<杠杠の生图机>'), 'HTTP 失败应留下脚本前缀警告');
  assert(!httpFailWarn.includes('/api/images') && !httpFailWarn.includes('.png'), '警告不得包含端点或图片路径');

  const notArrayWarn = await captureWarn(async () => {
    const failed = await fetchGalleryFileNames('f', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => response({ files: ['参考-角色-a1.png'] }),
    });
    equal(failed, null, '响应不是数组应返回 null');
  });
  assert(notArrayWarn.includes('<杠杠の生图机>'), '响应格式异常应留下脚本前缀警告');
  assert(!notArrayWarn.includes('参考-角色-a1.png'), '警告不得包含文件名');

  const badJsonWarn = await captureWarn(async () => {
    const failed = await fetchGalleryFileNames('f', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Unexpected token < in JSON');
          },
        }) as unknown as Response,
    });
    equal(failed, null, '响应 JSON 解析失败应返回 null');
  });
  assert(badJsonWarn.includes('<杠杠の生图机>'), 'JSON 解析失败应留下脚本前缀警告');

  const networkFailWarn = await captureWarn(async () => {
    const failed = await fetchGalleryFileNames('f', {
      getRequestHeaders: () => ({}),
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch https://192.168.1.5:8000/api/images/list');
      },
    });
    equal(failed, null, '网络异常应返回 null');
  });
  assert(networkFailWarn.includes('<杠杠の生图机>'), '网络异常应留下脚本前缀警告');
  assert(!networkFailWarn.includes('192.168.1.5'), '警告不得包含请求地址');

  console.info('<杠杠の生图机> story image gallery reference tests passed');
}

void run().catch(error => {
  throw error;
});
