import {
  CONTINUOUS_STORY_OUTPUT_EXAMPLE,
  DEFAULT_OUTPUT_PRESET,
  DEFAULT_OUTPUT_TEMPLATE,
  GALLERY_DECLARATION_INSTRUCTION,
  ImageOutputPresetSchema,
  OUTPUT_REFERENCE_MUTEX_NOTICES,
  createOutputPreset,
  normalizeOutputPreset,
  normalizeOutputPresets,
  repairOutputReferenceExclusivity,
  toggleOutputReferenceSwitch,
  updateOutputPreset,
} from '../src/杠杠の生图机/output-preset';
import { parseStoryImageSettings, type ImageApiProfile } from '../src/杠杠の生图机/settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function profile(id: string): ImageApiProfile {
  return {
    id,
    name: id,
    serviceUrl: `https://${id}.test/v1/images/generations`,
    modelListUrl: '',
    apiKey: '',
    model: `${id}-model`,
    imageSize: '1024x1024',
    quality: 'auto',
    imageCount: 1,
    timeoutMs: 120_000,
    retryAttempts: 0,
    retryDelayMs: 1_500,
    requestMode: 'auto',
    multipartImageField: 'auto',
    jsonReferenceField: 'images',
    extraBody: {},
  };
}

// ---------------------------------------------------------------------------
// 1. 默认值(执行简报 §2:useGalleryReferences 默认 false)
// ---------------------------------------------------------------------------

equal(DEFAULT_OUTPUT_PRESET.useGalleryReferences, false, '默认出图预设不得默认开启图鉴参考匹配');
equal(DEFAULT_OUTPUT_PRESET.useAvatarReferences, false, '默认出图预设也不得默认开启头像参考');
equal(
  ImageOutputPresetSchema.parse({ id: 'schema-default' }).useGalleryReferences,
  false,
  '出图预设 schema 缺省应补 useGalleryReferences=false',
);
equal(createOutputPreset({ id: 'fresh' }).useGalleryReferences, false, '新建出图预设默认关闭图鉴参考匹配');
equal(
  normalizeOutputPreset({ id: 'missing-switch', name: '缺开关', templateText: '{{xx}}' })?.useGalleryReferences,
  false,
  '归一化缺少图鉴开关时应补 false',
);
equal(
  normalizeOutputPreset({ id: 'bad-switch', useGalleryReferences: 'yes' })?.useGalleryReferences,
  false,
  '非法图鉴开关值应回退 false',
);
equal(
  normalizeOutputPreset({ id: 'bad-avatar', useAvatarReferences: 'on' })?.useGalleryReferences,
  false,
  '头像开关非法时图鉴开关仍应回退 false',
);

const defaults = parseStoryImageSettings({ apiProfiles: [profile('profile-a')] });
equal(defaults.outputPresets.length, 1, '新设置应恰好带一个默认出图预设');
equal(defaults.outputPresets[0].useGalleryReferences, false, '解析新设置时图鉴参考匹配应默认关闭');

// ---------------------------------------------------------------------------
// 2. 默认模板含声明指令(执行简报 §0.2:正文 AI 在 <pic> 中输出声明一行)
// ---------------------------------------------------------------------------

assert(DEFAULT_OUTPUT_PRESET.templateText.startsWith('{{xx}}'), '默认出图预设模板必须保留 {{xx}} 占位符');
assert(
  DEFAULT_OUTPUT_PRESET.templateText.includes(GALLERY_DECLARATION_INSTRUCTION),
  '默认出图预设模板应原样包含声明指令句',
);
assert(
  GALLERY_DECLARATION_INSTRUCTION.includes('当前出场角色：a2，b1；'),
  '声明指令句必须给出可解析的“当前出场角色”声明示例',
);
assert(GALLERY_DECLARATION_INSTRUCTION.includes('<pic>'), '声明指令句应说明声明写在 <pic> 提示词中');
equal(DEFAULT_OUTPUT_TEMPLATE, '{{xx}}', '模板回退默认保持 {{xx}}');
equal(createOutputPreset({ id: 'fresh-template' }).templateText, '{{xx}}', '新建空白预设模板不带声明指令');
assert(!CONTINUOUS_STORY_OUTPUT_EXAMPLE.templateText.includes('当前出场角色'), '连续剧情示例预设模板不受声明指令影响');
assert(
  !('useGalleryReferences' in CONTINUOUS_STORY_OUTPUT_EXAMPLE),
  '连续剧情示例预设不引入图鉴开关(保持 v0.5.0 行为)',
);
const keptUserPreset = normalizeOutputPresets([
  { id: 'kept', name: '用户已有', templateText: '画面：{{xx}}', useAvatarReferences: true },
]);
equal(keptUserPreset[0].templateText, '画面：{{xx}}', '已有用户预设模板必须原样保留(不受声明指令影响)');

// ---------------------------------------------------------------------------
// 3. 解析修复:头像与图鉴同时为 true 时保留头像、强制关闭图鉴(执行简报 §2/§3.5)
// ---------------------------------------------------------------------------

const repairedPreset = normalizeOutputPreset({
  id: 'dual-on',
  name: '双开',
  templateText: '{{xx}}',
  useAvatarReferences: true,
  useGalleryReferences: true,
});
assert(repairedPreset, '双开预设应能被归一化');
equal(
  [repairedPreset.useAvatarReferences, repairedPreset.useGalleryReferences],
  [true, false],
  '归一化双开预设必须保留头像、强制关闭图鉴',
);

const repairedList = normalizeOutputPresets([
  {
    id: 'keep-gallery',
    name: '仅图鉴',
    templateText: '{{xx}}',
    useGalleryReferences: true,
    useAvatarReferences: false,
  },
  { id: 'fix-me', name: '双开', templateText: '{{xx}}', useAvatarReferences: true, useGalleryReferences: true },
]);
equal(
  [repairedList[0].useAvatarReferences, repairedList[0].useGalleryReferences],
  [false, true],
  '仅开启图鉴的预设不应被修复逻辑改写',
);
equal(
  [repairedList[1].useAvatarReferences, repairedList[1].useGalleryReferences],
  [true, false],
  '归一化列表中的双开预设也应被修复',
);

const repairedInSettings = parseStoryImageSettings({
  apiProfiles: [profile('profile-a')],
  outputPresets: [{ id: 'dual-settings', name: '设置层双开', useAvatarReferences: true, useGalleryReferences: true }],
});
equal(
  [repairedInSettings.outputPresets[0].useAvatarReferences, repairedInSettings.outputPresets[0].useGalleryReferences],
  [true, false],
  '设置层解析到双真必须强制单真(保留头像)',
);

const basePresets = [createOutputPreset({ id: 'p1', name: 'P1' })];
const patched = updateOutputPreset(basePresets, 'p1', { useAvatarReferences: true, useGalleryReferences: true });
equal(
  [patched[0].useAvatarReferences, patched[0].useGalleryReferences],
  [true, false],
  'updateOutputPreset 写入双真也应被修复为保留头像、关闭图鉴',
);

equal(
  [
    repairOutputReferenceExclusivity({
      id: 'r1',
      name: 'r1',
      templateText: '{{xx}}',
      useAvatarReferences: true,
      useGalleryReferences: true,
    }).useGalleryReferences,
    repairOutputReferenceExclusivity({
      id: 'r2',
      name: 'r2',
      templateText: '{{xx}}',
      useAvatarReferences: false,
      useGalleryReferences: true,
    }).useGalleryReferences,
    repairOutputReferenceExclusivity({
      id: 'r3',
      name: 'r3',
      templateText: '{{xx}}',
      useAvatarReferences: true,
      useGalleryReferences: false,
    }).useGalleryReferences,
  ],
  [false, true, false],
  '互斥修复只应在双真时强制关闭图鉴,单开场景保持原状',
);

// ---------------------------------------------------------------------------
// 4. 关图鉴恢复头像能力:关闭图鉴后头像可以重新开启,且不会被自动打开
// ---------------------------------------------------------------------------

const galleryOnly = normalizeOutputPreset({ id: 'gallery-only', name: '仅图鉴', useGalleryReferences: true });
assert(galleryOnly, '仅图鉴预设应能被归一化');
const galleryOff = updateOutputPreset([galleryOnly], 'gallery-only', { useGalleryReferences: false });
equal(
  [galleryOff[0].useGalleryReferences, galleryOff[0].useAvatarReferences],
  [false, false],
  '关闭图鉴不得自动重开头像',
);
const avatarBackOn = updateOutputPreset(galleryOff, 'gallery-only', { useAvatarReferences: true });
equal(
  [avatarBackOn[0].useAvatarReferences, avatarBackOn[0].useGalleryReferences],
  [true, false],
  '关闭图鉴后头像参考恢复可开启',
);

// ---------------------------------------------------------------------------
// 5. 互斥 UI 行为:toggleOutputReferenceSwitch 组合表(执行简报 §4 Step 2 四路径)
// ---------------------------------------------------------------------------

// 路径 1:开图鉴自动关头像,并给出一句提示。
const openGalleryOverAvatar = toggleOutputReferenceSwitch(
  { useAvatarReferences: true, useGalleryReferences: false },
  'useGalleryReferences',
  true,
);
equal(
  [openGalleryOverAvatar.useAvatarReferences, openGalleryOverAvatar.useGalleryReferences],
  [false, true],
  'UI 开启图鉴参考匹配必须自动关闭头像参考',
);
equal(
  openGalleryOverAvatar.notice,
  OUTPUT_REFERENCE_MUTEX_NOTICES.useGalleryReferences,
  '开启图鉴覆盖头像时应给出图鉴侧互斥提示',
);
assert(openGalleryOverAvatar.notice?.includes('自动关闭头像参考'), '图鉴侧提示应说明已自动关闭头像参考');

// 路径 2:开头像自动关图鉴,并给出一句提示。
const openAvatarOverGallery = toggleOutputReferenceSwitch(
  { useAvatarReferences: false, useGalleryReferences: true },
  'useAvatarReferences',
  true,
);
equal(
  [openAvatarOverGallery.useAvatarReferences, openAvatarOverGallery.useGalleryReferences],
  [true, false],
  'UI 开启头像参考必须自动关闭图鉴参考匹配',
);
equal(
  openAvatarOverGallery.notice,
  OUTPUT_REFERENCE_MUTEX_NOTICES.useAvatarReferences,
  '开启头像覆盖图鉴时应给出头像侧互斥提示',
);
assert(openAvatarOverGallery.notice?.includes('自动关闭图鉴参考匹配'), '头像侧提示应说明已自动关闭图鉴参考匹配');

// 路径 3:关图鉴只关自己,头像保持关闭、恢复可开,不弹提示。
const closeGallery = toggleOutputReferenceSwitch(
  { useAvatarReferences: false, useGalleryReferences: true },
  'useGalleryReferences',
  false,
);
equal(
  [closeGallery.useAvatarReferences, closeGallery.useGalleryReferences, closeGallery.notice],
  [false, false, null],
  '关闭图鉴不得自动重开头像,也不应弹互斥提示',
);

// 路径 4:另一侧本来就关闭时正常开启,不弹提示。
const openGalleryFree = toggleOutputReferenceSwitch(
  { useAvatarReferences: false, useGalleryReferences: false },
  'useGalleryReferences',
  true,
);
equal(
  [openGalleryFree.useAvatarReferences, openGalleryFree.useGalleryReferences, openGalleryFree.notice],
  [false, true, null],
  '无冲突时开启图鉴应直接生效且不提示',
);
const openAvatarFree = toggleOutputReferenceSwitch(
  { useAvatarReferences: false, useGalleryReferences: false },
  'useAvatarReferences',
  true,
);
equal(
  [openAvatarFree.useAvatarReferences, openAvatarFree.useGalleryReferences, openAvatarFree.notice],
  [true, false, null],
  '无冲突时开启头像应直接生效且不提示',
);
const closeAvatar = toggleOutputReferenceSwitch(
  { useAvatarReferences: true, useGalleryReferences: true },
  'useAvatarReferences',
  false,
);
equal(
  [closeAvatar.useAvatarReferences, closeAvatar.useGalleryReferences, closeAvatar.notice],
  [false, true, null],
  '关闭头像不得自动重开图鉴,也不应弹互斥提示',
);

// 纯函数约束:开关工具不得改写传入状态。
const frozenState = { useAvatarReferences: true, useGalleryReferences: false };
toggleOutputReferenceSwitch(frozenState, 'useGalleryReferences', true);
equal(
  [frozenState.useAvatarReferences, frozenState.useGalleryReferences],
  [true, false],
  'toggleOutputReferenceSwitch 必须返回新状态,不得改写传入对象',
);

// ---------------------------------------------------------------------------
// 6. 风格参考开关(执行简报 §0.10):默认关闭,独立于头像/图鉴互斥
// ---------------------------------------------------------------------------

equal(DEFAULT_OUTPUT_PRESET.useStyleReference, false, '默认出图预设不得默认发送同名风格参考图');
equal(
  ImageOutputPresetSchema.parse({ id: 'schema-style' }).useStyleReference,
  false,
  '出图预设 schema 缺省应补 useStyleReference=false',
);
equal(createOutputPreset({ id: 'style-fresh' }).useStyleReference, false, '新建出图预设默认关闭风格参考');
equal(
  normalizeOutputPreset({ id: 'style-missing', name: '缺风格开关', templateText: '{{xx}}' })?.useStyleReference,
  false,
  '归一化缺少风格开关时应补 false',
);
equal(
  normalizeOutputPreset({ id: 'style-bad', useStyleReference: 'yes' })?.useStyleReference,
  false,
  '非法风格开关值应回退 false',
);
equal(
  normalizeOutputPreset({ id: 'style-kept', name: '已开风格', templateText: '{{xx}}', useStyleReference: true })
    ?.useStyleReference,
  true,
  '已有用户预设开启风格开关时必须保留',
);

const styleInSettings = parseStoryImageSettings({
  apiProfiles: [profile('profile-a')],
  outputPresets: [{ id: 'style-on', name: '风格开', templateText: '{{xx}}', useStyleReference: true }],
});
equal(styleInSettings.outputPresets[0].useStyleReference, true, '设置层解析必须保留已存储的风格开关');
equal(
  parseStoryImageSettings({ apiProfiles: [profile('profile-a')] }).outputPresets[0].useStyleReference,
  false,
  '设置层默认风格开关应为关闭',
);

// 互斥修复只关图鉴,不得改写风格开关。
const styleWithDualReferences = normalizeOutputPreset({
  id: 'style-mutex',
  name: '三开',
  templateText: '{{xx}}',
  useAvatarReferences: true,
  useGalleryReferences: true,
  useStyleReference: true,
});
assert(styleWithDualReferences, '三开预设应能被归一化');
equal(
  [
    styleWithDualReferences.useAvatarReferences,
    styleWithDualReferences.useGalleryReferences,
    styleWithDualReferences.useStyleReference,
  ],
  [true, false, true],
  '头像与图鉴双真修复时风格开关必须原样保留',
);
const stylePatched = updateOutputPreset(basePresets, 'p1', { useStyleReference: true });
equal(stylePatched[0].useStyleReference, true, 'updateOutputPreset 应支持写入风格开关');
equal(
  [stylePatched[0].useAvatarReferences, stylePatched[0].useGalleryReferences],
  [false, false],
  '风格开关写入不得连带改变头像/图鉴开关',
);

console.info('<杠杠の生图机> v0.5.2 gallery settings tests passed');
