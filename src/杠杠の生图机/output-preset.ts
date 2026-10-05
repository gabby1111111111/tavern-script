import { z } from 'zod';
import type { ImageOutputPreset as PipelineImageOutputPreset } from './pipeline-types';

/**
 * v0.5.2 extends the pipeline type with the gallery-reference switch.  Like
 * `usePreviousStoryImage`, the field is optional on the type (legacy/external
 * data may predate it) and always materializes as a boolean through the schema
 * (missing or malformed values fall back to `false`).
 */
export type ImageOutputPreset = PipelineImageOutputPreset & { useGalleryReferences?: boolean };

/**
 * A user-editable template for the generated image prompt. The template is
 * intentionally plain text; `{{xx}}` is the default placeholder consumed by
 * the runtime when it combines the generated prompt with this preset.
 */
export const DEFAULT_OUTPUT_TEMPLATE = '{{xx}}';

/**
 * 图鉴参考匹配(v0.5.2)的“当前出场角色”声明指令句,追加在默认出图预设模板中,
 * 教正文 AI 在每个 <pic> 提示词里单独输出一行声明。已有用户预设不受影响;
 * 发布阶段 README 会同时提供可复制的画图预设指令句(执行简报 §0.2/§0.8)。
 */
export const GALLERY_DECLARATION_INSTRUCTION =
  '开启“图鉴参考匹配”时，请在每个 <pic> 提示词中单独输出一行“当前出场角色：a2，b1；”：a2、b1 是本镜头实际出场角色的图鉴别名，多个别名用逗号或顿号分隔，整行以分号结尾；未开启图鉴参考匹配或本镜头没有出场角色时，不要输出这一行。';

export const DEFAULT_OUTPUT_PRESET_ID = 'default-output-preset';
export const DEFAULT_OUTPUT_PRESET: ImageOutputPreset = {
  id: DEFAULT_OUTPUT_PRESET_ID,
  name: '默认出图格式',
  templateText: `${DEFAULT_OUTPUT_TEMPLATE}\n\n${GALLERY_DECLARATION_INSTRUCTION}`,
  useAvatarReferences: false,
  useGalleryReferences: false,
  useStyleReference: false,
  usePreviousStoryImage: false,
};

export const ImageOutputPresetSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().default('未命名出图预设'),
  templateText: z.string().default(DEFAULT_OUTPUT_TEMPLATE),
  useAvatarReferences: z.boolean().default(false),
  useGalleryReferences: z.boolean().default(false),
  useStyleReference: z.boolean().default(false),
  usePreviousStoryImage: z.boolean().default(false),
});

/**
 * 身份参考互斥(执行简报 §0.3):出图预设的「头像参考」与「图鉴参考匹配」不得同时
 * 开启。解析修复规则:两者同时为真时保留头像、强制关闭图鉴。幂等,数据层与设置层
 * 的归一化路径都调用它。
 */
export function repairOutputReferenceExclusivity(preset: ImageOutputPreset): ImageOutputPreset {
  if (preset.useAvatarReferences === true && preset.useGalleryReferences === true) {
    return { ...preset, useGalleryReferences: false };
  }
  return preset;
}

/** The two mutually exclusive identity-reference switches of an output preset. */
export type OutputReferenceSwitchState = {
  useAvatarReferences: boolean;
  useGalleryReferences: boolean;
};

export type OutputReferenceSwitchKey = keyof OutputReferenceSwitchState;

export type OutputReferenceSwitchResult = OutputReferenceSwitchState & {
  /** One-sentence UI hint, set only when opening one switch forced the other off. */
  notice: string | null;
};

/** Hints shown by the settings UI; wording never contains paths or URLs. */
export const OUTPUT_REFERENCE_MUTEX_NOTICES = {
  useAvatarReferences: '已开启头像参考：头像参考与图鉴参考匹配互斥，已自动关闭图鉴参考匹配。',
  useGalleryReferences: '已开启图鉴参考匹配：图鉴参考匹配与头像参考互斥，已自动关闭头像参考。',
} as const;

/**
 * Pure switch logic behind the settings UI: opening one identity-reference
 * switch turns the other off and reports a hint; closing one never re-enables
 * the other (closing the gallery switch restores the ability to use avatars,
 * it does not switch them back on automatically).
 */
export function toggleOutputReferenceSwitch(
  state: OutputReferenceSwitchState,
  key: OutputReferenceSwitchKey,
  nextValue: boolean,
): OutputReferenceSwitchResult {
  if (!nextValue) {
    return { ...state, [key]: false, notice: null };
  }
  const otherKey: OutputReferenceSwitchKey =
    key === 'useAvatarReferences' ? 'useGalleryReferences' : 'useAvatarReferences';
  if (!state[otherKey]) {
    return { ...state, [key]: true, notice: null };
  }
  return { ...state, [key]: true, [otherKey]: false, notice: OUTPUT_REFERENCE_MUTEX_NOTICES[key] };
}

function fallbackId(index: number): string {
  return index === 0 ? DEFAULT_OUTPUT_PRESET_ID : `${DEFAULT_OUTPUT_PRESET_ID}-${index + 1}`;
}

function uniqueId(candidate: string, used: Set<string>, index: number): string {
  const base = candidate.trim() || fallbackId(index);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

let outputPresetSequence = 0;

export function normalizeOutputPreset(raw: unknown, index = 0): ImageOutputPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  const parsed = ImageOutputPresetSchema.safeParse({
    id: rawId || fallbackId(index),
    name: rawName || '未命名出图预设',
    templateText: typeof record.templateText === 'string' ? record.templateText : DEFAULT_OUTPUT_TEMPLATE,
    usePreviousStoryImage: typeof record.usePreviousStoryImage === 'boolean' ? record.usePreviousStoryImage : false,
    useAvatarReferences: typeof record.useAvatarReferences === 'boolean' ? record.useAvatarReferences : false,
    useGalleryReferences: typeof record.useGalleryReferences === 'boolean' ? record.useGalleryReferences : false,
    useStyleReference: typeof record.useStyleReference === 'boolean' ? record.useStyleReference : false,
  });
  return parsed.success ? repairOutputReferenceExclusivity(parsed.data) : null;
}

export function normalizeOutputPresets(raw: unknown): ImageOutputPreset[] {
  const source = Array.isArray(raw) ? raw : [];
  const used = new Set<string>();
  const normalized = source
    .map((item, index) => normalizeOutputPreset(item, index))
    .filter((item): item is ImageOutputPreset => item !== null)
    .map((item, index) => ({ ...item, id: uniqueId(item.id, used, index) }));
  return normalized.length > 0 ? normalized : [{ ...DEFAULT_OUTPUT_PRESET }];
}

export function createOutputPreset(
  input: Partial<Omit<ImageOutputPreset, 'id'>> & { id?: string } = {},
): ImageOutputPreset {
  const candidate = {
    id: input.id?.trim() || `output-preset-${Date.now()}-${outputPresetSequence++}`,
    name: input.name?.trim() || '新建出图预设',
    templateText: input.templateText ?? DEFAULT_OUTPUT_TEMPLATE,
    useAvatarReferences: input.useAvatarReferences ?? false,
    useGalleryReferences: input.useGalleryReferences ?? false,
    useStyleReference: input.useStyleReference ?? false,
    usePreviousStoryImage: input.usePreviousStoryImage ?? false,
  };
  return repairOutputReferenceExclusivity(ImageOutputPresetSchema.parse(candidate));
}

export function getCurrentOutputPreset(presets: ImageOutputPreset[], currentId: string): ImageOutputPreset {
  return presets.find(preset => preset.id === currentId) ?? presets[0] ?? DEFAULT_OUTPUT_PRESET;
}

export function updateOutputPreset(
  presets: ImageOutputPreset[],
  id: string,
  patch: Partial<Omit<ImageOutputPreset, 'id'>>,
): ImageOutputPreset[] {
  return presets.map(preset =>
    preset.id === id
      ? repairOutputReferenceExclusivity(
          ImageOutputPresetSchema.parse({
            ...preset,
            ...patch,
            id: preset.id,
          }),
        )
      : { ...preset },
  );
}

export type OutputPresetDeletion = {
  presets: ImageOutputPreset[];
  currentId: string;
  deleted: boolean;
};

/** Never leave the settings without one selectable output preset. */
export function deleteOutputPreset(presets: ImageOutputPreset[], id: string, currentId: string): OutputPresetDeletion {
  if (presets.length <= 1 || !presets.some(preset => preset.id === id)) {
    return { presets: presets.map(preset => ({ ...preset })), currentId, deleted: false };
  }
  const next = presets.filter(preset => preset.id !== id).map(preset => ({ ...preset }));
  const nextCurrentId = id === currentId ? next[0].id : currentId;
  return { presets: next, currentId: nextCurrentId, deleted: true };
}

// Explicitly named aliases keep the module discoverable for callers that use
// the full image-output terminology instead of the shorter output-preset name.
export const DEFAULT_IMAGE_OUTPUT_PRESET_ID = DEFAULT_OUTPUT_PRESET_ID;
export const DEFAULT_IMAGE_OUTPUT_PRESET = DEFAULT_OUTPUT_PRESET;
export const normalizeImageOutputPreset = normalizeOutputPreset;
export const normalizeImageOutputPresets = normalizeOutputPresets;
export const createImageOutputPreset = createOutputPreset;
export const getCurrentImageOutputPreset = getCurrentOutputPreset;
export const updateImageOutputPreset = updateOutputPreset;
export const deleteImageOutputPreset = deleteOutputPreset;

/** Explicitly added by the user; never replaces the selected preset on load. */
export const CONTINUOUS_STORY_OUTPUT_EXAMPLE = {
  name: '连续剧情',
  templateText:
    '实际参考图：\n{{reference_sources}}\n\n上一镜头的文字背景：\n{{xx_pic}}\n\n当前镜头：\n{{xx}}\n\n延续未被当前剧情改变的视觉细节，按当前剧情更新动作与场景。头像用于人物身份，上一镜头图用于服装、道具、环境与画风。若提供上一镜头图，旧文字与该图的局部细节不一致时，以图为准；当前剧情明确要求的新变化优先。',
  useAvatarReferences: true,
  usePreviousStoryImage: true,
};
