import type { DrawingPreset } from './pipeline-types';
import { z } from 'zod';

/**
 * Schema for the small, user-editable instruction object sent to the
 * assistant prompt.  This object deliberately has no frequency or display
 * fields; cadence belongs to `displaySettings` in settings.ts.
 */
export const DrawingPresetSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().default('未命名预设'),
  instructionText: z.string().default(''),
});

export type { DrawingPreset } from './pipeline-types';

export const DEFAULT_DRAWING_PRESET_ID = 'default-drawing-preset';

/** The intentionally small fallback used when no previous settings exist. */
export const DEFAULT_DRAWING_PRESET: DrawingPreset = {
  id: DEFAULT_DRAWING_PRESET_ID,
  name: '默认随文插图',
  instructionText:
    '当回复中确实需要随文插图时，在对应正文段落中输出最多两个 <pic prompt="绘图提示词"> 标记；没有需要时不要输出标记。标记必须位于 <content> 内，不要输出分析过程。',
};

export const LEGACY_GIFT_DRAWING_PRESET_ID = 'legacy-gift-cg-v2';
export const LEGACY_GIFT_DRAWING_PRESET_NAME = 'v0.2 礼物 CG 兼容预设';

let presetSequence = 0;

function fallbackId(index: number): string {
  return index === 0 ? DEFAULT_DRAWING_PRESET_ID : `${DEFAULT_DRAWING_PRESET_ID}-${index + 1}`;
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

/**
 * Parse one preset without allowing malformed persisted data to poison the
 * whole settings object. IDs are made unique in `normalizeDrawingPresets`.
 */
export function normalizeDrawingPreset(raw: unknown, index = 0): DrawingPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  const parsed = DrawingPresetSchema.safeParse({
    id: rawId || fallbackId(index),
    name: rawName || '未命名预设',
    instructionText: typeof record.instructionText === 'string' ? record.instructionText : '',
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeDrawingPresets(raw: unknown): DrawingPreset[] {
  const source = Array.isArray(raw) ? raw : [];
  const used = new Set<string>();
  const normalized = source
    .map((item, index) => normalizeDrawingPreset(item, index))
    .filter((item): item is DrawingPreset => item !== null)
    .map((item, index) => ({ ...item, id: uniqueId(item.id, used, index) }));
  return normalized.length > 0 ? normalized : [{ ...DEFAULT_DRAWING_PRESET }];
}

export function createDrawingPreset(input: Partial<Omit<DrawingPreset, 'id'>> & { id?: string } = {}): DrawingPreset {
  const candidate = {
    id: input.id?.trim() || `drawing-preset-${Date.now()}-${presetSequence++}`,
    name: input.name?.trim() || '新建预设',
    instructionText: input.instructionText ?? '',
  };
  return DrawingPresetSchema.parse(candidate);
}

export function getCurrentDrawingPreset(presets: DrawingPreset[], currentId: string): DrawingPreset {
  return presets.find(preset => preset.id === currentId) ?? presets[0] ?? DEFAULT_DRAWING_PRESET;
}

/** Return a new array so callers can replace a reactive array atomically. */
export function updateDrawingPreset(
  presets: DrawingPreset[],
  id: string,
  patch: Partial<Omit<DrawingPreset, 'id'>>,
): DrawingPreset[] {
  return presets.map(preset =>
    preset.id === id
      ? DrawingPresetSchema.parse({
          ...preset,
          ...patch,
          id: preset.id,
        })
      : { ...preset },
  );
}

export type DrawingPresetDeletion = {
  presets: DrawingPreset[];
  currentId: string;
  deleted: boolean;
};

/** Never leave the settings without one selectable preset. */
export function deleteDrawingPreset(presets: DrawingPreset[], id: string, currentId: string): DrawingPresetDeletion {
  if (presets.length <= 1 || !presets.some(preset => preset.id === id)) {
    return { presets: presets.map(preset => ({ ...preset })), currentId, deleted: false };
  }
  const next = presets.filter(preset => preset.id !== id).map(preset => ({ ...preset }));
  const nextCurrentId = id === currentId ? next[0].id : currentId;
  return { presets: next, currentId: nextCurrentId, deleted: true };
}

export const CONTINUOUS_STORY_DRAWING_EXAMPLE = {
  name: '连续剧情',
  instructionText: `${DEFAULT_DRAWING_PRESET.instructionText}\n\n上一镜头的画面提示词：\n{{xx_pic}}\n\n请结合当前剧情判断哪些视觉元素继续保持，哪些已经改变，并在本次回复中输出新的、完整的 <pic> 画面提示词。没有上一镜头时按首次配图处理。`,
};
