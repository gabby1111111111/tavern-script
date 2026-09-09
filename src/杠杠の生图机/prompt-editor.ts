import type { AvatarReferenceSource } from './avatar-references';
import { applyOutputPromptTemplate } from './prompt-processor';
import type { ImageOutputPreset, ImageReferenceKind, ResolvedReferenceSource } from './pipeline-types';
import { resolveRegionEditorMountTarget } from './region-redraw-editor';

export type PromptEditorOutputPreset = Pick<
  ImageOutputPreset,
  'id' | 'name' | 'templateText' | 'useAvatarReferences' | 'usePreviousStoryImage'
>;

export type PromptEditorAvatarReferenceStatus = {
  enabled: boolean;
  availableSources: AvatarReferenceSource[];
  failedSources: AvatarReferenceSource[];
};

export type PromptEditorReferenceSelection = {
  /** False means the placement predates reference provenance tracking. */
  known: boolean;
  useAvatarReferences: boolean;
  usePreviousStoryImage: boolean;
};

export type PromptEditorReferenceAvailability = {
  avatarReferences: boolean;
  previousStoryImage: boolean;
};

export type PromptEditorReferencePreparation = (
  selection: PromptEditorReferenceSelection,
  signal: AbortSignal,
) => Promise<ResolvedReferenceSource[]>;

export type ImagePromptEditorInput = {
  prompt: string;
  /** Exact final API text retained by the page-memory placement, when known. */
  finalPrompt?: string;
  outputPreset: PromptEditorOutputPreset;
  avatarReferences: PromptEditorAvatarReferenceStatus;
  previousShotPrompt?: string;
  referenceSources?: ResolvedReferenceSource[];
  referenceSelection?: PromptEditorReferenceSelection;
  referenceAvailability?: PromptEditorReferenceAvailability;
  /** Materializes only the sources enabled for this one redraw. */
  prepareReferenceSources?: PromptEditorReferencePreparation;
  signal?: AbortSignal;
};

export type ImagePromptEditorResult = {
  /** The exact final prompt text the user confirmed for the image API. */
  prompt: string;
  /** The editable scene description retained for future continuity metadata. */
  scenePrompt?: string;
  /** The exact sources selected for this one redraw. */
  referenceSources?: ResolvedReferenceSource[];
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

export function buildPromptEditorFinalPrompt(
  templateText: string,
  prompt: string,
  previousShotPrompt = '',
  referenceSources: ResolvedReferenceSource[] = [],
): string {
  return applyOutputPromptTemplate(templateText, prompt.trim(), previousShotPrompt, referenceSources);
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

export function canConfirmPromptEditorFinalPrompt(prompt: string): boolean {
  return prompt.trim().length > 0;
}

export function selectPromptEditorReferenceSources(
  sources: ReadonlyArray<ResolvedReferenceSource>,
  selection?: PromptEditorReferenceSelection,
): ResolvedReferenceSource[] {
  if (!selection) return sources.map(source => ({ ...source }));
  return sources
    .filter(source => {
      if (source.kind === 'previous-story-image') return selection.usePreviousStoryImage;
      return selection.useAvatarReferences;
    })
    .map(source => ({ ...source }));
}

const promptEditorReferenceLabels: Record<ImageReferenceKind, string> = {
  'user-avatar': 'User 头像',
  'character-avatar': '角色头像',
  'previous-story-image': '上一镜头参考图',
};

/**
 * Build labels for the editor before optional reference bytes are read. Empty
 * values are intentional placeholders for the preview and must be replaced by
 * prepareReferenceSources before a request is submitted.
 */
export function buildPromptEditorReferenceCandidates(
  recordedKinds: ReadonlyArray<ImageReferenceKind> | undefined,
  availability: PromptEditorReferenceAvailability,
): ResolvedReferenceSource[] {
  const recorded = new Set(recordedKinds ?? []);
  const kinds: ImageReferenceKind[] = [];
  if (availability.avatarReferences || recorded.has('user-avatar') || recorded.has('character-avatar')) {
    kinds.push('user-avatar', 'character-avatar');
  }
  if (availability.previousStoryImage || recorded.has('previous-story-image')) {
    kinds.push('previous-story-image');
  }
  return kinds.map(kind => ({ kind, label: promptEditorReferenceLabels[kind], value: '' }));
}

function isPromptEditorFocusable(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true' || element.closest('[hidden]')) return false;
  if (element.getAttribute('inert') !== null || element.closest('[inert]')) return false;
  if ('disabled' in element && Boolean((element as HTMLButtonElement | HTMLInputElement).disabled)) return false;
  const view = element.ownerDocument?.defaultView;
  if (view) {
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

export function getPromptEditorFocusableElements(elements: readonly HTMLElement[]): HTMLElement[] {
  return elements.filter(isPromptEditorFocusable);
}

export function describePromptEditorReferenceSelection(
  sources: ReadonlyArray<ResolvedReferenceSource>,
  selection: PromptEditorReferenceSelection,
): string {
  const hasAvatar = sources.some(source => source.kind === 'user-avatar' || source.kind === 'character-avatar');
  const hasPrevious = sources.some(source => source.kind === 'previous-story-image');
  const messages: string[] = [];
  if (!selection.known) messages.push('原参考记录不可用，请选择本次要使用的参考图。');
  if (selection.useAvatarReferences && !hasAvatar) messages.push('头像参考当前不可用，本次不会附带头像。');
  if (selection.usePreviousStoryImage && !hasPrevious) messages.push('上一镜头图当前不可用，本次不会附带上一镜头图。');
  const selected = selectPromptEditorReferenceSources(sources, selection);
  if (selected.length > 0) messages.push(`本次将附带 ${selected.length} 类参考图。`);
  else if (messages.length === 0) messages.push('本次不附带参考图。');
  return messages.join(' ');
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
      '场景描述用于辅助生成最终提示词；最终提示词框中的内容就是本次实际发送给生图 API 的文本。',
    );
    const preset = createElement(ownerDocument, 'p', 'story-image-prompt-editor__preset');
    preset.textContent = `当前出图预设：${input.outputPreset.name}`;
    let referenceSources = input.referenceSources ?? [];
    const referenceSelection: PromptEditorReferenceSelection = input.referenceSelection ?? {
      known: input.referenceSources !== undefined,
      useAvatarReferences: referenceSources.some(
        source => source.kind === 'user-avatar' || source.kind === 'character-avatar',
      ),
      usePreviousStoryImage: referenceSources.some(source => source.kind === 'previous-story-image'),
    };
    let selectedReferenceSources = selectPromptEditorReferenceSources(referenceSources, referenceSelection);
    const referencePanel = createElement(ownerDocument, 'div', 'story-image-prompt-editor__references');
    const referenceTitle = createElement(
      ownerDocument,
      'p',
      'story-image-prompt-editor__references-title',
      '本次参考图',
    );
    const referenceControls = createElement(ownerDocument, 'div', 'story-image-prompt-editor__reference-controls');
    const avatarReferenceLabel = createElement(ownerDocument, 'label', 'story-image-prompt-editor__reference-option');
    const avatarReferenceToggle = createElement(ownerDocument, 'input', 'story-image-prompt-editor__reference-toggle');
    avatarReferenceToggle.type = 'checkbox';
    avatarReferenceToggle.checked = referenceSelection.useAvatarReferences;
    avatarReferenceToggle.disabled = !(
      input.referenceAvailability?.avatarReferences ??
      referenceSources.some(source => source.kind === 'user-avatar' || source.kind === 'character-avatar')
    );
    avatarReferenceToggle.setAttribute('aria-label', '使用头像参考');
    const avatarReferenceText = createElement(ownerDocument, 'span', '', '使用头像参考');
    avatarReferenceLabel.append(avatarReferenceToggle, avatarReferenceText);
    const previousReferenceLabel = createElement(ownerDocument, 'label', 'story-image-prompt-editor__reference-option');
    const previousReferenceToggle = createElement(
      ownerDocument,
      'input',
      'story-image-prompt-editor__reference-toggle',
    );
    previousReferenceToggle.type = 'checkbox';
    previousReferenceToggle.checked = referenceSelection.usePreviousStoryImage;
    previousReferenceToggle.disabled = !(
      input.referenceAvailability?.previousStoryImage ??
      referenceSources.some(source => source.kind === 'previous-story-image')
    );
    previousReferenceToggle.setAttribute('aria-label', '使用上一镜头图参考');
    const previousReferenceText = createElement(ownerDocument, 'span', '', '使用上一镜头图参考');
    previousReferenceLabel.append(previousReferenceToggle, previousReferenceText);
    referenceControls.append(avatarReferenceLabel, previousReferenceLabel);
    const referenceStatus = createElement(ownerDocument, 'p', 'story-image-prompt-editor__reference-status');
    referencePanel.append(referenceTitle, referenceControls, referenceStatus);
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
    const finalPromptLabel = createElement(
      ownerDocument,
      'label',
      'story-image-prompt-editor__final-label',
      '最终提示词（实际发送内容）',
    );
    const finalPromptControls = createElement(ownerDocument, 'div', 'story-image-prompt-editor__final-controls');
    const finalPromptTextarea = createElement(
      ownerDocument,
      'textarea',
      'story-image-prompt-editor__textarea story-image-prompt-editor__final-textarea',
    );
    finalPromptTextarea.value = input.finalPrompt?.trim()
      ? input.finalPrompt
      : buildPromptEditorFinalPrompt(
          input.outputPreset.templateText,
          sceneTextarea.value,
          input.previousShotPrompt,
          selectedReferenceSources,
        );
    finalPromptTextarea.setAttribute('aria-label', '最终提示词（实际发送内容）');
    finalPromptTextarea.rows = 12;
    finalPromptTextarea.autocomplete = 'off';
    finalPromptTextarea.spellcheck = false;
    const clearFinalPrompt = createElement(
      ownerDocument,
      'button',
      'story-image-prompt-editor__button story-image-prompt-editor__clear-final',
      '清空最终提示词',
    );
    clearFinalPrompt.type = 'button';
    finalPromptControls.append(finalPromptTextarea, clearFinalPrompt);
    finalPromptLabel.append(finalPromptControls);
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

    let finalPromptEdited = Boolean(input.finalPrompt?.trim());
    let referencePreparationError = false;
    const preparationPromises = new Map<string, Promise<ResolvedReferenceSource[]>>();
    const currentReferenceSelection = (): PromptEditorReferenceSelection => ({
      ...referenceSelection,
      useAvatarReferences: avatarReferenceToggle.checked,
      usePreviousStoryImage: previousReferenceToggle.checked,
    });
    const selectedReferenceKindRequested = (selection: PromptEditorReferenceSelection): boolean =>
      selection.useAvatarReferences || selection.usePreviousStoryImage;
    const referenceSelectionKey = (selection: PromptEditorReferenceSelection): string =>
      `${selection.useAvatarReferences ? 'avatar' : 'no-avatar'}:${selection.usePreviousStoryImage ? 'previous' : 'no-previous'}`;
    let activePreparationKey: string | null = null;
    const updateConfirmState = (): void => {
      confirm.disabled =
        activePreparationKey === referenceSelectionKey(currentReferenceSelection()) ||
        referencePreparationError ||
        !canConfirmPromptEditorFinalPrompt(finalPromptTextarea.value);
    };
    const replacePreparedReferenceSources = (
      preparedSources: readonly ResolvedReferenceSource[],
      selection: PromptEditorReferenceSelection,
    ): void => {
      const requestedKinds = new Set<ImageReferenceKind>();
      if (selection.useAvatarReferences) {
        requestedKinds.add('user-avatar');
        requestedKinds.add('character-avatar');
      }
      if (selection.usePreviousStoryImage) requestedKinds.add('previous-story-image');
      const unrequestedCandidates = referenceSources.filter(source => !requestedKinds.has(source.kind));
      const preparedByKind = new Map(preparedSources.map(source => [source.kind, { ...source }]));
      referenceSources = [...unrequestedCandidates, ...preparedByKind.values()];
    };
    const updateReferenceStatus = (selection: PromptEditorReferenceSelection, message?: string): void => {
      referenceStatus.textContent = message ?? describePromptEditorReferenceSelection(referenceSources, selection);
    };
    const applyPreparedReferenceSources = (
      key: string,
      selection: PromptEditorReferenceSelection,
      preparedSources: readonly ResolvedReferenceSource[],
    ): ResolvedReferenceSource[] => {
      if (signal.aborted) return [];
      replacePreparedReferenceSources(preparedSources, selection);
      const currentSelection = currentReferenceSelection();
      if (referenceSelectionKey(currentSelection) === key) {
        activePreparationKey = null;
        referencePreparationError = false;
        selectedReferenceSources = selectPromptEditorReferenceSources(referenceSources, currentSelection);
        if (!finalPromptEdited) updateFinalPromptFromScene();
        updateReferenceStatus(currentSelection);
        updateConfirmState();
      }
      // A stale selection may finish after the user has switched the
      // checkboxes. Return the sources for that request itself without
      // overwriting the current selection's in-memory list.
      return selectPromptEditorReferenceSources(referenceSources, selection);
    };
    const applyReferencePreparationError = (
      key: string,
      selection: PromptEditorReferenceSelection,
      error: unknown,
    ): void => {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      if (referenceSelectionKey(currentReferenceSelection()) !== key) return;
      activePreparationKey = null;
      referencePreparationError = true;
      updateReferenceStatus(selection, '参考图准备失败，请关闭该参考开关后再提交。');
      updateConfirmState();
    };
    const prepareReferences = (selection: PromptEditorReferenceSelection): Promise<ResolvedReferenceSource[]> => {
      if (!input.prepareReferenceSources || !selectedReferenceKindRequested(selection)) {
        selectedReferenceSources = selectPromptEditorReferenceSources(referenceSources, selection);
        activePreparationKey = null;
        referencePreparationError = false;
        updateConfirmState();
        return Promise.resolve(selectedReferenceSources);
      }
      const key = referenceSelectionKey(selection);
      activePreparationKey = key;
      referencePreparationError = false;
      confirm.disabled = true;
      updateReferenceStatus(selection, '正在准备本次选择的参考图，请稍候。');
      const existing = preparationPromises.get(key);
      if (existing) {
        // A previously completed promise still needs to replay the state
        // transition for the current checkbox selection. Without this,
        // toggling the same reference off and on leaves the editor disabled
        // forever even though no second read is necessary.
        void existing.then(
          preparedSources => applyPreparedReferenceSources(key, selection, preparedSources),
          error => applyReferencePreparationError(key, selection, error),
        );
        return existing;
      }
      const preparation = input
        .prepareReferenceSources(selection, signal)
        .then(preparedSources => applyPreparedReferenceSources(key, selection, preparedSources))
        .catch(error => {
          applyReferencePreparationError(key, selection, error);
          throw error;
        });
      preparationPromises.set(key, preparation);
      return preparation;
    };
    const updateReferenceSelection = (): void => {
      const selection = currentReferenceSelection();
      selectedReferenceSources = selectPromptEditorReferenceSources(referenceSources, selection);
      updateReferenceStatus(selection);
      if (!finalPromptEdited) updateFinalPromptFromScene();
      void prepareReferences(selection).catch(error => {
        if (
          !signal.aborted &&
          !(error instanceof Error && error.name === 'AbortError') &&
          referenceSelectionKey(currentReferenceSelection()) === referenceSelectionKey(selection)
        ) {
          referenceStatus.textContent = '参考图准备失败，请关闭该参考开关后再提交。';
        }
      });
    };
    const updateFinalPromptFromScene = (): void => {
      if (finalPromptEdited) return;
      finalPromptTextarea.value = buildPromptEditorFinalPrompt(
        input.outputPreset.templateText,
        sceneTextarea.value,
        input.previousShotPrompt,
        selectedReferenceSources,
      );
      updateConfirmState();
    };
    sceneTextarea.addEventListener('input', updateFinalPromptFromScene, { signal });
    avatarReferenceToggle.addEventListener('change', updateReferenceSelection, { signal });
    previousReferenceToggle.addEventListener('change', updateReferenceSelection, { signal });
    finalPromptTextarea.addEventListener(
      'input',
      () => {
        finalPromptEdited = true;
        error.textContent = '';
        referencePreparationError = false;
        updateConfirmState();
      },
      { signal },
    );
    clearFinalPrompt.addEventListener(
      'click',
      () => {
        finalPromptEdited = true;
        finalPromptTextarea.value = '';
        error.textContent = '';
        referencePreparationError = false;
        confirm.disabled = true;
        finalPromptTextarea.focus();
      },
      { signal },
    );
    updateReferenceSelection();
    dialog.append(title, hint, preset, sceneLabel, referencePanel, finalPromptLabel, error, actions);
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
        const value = finalPromptTextarea.value;
        if (!canConfirmPromptEditorFinalPrompt(value)) {
          error.textContent = '最终提示词不能为空。';
          finalPromptTextarea.focus();
          return;
        }
        const selection = currentReferenceSelection();
        if (activePreparationKey === referenceSelectionKey(selection)) return;
        if (input.prepareReferenceSources && selectedReferenceKindRequested(selection)) {
          confirm.disabled = true;
          void prepareReferences(selection)
            .then(preparedSources => {
              if (signal.aborted) return;
              const finalValue = finalPromptTextarea.value;
              if (!canConfirmPromptEditorFinalPrompt(finalValue)) {
                confirm.disabled = true;
                return;
              }
              finish({
                prompt: finalValue,
                scenePrompt: sceneTextarea.value,
                referenceSources: preparedSources.map(source => ({ ...source })),
                outputPreset: { ...input.outputPreset },
              });
            })
            .catch(caughtError => {
              if (signal.aborted || (caughtError instanceof Error && caughtError.name === 'AbortError')) return;
              error.textContent = '参考图准备失败，请关闭该参考开关后再提交。';
              finalPromptTextarea.focus();
            });
          return;
        }
        finish({
          prompt: value,
          scenePrompt: sceneTextarea.value,
          referenceSources: selectedReferenceSources.map(source => ({ ...source })),
          outputPreset: { ...input.outputPreset },
        });
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
        const focusable = getPromptEditorFocusableElements([
          sceneTextarea,
          avatarReferenceToggle,
          previousReferenceToggle,
          finalPromptTextarea,
          clearFinalPrompt,
          cancel,
          confirm,
        ]);
        if (focusable.length === 0) return;
        const current = ownerDocument.activeElement as HTMLElement | null;
        const currentIndex = focusable.indexOf(current as HTMLElement);
        const nextIndex = event.shiftKey
          ? currentIndex < 0 || currentIndex === 0
            ? focusable.length - 1
            : currentIndex - 1
          : currentIndex < 0 || currentIndex >= focusable.length - 1
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
