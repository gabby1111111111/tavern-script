import { materializeReferenceSources } from './reference-resolution';
import type { ImageApiProfile } from './settings';
import type { ImageOutputPreset, PromptProcessingResult, ResolvedReferenceSource } from './pipeline-types';
import { readCurrentAvatarReferences, type AvatarReferenceReadResult } from './avatar-references';

export type PromptProcessorOptions = {
  readReferences?: () => Promise<AvatarReferenceReadResult>;
  previousShotPrompt?: string;
  previousStoryImage?: string;
  referenceContext?: { profile: ImageApiProfile; signal: AbortSignal };
  resolvedReferenceSources?: readonly ResolvedReferenceSource[];
};

export function describeReferenceSources(sources: readonly ResolvedReferenceSource[]): string {
  return sources.map((source, index) => `图${index + 1}：${source.label}`).join('\n');
}

function asPromptTemplateValue(value: string): string {
  return value.trim() ? value : 'null';
}

/** Literal one-pass substitution: inserted shot text is never evaluated as a template. */
export function applyOutputPromptTemplate(
  templateText: string,
  prompt: string,
  previousShotPrompt = '',
  referenceSources: readonly ResolvedReferenceSource[] = [],
): string {
  const values = {
    xx: asPromptTemplateValue(prompt),
    xx_pic: asPromptTemplateValue(previousShotPrompt),
    reference_sources: asPromptTemplateValue(describeReferenceSources(referenceSources)),
  };
  return templateText.replace(/\{\{(xx|xx_pic|reference_sources)\}\}/g, (_match, key: string) => {
    return values[key as keyof typeof values];
  });
}

export function applyDrawingPromptTemplate(templateText: string, previousShotPrompt = ''): string {
  return templateText.replace(/\{\{xx_pic\}\}/g, () => asPromptTemplateValue(previousShotPrompt));
}

/** Sources are resolved in request order; absent images never reserve an image number. */
export async function processDrawingPrompt(
  preset: ImageOutputPreset,
  prompt: string,
  options: PromptProcessorOptions = {},
): Promise<PromptProcessingResult> {
  let references: AvatarReferenceReadResult = { references: [], failedSources: [] };
  if (preset.useAvatarReferences && !options.resolvedReferenceSources) {
    try {
      references = await (options.readReferences ?? readCurrentAvatarReferences)();
    } catch {
      // Missing avatar inputs do not block text or previous-story references.
    }
  }
  let sources =
    options.resolvedReferenceSources?.map(source => ({ ...source })) ??
    resolveReferenceSources(references, preset.usePreviousStoryImage ? options.previousStoryImage : undefined);
  if (options.referenceContext) {
    if (options.referenceContext.signal.aborted) throw new DOMException('图片请求已取消', 'AbortError');
    if (!options.resolvedReferenceSources)
      sources = await materializeReferenceSources(
        sources,
        options.referenceContext.profile,
        options.referenceContext.signal,
      );
  }
  const result: PromptProcessingResult = {
    prompt: applyOutputPromptTemplate(preset.templateText, prompt, options.previousShotPrompt, sources),
    processing: 'processed',
  };
  if (sources.length > 0) {
    result.referenceImages = sources.map(source => source.value);
    result.referenceSources = sources;
  }
  return result;
}

/**
 * 兼容两种自然调用顺序：`(preset, prompt)` 是主接口，`(prompt, preset)`
 * 便于旧运行时迁移；两者共享同一套模板和头像引用语义。
 */
export async function processPrompt(
  first: ImageOutputPreset | string,
  second: string | ImageOutputPreset,
  options: PromptProcessorOptions = {},
): Promise<PromptProcessingResult> {
  if (typeof first === 'string') return processDrawingPrompt(second as ImageOutputPreset, first, options);
  return processDrawingPrompt(first, second as string, options);
}

export function resolveReferenceSources(
  references: AvatarReferenceReadResult,
  previousStoryImage?: string,
): ResolvedReferenceSource[] {
  const sources: ResolvedReferenceSource[] = [];
  for (const source of ['persona', 'character'] as const) {
    const reference = references.references.find(reference => reference.source === source && reference.value.trim());
    if (reference)
      sources.push({
        kind: source === 'persona' ? 'user-avatar' : 'character-avatar',
        label: source === 'persona' ? 'User 头像' : '角色头像',
        value: reference.value,
      });
  }
  if (previousStoryImage?.trim())
    sources.push({ kind: 'previous-story-image', label: '上一镜头参考图', value: previousStoryImage });
  return sources;
}
