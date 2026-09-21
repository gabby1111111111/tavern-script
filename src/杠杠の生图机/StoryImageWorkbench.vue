<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div ref="root" class="story-workbench" :style="{ '--story-workbench-bottom': `${bottomInset}px` }">
    <button
      ref="opener"
      class="story-workbench__orb"
      type="button"
      aria-label="打开或关闭剧情图面板"
      aria-controls="story-workbench-panel"
      :aria-expanded="open"
      @click="togglePanel"
    >
      <span aria-hidden="true">▧</span>
      <span>剧情图</span>
      <span v-if="pendingCount" class="story-workbench__badge">{{ pendingCount }}</span>
    </button>

    <section
      v-if="open"
      id="story-workbench-panel"
      class="story-workbench__panel"
      aria-labelledby="story-workbench-title"
    >
      <header class="story-workbench__header">
        <div>
          <h2 id="story-workbench-title">剧情图</h2>
          <small>杠杠の生图机 V0.4.2</small>
        </div>
        <button ref="closeButton" type="button" aria-label="关闭剧情图面板" @click="closePanel">×</button>
      </header>
      <div class="story-workbench__notice">
        <span>边聊边修，确认后才用于后续参考。</span>
        <span>图片仅留在本次页面，刷新即清空。</span>
        <strong v-if="!settings.enabled">生图机已关闭，开启后可继续重绘。</strong>
      </div>
      <p class="story-workbench__summary" role="status">{{ shots.length }} 个镜头 · {{ pendingCount }} 个任务进行中</p>
      <div class="story-workbench__body">
        <p v-if="!shots.length" class="story-workbench__empty">
          当前聊天暂无剧情图。已有图片会按各楼当前回答显示在这里。
        </p>
        <article v-for="shot in shots" :key="shot.id" class="story-workbench__shot">
          <div class="story-workbench__shot-heading">
            <h3>第 {{ shot.messageId }} 楼 · 插图 {{ shot.imageIndex + 1 }}</h3>
            <span
              class="story-workbench__state"
              :class="{ 'story-workbench__state--confirmed': shot.status === 'confirmed' }"
            >
              {{ statusText(shot) }}
            </span>
          </div>
          <div class="story-workbench__meta">
            <span>Swipe {{ shot.swipeId + 1 }}</span>
            <button type="button" @click="jumpToShot(shot.id)">回到原楼层 ↗</button>
          </div>
          <details class="story-workbench__prompt">
            <summary>镜头文字 <code v-text="'{{xx}}'"></code></summary>
            <p>{{ selectedImage(shot)?.prompt || shot.shotPrompt || '暂无镜头文字' }}</p>
          </details>
          <template v-if="selectedImage(shot)">
            <button
              class="story-workbench__preview"
              type="button"
              :aria-label="`放大第 ${shot.messageId} 楼当前预览图`"
              @click="showLightbox(shot, $event)"
            >
              <img :src="selectedImage(shot)!.url" :alt="`第 ${shot.messageId} 楼插图 ${shot.imageIndex + 1}`" />
              <span>点击放大 · {{ imageLabel(shot, selectedImage(shot)!) }}</span>
            </button>
            <div class="story-workbench__candidates" aria-label="候选与重绘版本">
              <button
                v-for="candidate in shot.images"
                :key="candidate.id"
                type="button"
                :aria-label="imageLabel(shot, candidate)"
                :aria-pressed="selectedImage(shot)?.id === candidate.id"
                :title="imageLabel(shot, candidate)"
                @click="selectedIds[shot.id] = candidate.id"
              >
                <img :src="candidate.url" alt="" loading="lazy" />
                <span>{{ candidate.variantIndex + 1 }} · {{ candidate.revisionIndex + 1 }}</span>
              </button>
            </div>
            <p class="story-workbench__hint">查看候选不会改变正文底图；确认后清理本镜头其他版本。</p>
            <p class="story-workbench__hint">
              {{ referenceLabel(shot) }}
            </p>
            <div class="story-workbench__actions">
              <button
                class="story-workbench__primary"
                type="button"
                :disabled="
                  selectedImage(shot)?.id === shot.confirmedPlacementId &&
                  shot.images.length === 1 &&
                  !shot.pendingCount
                "
                @click="confirmImage(shot)"
              >
                {{ selectedImage(shot)?.id === shot.confirmedPlacementId ? '保留确认图并清理' : '确认这张' }}
              </button>
              <button type="button" :disabled="!settings.enabled" @click="editImage(shot, false)">修改提示词</button>
              <button type="button" :disabled="!settings.enabled" @click="editImage(shot, true)">区域重绘</button>
              <button
                type="button"
                :disabled="!canRemoveSelected(shot)"
                title="底图或已确认图请通过放弃整个镜头删除"
                @click="removeCandidate(shot)"
              >
                删除候选
              </button>
            </div>
          </template>
          <p v-if="shot.pendingCount" class="story-workbench__progress" role="status">
            {{ shot.pendingCount }} 个任务正在生成，可继续聊天或查看其他镜头。
          </p>
          <p v-else-if="!shot.images.length" class="story-workbench__hint">
            {{ shot.status === 'failed' ? '本镜头生成失败。' : '本镜头暂无可用图片。' }}
          </p>
          <button class="story-workbench__abandon" type="button" @click="abandonShot(shot)">放弃整个镜头</button>
        </article>
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
import type { StoryImageRuntime } from './runtime';
import { useStoryImageSettingsStore } from './settings';
import type { WorkbenchShot } from './workbench-types';

const props = defineProps<{ runtime: StoryImageRuntime }>();
const settingsStore = useStoryImageSettingsStore();
const settings = computed(() => settingsStore.settings);
const root = ref<HTMLElement>();
const opener = ref<HTMLButtonElement>();
const closeButton = ref<HTMLButtonElement>();
const lightboxClose = ref<HTMLButtonElement>();
const open = ref(false);
const bottomInset = ref(148);
const selectedIds = ref<Record<string, string>>({});
const lightboxId = ref<string | null>(null);
let lightboxOpener: HTMLElement | null = null;
let inputObserver: ResizeObserver | null = null;
let hostDocument: Document | null = null;
let hostWindow: (Window & typeof globalThis) | null = null;

const shots = computed(() => props.runtime.workbenchShots.value);
const pendingCount = computed(() => shots.value.reduce((count, shot) => count + shot.pendingCount, 0));
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

function imageLabel(shot: WorkbenchShot, image: WorkbenchShot['images'][number]): string {
  const state =
    image.id === shot.confirmedPlacementId ? '已确认' : image.id === shot.basePlacementId ? '底图 · 未确认' : '待选';
  return `候选 ${image.variantIndex + 1} · 版本 ${image.revisionIndex + 1} · ${state}`;
}

function referenceLabel(shot: WorkbenchShot): string {
  const source = selectedImage(shot)?.referenceSource;
  if (source)
    return `生成时剧情参考位置：第 ${source.messageId} 楼 · Swipe ${source.swipeId + 1} · 插图 ${source.imageIndex + 1}`;
  return source === null ? '本图未附带上一镜头剧情图' : '本图暂无剧情参考来源记录';
}

function closePanel() {
  closeLightbox();
  open.value = false;
  opener.value?.focus();
}

async function togglePanel() {
  if (open.value) return closePanel();
  open.value = true;
  await nextTick();
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

function abandonShot(shot: WorkbenchShot) {
  if (
    !hostWindow?.confirm(
      `放弃第 ${shot.messageId} 楼的这个镜头？清理本镜头全部图片和在途任务；后续仍使用最近有效的已确认镜头，没有则不附剧情参考图。`,
    )
  )
    return;
  props.runtime.abandonWorkbenchShot(shot.id);
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
}

watch(shots, nextShots => {
  const nextIds: Record<string, string> = {};
  for (const shot of nextShots) {
    const selected = selectedIds.value[shot.id];
    if (shot.images.some(image => image.id === selected)) nextIds[shot.id] = selected;
  }
  selectedIds.value = nextIds;
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
.story-workbench {
  --story-workbench-bg: #20232d;
  --story-workbench-text: #f1eee8;
  --story-workbench-muted: #bbb9c4;
  --story-workbench-accent: #dfbd7c;
  color: var(--story-workbench-text);
  font: 14px/1.5 sans-serif;
}
.story-workbench *,
.story-workbench *::before,
.story-workbench *::after {
  box-sizing: border-box;
}
.story-workbench button {
  min-height: 40px;
  border: 1px solid #686575;
  border-radius: 8px;
  padding: 6px 10px;
  background: #30323f;
  color: var(--story-workbench-text);
  font: inherit;
  cursor: pointer;
}
.story-workbench button:disabled {
  opacity: 0.45;
  cursor: default;
}
.story-workbench button:focus-visible,
.story-workbench summary:focus-visible {
  outline: 2px solid var(--story-workbench-accent);
  outline-offset: 3px;
}
.story-workbench__orb {
  position: fixed;
  right: 12px;
  top: calc(100dvh - var(--story-workbench-bottom) - 48px);
  z-index: 9990;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 48px !important;
  border-radius: 28px !important;
  box-shadow: 0 3px 16px #0008;
}
.story-workbench__badge {
  border-radius: 50%;
  background: var(--story-workbench-accent);
  color: #222;
  min-width: 22px;
  text-align: center;
}
.story-workbench__panel {
  position: fixed;
  z-index: 9991;
  top: max(48px, env(safe-area-inset-top));
  right: 12px;
  /* Host themes can transform a zero-height html element. Size from the viewport
     instead of stretching between top/bottom of that fixed containing block. */
  height: max(0px, calc(100dvh - max(48px, env(safe-area-inset-top)) - var(--story-workbench-bottom) - 58px));
  display: flex;
  flex-direction: column;
  width: min(390px, calc(100vw - 24px));
  max-height: 760px;
  overflow: hidden;
  border: 1px solid #686575;
  border-radius: 14px;
  background: var(--story-workbench-bg);
  box-shadow: 0 8px 32px #0007;
}
.story-workbench__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #ffffff20;
}
.story-workbench h2,
.story-workbench h3,
.story-workbench p {
  margin: 0;
}
.story-workbench h2 {
  color: var(--story-workbench-text);
  font-size: 18px;
}
.story-workbench h3 {
  color: var(--story-workbench-text);
  font-size: 14px;
}
.story-workbench small,
.story-workbench__meta,
.story-workbench__hint {
  color: var(--story-workbench-muted);
  font-size: 12px;
}
.story-workbench__notice {
  display: grid;
  gap: 2px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--story-workbench-muted);
}
.story-workbench__notice strong {
  color: #f3cc90;
}
.story-workbench__summary {
  padding: 0 14px 8px;
  font-size: 12px;
}
.story-workbench__body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 14px 14px;
}
.story-workbench__empty {
  padding: 24px 0;
  color: var(--story-workbench-muted);
}
.story-workbench__shot {
  padding: 14px 0;
  border-top: 1px solid #ffffff24;
  min-width: 0;
}
.story-workbench__shot-heading,
.story-workbench__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
}
.story-workbench__state {
  font-size: 12px;
  color: #f3cc90;
}
.story-workbench__state--confirmed {
  color: #a9d8b8;
}
.story-workbench__meta button {
  padding: 4px 6px;
  border: none;
  background: transparent;
  color: var(--story-workbench-accent);
}
.story-workbench__prompt {
  margin: 4px 0 10px;
  font-size: 12px;
}
.story-workbench__prompt summary {
  cursor: pointer;
  padding: 6px 0;
}
.story-workbench__prompt p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 160px;
  overflow-y: auto;
  padding-top: 6px;
}
.story-workbench__preview {
  display: block;
  width: 100%;
  padding: 0 !important;
  overflow: hidden;
}
.story-workbench__preview img {
  display: block;
  width: 100%;
  max-height: 240px;
  object-fit: contain;
  background: #171920;
}
.story-workbench__preview span {
  display: block;
  padding: 7px;
  font-size: 12px;
}
.story-workbench__candidates {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding: 10px 2px;
}
.story-workbench__candidates button {
  flex: 0 0 64px;
  padding: 3px;
}
.story-workbench__candidates button[aria-pressed='true'] {
  outline: 2px solid var(--story-workbench-accent);
  outline-offset: -2px;
}
.story-workbench__candidates img {
  display: block;
  width: 56px;
  height: 52px;
  object-fit: cover;
  border-radius: 4px;
}
.story-workbench__candidates span {
  font-size: 11px;
}
.story-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 0;
}
.story-workbench__actions button {
  flex: 1 1 44%;
  font-size: 12px;
}
.story-workbench button.story-workbench__primary {
  background: var(--story-workbench-accent);
  color: #292219;
  border-color: var(--story-workbench-accent);
}
.story-workbench__progress {
  padding: 8px 0;
  font-size: 12px;
  color: #c9d9f4;
}
.story-workbench button.story-workbench__abandon {
  width: 100%;
  margin-top: 6px;
  color: #eeb9b6;
  background: transparent;
  border-color: #875e63;
}
.story-workbench__lightbox {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100dvh;
  z-index: 99999;
  background: #000e;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 64px 12px 16px;
}
.story-workbench__lightbox img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.story-workbench__lightbox-close {
  position: absolute;
  right: 12px;
  top: max(12px, env(safe-area-inset-top));
}
@media (max-height: 550px) {
  .story-workbench__panel {
    top: 8px;
    height: max(0px, calc(100dvh - 8px - var(--story-workbench-bottom) - 58px));
  }
  .story-workbench__notice {
    display: none;
  }
}
</style>
