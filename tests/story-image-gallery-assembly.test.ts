import {
  assembleOutputReferenceSources,
  galleryReferenceServerPath,
  processDrawingPrompt,
  resolveMaterializableReferenceUrl,
  resolveReferenceSources,
  type PromptProcessorOptions,
} from '../src/杠杠の生图机/prompt-processor';
import { buildGalleryAliasIndex, type GalleryAliasEntry } from '../src/杠杠の生图机/gallery-reference';
import { CONFIRMED_SHOT_FOLDER_NAME } from '../src/杠杠の生图机/shot-storage';
import type { ImageApiProfile } from '../src/杠杠の生图机/settings';
import type {
  AvatarReferenceReadResult,
} from '../src/杠杠の生图机/avatar-references';
import type { ImageOutputPreset } from '../src/杠杠の生图机/pipeline-types';
import {
  applyGalleryIndexFromFiles,
  createEmptyAudit,
  galleryReferenceToastNotice,
  GALLERY_MATCHED_COUNT_LIMIT,
} from '../src/杠杠の生图机/runtime';
import {
  buildPromptEditorReferenceCandidates,
  describePromptEditorGalleryPreview,
  openImagePromptEditor,
  selectPromptEditorReferenceSources,
  type ImagePromptEditorInput,
} from '../src/杠杠の生图机/prompt-editor';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function entry(filename: string, label: string, aliases: string[]): GalleryAliasEntry {
  return { filename, label, aliases };
}

function emptyAvatarReferences(): AvatarReferenceReadResult {
  return { references: [], failedSources: [] };
}

function preset(overrides: Partial<ImageOutputPreset> = {}): ImageOutputPreset {
  return {
    id: 'preset',
    name: '韩式线条风',
    templateText: '{{reference_sources}}\n{{xx}}',
    useAvatarReferences: false,
    useGalleryReferences: true,
    ...overrides,
  };
}

/** Run an action while capturing console.warn output for assertions. */
async function captureWarn(action: () => Promise<void> | void): Promise<string> {
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
// 固定段序组装:①身份 → ②服装(预留)→ ③场景(预留)→ ④画风 → ⑤上一镜头图
// ---------------------------------------------------------------------------

const aliasIndex = buildGalleryAliasIndex([
  '参考-角色-a1,a2.png',
  '参考-角色-b1.png',
  '参考-服装-c1.png',
  '参考-风格-韩式线条风.png',
  '主图-噪声.png',
]);

function testGalleryDeclarationOrder(): void {
  const assembly = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：b1，a2；',
    galleryAliasIndex: aliasIndex,
  });
  equal(assembly.sources.map(source => source.kind), ['gallery-reference', 'gallery-reference'], '图鉴命中应按声明序排列');
  equal(assembly.sources.map(source => source.label), ['图鉴·角色(b1)', '图鉴·角色(a2)'], '编号标签应为 图鉴·<标签>(<最早命中别名>)');
  const folderRoot = `/user/images/${CONFIRMED_SHOT_FOLDER_NAME}/`;
  equal(assembly.sources.map(source => source.value), [`${folderRoot}参考-角色-b1.png`, `${folderRoot}参考-角色-a1,a2.png`], '命中文件 value 应为专用图库文件夹下的服务器相对路径');
  equal(assembly.status, 'matched', '全部声明命中应为 matched');
  equal(assembly.galleryMatches.length, 2, '命中文件数应与声明命中一致');
  equal(assembly.unmatchedAliases, [], '全部命中时缺失清单应为空');
  equal(assembly.declarationFound, true, '应报告读到了声明');
  equal(assembly.scannedAliases, [], '有声明时不应做兜底扫描');
}

function testGallerySameFileMultipleAliases(): void {
  const assembly = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：a2，a1；',
    galleryAliasIndex: aliasIndex,
  });
  equal(assembly.sources.length, 1, '同一文件多次命中只应附一次');
  equal(assembly.sources[0].label, '图鉴·角色(a2)', '编号标签应使用声明位置最早的命中别名');
}

function testAvatarPriorityOverGallery(): void {
  const assembly = assembleOutputReferenceSources({
    preset: preset({ useAvatarReferences: true }),
    avatarReferences: {
      references: [
        { source: 'persona', value: '/user/images/user.png' },
        { source: 'character', value: '/characters/char.png' },
      ],
      failedSources: [],
    },
    promptText: '当前出场角色：a2；',
    galleryAliasIndex: aliasIndex,
  });
  equal(
    assembly.sources.map(source => source.kind),
    ['user-avatar', 'character-avatar'],
    '双真数据下头像优先(与设置层互斥修复同口径),不产出图鉴来源',
  );
  equal(assembly.status, 'off', '双真时图鉴匹配状态应为 off');
}

function testGalleryNoDeclaration(): void {
  const withScanHits = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '画面里 a2 站在窗边',
    galleryAliasIndex: aliasIndex,
  });
  equal(withScanHits.sources, [], '声明缺失时一张不附');
  equal(withScanHits.status, 'no_declaration', '声明缺失状态应为 no_declaration');
  equal(withScanHits.scannedAliases, ['a2'], '声明缺失时应记录兜底扫描命中(仅检测,不附图)');

  const withoutHits = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '画面里没有认识的人',
    galleryAliasIndex: aliasIndex,
  });
  equal(withoutHits.status, 'no_declaration', '声明缺失且零扫描命中同为 no_declaration');
  equal(withoutHits.scannedAliases, [], '零扫描命中应为空');
}

function testGalleryNoMatchAndPartial(): void {
  const noMatch = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：z9；',
    galleryAliasIndex: aliasIndex,
  });
  equal(noMatch.status, 'no_match', '有声明零匹配应为 no_match');
  equal(noMatch.sources, [], '零匹配时不附图鉴来源');
  equal(noMatch.unmatchedAliases, ['z9'], '声明的缺失角色应单列');

  const partial = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：a2，z9；',
    galleryAliasIndex: aliasIndex,
  });
  equal(partial.status, 'partial', '部分命中应为 partial');
  equal(partial.sources.map(source => source.label), ['图鉴·角色(a2)'], '部分命中只附命中的文件');
  equal(partial.unmatchedAliases, ['z9'], '部分命中时缺失角色单列');
}

function testGalleryOff(): void {
  const switchedOff = assembleOutputReferenceSources({
    preset: preset({ useGalleryReferences: false }),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：a2；',
    galleryAliasIndex: aliasIndex,
  });
  equal(switchedOff.sources, [], '图鉴开关关闭时不附图鉴来源');
  equal(switchedOff.status, 'off', '图鉴开关关闭时状态应为 off');

  const withoutIndex = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：a2；',
  });
  equal(withoutIndex.status, 'no_match', '未提供别名索引等价于图鉴为空,有声明零匹配');
  equal(withoutIndex.sources, [], '空索引不产出图鉴来源');
}

function testStyleSegment(): void {
  const found = assembleOutputReferenceSources({
    preset: preset({ useGalleryReferences: false, useStyleReference: true }),
    avatarReferences: emptyAvatarReferences(),
    promptText: '',
    galleryAliasIndex: aliasIndex,
  });
  equal(found.sources.map(source => source.kind), ['style-reference'], '风格段独立于图鉴模式,命中时单独成段');
  equal(found.sources[0].label, '风格·韩式线条风', '风格编号标签应为 风格·<预设名>');
  equal(
    found.sources[0].value,
    `/user/images/${CONFIRMED_SHOT_FOLDER_NAME}/参考-风格-韩式线条风.png`,
    '风格命中文件 value 应为专用图库文件夹下的服务器相对路径',
  );
  equal(found.styleRequested && found.styleFound, true, '风格段应报告命中');
  equal(found.status, 'off', '图鉴开关关闭时匹配状态为 off,与风格段无关');

  const missing = assembleOutputReferenceSources({
    preset: preset({ useGalleryReferences: false, useStyleReference: true, name: '不存在的预设' }),
    avatarReferences: emptyAvatarReferences(),
    promptText: '',
    galleryAliasIndex: aliasIndex,
  });
  equal(missing.sources, [], '同名风格图缺失时段为空且不影响其他段');
  equal(missing.styleRequested && !missing.styleFound, true, '风格段应报告开启但缺失');

  const off = assembleOutputReferenceSources({
    preset: preset({ useGalleryReferences: false }),
    avatarReferences: emptyAvatarReferences(),
    promptText: '',
    galleryAliasIndex: aliasIndex,
  });
  equal(off.styleRequested, false, '风格开关关闭时段不启用');
}

function testSegmentOrder(): void {
  const assembly = assembleOutputReferenceSources({
    preset: preset({ useStyleReference: true, usePreviousStoryImage: true }),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：a2；',
    previousStoryImage: 'previous-url',
    galleryAliasIndex: aliasIndex,
  });
  equal(
    assembly.sources.map(source => source.kind),
    ['gallery-reference', 'style-reference', 'previous-story-image'],
    '固定段序:身份(图鉴)→ 画风(风格)→ 上一镜头图收尾',
  );
  equal(
    assembly.sources.map(source => source.label),
    ['图鉴·角色(a2)', '风格·韩式线条风', '上一镜头图'],
    '编号标签按段序与要求格式渲染',
  );
}

function testNoUpperBound(): void {
  const wideIndex = buildGalleryAliasIndex([
    '参考-角色-p1.png',
    '参考-角色-p2.png',
    '参考-角色-p3.png',
    '参考-角色-p4.png',
    '参考-角色-p5.png',
  ]);
  const assembly = assembleOutputReferenceSources({
    preset: preset(),
    avatarReferences: emptyAvatarReferences(),
    promptText: '当前出场角色：p5，p4，p3，p2，p1；',
    galleryAliasIndex: wideIndex,
  });
  equal(assembly.sources.length, 5, '命中数量不设上限,声明几个附几个');
  equal(
    assembly.sources.map(source => source.label),
    ['图鉴·角色(p5)', '图鉴·角色(p4)', '图鉴·角色(p3)', '图鉴·角色(p2)', '图鉴·角色(p1)'],
    '五张命中按声明序排列',
  );
}

function testPreviousStoryLabel(): void {
  const sources = resolveReferenceSources(
    {
      references: [{ source: 'character', value: '/characters/char.png' }],
      failedSources: [],
    },
    'previous-url',
  );
  equal(
    sources.map(source => source.label),
    ['角色头像', '上一镜头图'],
    '头像模式的上一镜头来源收尾,标签为 上一镜头图',
  );
}

// ---------------------------------------------------------------------------
// 物化基准:服务器相对路径显式相对 location.origin 解析(srcdoc 基准)
// ---------------------------------------------------------------------------

function testGalleryReferenceServerPath(): void {
  equal(
    galleryReferenceServerPath('参考-角色-a2.png'),
    `/user/images/${CONFIRMED_SHOT_FOLDER_NAME}/参考-角色-a2.png`,
    '图鉴命中文件的服务器相对路径应落在专用图库文件夹',
  );
  equal(galleryReferenceServerPath('   '), '', '空白文件名应返回空路径(物化阶段剔除)');
}

function testResolveMaterializableReferenceUrl(): void {
  equal(
    resolveMaterializableReferenceUrl('/user/images/shot.png', 'http://host:8000'),
    'http://host:8000/user/images/shot.png',
    '服务器相对路径应显式相对注入 origin 解析',
  );
  equal(
    resolveMaterializableReferenceUrl('https://else.example/a.png', 'http://host'),
    'https://else.example/a.png',
    '已是绝对 URL 的引用原样放行',
  );
  equal(
    resolveMaterializableReferenceUrl('data:image/png;base64,AAA', 'http://host'),
    'data:image/png;base64,AAA',
    'data URL 原样放行',
  );
  equal(resolveMaterializableReferenceUrl('/user/images/shot.png', null), '', '显式 null 基准应返回空(物化失败剔除)');
  equal(resolveMaterializableReferenceUrl('/user/images/shot.png', 'ftp://bad'), '', '非法基准应返回空');

  const globals = globalThis as { location?: { origin?: string } };
  const previousLocation = globals.location;
  globals.location = { origin: 'https://st.example' };
  try {
    const serverPath = galleryReferenceServerPath('参考-角色-a2.png');
    const resolved = resolveMaterializableReferenceUrl(serverPath);
    assert(resolved.startsWith('https://st.example/'), '缺省基准必须取当前文档 location.origin(srcdoc 下为宿主页)');
    equal(
      `${new URL(resolved).origin}${decodeURIComponent(new URL(resolved).pathname)}`,
      `https://st.example${serverPath}`,
      'srcdoc 基准固定:相对路径应解析为宿主页 origin 下的同路径(非 ASCII 文件名按 URL 规则编码)',
    );
  } finally {
    if (typeof previousLocation === 'undefined') delete globals.location;
    else globals.location = previousLocation;
  }
}

// ---------------------------------------------------------------------------
// processDrawingPrompt 集成:编号与最终实际发送一致、剔除不占编号
// ---------------------------------------------------------------------------

const apiProfile: ImageApiProfile = {
  id: 'profile',
  name: '测试配置',
  serviceUrl: 'https://api.test/v1/images/edits',
  modelListUrl: '',
  apiKey: '',
  model: 'test-model',
  imageSize: '1024x1024',
  quality: 'auto',
  imageCount: 1,
  timeoutMs: 5000,
  retryAttempts: 0,
  retryDelayMs: 0,
  requestMode: 'auto',
  multipartImageField: 'auto',
  jsonReferenceField: 'images',
  extraBody: {},
};

async function withImageFetchMock(
  run: (calls: string[]) => Promise<void>,
  failMarker = '',
): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousFetch = globals.fetch;
  const calls: string[] = [];
  globals.window = { setTimeout, clearTimeout, atob, btoa };
  globals.fetch = (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (failMarker && url.includes(encodeURIComponent(failMarker))) {
      return Promise.resolve(new Response('gone', { status: 404 }));
    }
    return Promise.resolve(
      new Response(new Uint8Array([7, 8, 9]), { headers: { 'Content-Type': 'image/png' } }),
    );
  };
  try {
    await run(calls);
  } finally {
    if (typeof previousWindow === 'undefined') delete globals.window;
    else globals.window = previousWindow;
    if (typeof previousFetch === 'undefined') delete globals.fetch;
    else globals.fetch = previousFetch;
  }
}

function isDataUrl(value: string): boolean {
  return value.startsWith('data:image/');
}

async function testProcessDrawingPromptGalleryIntegration(): Promise<void> {
  // 集成测试用独立索引:两张命中文件,第二块模拟其中一张物化 404 被剔除。
  const integrationIndex = buildGalleryAliasIndex(['参考-角色-a2.png', '参考-角色-b1.png']);
  await withImageFetchMock(async calls => {
    const result = await processDrawingPrompt(preset(), '当前出场角色：a2，b1；', {
      gallery: { aliasIndex: integrationIndex, baseOrigin: 'http://st.test' },
      referenceContext: { profile: apiProfile, signal: new AbortController().signal },
    });
    equal(result.galleryMatch?.status, 'matched', '集成路径应带出 matched 状态');
    equal(result.galleryMatch?.matchedCount, 2, '组装命中数应为 2');
    equal(result.galleryMatch?.style, 'off', '风格开关关闭时摘要为 off');
    assert(
      (result.referenceImages ?? []).length === 2 && result.referenceImages!.every(isDataUrl),
      '图鉴命中应被物化为可发送的图片数据(现行物化管线)',
    );
    equal(
      result.prompt,
      '图1：图鉴·角色(a2)\n图2：图鉴·角色(b1)\n当前出场角色：a2，b1；',
      '{{reference_sources}} 应按最终实际发送列表编号',
    );
    assert(calls.length === 2, '每张命中图只应发起一次参考图读取');
  });

  await withImageFetchMock(
    async () => {
      const result = await processDrawingPrompt(preset(), '当前出场角色：a2，b1；', {
        gallery: { aliasIndex: integrationIndex, baseOrigin: 'http://st.test' },
        referenceContext: { profile: apiProfile, signal: new AbortController().signal },
      });
      equal(result.referenceSources?.map(source => source.label), ['图鉴·角色(a2)'], '物化失败的图鉴来源应按可选来源规则剔除');
      equal(result.galleryMatch?.status, 'matched', '匹配摘要反映声明匹配阶段的判定;物化剔除只影响实际发送与 matched_count');
      equal(
        result.prompt.split('\n')[0],
        '图1：图鉴·角色(a2)',
        '剔除后编号必须连续且与真实发送一致,不占编号',
      );
    },
    '参考-角色-b1.png',
  );

  const withoutGallery = await processDrawingPrompt(
    preset({ useGalleryReferences: false }),
    '当前出场角色：a2，b1；',
    { gallery: { aliasIndex } },
  );
  equal(withoutGallery.galleryMatch?.status, 'off', '开关关闭时摘要为 off');
  assert(!('referenceImages' in withoutGallery), '无可用来源时不得携带 referenceImages');

  const legacyCall = await processDrawingPrompt(preset(), '场景 prompt', {});
  equal(legacyCall.prompt, 'null\n场景 prompt', '省略 gallery 上下文时模板行为不变(空来源列表仍展开为 null)');
  assert(legacyCall.galleryMatch === undefined, '省略 gallery 上下文时不得带出图鉴摘要(旧调用方行为不变)');

  const presetResolvedSources: PromptProcessorOptions['resolvedReferenceSources'] = [
    { kind: 'user-avatar', label: 'User 头像', value: 'u' },
  ];
  const manualCall = await processDrawingPrompt(preset(), '场景 prompt', {
    gallery: { aliasIndex },
    resolvedReferenceSources: presetResolvedSources,
  });
  assert(manualCall.galleryMatch === undefined, '调用方预解析来源(手动重绘)不跑声明制匹配');
  equal(manualCall.referenceImages, ['u'], '预解析来源原样保留');
  equal(presetResolvedSources.length, 1, '不得修改调用方来源快照');
}

// ---------------------------------------------------------------------------
// toast 文案与别名索引处置
// ---------------------------------------------------------------------------

function testToastNotice(): void {
  equal(
    galleryReferenceToastNotice('no_declaration', 2),
    '检测到出场角色但未声明，本次未附图鉴参考',
    '声明缺失且扫描到别名应提示未声明',
  );
  equal(
    galleryReferenceToastNotice('no_declaration', 0),
    '未读到出场角色声明，本次未附图鉴参考',
    '声明缺失且零扫描命中应提示未读到声明',
  );
  equal(
    galleryReferenceToastNotice('no_match', 0),
    '声明的出场角色在图鉴中无匹配',
    '有声明零匹配应提示无匹配',
  );
  equal(galleryReferenceToastNotice('matched', 0), null, '成功匹配不弹 toast');
  equal(galleryReferenceToastNotice('partial', 0), null, '部分命中不弹 toast(预演与审计体现)');
  equal(galleryReferenceToastNotice('off', 0), null, '图鉴模式关闭不弹 toast');
}

async function testApplyGalleryIndexFromFiles(): Promise<void> {
  const warn = await captureWarn(() => {
    equal(applyGalleryIndexFromFiles(null), [], '列表失败(null)应把索引置空');
  });
  assert(warn.includes('<杠杠の生图机>'), '列表失败应留下脚本前缀警告');
  assert(!warn.includes('.png') && !warn.includes('/user/images'), '警告不得包含文件名或图片路径');

  equal(
    applyGalleryIndexFromFiles(['参考-角色-a2.png', '主图-噪声.png']),
    [entry('参考-角色-a2.png', '角色', ['a2'])],
    '成功列表应建为别名索引,非参考-前缀文件不建条目',
  );
  equal(applyGalleryIndexFromFiles([]), [], '空列表应得到空索引');
}

function testAuditFields(): void {
  const audit = createEmptyAudit();
  equal(audit.continuity.reference_match, 'off', '审计初始 reference_match 应为 off');
  equal(audit.continuity.matched_count, 0, '审计初始 matched_count 应为 0');
  assert(GALLERY_MATCHED_COUNT_LIMIT > 0 && Number.isInteger(GALLERY_MATCHED_COUNT_LIMIT), 'matched_count 有界上限应为正整数');
}

// ---------------------------------------------------------------------------
// prompt-editor:预演文案、来源选择与候选
// ---------------------------------------------------------------------------

function testDescribePromptEditorGalleryPreview(): void {
  equal(
    describePromptEditorGalleryPreview({
      galleryEnabled: true,
      declarationFound: true,
      matches: ['图鉴·角色(a2)', '图鉴·服装(b1)'],
      missingAliases: ['z9'],
      styleRequested: true,
      styleFound: true,
      styleLabel: '风格·韩式线条风',
    }),
    '图鉴参考：本次将附图鉴·角色(a2)、图鉴·服装(b1)。\n声明了但图鉴中无匹配：z9。\n风格参考：本次将附风格·韩式线条风。',
    '预演应列出命中(标签+别名)、缺失角色与风格段状态',
  );
  equal(
    describePromptEditorGalleryPreview({
      galleryEnabled: true,
      declarationFound: true,
      matches: [],
      missingAliases: [],
      styleRequested: false,
      styleFound: false,
    }),
    '声明的出场角色在图鉴中无匹配，本次不附图鉴参考。',
    '有声明零命中应提示无匹配',
  );
  equal(
    describePromptEditorGalleryPreview({
      galleryEnabled: true,
      declarationFound: false,
      matches: [],
      missingAliases: [],
      styleRequested: false,
      styleFound: false,
    }),
    '未读到出场角色声明，本次不附图鉴参考。',
    '声明缺失应提示未读到声明',
  );
  equal(
    describePromptEditorGalleryPreview({
      galleryEnabled: false,
      declarationFound: false,
      matches: [],
      missingAliases: [],
      styleRequested: true,
      styleFound: false,
    }),
    '风格参考：未找到与出图预设同名的风格参考图，本次不附。',
    '风格段缺失仅在预演中提示,不弹 toast',
  );
  equal(
    describePromptEditorGalleryPreview({
      galleryEnabled: false,
      declarationFound: false,
      matches: [],
      missingAliases: [],
      styleRequested: false,
      styleFound: false,
    }),
    '',
    '图鉴与风格都关闭时不渲染预演',
  );
}

function testSelectPromptEditorReferenceSources(): void {
  const sources = [
    { kind: 'user-avatar' as const, label: 'User 头像', value: 'u' },
    { kind: 'gallery-reference' as const, label: '图鉴·角色(a2)', value: 'g' },
    { kind: 'style-reference' as const, label: '风格·韩式线条风', value: 's' },
    { kind: 'previous-story-image' as const, label: '上一镜头图', value: 'p' },
  ];
  equal(
    selectPromptEditorReferenceSources(sources, {
      known: true,
      useAvatarReferences: true,
      usePreviousStoryImage: true,
    }).map(source => source.kind),
    ['user-avatar', 'previous-story-image'],
    '旧调用(未提供 useGalleryReferences)不得误选图鉴/风格来源',
  );
  equal(
    selectPromptEditorReferenceSources(sources, {
      known: true,
      useAvatarReferences: false,
      useGalleryReferences: true,
      usePreviousStoryImage: false,
    }).map(source => source.kind),
    ['gallery-reference', 'style-reference'],
    '图鉴开关开启时只保留图鉴/风格来源',
  );
}

function testBuildPromptEditorReferenceCandidates(): void {
  equal(
    buildPromptEditorReferenceCandidates(undefined, {
      avatarReferences: true,
      galleryReferences: true,
      previousStoryImage: true,
    }).map(source => source.kind),
    ['user-avatar', 'character-avatar', 'gallery-reference', 'style-reference', 'previous-story-image'],
    '候选顺序应保持固定段序(身份→图鉴→风格→上一镜头)',
  );
  equal(
    buildPromptEditorReferenceCandidates(undefined, {
      avatarReferences: true,
      previousStoryImage: true,
    }).map(source => source.kind),
    ['user-avatar', 'character-avatar', 'previous-story-image'],
    '旧 availability(未提供 galleryReferences)不生成图鉴候选',
  );
  equal(
    buildPromptEditorReferenceCandidates(['gallery-reference', 'style-reference'], {
      avatarReferences: false,
      previousStoryImage: false,
    }).map(source => source.kind),
    ['gallery-reference', 'style-reference'],
    '旧 placement 已带图鉴来源时应恢复候选',
  );
}

// ---------------------------------------------------------------------------
// prompt-editor 弹窗:预演渲染 + 确认时按场景文本准备多来源
// ---------------------------------------------------------------------------

type FakeEvent = {
  type: string;
  key?: string;
  shiftKey?: boolean;
  target?: FakeElement;
  preventDefault: () => void;
  stopPropagation: () => void;
};
type FakeListener = (event: FakeEvent) => void;

class FakeDocument {
  readonly body = new FakeElement(this);
  readonly defaultView = {
    getComputedStyle: () => ({ display: '', visibility: 'visible' }),
  };
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<FakeListener>>();

  createElement(tag: string): FakeElement {
    const element = new FakeElement(this);
    element.tagName = tag.toUpperCase();
    return element;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(type: string, event: Partial<FakeEvent> = {}): void {
    const dispatched: FakeEvent = {
      type,
      target: this.activeElement ?? undefined,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(dispatched);
  }
}

class FakeElement {
  tagName = 'DIV';
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  inert = false;
  type = '';
  checked = false;
  value = '';
  rows = 0;
  autocomplete = '';
  spellcheck = false;
  tabIndex = 0;
  readonly style = { display: '', visibility: '', pointerEvents: '', aspectRatio: '' };
  readonly children: FakeElement[] = [];
  parent: FakeElement | FakeDocument | null = null;
  readonly ownerDocument: FakeDocument;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<FakeListener>>();

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  get isConnected(): boolean {
    return this.parent !== null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(_selector: string): FakeElement | null {
    return null;
  }

  append(...nodes: FakeElement[]): void {
    nodes.forEach(node => {
      node.parent = this;
      this.children.push(node);
    });
  }

  remove(): void {
    if (this.parent instanceof FakeElement) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    } else if (this.parent instanceof FakeDocument) {
      this.parent.body.children.splice(this.parent.body.children.indexOf(this), 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(type: string, event: Partial<FakeEvent> = {}): void {
    const dispatched: FakeEvent = {
      type,
      target: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...event,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(dispatched);
  }

  click(): void {
    this.dispatchEvent('click');
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => {
      if (selector.startsWith('.')) return element.className.split(/\s+/u).includes(selector.slice(1));
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const result: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (matches(element)) result.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return result;
  }
}

async function withFakeDocument<T>(run: (ownerDocument: FakeDocument) => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as { document?: unknown; $?: unknown };
  const previousDocument = globals.document;
  const previousDollar = globals.$;
  const ownerDocument = new FakeDocument();
  globals.document = ownerDocument;
  delete globals.$;
  try {
    return await run(ownerDocument);
  } finally {
    if (typeof previousDocument === 'undefined') delete globals.document;
    else globals.document = previousDocument;
    if (typeof previousDollar === 'undefined') delete globals.$;
    else globals.$ = previousDollar;
  }
}

function requireValue<T>(value: T, message: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
  return value as NonNullable<T>;
}

async function awaitWithTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时`)), 1000);
    }),
  ]);
}

function editorInput(overrides: Partial<ImagePromptEditorInput> = {}): ImagePromptEditorInput {
  return {
    prompt: '当前出场角色：a2',
    outputPreset: {
      id: 'output',
      name: '韩式线条风',
      templateText: '{{xx}}',
      useAvatarReferences: false,
      useGalleryReferences: true,
      usePreviousStoryImage: false,
    },
    avatarReferences: { enabled: false, availableSources: [], failedSources: [] },
    referenceSources: [],
    referenceSelection: { known: true, useAvatarReferences: false, useGalleryReferences: true, usePreviousStoryImage: false },
    referenceAvailability: { avatarReferences: false, galleryReferences: true, previousStoryImage: false },
    ...overrides,
  };
}

async function testPromptEditorGalleryPreviewAndPreparation(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    let preparedScenePrompt: string | null = null;
    let preparationCalls = 0;
    const editorPromise = openImagePromptEditor(
      editorInput({
        galleryPreview: {
          galleryEnabled: true,
          declarationFound: true,
          matches: ['图鉴·角色(a2)'],
          missingAliases: ['z9'],
          styleRequested: true,
          styleFound: false,
        },
        prepareReferenceSources: async selection => {
          preparationCalls += 1;
          preparedScenePrompt = selection.scenePrompt ?? null;
          return [
            { kind: 'gallery-reference', label: '图鉴·角色(a2)', value: 'gallery-1' },
            { kind: 'gallery-reference', label: '图鉴·角色(a1)', value: 'gallery-2' },
            { kind: 'style-reference', label: '风格·韩式线条风', value: 'style' },
          ];
        },
      }),
    );
    const dialog = requireValue(
      ownerDocument.body.querySelector('.story-image-prompt-editor'),
      '编辑器应挂载',
    );
    const preview = requireValue(
      dialog.querySelector('.story-image-prompt-editor__gallery-preview'),
      '开启图鉴/风格段时应渲染预演段落',
    );
    assert(!preview.hidden, '有预演内容时预演段落应可见');
    equal(
      preview.textContent,
      '图鉴参考：本次将附图鉴·角色(a2)。\n声明了但图鉴中无匹配：z9。\n风格参考：未找到与出图预设同名的风格参考图，本次不附。',
      '预演段落应渲染命中、缺失角色与风格段状态',
    );
    const confirm = requireValue(
      dialog.querySelector('.story-image-prompt-editor__button--primary'),
      '应渲染确认按钮',
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    confirm.click();
    const result = requireValue(
      await awaitWithTimeout(editorPromise, '图鉴参考确认'),
      '确认后应返回编辑结果',
    );
    equal(preparationCalls >= 1, true, '图鉴开关开启时应触发参考准备');
    equal(preparedScenePrompt, '当前出场角色：a2', '参考准备必须携带确认时的场景文本(声明制匹配基准)');
    equal(
      result.referenceSources?.map(source => `${source.kind}:${source.value}`),
      ['gallery-reference:gallery-1', 'gallery-reference:gallery-2', 'style-reference:style'],
      '确认后应保留全部物化来源;同 kind 的多个图鉴命中不得互相覆盖',
    );
  });
}

async function testPromptEditorHidesPreviewWhenDisabled(): Promise<void> {
  await withFakeDocument(async ownerDocument => {
    const editorPromise = openImagePromptEditor(
      editorInput({
        referenceSelection: { known: true, useAvatarReferences: false, usePreviousStoryImage: false },
        referenceAvailability: { avatarReferences: false, previousStoryImage: false },
      }),
    );
    const dialog = requireValue(ownerDocument.body.querySelector('.story-image-prompt-editor'), '编辑器应挂载');
    const preview = dialog.querySelector('.story-image-prompt-editor__gallery-preview');
    assert(preview !== null && preview.hidden, '未提供预演快照时预演段落应隐藏');
    preview.ownerDocument.dispatchEvent('keydown', { key: 'Escape' });
    equal(await awaitWithTimeout(editorPromise, '取消编辑'), null, 'Esc 应关闭编辑器');
  });
}

// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  testGalleryDeclarationOrder();
  testGallerySameFileMultipleAliases();
  testAvatarPriorityOverGallery();
  testGalleryNoDeclaration();
  testGalleryNoMatchAndPartial();
  testGalleryOff();
  testStyleSegment();
  testSegmentOrder();
  testNoUpperBound();
  testPreviousStoryLabel();
  testGalleryReferenceServerPath();
  testResolveMaterializableReferenceUrl();
  await testProcessDrawingPromptGalleryIntegration();
  testToastNotice();
  await testApplyGalleryIndexFromFiles();
  testAuditFields();
  testDescribePromptEditorGalleryPreview();
  testSelectPromptEditorReferenceSources();
  testBuildPromptEditorReferenceCandidates();
  await testPromptEditorGalleryPreviewAndPreparation();
  await testPromptEditorHidesPreviewWhenDisabled();
  console.info('<杠杠の生图机> story image gallery assembly tests passed');
}

void run().catch(error => {
  console.error(error);
  (globalThis as typeof globalThis & { process?: { exitCode?: number } }).process!.exitCode = 1;
});
