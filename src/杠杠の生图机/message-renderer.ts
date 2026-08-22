import { cleanInlineImageMarkers } from './marker';
import { imageTaskKey, type ImageTask } from './task-cache';

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

function findAnchorParagraph($mesText: JQuery<HTMLElement>, task: ImageTask): JQuery<HTMLElement> {
  const $blocks = paragraphCandidates($mesText);
  const direct = $blocks.eq(task.paragraphIndex);
  if (direct.length > 0) return direct;

  const before = normalizeText(task.anchorTextBefore);
  const after = normalizeText(task.anchorTextAfter);
  let bestScore = -1;
  let $best = $blocks.first();

  $blocks.each((_index, element) => {
    const text = normalizeText($(element).text());
    let score = 0;
    if (before && text.includes(before)) score += 2;
    if (after && text.includes(after)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      $best = $(element);
    }
  });

  return $best;
}

function findOrCreateHost($mesText: JQuery<HTMLElement>, task: ImageTask): JQuery<HTMLElement> {
  const key = imageTaskKey(task);
  let $host = $mesText.find('[data-story-image-host]').filter((_index, element) => {
    return $(element).attr('data-story-image-key') === key;
  });
  if ($host.length > 0) return $host.first() as JQuery<HTMLElement>;

  $host = $('<div class="story-image-host" data-story-image-host="true">').attr('data-story-image-key', key);
  const $paragraph = findAnchorParagraph($mesText, task);
  if ($paragraph.is($mesText)) $host.appendTo($mesText);
  else $host.insertAfter($paragraph);
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
  $('#chat').find('[data-story-image-host]').remove();
}

function renderPending($host: JQuery<HTMLElement>, task: ImageTask): void {
  const label = task.status === 'running' ? '正在生成随文插图…' : '等待生成随文插图…';
  $host
    .empty()
    .append(
      $('<div class="story-image-card story-image-card--pending">')
        .append($('<span class="story-image-card__spinner" aria-hidden="true">'))
        .append($('<span>').text(label)),
    );
}

function renderFailed($host: JQuery<HTMLElement>): void {
  $host.empty().append($('<div class="story-image-card--failed">').text('随文插图生成失败'));
}

function renderSuccess($host: JQuery<HTMLElement>, task: ImageTask): void {
  if (!task.image) {
    renderFailed($host);
    return;
  }

  const $image = $('<img class="story-image-inline-image" loading="lazy">').attr({
    src: task.image.url,
    alt: '',
  });
  $host.empty().append($image);
}

export function renderImageTask(task: ImageTask): boolean {
  if (SillyTavern.getCurrentChatId() !== task.chatId) return false;
  const $message = messageElement(task.messageId);
  if ($message.length === 0) return false;
  const activeSwipeId = currentSwipeId(task.messageId);
  removeStaleHosts($message, task.chatId, task.messageId, activeSwipeId);
  if (activeSwipeId !== task.swipeId) return false;

  const $mesText = $message.find('.mes_text').first() as JQuery<HTMLElement>;
  if ($mesText.length === 0) return false;
  removeRenderedMarkerText($mesText);
  const $host = findOrCreateHost($mesText, task);

  if (task.status === 'success') renderSuccess($host, task);
  else if (task.status === 'failed') renderFailed($host);
  else renderPending($host, task);
  return true;
}

export function renderMessageTasks(tasks: ImageTask[], messageId: number): number {
  return tasks.filter(task => task.messageId === messageId && renderImageTask(task)).length;
}
