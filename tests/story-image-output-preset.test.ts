import {
  DEFAULT_OUTPUT_PRESET,
  DEFAULT_OUTPUT_PRESET_ID,
  ImageOutputPresetSchema,
  createOutputPreset,
  deleteOutputPreset,
  getCurrentOutputPreset,
  normalizeOutputPreset,
  normalizeOutputPresets,
  updateOutputPreset,
  type ImageOutputPreset,
} from '../src/杠杠の生图机/output-preset';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

equal(DEFAULT_OUTPUT_PRESET_ID, 'default-output-preset', '默认出图预设 ID 应稳定');
equal(DEFAULT_OUTPUT_PRESET.templateText, '{{xx}}', '默认出图预设模板必须精确为 {{xx}}');
assert(!DEFAULT_OUTPUT_PRESET.useAvatarReferences, '默认出图预设不得默认使用头像参考图');
equal(
  ImageOutputPresetSchema.parse({ id: 'schema-default' }),
  {
    id: 'schema-default',
    name: '未命名出图预设',
    templateText: '{{xx}}',
    useAvatarReferences: false,
    usePreviousStoryImage: false,
  },
  '出图预设 schema 默认值应完整',
);

const first = createOutputPreset({ id: 'first', name: '第一份' });
const second = createOutputPreset({
  id: 'second',
  name: '第二份',
  templateText: '画面：{{xx}}',
  useAvatarReferences: true,
});
equal(first.templateText, '{{xx}}', '新建出图预设默认模板应为 {{xx}}');
assert(!first.useAvatarReferences, '新建出图预设默认不得使用头像');
assert(getCurrentOutputPreset([first, second], 'second') === second, '当前出图预设 helper 应返回选中项');

const updated = updateOutputPreset([first, second], 'first', {
  name: '已修改',
  templateText: '更新：{{xx}}',
  useAvatarReferences: true,
});
equal(
  updated[0],
  { ...first, name: '已修改', templateText: '更新：{{xx}}', useAvatarReferences: true },
  '出图预设 CRUD 应支持修改全部用户字段',
);
assert(updated[0] !== first && updated[1] !== second, '出图预设 update 不应原地修改旧数组或记录');
equal(first.name, '第一份', '出图预设 update 不应修改旧记录');

const deleted = deleteOutputPreset([first, second], 'second', 'second');
assert(deleted.deleted, '出图预设 CRUD 应允许删除非最后一项');
equal(deleted.currentId, 'first', '删除当前出图预设后应切换到剩余项');
equal(deleted.presets.length, 1, '删除后应只保留剩余出图预设');
const protectedLast = deleteOutputPreset([first], 'first', 'first');
assert(!protectedLast.deleted && protectedLast.presets.length === 1, '最后一个出图预设不得删除');

const normalized = normalizeOutputPresets([
  { id: 'duplicate', name: 'A', templateText: '{{xx}}', useAvatarReferences: false, usePreviousStoryImage: false },
  { id: 'duplicate', name: 'B', templateText: 'B {{xx}}', useAvatarReferences: true },
  null,
]);
equal(
  normalized.map(preset => preset.id),
  ['duplicate', 'duplicate-2'],
  '重复出图预设 ID 应自动修复且保持顺序',
);
assert(normalized[1].useAvatarReferences, '归一化不得丢失头像参考开关');
const malformed = normalizeOutputPreset({ id: 'malformed', templateText: 123, useAvatarReferences: 'yes' });
equal(
  malformed,
  {
    id: 'malformed',
    name: '未命名出图预设',
    templateText: '{{xx}}',
    useAvatarReferences: false,
    usePreviousStoryImage: false,
  },
  '非法出图字段应回退到安全默认值',
);

const list: ImageOutputPreset[] = [first, second];
assert(
  list.every(preset => typeof preset.templateText === 'string'),
  '输出预设契约必须使用纯文本模板',
);

console.info('<杠杠の生图机> v0.3 output preset tests passed');
