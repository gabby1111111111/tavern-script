import {
  createDrawingPreset,
  deleteDrawingPreset,
  getCurrentDrawingPreset as getCurrentDrawingPresetFromList,
  normalizeDrawingPreset,
  updateDrawingPreset,
  type DrawingPreset,
} from '../src/杠杠の生图机/drawing-preset';
import { createPinia, setActivePinia } from 'pinia';
import {
  getCurrentDrawingPreset,
  getCurrentOutputPreset,
  getGiftApiProfile,
  getStoryApiProfile,
  parseStoryImageSettings,
  repairApiProfileRouteIds,
  type ImageApiProfile,
  useStoryImageSettingsStore,
} from '../src/杠杠の生图机/settings';

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

const profiles = [profile('profile-a'), profile('profile-b')];
const defaults = parseStoryImageSettings({ apiProfiles: profiles, activeApiProfileId: 'profile-b' });
equal(defaults.apiProfiles[0].quality, 'auto', '生图质量默认应为自动');
equal(defaults.apiProfiles[0].imageCount, 1, '生成数量默认应为一张');
assert(defaults.drawingPresets.length === 1, '新设置应至少包含一个画图预设');
assert(defaults.drawingPresets[0].instructionText.length > 0, '默认画图预设应有正文 AI 指令');
equal(defaults.currentDrawingPresetId, defaults.drawingPresets[0].id, '默认当前预设应指向可用预设');
assert(defaults.outputPresets.length === 1, '新设置应至少包含一个出图预设');
equal(defaults.outputPresets[0].templateText, '{{xx}}', '默认出图预设模板必须精确为 {{xx}}');
assert(!defaults.outputPresets[0].useAvatarReferences, '默认出图预设不得默认读取头像');
equal(defaults.currentOutputPresetId, defaults.outputPresets[0].id, '默认当前出图预设应指向可用预设');
equal(getCurrentOutputPreset(defaults).id, defaults.outputPresets[0].id, 'settings lookup 应返回当前出图预设');
equal(defaults.recentImageLimit, 10, '最近图片默认保留张数应为 10');
equal(
  defaults.displaySettings,
  { displayMode: 'inline', skipFloors: 0, generateOnSwipe: true },
  '展现设置应有安全默认值且默认允许新 Swipe 生图',
);
equal(getCurrentDrawingPreset(defaults).id, defaults.drawingPresets[0].id, 'settings lookup 应返回当前预设');

const legacyProfileWithoutGenerationOptions = profile('legacy-profile') as Partial<ImageApiProfile>;
delete legacyProfileWithoutGenerationOptions.quality;
delete legacyProfileWithoutGenerationOptions.imageCount;
const migratedGenerationOptions = parseStoryImageSettings({
  apiProfiles: [legacyProfileWithoutGenerationOptions],
  activeApiProfileId: 'legacy-profile',
});
equal(migratedGenerationOptions.apiProfiles[0].quality, 'auto', '旧 API 档案缺少质量时应迁移为自动');
equal(migratedGenerationOptions.apiProfiles[0].imageCount, 1, '旧 API 档案缺少数量时应迁移为一张');

const profileWithEmptyTimeout = parseStoryImageSettings({
  apiProfiles: [
    {
      ...profile('timeout-empty'),
      serviceUrl: 'http://fixture.invalid/v1/images/generations',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      timeoutMs: '',
    },
  ],
});
equal(profileWithEmptyTimeout.apiProfiles.length, 1, '空 timeout 不得丢弃整个 API 档案');
equal(
  profileWithEmptyTimeout.apiProfiles[0].serviceUrl,
  'http://fixture.invalid/v1/images/generations',
  '空 timeout 时必须保留 API 地址',
);
assert(profileWithEmptyTimeout.apiProfiles[0].apiKey === 'fixture-key', '空 timeout 时必须保留 API key');
equal(profileWithEmptyTimeout.apiProfiles[0].model, 'fixture-model', '空 timeout 时必须保留模型');
equal(profileWithEmptyTimeout.apiProfiles[0].timeoutMs, 120_000, '空 timeout 应回退到默认超时');

const profileWithOutOfRangeTimeout = parseStoryImageSettings({
  apiProfiles: [{ ...profile('timeout-range'), timeoutMs: 900_001 }],
});
equal(profileWithOutOfRangeTimeout.apiProfiles.length, 1, '越界 timeout 不得丢弃整个 API 档案');
equal(profileWithOutOfRangeTimeout.apiProfiles[0].id, 'timeout-range', '越界 timeout 时必须保留档案 ID');
equal(profileWithOutOfRangeTimeout.apiProfiles[0].timeoutMs, 120_000, '越界 timeout 应回退到默认超时');

for (const [label, invalidTimeout] of [
  ['zero', 0],
  ['fraction', 1_000.5],
] as const) {
  const repaired = parseStoryImageSettings({
    apiProfiles: [{ ...profile(`timeout-${label}`), timeoutMs: invalidTimeout }],
  });
  equal(repaired.apiProfiles[0].id, `timeout-${label}`, `${label} timeout 时必须保留档案`);
  equal(repaired.apiProfiles[0].timeoutMs, 120_000, `${label} timeout 应回退到默认超时`);
}

const runtime = globalThis as unknown as Record<string, unknown>;
const previousRuntime = {
  getScriptId: runtime.getScriptId,
  getVariables: runtime.getVariables,
  updateVariablesWith: runtime.updateVariablesWith,
};
let persistedVariables: Record<string, unknown> = {
  apiProfiles: [
    {
      ...profile('writeback-profile'),
      serviceUrl: 'http://fixture.invalid/v1/images/generations',
      apiKey: 'writeback-fixture-key',
      model: 'writeback-fixture-model',
      timeoutMs: '',
    },
  ],
};
runtime.getScriptId = () => 'story-image-settings-fixture';
runtime.getVariables = () => persistedVariables;
runtime.updateVariablesWith = (updater: (variables: Record<string, unknown>) => Record<string, unknown>) => {
  persistedVariables = updater(persistedVariables);
  return persistedVariables;
};
try {
  setActivePinia(createPinia());
  useStoryImageSettingsStore();
} finally {
  for (const [key, previous] of Object.entries(previousRuntime)) {
    if (typeof previous === 'undefined') Reflect.deleteProperty(runtime, key);
    else runtime[key] = previous;
  }
}
const persistedProfile = (persistedVariables.apiProfiles as Array<Record<string, unknown>>)[0];
assert(
  persistedProfile?.serviceUrl === 'http://fixture.invalid/v1/images/generations',
  '设置 store 立即写回不得丢失 API 地址',
);
assert(persistedProfile?.apiKey === 'writeback-fixture-key', '设置 store 立即写回不得丢失 API key');
assert(persistedProfile?.model === 'writeback-fixture-model', '设置 store 立即写回不得丢失模型');
equal(persistedProfile?.timeoutMs, 120_000, '设置 store 立即写回应保存修复后的默认超时');
const reloadedAfterWriteback = parseStoryImageSettings(persistedVariables);
assert(
  reloadedAfterWriteback.apiProfiles[0].apiKey === 'writeback-fixture-key',
  '设置 store 写回后的下一次加载仍应保留 API key',
);

const explicitPresets: DrawingPreset[] = [
  { id: 'scene', name: '场景', instructionText: 'scene instructions' },
  { id: 'portrait', name: '一致性', instructionText: 'portrait instructions' },
];
const explicit = parseStoryImageSettings({
  enabled: true,
  currentDrawingPresetId: 'portrait',
  drawingPresets: explicitPresets,
  displaySettings: { displayMode: 'gift', skipFloors: '2.9', generateOnSwipe: false },
  activeApiProfileId: 'profile-b',
  apiProfiles: profiles,
});
equal(explicit.drawingPresets, explicitPresets, '已有画图预设不得被默认值覆盖');
equal(explicit.currentDrawingPresetId, 'portrait', '已有当前预设 ID 应保留');
equal(
  explicit.displaySettings,
  { displayMode: 'gift', skipFloors: 2, generateOnSwipe: false },
  '展现设置应归一化楼层数并保留 Swipe 开关',
);
assert(!('needsProcessing' in getCurrentDrawingPreset(explicit)), 'v0.3 画图预设不应继续暴露 needsProcessing');

const explicitOutputPresets = [
  { id: 'output-a', name: '无头像', templateText: '{{xx}}', useAvatarReferences: false },
  { id: 'output-b', name: '双头像', templateText: '画面：{{xx}}', useAvatarReferences: true },
];
const explicitOutput = parseStoryImageSettings({
  outputPresets: explicitOutputPresets,
  currentOutputPresetId: 'output-b',
  apiProfiles: profiles,
});
equal(
  explicitOutput.outputPresets,
  explicitOutputPresets.map(preset => ({ ...preset, usePreviousStoryImage: false })),
  '已有出图预设应保留内容，上一图引用默认关闭',
);
equal(explicitOutput.currentOutputPresetId, 'output-b', '已有当前出图预设 ID 应保留');
assert(getCurrentOutputPreset(explicitOutput).useAvatarReferences, '当前出图预设头像开关应传递');

const migratedOldDrawingPreset = parseStoryImageSettings({
  drawingPresets: [
    { id: 'old-current', name: '旧当前', instructionText: 'old', needsProcessing: true },
    { id: 'old-other', name: '旧其他', instructionText: 'other', needsProcessing: false },
  ],
  currentDrawingPresetId: 'old-current',
  apiProfiles: profiles,
});
assert(!('needsProcessing' in migratedOldDrawingPreset.drawingPresets[0]), '迁移后的画图预设必须删除 needsProcessing');
equal(migratedOldDrawingPreset.outputPresets[0].templateText, '{{xx}}', '迁移出的出图模板必须保持 {{xx}}');
assert(
  migratedOldDrawingPreset.outputPresets[0].useAvatarReferences,
  '出图预设应继承旧当前画图预设的 needsProcessing=true',
);

const recentLimitClamped = parseStoryImageSettings({ recentImageLimit: 100, apiProfiles: profiles });
equal(recentLimitClamped.recentImageLimit, 50, '最近图片保留张数上限应为 50');
const recentLimitFloored = parseStoryImageSettings({ recentImageLimit: 0, apiProfiles: profiles });
equal(recentLimitFloored.recentImageLimit, 1, '最近图片保留张数下限应为 1');
const recentLimitInvalid = parseStoryImageSettings({ recentImageLimit: 'not-a-number', apiProfiles: profiles });
equal(recentLimitInvalid.recentImageLimit, 10, '非法最近图片保留张数应回退到 10');

const normalizedLegacyDrawing = normalizeDrawingPreset({
  id: 'legacy',
  name: 'legacy',
  instructionText: 'legacy',
  needsProcessing: true,
});
assert(normalizedLegacyDrawing && !('needsProcessing' in normalizedLegacyDrawing), '画图预设归一化不得保留旧加工字段');

const invalidCurrent = parseStoryImageSettings({
  currentDrawingPresetId: 'missing',
  drawingPresets: explicitPresets,
  displaySettings: { displayMode: 'inline', skipFloors: 2001 },
  apiProfiles: profiles,
});
equal(invalidCurrent.currentDrawingPresetId, 'scene', '无效当前预设应回退到第一个预设');
equal(invalidCurrent.displaySettings.skipFloors, 1000, '过大的 skipFloors 应钳制到上限');
const negativeSkip = parseStoryImageSettings({
  displaySettings: { displayMode: 'inline', skipFloors: -3 },
  apiProfiles: profiles,
});
equal(negativeSkip.displaySettings.skipFloors, 0, '负 skipFloors 应钳制到零');

const explicitDisplaySettingsAreAuthoritative = parseStoryImageSettings({
  enabled: false,
  displaySettings: { displayMode: 'inline', skipFloors: 0 },
  gift: { enabled: true, triggerInterval: '3' },
  apiProfiles: profiles,
});
assert(!explicitDisplaySettingsAreAuthoritative.enabled, '显式 v0.3 enabled=false 不得被残留 gift.enabled 覆盖');
equal(
  explicitDisplaySettingsAreAuthoritative.displaySettings,
  { displayMode: 'inline', skipFloors: 0, generateOnSwipe: true },
  '显式 v0.3 displaySettings 不得被旧礼物触发配置改写',
);

const migratedV02 = parseStoryImageSettings({
  enabled: true,
  basePrompt: '旧基础规则',
  scenePrompt: '旧场景规则',
  stylePrompt: '旧风格规则',
  safetyPrompt: '旧安全规则',
  gift: {
    enabled: true,
    triggerInterval: '3',
    requestMode: 'json-reference',
    multipartImageField: 'image',
    jsonReferenceField: 'reference_images',
    identityPrompt: '旧身份规则\n不要让模板图改变角色身份',
    templatePrompt: '旧模板规则',
    scenePrompt: '旧礼物场景',
    stylePrompt: '旧礼物风格\n如果模板图是真人照片，必须重绘',
    outputPrompt: '旧输出规则',
  },
  apiProfiles: profiles,
});
equal(migratedV02.drawingPresets.length, 2, 'v0.2 的 inline 与 gift prompt 应各迁移为一个预设');
assert(
  migratedV02.drawingPresets[0].instructionText.includes('旧基础规则') &&
    migratedV02.drawingPresets[0].instructionText.includes('旧安全规则'),
  'v0.2 inline prompt sections 不得丢失',
);
const migratedGift = migratedV02.drawingPresets.find(item => item.id === 'legacy-gift-cg-v2');
assert(migratedGift && !('needsProcessing' in migratedGift), 'v0.2 礼物兼容预设不得保留 needsProcessing');
assert(migratedGift?.instructionText.includes('旧身份规则'), 'v0.2 gift identity 约束应保留');
assert(migratedGift?.instructionText.includes('旧礼物场景'), 'v0.2 gift scene 约束应保留');
assert(migratedGift?.instructionText.includes('旧礼物风格'), 'v0.2 gift style 约束应保留');
assert(!migratedGift?.instructionText.includes('旧模板规则'), 'v0.2 templatePrompt 不得注入正文 AI');
assert(!migratedGift?.instructionText.includes('模板图'), '不存在的模板图规则不得注入正文 AI');
assert(!migratedGift?.instructionText.includes('只输出一条'), 'v0.2 output 的单条提示词约束不得注入正文 AI');
assert(!migratedGift?.instructionText.includes('旧输出规则'), 'v0.2 outputPrompt 不得注入正文 AI');
assert(!('gift' in migratedV02), '新版设置对象不应继续暴露旧礼物触发配置');
equal(migratedV02.apiProfiles[0].requestMode, 'json-reference', 'v0.2 礼物请求模式应迁移到原礼物 API 档案');
equal(migratedV02.apiProfiles[0].jsonReferenceField, 'reference_images', 'v0.2 JSON 参考图字段不得丢失');
equal(
  migratedV02.displaySettings,
  { displayMode: 'gift', skipFloors: 2, generateOnSwipe: true },
  'v0.2 3 楼触发应迁移为跳过 2 楼并默认允许新 Swipe 生图',
);

const migratedManualGift = parseStoryImageSettings({
  enabled: true,
  mode: 'gift',
  gift: { enabled: true, triggerInterval: 'manual' },
  apiProfiles: profiles,
});
assert(!migratedManualGift.enabled, 'v0.2 manual 礼物调度必须安全迁移为关闭，避免自动逐楼请求');
equal(migratedManualGift.displaySettings.displayMode, 'gift', 'manual 迁移仍应保留礼物展现方式');
equal(migratedManualGift.displaySettings.skipFloors, 1000, 'manual 迁移应使用显式的大间隔保护值');

const migratedInlineAndManualGift = parseStoryImageSettings({
  enabled: true,
  gift: { enabled: true, triggerInterval: 'manual' },
  apiProfiles: profiles,
});
assert(migratedInlineAndManualGift.enabled, 'inline 与 manual 礼物并存时应保留原有 enabled=true');
equal(
  migratedInlineAndManualGift.displaySettings,
  { displayMode: 'inline', skipFloors: 0, generateOnSwipe: true },
  '没有显式 mode:gift 时 manual 礼物不得把随文模式改成礼物模式',
);

const migratedScheduledGiftWithStaleInlineMode = parseStoryImageSettings({
  enabled: false,
  mode: 'inline',
  gift: { enabled: true, triggerInterval: '3' },
  apiProfiles: profiles,
});
assert(migratedScheduledGiftWithStaleInlineMode.enabled, '启用的旧 3 楼礼物调度不得被 stale mode:inline 关闭');
equal(
  migratedScheduledGiftWithStaleInlineMode.displaySettings,
  { displayMode: 'gift', skipFloors: 2, generateOnSwipe: true },
  '启用的旧 3 楼礼物调度应优先迁移为礼物展现',
);

const migratedMissingGiftTrigger = parseStoryImageSettings({
  enabled: false,
  gift: { enabled: true },
  apiProfiles: profiles,
});
assert(!migratedMissingGiftTrigger.enabled, '缺失旧礼物触发值时不得启用 gift 自动生成');
assert(
  !(
    migratedMissingGiftTrigger.displaySettings.displayMode === 'gift' &&
    migratedMissingGiftTrigger.displaySettings.skipFloors === 0
  ),
  '缺失旧礼物触发值时不得迁移为 gift+skipFloors=0 逐楼请求',
);
equal(
  migratedMissingGiftTrigger.displaySettings,
  { displayMode: 'gift', skipFloors: 1000, generateOnSwipe: true },
  '缺失旧礼物触发值应按 manual 语义使用安全禁用设置',
);

const migratedInvalidGiftTrigger = parseStoryImageSettings({
  enabled: false,
  gift: { enabled: true, triggerInterval: 'hourly' },
  apiProfiles: profiles,
});
assert(!migratedInvalidGiftTrigger.enabled, '非法旧礼物触发值时不得启用 gift 自动生成');
assert(
  !(
    migratedInvalidGiftTrigger.displaySettings.displayMode === 'gift' &&
    migratedInvalidGiftTrigger.displaySettings.skipFloors === 0
  ),
  '非法旧礼物触发值时不得迁移为 gift+skipFloors=0 逐楼请求',
);
equal(
  migratedInvalidGiftTrigger.displaySettings,
  { displayMode: 'gift', skipFloors: 1000, generateOnSwipe: true },
  '非法旧礼物触发值应按 manual 语义使用安全禁用设置',
);

const migratedInvalidGiftWithInline = parseStoryImageSettings({
  enabled: true,
  mode: 'inline',
  gift: { enabled: true, triggerInterval: 'hourly' },
  apiProfiles: profiles,
});
assert(migratedInvalidGiftWithInline.enabled, '非法礼物触发值且 inline 可用时应保留 inline 自动路线');
equal(
  migratedInvalidGiftWithInline.displaySettings,
  { displayMode: 'inline', skipFloors: 0, generateOnSwipe: true },
  '非法礼物触发值且 inline 可用时不得切换到 gift',
);

const migratedManualWithoutInline = parseStoryImageSettings({
  enabled: false,
  gift: { enabled: true, triggerInterval: 'manual' },
  apiProfiles: profiles,
});
assert(!migratedManualWithoutInline.enabled, '没有可保留的随文自动能力时 manual 礼物应安全保持关闭');
equal(
  migratedManualWithoutInline.displaySettings,
  { displayMode: 'gift', skipFloors: 1000, generateOnSwipe: true },
  '没有可保留的随文自动能力时 manual 礼物应保留安全禁用设置',
);

const migratedFiveGift = parseStoryImageSettings({
  enabled: false,
  gift: { enabled: true, triggerInterval: '5' },
  apiProfiles: profiles,
});
assert(migratedFiveGift.enabled, 'v0.2 启用的 5 楼礼物调度应迁移为启用');
equal(
  migratedFiveGift.displaySettings,
  { displayMode: 'gift', skipFloors: 4, generateOnSwipe: true },
  'v0.2 5 楼触发应迁移为跳过 4 楼',
);

const flatLegacy = parseStoryImageSettings({
  serviceUrl: 'https://legacy.test/v1/images/generations',
  apiKey: 'legacy-key',
  model: 'legacy-model',
  mode: 'gift',
});
equal(flatLegacy.apiProfiles.length, 1, '更老扁平设置应迁移为单一 API profile');
equal(flatLegacy.apiProfiles[0].serviceUrl, 'https://legacy.test/v1/images/generations', '扁平 API 地址必须保留');
equal(flatLegacy.apiProfiles[0].apiKey, 'legacy-key', '扁平 API key 必须保留');
equal(flatLegacy.apiProfiles[0].quality, 'auto', '更老扁平设置应补齐自动质量');
equal(flatLegacy.apiProfiles[0].imageCount, 1, '更老扁平设置应补齐单张数量');
equal(flatLegacy.displaySettings.displayMode, 'gift', 'v0.2 mode 应迁移为展现方式');

const routeSettings = parseStoryImageSettings({
  activeApiProfileId: 'profile-b',
  storyApiProfileId: 'profile-a',
  giftApiProfileId: 'profile-b',
  apiProfiles: profiles,
});
equal(getStoryApiProfile(routeSettings).id, 'profile-a', '兼容随文 API selector 应读取 story route');
equal(getGiftApiProfile(routeSettings).id, 'profile-b', '兼容礼物 API selector 应读取 gift route');

const deletion = parseStoryImageSettings({
  activeApiProfileId: 'profile-b',
  storyApiProfileId: 'profile-b',
  giftApiProfileId: 'profile-b',
  apiProfiles: [...profiles, profile('profile-c')],
});
deletion.apiProfiles.splice(1, 1);
repairApiProfileRouteIds(deletion, 'profile-c');
equal(
  [deletion.activeApiProfileId, deletion.storyApiProfileId, deletion.giftApiProfileId],
  ['profile-c', 'profile-c', 'profile-c'],
  '删除正在使用的档案后三条兼容 ID 必须落到有效相邻档案',
);

const first = createDrawingPreset({ id: 'first', name: '第一份', instructionText: 'first' });
const second = createDrawingPreset({ id: 'second', name: '第二份', instructionText: 'second' });
equal(getCurrentDrawingPresetFromList([first, second], 'second'), second, '纯列表 helper 应返回当前预设');
const updated = updateDrawingPreset([first, second], 'first', { name: '已修改', instructionText: 'updated' });
equal(updated[0], { ...first, name: '已修改', instructionText: 'updated' }, '预设 CRUD 应支持修改名称和指令');
equal(first.name, '第一份', '纯 update helper 不应原地修改旧预设');
const deletionResult = deleteDrawingPreset([first, second], 'second', 'second');
assert(deletionResult.deleted, '预设 CRUD 应允许删除非最后一个预设');
equal(deletionResult.currentId, 'first', '删除当前预设后应切换到剩余预设');
assert(!deletionResult.presets.some(item => item.id === 'second'), '删除后预设列表不应保留旧 ID');
const protectedLast = deleteDrawingPreset([first], 'first', 'first');
assert(!protectedLast.deleted && protectedLast.presets.length === 1, '最后一个预设不得删除');

console.info('<杠杠の生图机> v0.3 settings tests passed');
