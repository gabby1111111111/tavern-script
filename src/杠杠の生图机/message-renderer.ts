import { cleanInlineImageMarkers } from './marker';
import type { ImagePlacement } from './image-placement';
import type { ImagePlacementTarget } from './image-system';
import { groupImagePlacements } from './renderer-model';
import { imageTaskKey, type ImageTask } from './task-cache';

export type ImageTaskRenderHandlers = {
  onImageError?: (task: ImageTask) => boolean;
};

export type ImagePlacementRenderHandlers = {
  onImageError?: (placement: ImagePlacement) => void;
  onEditPrompt?: (placement: ImagePlacement, onSubmitted?: () => void) => Promise<void> | void;
  onRegionRedraw?: (placement: ImagePlacement, onSubmitted?: () => void) => Promise<void> | void;
  onDelete?: (placement: ImagePlacement) => Promise<void> | void;
  onPin?: (placement: ImagePlacement) => Promise<void> | void;
  isPinned?: (placement: ImagePlacement) => boolean;
};

const renderedTaskByHost = new WeakMap<HTMLElement, ImageTask>();
const renderedImageByPlacement = new WeakMap<ImagePlacement, HTMLImageElement>();
const OWNED_IMAGE_HOST_SELECTOR = '[data-story-image-host], [data-story-image-placement-host]';
type PlacementActionId = 'edit-prompt' | 'region-redraw' | 'delete' | 'pin';
type RevisionSelection = { placementId: string; revisionIndex: number };
const selectedRevisionByVariant = new Map<string, RevisionSelection>();
const selectedVariantByGroup = new Map<string, number>();
const activePlacementActions = new Set<string>();
const loadingPlacementActions = new Set<string>();
const renderedPlacements = new WeakSet<ImagePlacement>();

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function currentSwipeId(messageId: number): number {
  const message = getChatMessages(messageId, { include_swipes: true })[0];
  return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}

function messageElement(messageId: number): JQuery<HTMLElement> {
  return $(`#chat > .mes[mesid="${messageId}"]`);
}

function removeRenderedMarkerText($mesText: JQuery<HTMLElement>): void {
  $mesText
    .find('pic')
    .filter((_index, element) => $(element).closest('pre, code').length === 0)
    .remove();
  const root = $mesText[0];
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (!textNode.parentElement?.closest('pre, code')) nodes.push(textNode);
    node = walker.nextNode();
  }
  nodes.forEach(textNode => {
    textNode.nodeValue = cleanInlineImageMarkers(textNode.nodeValue ?? '');
  });
}

function paragraphCandidates($mesText: JQuery<HTMLElement>): JQuery<HTMLElement> {
  const $blocks = $mesText.find('p, li, blockquote, pre, h1, h2, h3');
  return $blocks.length > 0 ? $blocks : $mesText;
}

function findAnchorParagraph(
  $mesText: JQuery<HTMLElement>,
  target: Pick<ImagePlacementTarget, 'paragraphIndex' | 'anchorTextBefore' | 'anchorTextAfter'>,
): JQuery<HTMLElement> {
  const $blocks = paragraphCandidates($mesText);
  const direct = $blocks.eq(target.paragraphIndex);
  const before = normalizeText(target.anchorTextBefore);
  const after = normalizeText(target.anchorTextAfter);
  const score = (element: HTMLElement): number => {
    const text = normalizeText($(element).text());
    let value = 0;
    if (before && text.includes(before)) value += 2;
    if (after && text.includes(after)) value += 2;
    return value;
  };
  let $best = direct.length > 0 ? direct : $blocks.first();
  let bestScore = $best[0] ? score($best[0]) : -1;

  $blocks.each((_index, element) => {
    const candidateScore = score(element);
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      $best = $(element);
    }
  });

  if (bestScore > 0) return $best;
  return direct.length > 0 ? direct : $blocks.first();
}

function hostImageIndex($host: JQuery<HTMLElement>): number {
  const value = Number($host.attr('data-story-image-index'));
  return Number.isInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
}

function positionImageHost(
  $host: JQuery<HTMLElement>,
  $mesText: JQuery<HTMLElement>,
  target: Pick<ImagePlacementTarget, 'imageIndex' | 'paragraphIndex' | 'anchorTextBefore' | 'anchorTextAfter'>,
): void {
  $host.attr('data-story-image-index', String(target.imageIndex)).detach();
  const $anchor = findAnchorParagraph($mesText, target);
  if ($anchor.is($mesText)) {
    let inserted = false;
    $mesText.children(OWNED_IMAGE_HOST_SELECTOR).each((_index, element) => {
      if (inserted) return;
      const $candidate = $(element) as JQuery<HTMLElement>;
      if (hostImageIndex($candidate) <= target.imageIndex) return;
      $host.insertBefore($candidate);
      inserted = true;
    });
    if (!inserted) $host.appendTo($mesText);
    return;
  }

  let $cursor = $anchor;
  let $next = $cursor.next() as JQuery<HTMLElement>;
  while ($next.length > 0 && $next.is(OWNED_IMAGE_HOST_SELECTOR)) {
    if (hostImageIndex($next) > target.imageIndex) break;
    $cursor = $next;
    $next = $cursor.next() as JQuery<HTMLElement>;
  }
  $host.insertAfter($cursor);
}

function findOrCreateHost($mesText: JQuery<HTMLElement>, task: ImageTask): JQuery<HTMLElement> {
  const key = imageTaskKey(task);
  let $host = $mesText.find('[data-story-image-host]').filter((_index, element) => {
    return $(element).attr('data-story-image-key') === key;
  });
  if ($host.length > 0) {
    $host = $host.first() as JQuery<HTMLElement>;
    positionImageHost($host, $mesText, task);
    return $host;
  }

  $host = $('<div class="story-image-host" data-story-image-host="true">').attr('data-story-image-key', key);
  positionImageHost($host, $mesText, task);
  return $host;
}

function removeStaleHosts($message: JQuery<HTMLElement>, chatId: string, messageId: number, swipeId: number): void {
  const prefix = `${chatId}::${messageId}::${swipeId}::`;
  $message.find('[data-story-image-host]').each((_index, element) => {
    const key = $(element).attr('data-story-image-key') ?? '';
    if (!key.startsWith(prefix)) $(element).remove();
  });
}

export function clearRenderedHosts(): void {
  selectedRevisionByVariant.clear();
  selectedVariantByGroup.clear();
  $('#chat').find('[data-story-image-host], [data-story-image-placement-host]').remove();
}

function clearRevisionSelection(placementId: string): void {
  for (const [key, selection] of selectedRevisionByVariant) {
    if (selection.placementId === placementId) selectedRevisionByVariant.delete(key);
  }
}

export function removeRenderedTaskHost(task: ImageTask): void {
  const key = imageTaskKey(task);
  $('#chat')
    .find('[data-story-image-host]')
    .filter((_index, element) => $(element).attr('data-story-image-key') === key)
    .remove();
}

function displayedMessageText(messageId: number): JQuery<HTMLElement> {
  const $displayed = retrieveDisplayedMessage(messageId) as unknown as JQuery<HTMLElement>;
  if ($displayed.length === 0) return $displayed;
  if ($displayed.is('.mes_text')) return $displayed.first() as JQuery<HTMLElement>;
  const $nested = $displayed.find('.mes_text').first() as JQuery<HTMLElement>;
  return $nested.length > 0 ? $nested : ($displayed.first() as JQuery<HTMLElement>);
}

function placementGroupKey(placement: ImagePlacement): string {
  const { messageId, swipeId, imageIndex } = placement.target;
  return `${messageId}::${swipeId}::${imageIndex}`;
}

function validVariantIndex(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const variantIndex = Number(value);
  return Number.isInteger(variantIndex) && variantIndex >= 0 ? variantIndex : undefined;
}

function latestRevision(placements: ReadonlyArray<ImagePlacement>): ImagePlacement | undefined {
  return [...placements].sort((lhs, rhs) => lhs.revisionIndex - rhs.revisionIndex || lhs.createdAt - rhs.createdAt)[
    placements.length - 1
  ];
}

function domPlacementSelection(
  groupKey: string,
  placements: ReadonlyArray<ImagePlacement>,
): { variantIndex?: number; placement?: ImagePlacement } {
  if (typeof document === 'undefined' || typeof $ !== 'function') return {};
  const $host = $('#chat')
    .find('[data-story-image-placement-host]')
    .filter((_index, element) => $(element).attr('data-story-image-placement-group') === groupKey)
    .first() as JQuery<HTMLElement>;
  if ($host.length === 0) return {};
  const $carousel = $host.find('.story-image-carousel').first() as JQuery<HTMLElement>;
  const $slot = $carousel
    .children('[data-story-image-variant][data-story-image-selected="true"]')
    .first() as JQuery<HTMLElement>;
  const variantIndex = validVariantIndex($slot.attr('data-story-image-variant'));
  if (variantIndex === undefined) return {};
  const $slide = $slot
    .find('[data-story-image-placement-id][data-story-image-selected="true"]')
    .first() as JQuery<HTMLElement>;
  const placementId = $slide.attr('data-story-image-placement-id');
  const placement = placements.find(item => item.id === placementId && item.variantIndex === variantIndex);
  return placement ? { variantIndex, placement } : { variantIndex };
}

function rememberedRevision(
  groupKey: string,
  variantIndex: number,
  placements: ReadonlyArray<ImagePlacement>,
): ImagePlacement | undefined {
  const selection = selectedRevisionByVariant.get(`${groupKey}::${variantIndex}`);
  if (selection) {
    const byId = placements.find(placement => placement.id === selection.placementId);
    if (byId) return byId;
    const byRevision = placements.filter(placement => placement.revisionIndex === selection.revisionIndex);
    if (byRevision.length > 0) return latestRevision(byRevision);
  }
  return latestRevision(placements);
}

export function getSelectedImagePlacements(placements: ReadonlyArray<ImagePlacement>): ImagePlacement[] {
  const groups = new Map<string, ImagePlacement[]>();
  placements.forEach(placement => {
    const group = groups.get(placementGroupKey(placement)) ?? [];
    group.push(placement);
    groups.set(placementGroupKey(placement), group);
  });

  const selected: ImagePlacement[] = [];
  groups.forEach((group, groupKey) => {
    const domSelection = domPlacementSelection(groupKey, group);
    if (domSelection.placement) {
      selected.push(domSelection.placement);
      return;
    }

    const variants = new Map<number, ImagePlacement[]>();
    group.forEach(placement => {
      const variant = variants.get(placement.variantIndex) ?? [];
      variant.push(placement);
      variants.set(placement.variantIndex, variant);
    });
    const variantIndexes = [...variants.keys()].sort((lhs, rhs) => lhs - rhs);
    if (variantIndexes.length === 0) return;
    const rememberedVariant = selectedVariantByGroup.get(groupKey);
    const variantIndex =
      domSelection.variantIndex !== undefined && variants.has(domSelection.variantIndex)
        ? domSelection.variantIndex
        : rememberedVariant !== undefined && variants.has(rememberedVariant)
          ? rememberedVariant
          : variantIndexes[0];
    const variantPlacements = variants.get(variantIndex);
    if (!variantPlacements) return;
    const placement = rememberedRevision(groupKey, variantIndex, variantPlacements);
    if (placement) selected.push(placement);
  });
  return selected;
}

export function pruneImagePlacementSelections(placements: ReadonlyArray<ImagePlacement>): void {
  const placementsByGroup = new Map<string, Map<number, Set<string>>>();
  placements.forEach(placement => {
    const groupKey = placementGroupKey(placement);
    const variants = placementsByGroup.get(groupKey) ?? new Map<number, Set<string>>();
    const placementIds = variants.get(placement.variantIndex) ?? new Set<string>();
    placementIds.add(placement.id);
    variants.set(placement.variantIndex, placementIds);
    placementsByGroup.set(groupKey, variants);
  });

  for (const [groupKey, variantIndex] of selectedVariantByGroup) {
    if (!placementsByGroup.get(groupKey)?.has(variantIndex)) selectedVariantByGroup.delete(groupKey);
  }

  for (const [selectionKey, selection] of selectedRevisionByVariant) {
    const separator = selectionKey.lastIndexOf('::');
    const groupKey = separator >= 0 ? selectionKey.slice(0, separator) : '';
    const variantIndex = validVariantIndex(separator >= 0 ? selectionKey.slice(separator + 2) : undefined);
    const placementIds = variantIndex === undefined ? undefined : placementsByGroup.get(groupKey)?.get(variantIndex);
    if (!placementIds?.has(selection.placementId)) selectedRevisionByVariant.delete(selectionKey);
  }
}

function findOrCreatePlacementHost($mesText: JQuery<HTMLElement>, placement: ImagePlacement): JQuery<HTMLElement> {
  const groupKey = placementGroupKey(placement);
  let $host = $mesText.find('[data-story-image-placement-host]').filter((_index, element) => {
    return $(element).attr('data-story-image-placement-group') === groupKey;
  });
  if ($host.length > 0) {
    $host = $host.first() as JQuery<HTMLElement>;
    positionImageHost($host, $mesText, placement.target);
    return $host;
  }

  $host = $('<div class="story-image-host story-image-placement-host" data-story-image-placement-host="true">').attr(
    'data-story-image-placement-group',
    groupKey,
  );
  $host.append($('<div class="story-image-carousel" role="group" aria-label="生成图片">'));
  positionImageHost($host, $mesText, placement.target);
  return $host;
}

export function removeRenderedPlacementHost(placementId: string): void {
  clearRevisionSelection(placementId);
  $('#chat')
    .find(`[data-story-image-placement-id="${placementId}"]`)
    .each((_index, element) => {
      const $slide = $(element);
      const $host = $slide.closest('[data-story-image-placement-host]');
      $slide.remove();
      refreshPlacementHost($host);
    });
  // Remove hosts created by older bundles during a hot reload.
  $('#chat')
    .find('[data-story-image-placement-host]')
    .filter((_index, element) => $(element).attr('data-story-image-placement-id') === placementId)
    .remove();
}

function numericData($element: JQuery<HTMLElement>, attribute: string): number {
  const value = Number($element.attr(attribute));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function variantSelectionKey($host: JQuery<HTMLElement>): string {
  return $host.attr('data-story-image-placement-group') ?? '';
}

function variantSlots($carousel: JQuery<HTMLElement>): HTMLElement[] {
  return $carousel
    .children('[data-story-image-variant]')
    .get()
    .sort(
      (lhs, rhs) => numericData($(lhs), 'data-story-image-variant') - numericData($(rhs), 'data-story-image-variant'),
    );
}

function setVariantSelection($host: JQuery<HTMLElement>, $slot: JQuery<HTMLElement>): void {
  const variantIndex = numericData($slot, 'data-story-image-variant');
  if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex >= Number.MAX_SAFE_INTEGER) return;
  selectedVariantByGroup.set(variantSelectionKey($host), variantIndex);
}

function selectVariantNeighbor($host: JQuery<HTMLElement>, variantIndex: number): void {
  const $carousel = $host.find('.story-image-carousel').first() as JQuery<HTMLElement>;
  const slots = variantSlots($carousel);
  const index = slots.findIndex(slot => numericData($(slot), 'data-story-image-variant') === variantIndex);
  if (index < 0 || slots.length < 2) return;
  const target = slots[index - 1] ?? slots[index + 1];
  if (target) setVariantSelection($host, $(target) as JQuery<HTMLElement>);
}

function moveVariant($host: JQuery<HTMLElement>, offset: -1 | 1): void {
  const $carousel = $host.find('.story-image-carousel').first() as JQuery<HTMLElement>;
  const slots = variantSlots($carousel);
  if (slots.length < 2) return;
  const selectedVariant = selectedVariantByGroup.get(variantSelectionKey($host));
  const mountedSelectedIndex = slots.findIndex(slot => $(slot).attr('data-story-image-selected') === 'true');
  const rememberedSelectedIndex =
    selectedVariant === undefined
      ? -1
      : slots.findIndex(slot => numericData($(slot), 'data-story-image-variant') === selectedVariant);
  const selectedIndex =
    mountedSelectedIndex >= 0 ? mountedSelectedIndex : rememberedSelectedIndex >= 0 ? rememberedSelectedIndex : 0;
  const target = slots[selectedIndex + offset];
  if (!target) return;
  setVariantSelection($host, $(target) as JQuery<HTMLElement>);
  refreshPlacementHost($host);
}

function revisionSlides($revisions: JQuery<HTMLElement>): HTMLElement[] {
  return $revisions
    .children('[data-story-image-placement-id]')
    .get()
    .sort(
      (lhs, rhs) => numericData($(lhs), 'data-story-image-revision') - numericData($(rhs), 'data-story-image-revision'),
    );
}

function revisionSelectionKey($host: JQuery<HTMLElement>, $slot: JQuery<HTMLElement>): string {
  return `${$host.attr('data-story-image-placement-group') ?? ''}::${$slot.attr('data-story-image-variant') ?? ''}`;
}

function setRevisionSelection($host: JQuery<HTMLElement>, $slot: JQuery<HTMLElement>, slide: HTMLElement): void {
  const placementId = $(slide).attr('data-story-image-placement-id');
  if (!placementId) return;
  selectedRevisionByVariant.set(revisionSelectionKey($host, $slot), {
    placementId,
    revisionIndex: numericData($(slide), 'data-story-image-revision'),
  });
}

function selectRevisionNeighbor($host: JQuery<HTMLElement>, $slot: JQuery<HTMLElement>, placementId: string): void {
  const $revisions = $slot.find('.story-image-revisions').first() as JQuery<HTMLElement>;
  const slides = revisionSlides($revisions);
  const index = slides.findIndex(slide => $(slide).attr('data-story-image-placement-id') === placementId);
  if (index < 0 || slides.length < 2) return;
  setRevisionSelection($host, $slot, slides[index - 1] ?? slides[index + 1]!);
}

function moveRevision($host: JQuery<HTMLElement>, $slot: JQuery<HTMLElement>, offset: -1 | 1): void {
  const $revisions = $slot.find('.story-image-revisions').first() as JQuery<HTMLElement>;
  const slides = revisionSlides($revisions);
  if (slides.length < 2) return;
  const key = revisionSelectionKey($host, $slot);
  const selectedId =
    selectedRevisionByVariant.get(key)?.placementId ??
    $(slides[slides.length - 1]!).attr('data-story-image-placement-id');
  const index = slides.findIndex(slide => $(slide).attr('data-story-image-placement-id') === selectedId);
  const target = slides[index + offset];
  if (!target) return;
  setRevisionSelection($host, $slot, target);
  refreshRevisionSlot($host, $slot);
  const $carousel = $host.find('.story-image-carousel').first() as JQuery<HTMLElement>;
  refreshVariantSelection($host, $carousel, variantSlots($carousel));
}

function refreshRevisionSlot($host: JQuery<HTMLElement>, $slot: JQuery<HTMLElement>): void {
  const $revisions = $slot.find('.story-image-revisions').first() as JQuery<HTMLElement>;
  const slides = revisionSlides($revisions);
  const selectionKey = revisionSelectionKey($host, $slot);
  if (slides.length === 0) {
    selectedRevisionByVariant.delete(selectionKey);
    $slot.remove();
    return;
  }

  const previousSelection = selectedRevisionByVariant.get(selectionKey);
  let selected = previousSelection
    ? slides.find(slide => $(slide).attr('data-story-image-placement-id') === previousSelection.placementId)
    : undefined;
  if (!selected) {
    const maxMountedRevision = Math.max(...slides.map(slide => numericData($(slide), 'data-story-image-revision')));
    const selectionIsPending = Boolean(previousSelection && previousSelection.revisionIndex > maxMountedRevision);
    const preferred = previousSelection
      ? slides
          .filter(slide => numericData($(slide), 'data-story-image-revision') <= previousSelection.revisionIndex)
          .at(-1)
      : slides.at(-1);
    selected = preferred ?? slides[0];
    if (!selectionIsPending) setRevisionSelection($host, $slot, selected);
  }

  slides.forEach(slide => {
    const isSelected = slide === selected;
    $(slide)
      .attr('data-story-image-selected', isSelected ? 'true' : 'false')
      .attr('aria-hidden', isSelected ? 'false' : 'true');
  });
  $revisions.attr('data-story-image-multiple', slides.length > 1 ? 'true' : 'false');
  $revisions.attr('aria-label', `图片版本 ${slides.indexOf(selected) + 1}/${slides.length}`);

  let $controls = $slot.find('.story-image-revisions__controls').first() as JQuery<HTMLElement>;
  if (slides.length > 1) {
    if ($controls.length === 0) {
      const $previous = $('<button type="button" class="story-image-revisions__button">').attr({
        'data-story-image-revision-direction': 'previous',
        'aria-label': '上一个图片版本',
        title: '上一个图片版本',
      });
      const $count = $('<span class="story-image-revisions__count" aria-live="polite">');
      const $next = $('<button type="button" class="story-image-revisions__button">').attr({
        'data-story-image-revision-direction': 'next',
        'aria-label': '下一个图片版本',
        title: '下一个图片版本',
      });
      $controls = $('<div class="story-image-revisions__controls">').append(
        $count,
        $previous.text('↑'),
        $next.text('↓'),
      );
    }
    const $previous = $controls.find('[data-story-image-revision-direction="previous"]');
    const $count = $controls.find('.story-image-revisions__count');
    const $next = $controls.find('[data-story-image-revision-direction="next"]');
    const selectedIndex = slides.indexOf(selected);
    $count.text(`${selectedIndex + 1} / ${slides.length}`);
    $previous.prop('disabled', selectedIndex <= 0);
    $next.prop('disabled', selectedIndex >= slides.length - 1);
    const $actions = $(selected).find('.story-image-revision__actions').first() as JQuery<HTMLElement>;
    if ($actions.length > 0) $controls.detach().prependTo($actions);
    else $controls.detach().prependTo($(selected));
    $previous.off('.story-image-revision').on('click.story-image-revision', event => {
      event.preventDefault();
      event.stopPropagation();
      moveRevision($host, $slot, -1);
    });
    $next.off('.story-image-revision').on('click.story-image-revision', event => {
      event.preventDefault();
      event.stopPropagation();
      moveRevision($host, $slot, 1);
    });
  } else $controls.remove();
}

function refreshVariantSelection(
  $host: JQuery<HTMLElement>,
  $carousel: JQuery<HTMLElement>,
  slots: HTMLElement[],
): void {
  const selectionKey = variantSelectionKey($host);
  const previousSelection = selectedVariantByGroup.get(selectionKey);
  let selected =
    previousSelection === undefined
      ? slots[0]
      : slots.find(slot => numericData($(slot), 'data-story-image-variant') === previousSelection);
  if (!selected) {
    const maxMountedVariant = Math.max(...slots.map(slot => numericData($(slot), 'data-story-image-variant')));
    const selectionIsPending = Boolean(previousSelection !== undefined && previousSelection > maxMountedVariant);
    const preferred =
      previousSelection === undefined
        ? slots[0]
        : slots.filter(slot => numericData($(slot), 'data-story-image-variant') <= previousSelection).at(-1);
    selected = preferred ?? slots[0];
    if (selected && !selectionIsPending) setVariantSelection($host, $(selected) as JQuery<HTMLElement>);
  } else if (previousSelection === undefined) {
    setVariantSelection($host, $(selected) as JQuery<HTMLElement>);
  }
  if (!selected) return;

  slots.forEach(slot => {
    const isSelected = slot === selected;
    $(slot)
      .attr('data-story-image-selected', isSelected ? 'true' : 'false')
      .attr('aria-hidden', isSelected ? 'false' : 'true');
  });
  $carousel.attr('data-story-image-multiple', slots.length > 1 ? 'true' : 'false');
  $carousel.attr('aria-label', slots.length > 1 ? '生成图片，可切换候选' : '生成图片');

  const $allControls = $host.find('.story-image-carousel__controls');
  let $controls = $allControls.first() as JQuery<HTMLElement>;
  $allControls.slice(1).remove();
  $host.find('.story-image-carousel__count').remove();
  if (slots.length < 2) {
    $host.find('.story-image-carousel__controls, .story-image-carousel__count').remove();
    return;
  }

  if ($controls.length === 0) {
    const $previous = $('<button type="button" class="story-image-carousel__button">').attr({
      'data-story-image-variant-direction': 'previous',
      'aria-label': '上一个候选图片',
      title: '上一个候选图片',
    });
    const $next = $('<button type="button" class="story-image-carousel__button">').attr({
      'data-story-image-variant-direction': 'next',
      'aria-label': '下一个候选图片',
      title: '下一个候选图片',
    });
    $controls = $('<div class="story-image-carousel__controls" role="group" aria-label="候选图片切换">').append(
      $previous.text('←'),
      $next.text('→'),
    );
  }
  const $previous = $controls.find('[data-story-image-variant-direction="previous"]');
  const $next = $controls.find('[data-story-image-variant-direction="next"]');
  const selectedIndex = slots.indexOf(selected);
  $previous
    .prop('disabled', false)
    .prop('hidden', selectedIndex <= 0)
    .attr('aria-hidden', selectedIndex <= 0 ? 'true' : 'false');
  $next
    .prop('disabled', false)
    .prop('hidden', selectedIndex >= slots.length - 1)
    .attr('aria-hidden', selectedIndex >= slots.length - 1 ? 'true' : 'false');
  const $selectedSlide = $(selected).find('.story-image-revision[data-story-image-selected="true"]').first();
  const $media = $selectedSlide.find('.story-image-revision__media').first() as JQuery<HTMLElement>;
  if ($media.length > 0) $controls.detach().appendTo($media);
  else if ($selectedSlide.length > 0) $controls.detach().appendTo($selectedSlide);
  else $controls.detach().appendTo($(selected));
  $previous.off('.story-image-carousel').on('click.story-image-carousel', event => {
    event.preventDefault();
    event.stopPropagation();
    moveVariant($host, -1);
  });
  $next.off('.story-image-carousel').on('click.story-image-carousel', event => {
    event.preventDefault();
    event.stopPropagation();
    moveVariant($host, 1);
  });
}

function refreshPlacementHost($host: JQuery<HTMLElement>): void {
  const $carousel = $host.find('.story-image-carousel').first();
  $carousel.children('[data-story-image-variant]').each((_index, slot) => {
    const $slot = $(slot) as JQuery<HTMLElement>;
    const $revisions = $slot.find('.story-image-revisions').first();
    revisionSlides($revisions).forEach(slide => $revisions.append(slide));
    refreshRevisionSlot($host, $slot);
  });

  const slots = variantSlots($carousel);
  slots.forEach(slot => $carousel.append(slot));
  if (slots.length === 0) {
    const groupKey = $host.attr('data-story-image-placement-group') ?? '';
    for (const key of selectedRevisionByVariant.keys()) {
      if (key.startsWith(`${groupKey}::`)) selectedRevisionByVariant.delete(key);
    }
    selectedVariantByGroup.delete(variantSelectionKey($host));
    $host.remove();
    return;
  }
  $host.children('.story-image-carousel__count').remove();
  refreshVariantSelection($host, $carousel, slots);
}

function placementActionKey(placement: ImagePlacement, action: PlacementActionId): string {
  return `${placement.id}::${action}`;
}

function syncPlacementActionButtons(
  $slide: JQuery<HTMLElement>,
  placement: ImagePlacement,
  handlers?: ImagePlacementRenderHandlers,
): void {
  $slide.find('[data-story-image-action]').each((_index, element) => {
    const $button = $(element) as JQuery<HTMLElement>;
    const action = $button.attr('data-story-image-action') as PlacementActionId | undefined;
    if (!action) return;
    const available = $button.attr('data-story-image-action-available') === 'true';
    const pinned = action === 'pin' && handlers?.isPinned?.(placement) === true;
    const symbol =
      action === 'pin' ? (pinned ? '已固定' : '📌') : ($button.attr('data-story-image-action-label') ?? '');
    const title = pinned ? '已固定（保留此版本）' : action === 'pin' ? '固定此版本并清理同位置其他版本' : undefined;
    const actionKey = placementActionKey(placement, action);
    const active = activePlacementActions.has(actionKey);
    const loading = loadingPlacementActions.has(actionKey);
    $button
      .prop('disabled', !available || active)
      .attr('aria-busy', loading ? 'true' : 'false')
      .attr('data-story-image-action-pinned', pinned ? 'true' : 'false')
      .toggleClass('story-image-revision__button--pinned', pinned)
      .toggleClass('story-image-revision__button--loading', loading)
      .attr('aria-label', title ?? $button.attr('aria-label') ?? '')
      .attr('title', title ?? $button.attr('title') ?? '')
      .text(loading ? '…' : symbol);
  });
}

function syncMountedPlacementActionButtons(placement: ImagePlacement, handlers?: ImagePlacementRenderHandlers): void {
  $('#chat')
    .find('[data-story-image-placement-id]')
    .filter((_index, element) => $(element).attr('data-story-image-placement-id') === placement.id)
    .each((_index, element) => syncPlacementActionButtons($(element) as JQuery<HTMLElement>, placement, handlers));
}

function getOrCreatePlacementImage(placement: ImagePlacement): HTMLImageElement | undefined {
  const rendered = renderedImageByPlacement.get(placement);
  if (rendered) return rendered;

  const image = $('<img class="story-image-inline-image" loading="lazy">').attr({ src: placement.url, alt: '' })[0] as
    HTMLImageElement | undefined;
  if (image) renderedImageByPlacement.set(placement, image);
  return image;
}

function renderPlacementContent(
  $host: JQuery<HTMLElement>,
  placement: ImagePlacement,
  handlers?: ImagePlacementRenderHandlers,
): boolean {
  const image = getOrCreatePlacementImage(placement);
  if (!image) {
    $host.remove();
    return false;
  }

  const $carousel = $host.find('.story-image-carousel').first();
  let $slot = $carousel
    .children('[data-story-image-variant]')
    .filter((_index, element) => Number($(element).attr('data-story-image-variant')) === placement.variantIndex)
    .first() as JQuery<HTMLElement>;
  if ($slot.length === 0) {
    $slot = $('<div class="story-image-carousel__slot">').attr(
      'data-story-image-variant',
      String(placement.variantIndex),
    );
    $slot.append($('<div class="story-image-revisions" aria-label="图片版本">'));
    $carousel.append($slot);
  }
  const $revisions = $slot.find('.story-image-revisions').first();
  let $slide = $revisions
    .find('[data-story-image-placement-id]')
    .filter((_index, element) => $(element).attr('data-story-image-placement-id') === placement.id)
    .first() as JQuery<HTMLElement>;
  const isFirstPlacementRender = !renderedPlacements.has(placement);
  renderedPlacements.add(placement);
  if ($slide.length === 0) {
    $slide = $('<div class="story-image-revision">')
      .attr('data-story-image-placement-id', placement.id)
      .attr('data-story-image-revision', String(placement.revisionIndex));
    $revisions.append($slide);
  }
  const $image = $(image);
  const currentImage = $slide.find('img.story-image-inline-image').first();
  const currentCaption = $slide.find('.story-image-placement-caption').first().text();
  const $currentMedia = $image.parent('.story-image-revision__media');
  const $currentActions = $slide.find('.story-image-revision__actions').first();
  const actionsInMedia = $currentActions.length > 0 && $currentActions.parent()[0] === $currentMedia[0];
  const hasPinAction = $slide.find('[data-story-image-action="pin"]').length > 0;
  if (currentImage[0] !== image || currentCaption !== placement.caption || !actionsInMedia || !hasPinAction) {
    $image.detach();
    const $media = $('<div class="story-image-revision__media">').append($image);
    $slide.empty().append($media);
    if (placement.caption) $slide.append($('<div class="story-image-placement-caption">').text(placement.caption));
    const $actions = $('<div class="story-image-revision__actions">');
    const action = (
      actionId: PlacementActionId,
      symbol: string,
      title: string,
      handler: ((placement: ImagePlacement, onSubmitted?: () => void) => Promise<void> | void) | undefined,
    ): JQuery<HTMLElement> => {
      const actionKey = placementActionKey(placement, actionId);
      return $('<button type="button" class="story-image-revision__button">')
        .text(symbol)
        .attr({
          title,
          'aria-label': title,
          'data-story-image-action': actionId,
          'data-story-image-action-label': symbol,
          'data-story-image-action-available': handler ? 'true' : 'false',
        })
        .prop('disabled', !handler || activePlacementActions.has(actionKey))
        .on('click.story-image-placement', event => {
          event.preventDefault();
          event.stopPropagation();
          if (!handler || activePlacementActions.has(actionKey)) return;
          if (actionId === 'delete') {
            selectRevisionNeighbor($host, $slot, placement.id);
            const $revisionsForDelete = $slot.find('.story-image-revisions').first() as JQuery<HTMLElement>;
            if (revisionSlides($revisionsForDelete).length <= 1) {
              selectVariantNeighbor($host, Number($slot.attr('data-story-image-variant')));
            }
          }
          activePlacementActions.add(actionKey);
          syncMountedPlacementActionButtons(placement, handlers);
          const onSubmitted = (): void => {
            if (!activePlacementActions.has(actionKey)) return;
            loadingPlacementActions.add(actionKey);
            syncMountedPlacementActionButtons(placement, handlers);
          };
          void Promise.resolve()
            .then(() => handler(placement, onSubmitted))
            .catch(() => undefined)
            .finally(() => {
              activePlacementActions.delete(actionKey);
              loadingPlacementActions.delete(actionKey);
              syncMountedPlacementActionButtons(placement, handlers);
            });
        });
    };
    const addAction = (
      actionId: PlacementActionId,
      symbol: string,
      title: string,
      handler: ((placement: ImagePlacement, onSubmitted?: () => void) => Promise<void> | void) | undefined,
    ): void => {
      $actions.append(action(actionId, symbol, title, handler));
    };
    addAction('edit-prompt', '✎', '修改提示词并生成', handlers?.onEditPrompt);
    addAction('region-redraw', '▧', '区域重绘', handlers?.onRegionRedraw);
    addAction('pin', '📌', '固定此版本并清理同位置其他版本', handlers?.onPin);
    addAction('delete', '×', '删除当前版本', handlers?.onDelete);
    $media.append($actions);
  }
  refreshPlacementHost($host);
  if (isFirstPlacementRender && placement.revisionIndex > 0) {
    setRevisionSelection($host, $slot, $slide[0]);
    refreshRevisionSlot($host, $slot);
    const $carouselForSelection = $host.find('.story-image-carousel').first() as JQuery<HTMLElement>;
    refreshVariantSelection($host, $carouselForSelection, variantSlots($carouselForSelection));
  }
  syncPlacementActionButtons($slide, placement, handlers);

  const isCurrentImage = (): boolean => $slide.find('img.story-image-inline-image').first()[0] === image;
  const handleImageError = (): void => {
    if (!isCurrentImage()) return;
    handlers?.onImageError?.(placement);
    removeRenderedPlacementHost(placement.id);
  };
  $image
    .off('.story-image-placement')
    .on('load.story-image-placement', () => {
      if (isCurrentImage()) $slide.attr('data-story-image-state', 'loaded');
    })
    .on('error.story-image-placement', handleImageError);

  if (image.naturalWidth > 0) $slide.attr('data-story-image-state', 'loaded');
  else if (image.complete) {
    handleImageError();
    return false;
  } else $slide.attr('data-story-image-state', 'loading');
  return true;
}

export function renderImagePlacement(
  placement: ImagePlacement,
  handlers?: ImagePlacementRenderHandlers,
  swipeIdOverride?: number,
): boolean {
  const activeSwipeId = swipeIdOverride ?? currentSwipeId(placement.target.messageId);
  if (activeSwipeId !== placement.target.swipeId) {
    removeRenderedPlacementHost(placement.id);
    return false;
  }
  const $mesText = displayedMessageText(placement.target.messageId);
  if ($mesText.length === 0) return false;
  const $host = findOrCreatePlacementHost($mesText, placement);
  return renderPlacementContent($host, placement, handlers);
}

export function renderMessagePlacements(
  placements: ReadonlyArray<ImagePlacement>,
  messageId: number,
  handlers?: ImagePlacementRenderHandlers,
  swipeIdOverride?: number,
): number {
  const activeSwipeId = swipeIdOverride ?? currentSwipeId(messageId);
  const groups = groupImagePlacements(placements, messageId, activeSwipeId);
  const activePlacements = groups.flatMap(group => group.variants.flatMap(variant => variant.revisions));
  const activeGroups = new Set(activePlacements.map(placementGroupKey));
  const $mesText = displayedMessageText(messageId);
  $mesText.find('[data-story-image-placement-host]').each((_index, element) => {
    const groupKey = $(element).attr('data-story-image-placement-group') ?? '';
    if (!activeGroups.has(groupKey)) $(element).remove();
  });
  return activePlacements.filter(placement => renderImagePlacement(placement, handlers, activeSwipeId)).length;
}

function renderPending($host: JQuery<HTMLElement>): void {
  if ($host[0]) renderedTaskByHost.delete($host[0]);
  $host
    .empty()
    .removeAttr('data-story-image-state')
    .append(
      $('<div class="story-image-card story-image-card--pending">')
        .append($('<span class="story-image-card__spinner" aria-hidden="true">'))
        .append($('<span>').text('正在生图…')),
    );
}

function renderFailed($host: JQuery<HTMLElement>): void {
  if ($host[0]) renderedTaskByHost.delete($host[0]);
  $host
    .empty()
    .removeAttr('data-story-image-state')
    .append($('<div class="story-image-card story-image-card--failed">').text('随文插图生成失败'));
}

function renderSuccess($host: JQuery<HTMLElement>, task: ImageTask, handlers?: ImageTaskRenderHandlers): void {
  if (!task.image) {
    renderFailed($host);
    return;
  }

  const host = $host[0];
  const currentImage = $host.find('img.story-image-inline-image').first();
  if (host && renderedTaskByHost.get(host) === task && currentImage.attr('src') === task.image.url) return;

  const $image = $('<img class="story-image-inline-image" loading="lazy">').attr({
    src: task.image.url,
    alt: '',
  });
  const image = $image[0] as HTMLImageElement | undefined;
  if (!image) return;

  $image
    .on('load.story-image', () => {
      if ($host.find('img.story-image-inline-image').first()[0] === image) {
        $host.attr('data-story-image-state', 'loaded');
      }
    })
    .on('error.story-image', () => {
      if ($host.find('img.story-image-inline-image').first()[0] !== image) return;
      if (handlers?.onImageError?.(task)) renderFailed($host);
      else $host.remove();
    });
  if (host) renderedTaskByHost.set(host, task);
  $host.empty().attr('data-story-image-state', 'loading').append($image);
}

export function renderImageTask(
  task: ImageTask,
  handlers?: ImageTaskRenderHandlers,
  swipeIdOverride?: number,
): boolean {
  if (SillyTavern.getCurrentChatId() !== task.chatId) return false;
  const $message = messageElement(task.messageId);
  if ($message.length === 0) return false;
  const activeSwipeId = swipeIdOverride ?? currentSwipeId(task.messageId);
  removeStaleHosts($message, task.chatId, task.messageId, activeSwipeId);
  if (activeSwipeId !== task.swipeId) return false;

  const $displayedText = displayedMessageText(task.messageId);
  const $mesText =
    $displayedText.length > 0 ? $displayedText : ($message.find('.mes_text').first() as JQuery<HTMLElement>);
  if ($mesText.length === 0) return false;
  removeRenderedMarkerText($mesText);
  const $host = findOrCreateHost($mesText, task);

  if (task.status === 'success') renderSuccess($host, task, handlers);
  else if (task.status === 'failed') renderFailed($host);
  else renderPending($host);
  return true;
}

export function renderMessageTasks(
  tasks: ImageTask[],
  messageId: number,
  handlers?: ImageTaskRenderHandlers,
  swipeIdOverride?: number,
): number {
  return tasks.filter(task => task.messageId === messageId && renderImageTask(task, handlers, swipeIdOverride)).length;
}
