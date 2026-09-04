import { z } from 'zod';
import type { ImageOutputPreset } from './pipeline-types';

/**
 * A user-editable template for the generated image prompt. The template is
 * intentionally plain text; `{{xx}}` is the default placeholder consumed by
 * the runtime when it combines the generated prompt with this preset.
 */
export const DEFAULT_OUTPUT_TEMPLATE = '{{xx}}';
export const DEFAULT_OUTPUT_PRESET_ID = 'default-output-preset';
export const DEFAULT_OUTPUT_PRESET: ImageOutputPreset = {
  id: DEFAULT_OUTPUT_PRESET_ID,
  name: '默认出图格式',
  templateText: DEFAULT_OUTPUT_TEMPLATE,
  useAvatarReferences: false,
};

export const ImageOutputPresetSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().default('未命名出图预设'),
  templateText: z.string().default(DEFAULT_OUTPUT_TEMPLATE),
  useAvatarReferences: z.boolean().default(false),
});

export type { ImageOutputPreset } from './pipeline-types';

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
    useAvatarReferences: typeof record.useAvatarReferences === 'boolean' ? record.useAvatarReferences : false,
  });
  return parsed.success ? parsed.data : null;
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
  };
  return ImageOutputPresetSchema.parse(candidate);
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
      ? ImageOutputPresetSchema.parse({
          ...preset,
          ...patch,
          id: preset.id,
        })
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
