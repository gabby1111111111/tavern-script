import type { ImageOutputPreset, PromptProcessingResult } from './pipeline-types';
import { readCurrentAvatarReferences, type AvatarReferenceReadResult } from './avatar-references';

export type PromptProcessorOptions = {
  /** 测试或宿主适配器可替换头像读取器；生产默认读当前上下文头像。 */
  readReferences?: () => Promise<AvatarReferenceReadResult>;
};

const OUTPUT_PROMPT_PLACEHOLDER = '{{xx}}';

/**
 * 将解析出的单条 `<pic>` prompt 套入用户选择的出图模板。
 *
 * 这里只替换用户明确写出的字面量占位符，不追加任何隐含前缀、后缀或
 * 安全说明。没有占位符时，模板文本也必须原样作为最终 prompt。
 */
export function applyOutputPromptTemplate(templateText: string, prompt: string): string {
  return templateText.split(OUTPUT_PROMPT_PLACEHOLDER).join(prompt);
}

/**
 * 对单条 `<pic>` prompt 做一次本地、确定性的加工。
 *
 * 模板始终应用；`useAvatarReferences` 只控制头像读取和
 * `referenceImages` 字段。关闭头像引用时不得触发默认或注入的头像读取器。
 */
export async function processDrawingPrompt(
  preset: ImageOutputPreset,
  prompt: string,
  options: PromptProcessorOptions = {},
): Promise<PromptProcessingResult> {
  const processedPrompt = applyOutputPromptTemplate(preset.templateText, prompt);
  if (!preset.useAvatarReferences) {
    return { prompt: processedPrompt, processing: 'processed' };
  }

  const readReferences = options.readReferences ?? readCurrentAvatarReferences;
  let references: AvatarReferenceReadResult;
  try {
    references = await readReferences();
  } catch {
    // 头像是增强输入，不应阻塞正文图片任务；没有可用头像时保持文字 prompt。
    references = { references: [], failedSources: [] };
  }

  const referenceImages = references.references.map(reference => reference.value).filter(Boolean);
  const result: PromptProcessingResult = {
    prompt: processedPrompt,
    processing: 'processed',
  };
  if (referenceImages.length > 0) result.referenceImages = referenceImages;
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
