<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div ref="root" class="story-workbench" :data-theme="themeMode" :style="{ '--story-workbench-bottom': `${bottomInset}px` }">
    <button
      ref="opener"
      class="story-workbench__orb"
      type="button"
      aria-label="打开或关闭杠杠の生图机面板"
      aria-controls="story-workbench-panel"
      :aria-expanded="open"
      :style="orbStyle"
      @pointerdown="startOrbDrag"
      @pointermove="moveOrbDrag"
      @pointerup="endOrbDrag"
      @pointercancel="endOrbDrag"
      @click="handleOrbClick"
    >
      <svg class="story-workbench__orb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="14" rx="2.4" />
        <circle cx="8.7" cy="10.3" r="1.6" />
        <path d="M4.3 16.6l4.5-4.1 3.2 2.9 2.6-2.3 5 4.2" />
      </svg>
      <span v-if="pendingCount" class="story-workbench__badge">{{ pendingCount }}</span>
    </button>

    <section
      v-if="open"
      id="story-workbench-panel"
      ref="panelRef"
      class="story-workbench__panel"
      :style="panelStyle"
      aria-labelledby="story-workbench-title"
    >
      <header
        class="story-workbench__header"
        @pointerdown="startPanelDrag"
        @pointermove="movePanelDrag"
        @pointerup="endPanelDrag"
        @pointercancel="endPanelDrag"
      >
        <h2 id="story-workbench-title">杠杠の生图机</h2>
        <div class="story-workbench__header-actions">
          <button
            class="story-workbench__theme"
            type="button"
            :aria-label="`切换图片显示，当前为${thumbnailModeLabel}`"
            :title="`图片显示：${thumbnailModeLabel}`"
            @click="toggleThumbnails"
          >
            {{ thumbnailModeIcon }}
          </button>
          <button
            class="story-workbench__theme"
            type="button"
            :aria-label="`切换主题，当前为${themeLabel}`"
            :title="`主题：${themeLabel}`"
            @click="cycleTheme"
          >
            {{ themeIcon }}
          </button>
          <button ref="closeButton" type="button" aria-label="关闭剧情图面板" @click="closePanel">×</button>
        </div>
      </header>
      <div v-if="!settings.enabled" class="story-workbench__notice"><strong>生图机已关闭，开启后可继续重绘。</strong></div>
      <div class="story-workbench__body">
        <p v-if="!shots.length" class="story-workbench__empty">当前聊天暂无剧情图</p>
        <details v-for="shot in shots" :key="shot.id" class="story-workbench__shot">
          <summary class="story-workbench__shot-summary">
            <div class="story-workbench__shot-heading">
              <h3>
                <button type="button" class="story-workbench__floor-link" @click.stop="jumpToShot(shot.id)">
                  第 {{ shot.messageId }} 楼
                </button>
              </h3>
              <span
                class="story-workbench__state"
                :class="{ 'story-workbench__state--confirmed': shot.status === 'confirmed' }"
              >
                {{ statusText(shot) }}
              </span>
            </div>
            <div class="story-workbench__summary-meta">
              <span>{{ promptExcerpt(shot) }}</span>
            </div>
            <div
              v-if="selectedImage(shot)"
              class="story-workbench__card"
              :class="{ 'story-workbench__card--compact': compactThumbnails }"
              @click.stop
            >
              <div v-if="compactThumbnails" class="story-workbench__thumbs">
                <button
                  v-for="image in orderedImages(shot)"
                  :key="image.id"
                  type="button"
                  class="story-workbench__thumb"
                  :class="{ 'story-workbench__thumb--selected': selectedImage(shot)?.id === image.id }"
                  :aria-label="imageLabel(shot, image)"
                  :aria-pressed="selectedImage(shot)?.id === image.id"
                  :title="imageLabel(shot, image)"
                  @click="selectThumbnail(shot, image, $event)"
                >
                  <img :src="image.url" alt="" loading="lazy" />
                </button>
              </div>
              <div class="story-workbench__stage">
                <button
                  v-if="canSwitchVariant(shot) && variantPosition(shot) > 0"
                  type="button"
                  class="story-workbench__pager story-workbench__pager--previous"
                  aria-label="上一张候选图片"
                  title="上一张候选图片"
                  @click="switchVariant(shot, -1)"
                >
                  ←
                </button>
                <img
                  class="story-workbench__image"
                  :src="selectedImage(shot)!.url"
                  :alt="`第 ${shot.messageId} 楼 · ${imageLabel(shot, selectedImage(shot)!)}`"
                  loading="lazy"
                  @click="showLightbox(shot, $event)"
                />
                <button
                  v-if="canSwitchVariant(shot) && variantPosition(shot) < variantCount(shot) - 1"
                  type="button"
                  class="story-workbench__pager story-workbench__pager--next"
                  aria-label="下一张候选图片"
                  title="下一张候选图片"
                  @click="switchVariant(shot, 1)"
                >
                  →
                </button>
              </div>
              <div class="story-workbench__toolbar">
                <div v-if="canSwitchRevision(shot)" class="story-workbench__revision-pager">
                  <button
                    v-if="revisionPosition(shot) > 0"
                    type="button"
                    class="story-workbench__pager story-workbench__pager--mini"
                    aria-label="上一个图片版本"
                    title="上一个图片版本"
                    @click="switchRevision(shot, -1)"
                  >
                    ↑
                  </button>
                  <span class="story-workbench__revision-count">{{ revisionLabel(shot) }}</span>
                  <button
                    v-if="revisionPosition(shot) < revisionCount(shot) - 1"
                    type="button"
                    class="story-workbench__pager story-workbench__pager--mini"
                    aria-label="下一个图片版本"
                    title="下一个图片版本"
                    @click="switchRevision(shot, 1)"
                  >
                    ↓
                  </button>
                </div>
                <button
                  type="button"
                  class="story-workbench__tool"
                  title="修改提示词并生成"
                  aria-label="修改提示词并生成"
                  :disabled="!settings.enabled"
                  @click="editImage(shot, false)"
                >
                  ✎
                </button>
                <button
                  type="button"
                  class="story-workbench__tool"
                  title="区域重绘"
                  aria-label="区域重绘"
                  :disabled="!settings.enabled"
                  @click="editImage(shot, true)"
                >
                  ▧
                </button>
                <button
                  type="button"
                  class="story-workbench__tool"
                  title="删除当前版本"
                  aria-label="删除当前版本"
                  :disabled="!canRemoveSelected(shot)"
                  @click="removeCandidate(shot)"
                >
                  ×
                </button>
                <button
                  type="button"
                  class="story-workbench__tool"
                  :class="{ 'story-workbench__tool--pinned': isConfirmedSelected(shot) }"
                  :title="isConfirmedSelected(shot) ? '已确认（后续剧情可参考）' : '确认此图并清理本镜头其他版本'"
                  :aria-label="isConfirmedSelected(shot) ? '已确认' : '确认此图并清理本镜头其他版本'"
                  @click="confirmImage(shot)"
                >
                  {{ isConfirmedSelected(shot) ? '✔' : '✓' }}
                </button>
              </div>
            </div>
          </summary>
          <div class="story-workbench__shot-content">
            <div class="story-workbench__shot-prompt">
              <p>{{ shotPromptPreview(shot) }}</p>
              <button
                v-if="isShotPromptTruncated(shot)"
                type="button"
                class="story-workbench__shot-prompt__toggle"
                :aria-expanded="expandedPromptIds[shot.id] === true"
                @click="toggleShotPrompt(shot.id)"
              >
                {{ expandedPromptIds[shot.id] ? '收起' : '展开全部' }}
              </button>
            </div>
            <p v-if="!shot.images.length" class="story-workbench__hint">
              {{ shot.status === 'failed' ? '本镜头生成失败。' : '本镜头暂无可用图片。' }}
            </p>
          </div>
        </details>
      </div>
    </section>

    <div
      v-if="lightboxImage"
      class="story-workbench__lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="剧情图大图预览"
      @click.self="closeLightbox"
      @keydown.tab.prevent="lightboxClose?.focus()"
    >
      <button ref="lightboxClose" class="story-workbench__lightbox-close" type="button" @click="closeLightbox">
        关闭大图 ×
      </button>
      <img :src="lightboxImage.url" alt="当前候选大图，仅预览，不会自动确认或请求生图" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import type { StoryImageRuntime } from './runtime';
import { useStoryImageSettingsStore } from './settings';
import type { WorkbenchShot } from './workbench-types';

const props = defineProps<{ runtime: StoryImageRuntime }>();
const settingsStore = useStoryImageSettingsStore();
const settings = computed(() => settingsStore.settings);
const root = ref<HTMLElement>();
const opener = ref<HTMLButtonElement>();
const panelRef = ref<HTMLElement>();
const closeButton = ref<HTMLButtonElement>();
const lightboxClose = ref<HTMLButtonElement>();
const open = ref(false);
const bottomInset = ref(148);
const selectedIds = ref<Record<string, string>>({});
const expandedPromptIds = ref<Record<string, boolean>>({});
const compactThumbnails = ref(true);
const lightboxId = ref<string | null>(null);
type ThemeMode = 'follow' | 'day' | 'night';
const themeMode = ref<ThemeMode>('follow');
const orbPosition = ref<{ x: number; y: number } | null>(null);
const panelPosition = ref<{ x: number; y: number } | null>(null);
let lightboxOpener: HTMLElement | null = null;
let inputObserver: ResizeObserver | null = null;
let hostDocument: Document | null = null;
let hostWindow: (Window & typeof globalThis) | null = null;
let orbDrag: { pointerId: number; offsetX: number; offsetY: number; startX: number; startY: number } | null = null;
let orbDragged = false;
let panelDrag: { pointerId: number; offsetX: number; offsetY: number } | null = null;

const shots = computed(() => props.runtime.workbenchShots.value);
const pendingCount = computed(() => shots.value.reduce((count, shot) => count + shot.pendingCount, 0));
const themeLabel = computed(() => (themeMode.value === 'follow' ? '跟随酒馆' : themeMode.value === 'day' ? '日间' : '夜色'));
const themeIcon = computed(() => {
  if (themeMode.value === 'follow') return '◐';
  return themeMode.value === 'night' ? '☾' : '☼';
});
const thumbnailModeLabel = computed(() => (compactThumbnails.value ? '缩略图' : '大图'));
const thumbnailModeIcon = computed(() => (compactThumbnails.value ? '▤' : '▣'));
const lightboxImage = computed(() =>
  shots.value.flatMap(shot => shot.images).find(image => image.id === lightboxId.value),
);

function selectedImage(shot: WorkbenchShot) {
  return (
    shot.images.find(image => image.id === selectedIds.value[shot.id]) ??
    shot.images.find(image => image.id === shot.basePlacementId) ??
    shot.images[0]
  );
}

function statusText(shot: WorkbenchShot): string {
  if (shot.status === 'confirmed') return '已确认';
  if (shot.status === 'failed') return '生成失败';
  return shot.images.length ? '待确认' : '生成中';
}

function promptExcerpt(shot: WorkbenchShot): string {
  const prompt = (selectedImage(shot)?.prompt || shot.shotPrompt || '暂无镜头文字').replace(/\s+/g, ' ').trim();
  const tag = prompt.match(/^【[^】]*】/);
  if (tag) return tag[0];
  return prompt.slice(0, 72) + (prompt.length > 72 ? '…' : '');
}

const SHOT_PROMPT_PREVIEW_LENGTH = 120;

function shotPromptText(shot: WorkbenchShot): string {
  return (selectedImage(shot)?.prompt || shot.shotPrompt || '暂无镜头文字').trim();
}

function isShotPromptTruncated(shot: WorkbenchShot): boolean {
  return shotPromptText(shot).length > SHOT_PROMPT_PREVIEW_LENGTH;
}

function shotPromptPreview(shot: WorkbenchShot): string {
  const prompt = shotPromptText(shot);
  if (expandedPromptIds.value[shot.id] || prompt.length <= SHOT_PROMPT_PREVIEW_LENGTH) return prompt;
  return `${prompt.slice(0, SHOT_PROMPT_PREVIEW_LENGTH)}…`;
}

function toggleShotPrompt(id: string): void {
  expandedPromptIds.value = { ...expandedPromptIds.value, [id]: !expandedPromptIds.value[id] };
}

function imageLabel(shot: WorkbenchShot, image: WorkbenchShot['images'][number]): string {
  const state =
    image.id === shot.confirmedPlacementId ? '已确认' : image.id === shot.basePlacementId ? '底图 · 未确认' : '待选';
  return `候选 ${image.variantIndex + 1} · 版本 ${image.revisionIndex + 1} · ${state}`;
}

function orderedImages(shot: WorkbenchShot): WorkbenchShot['images'] {
  return shot.images
    .slice()
    .sort((a, b) => a.variantIndex - b.variantIndex || a.revisionIndex - b.revisionIndex);
}

function selectThumbnail(shot: WorkbenchShot, image: WorkbenchShot['images'][number], event: MouseEvent): void {
  selectedIds.value = { ...selectedIds.value, [shot.id]: image.id };
  const details = (event.currentTarget as HTMLElement | null)?.closest('details');
  details?.setAttribute('open', '');
}

function variantIndexes(shot: WorkbenchShot): number[] {
  return [...new Set(shot.images.map(image => image.variantIndex))].sort((a, b) => a - b);
}

function revisionImages(shot: WorkbenchShot, variantIndex: number): WorkbenchShot['images'] {
  return shot.images
    .filter(image => image.variantIndex === variantIndex)
    .sort((a, b) => a.revisionIndex - b.revisionIndex);
}

function selectedVariant(shot: WorkbenchShot): number {
  return selectedImage(shot)?.variantIndex ?? 0;
}

function selectedRevision(shot: WorkbenchShot): number {
  return selectedImage(shot)?.revisionIndex ?? 0;
}

function variantPosition(shot: WorkbenchShot): number {
  return variantIndexes(shot).indexOf(selectedVariant(shot));
}

function variantCount(shot: WorkbenchShot): number {
  return variantIndexes(shot).length;
}

function revisionPosition(shot: WorkbenchShot): number {
  return revisionImages(shot, selectedVariant(shot)).findIndex(image => image.id === selectedImage(shot)?.id);
}

function revisionCount(shot: WorkbenchShot): number {
  return revisionImages(shot, selectedVariant(shot)).length;
}

function revisionLabel(shot: WorkbenchShot): string {
  return `${revisionPosition(shot) + 1} / ${revisionCount(shot)}`;
}

function canSwitchVariant(shot: WorkbenchShot): boolean {
  return variantCount(shot) > 1;
}

function canSwitchRevision(shot: WorkbenchShot): boolean {
  return revisionCount(shot) > 1;
}

function switchVariant(shot: WorkbenchShot, delta: number): void {
  const variants = variantIndexes(shot);
  const nextVariant = variants[variantPosition(shot) + delta];
  if (nextVariant === undefined) return;
  const target = revisionImages(shot, nextVariant).at(-1);
  if (target) selectedIds.value = { ...selectedIds.value, [shot.id]: target.id };
}

function switchRevision(shot: WorkbenchShot, delta: number): void {
  const target = revisionImages(shot, selectedVariant(shot))[revisionPosition(shot) + delta];
  if (!target) return;
  selectedIds.value = { ...selectedIds.value, [shot.id]: target.id };
}

function isConfirmedSelected(shot: WorkbenchShot): boolean {
  const image = selectedImage(shot);
  return !!image && image.id === shot.confirmedPlacementId;
}

function toggleThumbnails(): void {
  compactThumbnails.value = !compactThumbnails.value;
}

function closePanel() {
  closeLightbox();
  open.value = false;
  opener.value?.focus();
}

function cycleTheme() {
  themeMode.value = themeMode.value === 'follow' ? 'day' : themeMode.value === 'day' ? 'night' : 'follow';
}

const orbStyle = computed<CSSProperties>(() => {
  const position = orbPosition.value;
  if (!position) return {};
  return { left: `${position.x}px`, top: `${position.y}px`, right: 'auto' };
});

function startOrbDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  orbDragged = false;
  orbDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    startX: event.clientX,
    startY: event.clientY,
  };
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; dragging still works without it.
  }
}

function moveOrbDrag(event: PointerEvent): void {
  const drag = orbDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  // A few pixels of jitter should still count as a click, not a drag.
  if (!orbDragged && Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) < 4) return;
  orbDragged = true;
  const size = (event.currentTarget as HTMLElement | null)?.offsetWidth || 48;
  const maxX = Math.max(0, (hostWindow?.innerWidth ?? 0) - size);
  const maxY = Math.max(0, (hostWindow?.innerHeight ?? 0) - size);
  orbPosition.value = {
    x: Math.min(Math.max(0, event.clientX - drag.offsetX), maxX),
    y: Math.min(Math.max(0, event.clientY - drag.offsetY), maxY),
  };
}

function endOrbDrag(event: PointerEvent): void {
  if (orbDrag?.pointerId !== event.pointerId) return;
  try {
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; dragging still works without it.
  }
  orbDrag = null;
}

function handleOrbClick(): void {
  if (orbDragged) {
    orbDragged = false;
    return;
  }
  void togglePanel();
}

const panelStyle = computed<CSSProperties>(() => {
  const position = panelPosition.value;
  if (!position) return {};
  return { left: `${position.x}px`, top: `${position.y}px`, right: 'auto' };
});

function startPanelDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  // Header buttons keep their own click behaviour.
  if ((event.target as HTMLElement | null)?.closest('button')) return;
  const panel = panelRef.value;
  const handle = event.currentTarget as HTMLElement | null;
  if (!panel || !handle) return;
  const rect = panel.getBoundingClientRect();
  panelDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; dragging still works without it.
  }
}

function movePanelDrag(event: PointerEvent): void {
  const drag = panelDrag;
  const panel = panelRef.value;
  if (!drag || drag.pointerId !== event.pointerId || !panel) return;
  const maxX = Math.max(0, (hostWindow?.innerWidth ?? 0) - panel.offsetWidth);
  const maxY = Math.max(0, (hostWindow?.innerHeight ?? 0) - panel.offsetHeight);
  panelPosition.value = {
    x: Math.min(Math.max(0, event.clientX - drag.offsetX), maxX),
    y: Math.min(Math.max(0, event.clientY - drag.offsetY), maxY),
  };
}

function endPanelDrag(event: PointerEvent): void {
  if (panelDrag?.pointerId !== event.pointerId) return;
  try {
    (event.currentTarget as HTMLElement | null)?.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; dragging still works without it.
  }
  panelDrag = null;
}

async function togglePanel() {
  if (open.value) return closePanel();
  open.value = true;
  await nextTick();
  clampFloatingPositions();
  closeButton.value?.focus();
}

async function showLightbox(shot: WorkbenchShot, event: MouseEvent) {
  lightboxOpener = event.currentTarget as HTMLElement;
  lightboxId.value = selectedImage(shot)?.id ?? null;
  await nextTick();
  lightboxClose.value?.focus();
}

function closeLightbox() {
  if (!lightboxId.value) return;
  lightboxId.value = null;
  if (lightboxOpener?.isConnected) lightboxOpener.focus();
  else closeButton.value?.focus();
  lightboxOpener = null;
}

function confirmImage(shot: WorkbenchShot) {
  const image = selectedImage(shot);
  if (!image) return;
  if (
    !hostWindow?.confirm(
      '确认这张作为正文底图并允许后续引用？后续仍优先使用剧情位置最近的已确认镜头。本镜头的其他候选、旧版本及在途重绘会清理，其他镜头不受影响。',
    )
  )
    return;
  props.runtime.confirmWorkbenchImage(image.id);
}

function canRemoveSelected(shot: WorkbenchShot): boolean {
  const image = selectedImage(shot);
  return !!image && image.id !== shot.basePlacementId && image.id !== shot.confirmedPlacementId;
}

function removeCandidate(shot: WorkbenchShot) {
  const image = selectedImage(shot);
  if (!image || !canRemoveSelected(shot)) return;
  if (hostWindow?.confirm('删除当前预览的这个候选版本？底图及其他候选保留。'))
    props.runtime.removeWorkbenchImage(image.id);
}

async function editImage(shot: WorkbenchShot, redraw: boolean) {
  const image = selectedImage(shot);
  if (!settings.value.enabled || !image) return;
  try {
    if (redraw) await props.runtime.redrawWorkbenchImage(image.id);
    else await props.runtime.editWorkbenchImage(image.id);
  } catch {
    toastr.error('无法打开修图窗口，请确认图片仍可用。', '杠杠の生图机');
  }
}

function jumpToShot(id: string) {
  closePanel();
  props.runtime.jumpToWorkbenchShot(id);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // A prompt or redraw editor owns Escape while it is in front of the workbench.
  if (!root.value?.contains(event.target as Node)) return;
  if (lightboxId.value) closeLightbox();
  else if (open.value) closePanel();
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function updateBottomInset() {
  if (!hostWindow || !hostDocument) return;
  const input = hostDocument.getElementById('send_form');
  const rect = input?.getBoundingClientRect();
  bottomInset.value = rect && rect.height > 0 ? Math.max(24, hostWindow.innerHeight - rect.top + 12) : 148;
  clampFloatingPositions();
}

function clampValue(value: number, limit: number): number {
  return Math.min(Math.max(0, value), Math.max(0, limit));
}

// The orb keeps its pixel position, so shrinking the window must pull it (and the panel) back on screen.
function clampFloatingPositions(): void {
  const viewportWidth = hostWindow?.innerWidth ?? 0;
  const viewportHeight = hostWindow?.innerHeight ?? 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) return;

  const orbSize = opener.value?.offsetWidth || 48;
  const orb = orbPosition.value;
  if (orb) {
    const x = clampValue(orb.x, viewportWidth - orbSize);
    const y = clampValue(orb.y, viewportHeight - orbSize);
    if (x !== orb.x || y !== orb.y) orbPosition.value = { x, y };
  }

  const panelElement = panelRef.value;
  const panel = panelPosition.value;
  if (panelElement && panel) {
    const x = clampValue(panel.x, viewportWidth - panelElement.offsetWidth);
    const y = clampValue(panel.y, viewportHeight - panelElement.offsetHeight);
    if (x !== panel.x || y !== panel.y) panelPosition.value = { x, y };
  }
}

watch(shots, nextShots => {
  const nextIds: Record<string, string> = {};
  const nextExpanded: Record<string, boolean> = {};
  for (const shot of nextShots) {
    const selected = selectedIds.value[shot.id];
    if (shot.images.some(image => image.id === selected)) nextIds[shot.id] = selected;
    if (expandedPromptIds.value[shot.id]) nextExpanded[shot.id] = true;
  }
  selectedIds.value = nextIds;
  expandedPromptIds.value = nextExpanded;
  if (lightboxId.value && !lightboxImage.value) closeLightbox();
});

onMounted(() => {
  hostDocument = root.value?.ownerDocument ?? null;
  hostWindow = hostDocument?.defaultView ?? null;
  hostDocument?.addEventListener('keydown', handleKeydown);
  hostWindow?.addEventListener('resize', updateBottomInset);
  updateBottomInset();
  const input = hostDocument?.getElementById('send_form');
  if (input && hostWindow) {
    inputObserver = new hostWindow.ResizeObserver(updateBottomInset);
    inputObserver.observe(input);
  }
});

onBeforeUnmount(() => {
  inputObserver?.disconnect();
  hostDocument?.removeEventListener('keydown', handleKeydown);
  hostWindow?.removeEventListener('resize', updateBottomInset);
});
</script>

<style scoped>
.story-workbench{--story-workbench-bg:#faf6ef;--story-workbench-panel:#fffdf8;--story-workbench-text:#2a201b;--story-workbench-muted:#6d5a50;--story-workbench-border:#d9cec1;--story-workbench-accent:#7f1d13;--story-workbench-accent-soft:#f3e3d8;--story-workbench-danger:#a3473e;color:var(--story-workbench-text);font-family:'Source Han Serif SC','Noto Serif SC','Songti SC',serif;font-size:14px;line-height:1.55}.story-workbench[data-theme=night]{--story-workbench-bg:#191411;--story-workbench-panel:#221b17;--story-workbench-text:#f1e3d6;--story-workbench-muted:#bea28f;--story-workbench-border:#4e3d32;--story-workbench-accent:#d98a67;--story-workbench-accent-soft:#3a2820;--story-workbench-danger:#df8d83}.story-workbench[data-theme=follow]{--story-workbench-bg:var(--SmartThemeBlurTintColor,rgba(30,30,30,1));--story-workbench-panel:color-mix(in srgb,var(--SmartThemeBlurTintColor,rgba(30,30,30,1)) 90%,var(--SmartThemeBodyColor,#eee));--story-workbench-text:var(--SmartThemeBodyColor,#eee);--story-workbench-muted:var(--SmartThemeEmColor,#aaa);--story-workbench-border:var(--SmartThemeBorderColor,#555);--story-workbench-accent:var(--SmartThemeQuoteColor,#8ab4f8);--story-workbench-accent-soft:color-mix(in srgb,var(--SmartThemeQuoteColor,#8ab4f8) 18%,transparent);--story-workbench-danger:#d9705f}.story-workbench *,.story-workbench *::before,.story-workbench *::after{box-sizing:border-box}.story-workbench button:not([class*="story-image-"]){min-height:36px;border:1px solid var(--story-workbench-border);border-radius:5px;padding:5px 10px;background:transparent;color:var(--story-workbench-text);font:inherit;cursor:pointer;transition:background .16s ease,border-color .16s ease,color .16s ease}.story-workbench button:hover:not(:disabled):not([class*="story-image-"]),.story-workbench button:focus-visible:not([class*="story-image-"]){border-color:var(--story-workbench-accent);color:var(--story-workbench-accent);background:var(--story-workbench-accent-soft)}.story-workbench button:disabled:not([class*="story-image-"]){opacity:.45;cursor:default}.story-workbench button:focus-visible,.story-workbench summary:focus-visible{outline:2px solid var(--story-workbench-accent);outline-offset:2px}.story-workbench__orb{position:fixed;right:12px;top:calc(100dvh - var(--story-workbench-bottom) - 56px);z-index:9990;display:flex;align-items:center;justify-content:center;width:48px;height:48px;min-height:48px!important;padding:0!important;border-color:var(--story-workbench-border)!important;border-radius:50%!important;background:var(--story-workbench-panel)!important;box-shadow:0 4px 16px rgb(0 0 0 / 30%);cursor:grab!important;touch-action:none;user-select:none}.story-workbench__orb:active{cursor:grabbing!important}.story-workbench__orb-icon{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.story-workbench__badge{position:absolute;top:-4px;right:-4px;min-width:18px;border-radius:999px;background:var(--story-workbench-accent);color:var(--story-workbench-bg);text-align:center;font:11px/18px sans-serif;box-shadow:0 1px 4px rgb(0 0 0 / 35%)}.story-workbench__panel{position:fixed;z-index:9991;top:max(48px,env(safe-area-inset-top));right:12px;height:max(0px,calc(100dvh - max(48px,env(safe-area-inset-top)) - var(--story-workbench-bottom) - 58px));display:flex;flex-direction:column;width:min(430px,calc(100vw - 24px));min-width:260px;min-height:220px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 96px);overflow:hidden;resize:both;border:1px solid var(--story-workbench-border);border-radius:9px;background:var(--story-workbench-bg);box-shadow:0 10px 34px rgb(0 0 0 / 28%)}.story-workbench__header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 16px;cursor:move;touch-action:none;user-select:none;border-bottom:1px solid var(--story-workbench-border);background:var(--story-workbench-panel)}.story-workbench__header button{cursor:pointer}.story-workbench__header-actions{display:flex;align-items:center;gap:6px}.story-workbench h2,.story-workbench h3,.story-workbench p{margin:0}.story-workbench h2{color:var(--story-workbench-accent);font-size:17px;line-height:1.2;letter-spacing:.02em}.story-workbench h3{font-size:18px;line-height:1.35}.story-workbench__hint{color:var(--story-workbench-muted);font-size:12px}.story-workbench__header-actions button{min-height:30px!important;padding:3px 8px!important;border-color:transparent!important;color:var(--story-workbench-muted)!important;font-size:12px!important}.story-workbench__notice{padding:8px 16px;color:var(--story-workbench-danger);font-size:12px}.story-workbench__body{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 16px 16px}.story-workbench__empty{padding:28px 2px;color:var(--story-workbench-muted);text-align:center}.story-workbench__shot{padding:15px 0 17px;border-top:1px solid var(--story-workbench-border)}.story-workbench__shot-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}.story-workbench__state{color:var(--story-workbench-accent);font-size:12px}.story-workbench__state--confirmed{color:#658b72}.story-workbench__hint{padding:4px 0}.story-workbench__lightbox{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:64px 12px 16px;background:rgb(20 12 8 / 86%)}.story-workbench__lightbox img{max-width:100%;max-height:100%;object-fit:contain}.story-workbench__lightbox-close{position:absolute;top:max(12px,env(safe-area-inset-top));right:12px;color:#fff4e8!important;border-color:#fff4e866!important}@media (max-width:600px){.story-workbench__panel{right:8px;width:calc(100vw - 16px)}.story-workbench__body{padding-inline:12px}.story-workbench h2{font-size:16px}.story-workbench h3{font-size:17px}}@media (max-height:550px){.story-workbench__panel{top:8px;height:max(0px,calc(100dvh - 8px - var(--story-workbench-bottom) - 58px))}}
.story-workbench__shot{padding:0;border-top:1px solid var(--story-workbench-border)}
.story-workbench__shot-summary{display:block;padding:14px 2px 13px;cursor:pointer;list-style:none}
.story-workbench__shot-summary::-webkit-details-marker{display:none}
.story-workbench__summary-meta{display:flex;gap:8px;min-width:0;margin-top:5px;color:var(--story-workbench-muted);font-size:12px}
.story-workbench__summary-meta span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.story-workbench__shot-content{padding:0 2px 17px}
/* 图片卡片：图片撑满面板宽度；翻页浮在图片内左右（绝对定位，翻页时不会推挤图片）；
   操作按钮排在图片下方并右对齐；缩略模式收起时改为展示本楼全部图片的缩略图。 */
.story-workbench__card{max-width:100%;margin-top:10px;cursor:default}
.story-workbench__thumbs{display:flex;align-items:flex-start;justify-content:flex-start;flex-wrap:wrap;gap:6px;margin-top:8px}
.story-workbench__shot[open] .story-workbench__thumbs{display:none}
.story-workbench button.story-workbench__thumb{width:auto;height:74px;min-height:0;padding:0;border:1px solid var(--story-workbench-border);border-radius:4px;overflow:hidden;background:transparent;line-height:0}
.story-workbench button.story-workbench__thumb img{display:block;width:auto;height:100%;object-fit:cover}
.story-workbench button.story-workbench__thumb:hover:not(:disabled),.story-workbench button.story-workbench__thumb:focus-visible{border-color:var(--story-workbench-accent);background:transparent}
.story-workbench button.story-workbench__thumb--selected{border-color:var(--story-workbench-accent);box-shadow:0 0 0 1px var(--story-workbench-accent)}
.story-workbench__stage{position:relative;margin-top:8px}
.story-workbench__image{display:block;width:100%;max-height:340px;border-radius:.35em;background:color-mix(in srgb,var(--story-workbench-text) 7%,transparent);object-fit:contain;cursor:zoom-in}
.story-workbench__toolbar{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;margin-top:8px}
.story-workbench__revision-pager{display:flex;align-items:center;gap:2px;margin-right:auto}
.story-workbench__revision-count{min-width:2.4rem;color:var(--story-workbench-muted);font-size:11px;text-align:center}
.story-workbench button.story-workbench__pager{position:absolute;top:50%;width:26px;height:26px;min-height:0;padding:0;border-color:rgb(255 255 255 / 30%);border-radius:50%;background:rgb(0 0 0 / 45%);color:#fff;font-size:13px;line-height:1;transform:translateY(-50%)}
.story-workbench button.story-workbench__pager--previous{left:6px}
.story-workbench button.story-workbench__pager--next{right:6px}
.story-workbench button.story-workbench__pager:hover:not(:disabled),.story-workbench button.story-workbench__pager:focus-visible{border-color:rgb(255 255 255 / 50%);background:rgb(0 0 0 / 68%);color:#fff}
.story-workbench button.story-workbench__pager--mini{position:static;width:22px;height:22px;font-size:11px;transform:none}
.story-workbench button.story-workbench__tool{width:28px;height:28px;min-height:0;padding:0;border-radius:50%;font-size:13px;line-height:1}
.story-workbench button.story-workbench__tool--pinned{border-color:var(--story-workbench-accent);background:var(--story-workbench-accent-soft);color:var(--story-workbench-accent)}
.story-workbench__shot:not([open]) .story-workbench__card--compact .story-workbench__stage,
.story-workbench__shot:not([open]) .story-workbench__card--compact .story-workbench__toolbar{display:none}
.story-workbench__state{display:inline-flex;align-items:center;min-height:22px;padding:0 8px;border:1px solid color-mix(in srgb,var(--story-workbench-accent) 32%,var(--story-workbench-border));border-radius:4px;background:var(--story-workbench-accent-soft);color:var(--story-workbench-accent);font-size:11px;line-height:1.2;white-space:nowrap}
.story-workbench__state--confirmed{color:#658b72;border-color:color-mix(in srgb,#658b72 38%,var(--story-workbench-border));background:color-mix(in srgb,#658b72 12%,transparent)}
.story-workbench button.story-workbench__floor-link{min-height:0;padding:0;border:0;border-radius:0;background:transparent;color:var(--story-workbench-accent);font:inherit;font-weight:700;text-align:left;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.story-workbench button.story-workbench__floor-link:hover,.story-workbench button.story-workbench__floor-link:focus-visible{border:0;background:transparent;color:color-mix(in srgb,var(--story-workbench-accent) 76%,#000)}
.story-workbench__shot-prompt{margin:4px 0 10px}
.story-workbench__shot-prompt p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.8;color:color-mix(in srgb,var(--story-workbench-text) 94%,transparent)}
.story-workbench__shot-prompt__toggle{min-height:0!important;margin-top:4px;padding:2px 0!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--story-workbench-accent);font-size:12px;text-decoration:underline;text-underline-offset:2px}
</style>
