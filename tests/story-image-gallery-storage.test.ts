import {
  GalleryStorageError,
  decodeImageDataUrl,
  normalizeGalleryFilename,
  saveImageToCharacterGallery,
} from '../src/杠杠の生图机/gallery-storage';

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

equal(decodeImageDataUrl('data:image/png;base64, YWJj\n'), { base64: 'YWJj', format: 'png' }, '应拆分 PNG data URL');
equal(
  decodeImageDataUrl('data:image/jpeg;base64, YWJj'),
  { base64: 'YWJj', format: 'jpg' },
  'jpeg format 应标准化为 jpg',
);
equal(normalizeGalleryFilename('../cg', 'png', 123), '.._cg.png', '文件名应去除路径分隔符并补扩展名');

async function run(): Promise<void> {
  let requestCount = 0;
  let requestBody: Record<string, unknown> | null = null;
  const saved = await saveImageToCharacterGallery(
    {
      dataUrl: 'data:image/png;base64, YWJj',
      characterName: '测试角色',
      filename: 'gift-cg.png',
    },
    {
      getRequestHeaders: () => ({ 'X-CSRF-TOKEN': 'csrf-test' }),
      fetchImpl: async (input, init) => {
        requestCount += 1;
        assert(input === '/api/images/upload', '应请求 SillyTavern 图片上传端点');
        equal(init?.method, 'POST', '图库保存应使用 POST');
        equal(init?.headers, { 'X-CSRF-TOKEN': 'csrf-test', 'Content-Type': 'application/json' }, '应合并请求头');
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ path: 'data/user/images/测试角色/gift-cg.png' });
      },
    },
  );
  equal(requestCount, 1, '显式保存应只请求一次');
  equal(
    requestBody,
    {
      image: 'YWJj',
      format: 'png',
      ch_name: '测试角色',
      filename: 'gift-cg.png',
    },
    '上传 body 应只含去前缀的图片与图库字段',
  );
  equal(saved.path, 'data/user/images/测试角色/gift-cg.png', '应返回服务端图库路径');

  let failed = false;
  try {
    await saveImageToCharacterGallery(
      { dataUrl: 'data:image/png;base64, YWJj', characterName: '测试角色', filename: 'failed.png' },
      { getRequestHeaders: () => ({}), fetchImpl: async () => response({}, 500) },
    );
  } catch (error) {
    failed = error instanceof GalleryStorageError && error.status === 500;
  }
  assert(failed, 'HTTP 失败应抛出可识别图库错误，供 runtime 保留内存图片');

  console.info('<杠杠の生图机> story image gallery storage tests passed');
}

void run().catch(error => {
  throw error;
});
