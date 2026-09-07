import type { AvatarReferenceSource } from './avatar-references';
import { applyOutputPromptTemplate } from './prompt-processor';
import type { ImageOutputPreset } from './pipeline-types';
import { resolveRegionEditorMountTarget } from './region-redraw-editor';

export type PromptEditorOutputPreset = Pick<ImageOutputPreset, 'id' | 'name' | 'templateText' | 'useAvatarReferences'>;

export type PromptEditorAvatarReferenceStatus = {
  enabled: boolean;
  availableSources: AvatarReferenceSource[];
  failedSources: AvatarReferenceSource[];
};

export type ImagePromptEditorInput = {
  prompt: string;
  outputPreset: PromptEditorOutputPreset;
  avatarReferences: PromptEditorAvatarReferenceStatus;
  signal?: AbortSignal;
};

export type ImagePromptEditorResult = {
  prompt: string;
  outputPreset: PromptEditorOutputPreset;
};

let activePromptEditorClose: (() => void) | null = null;

function createElement<K extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = ownerDocument.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

const avatarSourceLabels: Record<AvatarReferenceSource, string> = {
  persona: '用户头像',
  character: '角色头像',
};

function sourceLabels(sources: AvatarReferenceSource[]): string[] {
  return sources.map(source => avatarSourceLabels[source]);
}

export function buildPromptEditorFinalPrompt(templateText: string, prompt: string): string {
  return applyOutputPromptTemplate(templateText, prompt.trim());
}

export function describePromptEditorAvatarReferences(status: PromptEditorAvatarReferenceStatus): string {
  if (!status.enabled) return '头像参考图：已关闭，本次不会使用。';
  const available = sourceLabels(status.availableSources);
  const failed = sourceLabels(status.failedSources);
  if (available.length > 0) {
    const failedText = failed.length > 0 ? `；${failed.join('、')}读取失败，本次不使用这些头像` : '';
    return `头像参考图：本次将使用${available.join('、')}${failedText}。`;
  }
  if (failed.length > 0) {
    return `头像参考图：已启用，但${failed.join('、')}读取失败，本次不使用头像。`;
  }
  return '头像参考图：已启用，但没有可用的角色或用户头像，本次不使用头像。';
}

export function describePromptEditorTemplateWarning(templateText: string): string {
  return templateText.includes('{{xx}}') ? '' : '当前出图预设不包含 {{xx}}：你编辑的场景描述不会进入最终提示词。';
}

/** Open a prompt editor that previews the current output preset without changing settings. */
export function openImagePromptEditor(input: ImagePromptEditorInput): Promise<ImagePromptEditorResult | null> {
  if (input.signal?.aborted) return Promise.resolve(null);

  return new Promise<ImagePromptEditorResult | null>(resolve => {
    activePromptEditorClose?.();
    const mountTarget = resolveRegionEditorMountTarget(document);
    const ownerDocument = mountTarget.ownerDocument;
    const previousFocus =
      ownerDocument.activeElement && 'focus' in ownerDocument.activeElement
        ? (ownerDocument.activeElement as HTMLElement)
        : null;
    const controller = new AbortController();
    const { signal } = controller;
    const overlay = createElement(ownerDocument, 'div', 'story-image-prompt-editor');
    const dialog = createElement(ownerDocument, 'div', 'story-image-prompt-editor__dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const title = createElement(ownerDocument, 'h3', 'story-image-prompt-editor__title', '修改图片提示词');
    const titleId = `story-image-prompt-editor-title-${Date.now()}`;
    title.id = titleId;
    dialog.setAttribute('aria-labelledby', titleId);
    const hint = createElement(
      ownerDocument,
      'p',
      'story-image-prompt-editor__hint',
      '这里只修改本图场景描述；预设请到插件的“出图预设”修改。',
    );
    const preset = createElement(ownerDocument, 'p', 'story-image-prompt-editor__preset');
    preset.textContent = `当前出图预设：${input.outputPreset.name}`;
    const templateLabel = createElement(ownerDocument, 'label', 'story-image-prompt-editor__label', '当前出图模板');
    const templateTextarea = createElement(
      ownerDocument,
      'textarea',
      'story-image-prompt-editor__textarea story-image-prompt-editor__template-text',
    );
    templateTextarea.value = input.outputPreset.templateText;
    templateTextarea.readOnly = true;
    templateTextarea.setAttribute('aria-label', '当前出图模板');
    templateTextarea.rows = 8;
    templateTextarea.tabIndex = -1;
    templateLabel.append(templateTextarea);
    const avatarReferences = createElement(ownerDocument, 'p', 'story-image-prompt-editor__references');
    avatarReferences.textContent = describePromptEditorAvatarReferences(input.avatarReferences);
    const sceneLabel = createElement(
      ownerDocument,
      'label',
      'story-image-prompt-editor__scene-label',
      '场景描述（{{xx}}）',
    );
    const sceneTextarea = createElement(
      ownerDocument,
      'textarea',
      'story-image-prompt-editor__textarea story-image-prompt-editor__scene-textarea',
    );
    sceneTextarea.value = input.prompt;
    sceneTextarea.setAttribute('aria-label', '场景描述（{{xx}}）');
    sceneTextarea.rows = 8;
    sceneTextarea.autocomplete = 'off';
    sceneTextarea.spellcheck = false;
    sceneLabel.append(sceneTextarea);
    const previewDetails = createElement(ownerDocument, 'details', 'story-image-prompt-editor__preview');
    const previewSummary = createElement(ownerDocument, 'summary', '', '最终发送提示词预览（可折叠）');
    const previewPrompt = createElement(ownerDocument, 'pre', 'story-image-prompt-editor__preview-text');
    const templateWarning = createElement(ownerDocument, 'p', 'story-image-prompt-editor__warning');
    templateWarning.setAttribute('role', 'status');
    previewDetails.append(previewSummary, previewPrompt);
    const error = createElement(ownerDocument, 'p', 'story-image-prompt-editor__error');
    error.setAttribute('role', 'alert');
    const actions = createElement(ownerDocument, 'div', 'story-image-prompt-editor__footer');
    const cancel = createElement(ownerDocument, 'button', 'story-image-prompt-editor__button', '取消');
    cancel.type = 'button';
    const confirm = createElement(
      ownerDocument,
      'button',
      'story-image-prompt-editor__button story-image-prompt-editor__button--primary',
      '确认生成',
    );
    confirm.type = 'button';
    actions.append(cancel, confirm);

    const updatePreview = (): void => {
      previewPrompt.textContent = buildPromptEditorFinalPrompt(input.outputPreset.templateText, sceneTextarea.value);
      templateWarning.textContent = describePromptEditorTemplateWarning(input.outputPreset.templateText);
    };
    sceneTextarea.addEventListener('input', updatePreview, { signal });
    updatePreview();
    dialog.append(
      title,
      hint,
      preset,
      sceneLabel,
      templateLabel,
      avatarReferences,
      templateWarning,
      previewDetails,
      error,
      actions,
    );
    overlay.append(dialog);
    mountTarget.append(overlay);

    let settled = false;
    const onAbort = (): void => close();
    const finish = (result: ImagePromptEditorResult | null): void => {
      if (settled) return;
      settled = true;
      if (activePromptEditorClose === close) activePromptEditorClose = null;
      input.signal?.removeEventListener('abort', onAbort);
      controller.abort();
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(result);
    };
    const close = (): void => finish(null);
    activePromptEditorClose = close;

    cancel.addEventListener('click', close, { signal });
    confirm.addEventListener(
      'click',
      () => {
        const value = sceneTextarea.value.trim();
        if (!value) {
          error.textContent = '场景描述不能为空。';
          sceneTextarea.focus();
          return;
        }
        finish({ prompt: value, outputPreset: { ...input.outputPreset } });
      },
      { signal },
    );
    overlay.addEventListener('pointerdown', event => event.target === overlay && close(), { signal });
    ownerDocument.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable: HTMLElement[] = [sceneTextarea, previewSummary, cancel, confirm];
        const current = ownerDocument.activeElement as HTMLElement | null;
        const currentIndex = focusable.indexOf(current as HTMLElement);
        const nextIndex = event.shiftKey
          ? currentIndex <= 0
            ? focusable.length - 1
            : currentIndex - 1
          : currentIndex >= focusable.length - 1
            ? 0
            : currentIndex + 1;
        event.preventDefault();
        focusable[nextIndex].focus();
      },
      { signal },
    );
    input.signal?.addEventListener('abort', onAbort, { once: true });

    if (input.signal?.aborted) close();
    else sceneTextarea.focus();
  });
}
