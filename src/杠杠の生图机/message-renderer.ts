import { cleanInlineImageMarkers } from './marker';
import type { ImagePlacement } from './image-placement';
import type { ImagePlacementTarget } from './image-system';
import { imageTaskKey, type ImageTask } from './task-cache';

export type ImageTaskRenderHandlers = {
  onImageError?: (task: ImageTask) => boolean;
};

export type ImagePlacementRenderHandlers = {
  onImageError?: (placement: ImagePlacement) => void;
};

const renderedTaskByHost = new WeakMap<HTMLElement, ImageTask>();
const renderedImageByPlacement = new WeakMap<ImagePlacement, HTMLImageElement>();
const OWNED_IMAGE_HOST_SELECTOR = '[data-story-image-host], [data-story-image-placement-host]';

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
  $mesText.find('pic').remove();
  const root = $mesText[0];
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
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
  $('#chat').find('[data-story-image-host], [data-story-image-placement-host]').remove();
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

function findOrCreatePlacementHost($mesText: JQuery<HTMLElement>, placement: ImagePlacement): JQuery<HTMLElement> {
  let $host = $mesText.find('[data-story-image-placement-host]').filter((_index, element) => {
    return $(element).attr('data-story-image-placement-id') === placement.id;
  });
  if ($host.length > 0) {
    $host = $host.first() as JQuery<HTMLElement>;
    positionImageHost($host, $mesText, placement.target);
    return $host;
  }

  $host = $('<div class="story-image-host story-image-placement-host" data-story-image-placement-host="true">').attr(
    'data-story-image-placement-id',
    placement.id,
  );
  positionImageHost($host, $mesText, placement.target);
  return $host;
}

export function removeRenderedPlacementHost(placementId: string): void {
  $('#chat')
    .find('[data-story-image-placement-host]')
    .filter((_index, element) => $(element).attr('data-story-image-placement-id') === placementId)
    .remove();
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

  const $image = $(image);
  const currentImage = $host.find('img.story-image-inline-image').first();
  const currentCaption = $host.find('.story-image-placement-caption').first().text();
  if (currentImage[0] !== image || currentCaption !== placement.caption) {
    $image.detach();
    $host.empty().append($image);
    if (placement.caption) $host.append($('<div class="story-image-placement-caption">').text(placement.caption));
  }

  const isCurrentImage = (): boolean => $host.find('img.story-image-inline-image').first()[0] === image;
  const handleImageError = (): void => {
    if (!isCurrentImage()) return;
    handlers?.onImageError?.(placement);
    $host.remove();
  };
  $image
    .off('.story-image-placement')
    .on('load.story-image-placement', () => {
      if (isCurrentImage()) $host.attr('data-story-image-state', 'loaded');
    })
    .on('error.story-image-placement', handleImageError);

  if (image.naturalWidth > 0) $host.attr('data-story-image-state', 'loaded');
  else if (image.complete) {
    handleImageError();
    return false;
  } else $host.attr('data-story-image-state', 'loading');
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
  const activePlacements = placements
    .filter(placement => placement.target.messageId === messageId && placement.target.swipeId === activeSwipeId)
    .sort((lhs, rhs) => lhs.target.imageIndex - rhs.target.imageIndex);
  const activeIds = new Set(activePlacements.map(placement => placement.id));
  const $mesText = displayedMessageText(messageId);
  $mesText.find('[data-story-image-placement-host]').each((_index, element) => {
    const placementId = $(element).attr('data-story-image-placement-id') ?? '';
    if (!activeIds.has(placementId)) $(element).remove();
  });
  return activePlacements.filter(placement => renderImagePlacement(placement, handlers, activeSwipeId)).length;
}

function renderPending($host: JQuery<HTMLElement>, task: ImageTask): void {
  const label = task.status === 'running' ? '正在生成随文插图…' : '等待生成随文插图…';
  if ($host[0]) renderedTaskByHost.delete($host[0]);
  $host
    .empty()
    .removeAttr('data-story-image-state')
    .append(
      $('<div class="story-image-card story-image-card--pending">')
        .append($('<span class="story-image-card__spinner" aria-hidden="true">'))
        .append($('<span>').text(label)),
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

  const $mesText = $message.find('.mes_text').first() as JQuery<HTMLElement>;
  if ($mesText.length === 0) return false;
  removeRenderedMarkerText($mesText);
  const $host = findOrCreateHost($mesText, task);

  if (task.status === 'success') renderSuccess($host, task, handlers);
  else if (task.status === 'failed') renderFailed($host);
  else renderPending($host, task);
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
