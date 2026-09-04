<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <section class="story-image-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>杠杠の生图机 V0.3.0</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>

      <div class="inline-drawer-content">
        <div class="story-image-settings__tabs" role="tablist" aria-label="生图模块">
          <button
            v-for="tab in tabs"
            :key="tab.value"
            class="story-image-settings__tab"
            :class="{ 'story-image-settings__tab--active': activeTab === tab.value }"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.value"
            @click="selectTab(tab.value)"
          >
            {{ tab.label }}
          </button>
        </div>

        <div v-if="activeTab === 'preset'" class="story-image-settings__panel">
          <label class="story-image-settings__enable-row" for="story-image-enabled">
            <input id="story-image-enabled" v-model="settings.enabled" type="checkbox" />
            <span>启用生图机</span>
          </label>

          <div class="story-image-settings__preset-toolbar">
            <label class="story-image-settings__field" for="story-image-preset-select">
              <select
                id="story-image-preset-select"
                v-model="settings.currentDrawingPresetId"
                class="text_pole"
                aria-label="画图预设"
              >
                <option v-for="preset in settings.drawingPresets" :key="preset.id" :value="preset.id">
                  {{ preset.name || '未命名预设' }}
                </option>
              </select>
            </label>
            <div class="story-image-settings__profile-actions">
              <button class="story-image-settings__button" type="button" @click="createPreset">新建预设</button>
              <button
                class="story-image-settings__button story-image-settings__button--primary"
                type="button"
                @click="savePreset"
              >
                保存预设
              </button>
              <button
                class="story-image-settings__button story-image-settings__button--quiet"
                type="button"
                :disabled="settings.drawingPresets.length <= 1"
                @click="deleteActivePreset"
              >
                删除预设
              </button>
            </div>
          </div>

          <div class="story-image-settings__preset-editor">
            <label class="story-image-settings__field" for="story-image-preset-name">
              <span class="story-image-settings__label">预设名称</span>
              <input id="story-image-preset-name" v-model="activePreset.name" class="text_pole" type="text" />
            </label>
            <label class="story-image-settings__field" for="story-image-preset-instruction">
              <span class="story-image-settings__label">发给正文 AI 的指令</span>
              <textarea
                id="story-image-preset-instruction"
                v-model="activePreset.instructionText"
                class="text_pole story-image-settings__textarea"
                rows="14"
                placeholder='填写正文 AI 应如何输出 <pic prompt="..."> 标记的指令'
              ></textarea>
            </label>
          </div>

          <div class="story-image-settings__display-settings">
            <h4 class="story-image-settings__section-title">展现设置</h4>
            <div class="story-image-settings__grid">
              <label class="story-image-settings__field" for="story-image-display-mode">
                <span class="story-image-settings__label">图片展现方式</span>
                <select id="story-image-display-mode" v-model="settings.displaySettings.displayMode" class="text_pole">
                  <option value="inline">随文插入</option>
                  <option value="gift">礼物异步</option>
                </select>
              </label>
              <label class="story-image-settings__field" for="story-image-skip-floors">
                <span class="story-image-settings__label">跳过楼层数</span>
                <input
                  id="story-image-skip-floors"
                  v-model.number="settings.displaySettings.skipFloors"
                  class="text_pole"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                />
              </label>
            </div>
            <p class="story-image-settings__description">
              0 表示每个符合条件的新 AI 楼层都触发；1 表示每隔一楼触发。只统计正常新回复，重生成、切换 swipe
              和历史消息不会重复计数。
            </p>
          </div>

          <p
            class="story-image-settings__status"
            :class="{ 'story-image-settings__status--error': runtimeStatus === 'error' }"
          >
            当前状态：{{ statusLabel }}
          </p>
        </div>

        <div v-else-if="activeTab === 'output'" class="story-image-settings__panel">
          <div class="story-image-settings__preset-toolbar">
            <label class="story-image-settings__field" for="story-image-output-preset-select">
              <span class="story-image-settings__label">正在编辑</span>
              <select
                id="story-image-output-preset-select"
                v-model="settings.currentOutputPresetId"
                class="text_pole"
                aria-label="出图预设"
              >
                <option v-for="preset in settings.outputPresets" :key="preset.id" :value="preset.id">
                  {{ preset.name || '未命名出图预设' }}
                </option>
              </select>
            </label>
            <div class="story-image-settings__profile-actions">
              <button class="story-image-settings__button" type="button" @click="createOutputPresetEntry">
                新建预设
              </button>
              <button
                class="story-image-settings__button story-image-settings__button--primary"
                type="button"
                @click="saveOutputPresetEntry"
              >
                保存预设
              </button>
              <button
                class="story-image-settings__button story-image-settings__button--quiet"
                type="button"
                :disabled="settings.outputPresets.length <= 1"
                @click="deleteActiveOutputPreset"
              >
                删除预设
              </button>
            </div>
          </div>

          <div class="story-image-settings__preset-editor">
            <label class="story-image-settings__field" for="story-image-output-preset-name">
              <span class="story-image-settings__label">预设名称</span>
              <input
                id="story-image-output-preset-name"
                v-model="activeOutputPreset.name"
                class="text_pole"
                type="text"
              />
            </label>
            <label class="story-image-settings__field" for="story-image-output-preset-template">
              <span class="story-image-settings__label">出图模板</span>
              <textarea
                id="story-image-output-preset-template"
                v-model="activeOutputPreset.templateText"
                class="text_pole story-image-settings__textarea"
                rows="8"
                placeholder="使用 {{xx}} 代表当前图片提示词"
              ></textarea>
            </label>
            <label class="story-image-settings__enable-row" for="story-image-output-avatar-references">
              <input
                id="story-image-output-avatar-references"
                v-model="activeOutputPreset.useAvatarReferences"
                type="checkbox"
              />
              <span>使用当前 User 和角色头像</span>
            </label>
            <p class="story-image-settings__description story-image-settings__avatar-reference-note">
              开启后固定参考图顺序：User = 图1，当前角色 = 图2。关闭时不附加头像参考图。
            </p>
          </div>
        </div>

        <div v-else-if="activeTab === 'recent'" class="story-image-settings__panel story-image-settings__recent-panel">
          <div class="story-image-settings__recent-limit">
            <label class="story-image-settings__field" for="story-image-recent-limit">
              <span class="story-image-settings__label">最近图片保留张数</span>
              <input
                id="story-image-recent-limit"
                v-model.number="settings.recentImageLimit"
                class="text_pole"
                type="number"
                min="1"
                max="50"
                step="1"
                @change="normalizeRecentImageLimitInput"
                @blur="normalizeRecentImageLimitInput"
              />
            </label>
          </div>
          <p v-if="recentImages.length === 0" class="story-image-settings__recent-empty">
            当前会话还没有成功生成的图片。
          </p>
          <div v-else class="story-image-settings__recent-grid" role="list">
            <article
              v-for="image in recentImages"
              :key="image.id"
              class="story-image-settings__recent-card"
              role="listitem"
            >
              <div class="story-image-settings__recent-thumbnail">
                <img :src="image.url" alt="生成图片" loading="lazy" @error="removeRecentImage(image.id)" />
              </div>
              <div class="story-image-settings__recent-actions">
                <button
                  class="story-image-settings__button"
                  type="button"
                  :disabled="savingGalleryImageId === image.id"
                  @click="saveRecentImageToGallery(image.id)"
                >
                  {{ savingGalleryImageId === image.id ? '保存中…' : '保存到角色图库' }}
                </button>
                <button
                  class="story-image-settings__button story-image-settings__button--quiet"
                  type="button"
                  @click="removeRecentImage(image.id)"
                >
                  删除
                </button>
              </div>
              <p v-if="saveGalleryError === image.id" class="story-image-settings__error">保存失败，请稍后重试。</p>
            </article>
          </div>
        </div>

        <div v-else class="story-image-settings__panel story-image-settings__settings-panel">
          <div class="story-image-settings__advanced-content">
            <div class="story-image-settings__profile-toolbar">
              <label class="story-image-settings__field" for="story-image-profile-select">
                <span class="story-image-settings__label">正在编辑</span>
                <select id="story-image-profile-select" v-model="settings.activeApiProfileId" class="text_pole">
                  <option v-for="profile in settings.apiProfiles" :key="profile.id" :value="profile.id">
                    {{ profile.name || '未命名配置' }}
                  </option>
                </select>
              </label>
              <div class="story-image-settings__profile-actions">
                <button class="story-image-settings__button" type="button" @click="createProfile">新增配置</button>
                <button
                  class="story-image-settings__button story-image-settings__button--quiet"
                  type="button"
                  :disabled="settings.apiProfiles.length <= 1"
                  @click="deleteActiveProfile"
                >
                  删除配置
                </button>
              </div>
            </div>

            <label class="story-image-settings__field" for="story-image-profile-name">
              <span class="story-image-settings__label">配置名称</span>
              <input id="story-image-profile-name" v-model="activeProfile.name" class="text_pole" type="text" />
            </label>
            <label class="story-image-settings__field" for="story-image-service-url">
              <span class="story-image-settings__label">图片 API 地址</span>
              <input id="story-image-service-url" v-model="activeProfile.serviceUrl" class="text_pole" type="url" />
            </label>
            <label class="story-image-settings__field" for="story-image-model-list-url">
              <span class="story-image-settings__label">模型列表 API 地址（可选）</span>
              <input
                id="story-image-model-list-url"
                v-model="activeProfile.modelListUrl"
                class="text_pole"
                type="url"
                placeholder="留空时根据图片 API 地址推断 /models"
              />
              <small class="story-image-settings__description"
                >留空时，拉取模型会尝试使用图片 API 地址对应的模型端点。</small
              >
            </label>
            <label class="story-image-settings__field" for="story-image-api-key">
              <span class="story-image-settings__label">API Key</span>
              <input
                id="story-image-api-key"
                v-model="activeProfile.apiKey"
                class="text_pole"
                type="password"
                autocomplete="off"
              />
              <small class="story-image-settings__description story-image-settings__secret-warning">
                API Key 会以脚本设置明文保存；不会写入 console、audit、错误提示或普通日志。
              </small>
            </label>

            <div class="story-image-settings__model-field">
              <div class="story-image-settings__model-heading">
                <span class="story-image-settings__label">当前选中模型</span>
                <button
                  class="story-image-settings__button"
                  type="button"
                  :disabled="modelFetchState === 'loading' || !activeProfile.serviceUrl.trim()"
                  @click="pullModels"
                >
                  {{ modelFetchState === 'loading' ? '拉取中…' : '拉取模型' }}
                </button>
              </div>
              <select
                v-if="modelOptions.length > 0"
                id="story-image-model"
                v-model="activeProfile.model"
                class="text_pole"
              >
                <option value="">请选择模型</option>
                <option
                  v-if="activeProfile.model && !modelOptions.includes(activeProfile.model)"
                  :value="activeProfile.model"
                >
                  当前模型：{{ activeProfile.model }}
                </option>
                <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
              </select>
              <input
                v-else
                id="story-image-model"
                v-model="activeProfile.model"
                class="text_pole"
                type="text"
                placeholder="拉取失败或尚未拉取时，可手动输入模型名"
              />
              <p v-if="modelFetchState === 'error'" class="story-image-settings__error">{{ modelFetchError }}</p>
              <p v-else-if="modelFetchState === 'success'" class="story-image-settings__description">
                已拉取 {{ modelOptions.length }} 个模型；模型列表仅作为当前会话缓存。
              </p>
            </div>

            <label class="story-image-settings__field" for="story-image-request-mode">
              <span class="story-image-settings__label">参考图请求模式</span>
              <select id="story-image-request-mode" v-model="activeProfile.requestMode" class="text_pole">
                <option value="auto">自动判断</option>
                <option value="multipart-edit">Multipart 编辑</option>
                <option value="chat-multimodal">Chat 多模态</option>
                <option value="json-reference">JSON 参考图</option>
              </select>
              <small class="story-image-settings__description">
                仅在当前出图预设开启头像参考并取得头像时使用；无参考图始终走普通生图。
              </small>
            </label>
            <label
              v-if="activeProfile.requestMode === 'multipart-edit'"
              class="story-image-settings__field"
              for="story-image-multipart-field"
            >
              <span class="story-image-settings__label">Multipart 图片字段</span>
              <select id="story-image-multipart-field" v-model="activeProfile.multipartImageField" class="text_pole">
                <option value="auto">自动判断</option>
                <option value="image">image</option>
                <option value="image[]">image[]</option>
              </select>
            </label>
            <label
              v-if="activeProfile.requestMode === 'json-reference'"
              class="story-image-settings__field"
              for="story-image-json-reference-field"
            >
              <span class="story-image-settings__label">JSON 参考图字段</span>
              <select
                id="story-image-json-reference-field"
                v-model="activeProfile.jsonReferenceField"
                class="text_pole"
              >
                <option value="images">images</option>
                <option value="reference_images">reference_images</option>
                <option value="image">image</option>
              </select>
            </label>

            <div class="story-image-settings__grid">
              <label class="story-image-settings__field" for="story-image-size">
                <span class="story-image-settings__label">尺寸</span>
                <input id="story-image-size" v-model="activeProfile.imageSize" class="text_pole" type="text" />
              </label>
              <label class="story-image-settings__field" for="story-image-timeout">
                <span class="story-image-settings__label">超时（毫秒）</span>
                <input
                  id="story-image-timeout"
                  v-model.number="activeProfile.timeoutMs"
                  min="1000"
                  step="1000"
                  class="text_pole"
                  type="number"
                />
              </label>
            </div>
            <label class="story-image-settings__field" for="story-image-extra-body">
              <span class="story-image-settings__label">额外请求 JSON</span>
              <textarea
                id="story-image-extra-body"
                v-model="extraBodyText"
                class="text_pole story-image-settings__textarea"
                rows="3"
                @blur="applyExtraBody"
              ></textarea>
            </label>
            <p v-if="extraBodyError" class="story-image-settings__error">{{ extraBodyError }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, ref, type Ref, watch } from 'vue';
import { createDrawingPreset, deleteDrawingPreset, updateDrawingPreset } from './drawing-preset';
import { fetchModelList, ModelListApiError } from './model-api';
import type { RecentGeneratedImage } from './recent-image-cache';
import { createOutputPreset, deleteOutputPreset, updateOutputPreset } from './output-preset';
import type { ImageApiProfile } from './settings';
import {
  getCurrentDrawingPreset,
  getCurrentOutputPreset,
  normalizeRecentImageLimit,
  repairApiProfileRouteIds,
  useStoryImageSettingsStore,
} from './settings';

type ImageSettingsRuntime = {
  status: Readonly<Ref<string>>;
  recentImages: Readonly<Ref<RecentGeneratedImage[]>>;
  removeRecentImage: (id: string) => boolean;
  /** Runtime adapter implemented by the parent agent; it must not persist data automatically. */
  saveRecentImageToGallery?: (artifactId: string) => Promise<unknown> | unknown;
};

const props = defineProps<{ runtime: ImageSettingsRuntime }>();
const { settings } = storeToRefs(useStoryImageSettingsStore());
const tabs = [
  { value: 'preset', label: '画图预设' },
  { value: 'output', label: '出图预设' },
  { value: 'recent', label: '最近生成' },
  { value: 'settings', label: 'API 设置' },
] as const;
type TabValue = (typeof tabs)[number]['value'];
const activeTab = ref<TabValue>('preset');

const activePreset = computed(() => getCurrentDrawingPreset(settings.value));
const activeOutputPreset = computed(() => getCurrentOutputPreset(settings.value));
const activeProfile = computed<ImageApiProfile>(
  () =>
    settings.value.apiProfiles.find(profile => profile.id === settings.value.activeApiProfileId) ??
    settings.value.apiProfiles[0]!,
);
const activeProfileState = computed(() => ({
  id: activeProfile.value.id,
  signature: [activeProfile.value.serviceUrl, activeProfile.value.modelListUrl, activeProfile.value.apiKey].join(
    '\u0000',
  ),
}));
const modelOptions = ref<string[]>([]);
const modelFetchState = ref<'idle' | 'loading' | 'success' | 'error'>('idle');
const modelFetchError = ref('');
const modelCache = new Map<string, { signature: string; models: string[] }>();
let modelRequestController: AbortController | null = null;
let profileSequence = 0;
const extraBodyText = ref(JSON.stringify(activeProfile.value.extraBody, null, 2));
const extraBodyError = ref('');
const savingGalleryImageId = ref<string | null>(null);
const saveGalleryError = ref<string | null>(null);

const runtimeStatus = computed(() => props.runtime.status.value);
const recentImages = computed(() => props.runtime.recentImages.value);
const statusLabel = computed(() => {
  if (!settings.value.enabled) return '已关闭';
  if (runtimeStatus.value === 'generating') return '正在生成，聊天正文不受阻塞';
  if (runtimeStatus.value === 'error') return '最近一次图片任务失败';
  if (runtimeStatus.value === 'ready') return '图片任务已完成或可恢复';
  if (runtimeStatus.value === 'stopped') return '脚本已卸载';
  return '等待 AI 回复';
});

function selectTab(tab: TabValue): void {
  activeTab.value = tab;
}

function createPreset(): void {
  const preset = createDrawingPreset({
    name: `新预设 ${settings.value.drawingPresets.length + 1}`,
    instructionText: activePreset.value.instructionText,
  });
  settings.value.drawingPresets = [...settings.value.drawingPresets, preset];
  settings.value.currentDrawingPresetId = preset.id;
}

function savePreset(): void {
  const index = settings.value.drawingPresets.findIndex(preset => preset.id === settings.value.currentDrawingPresetId);
  if (index < 0) return;
  const [saved] = updateDrawingPreset(settings.value.drawingPresets, settings.value.currentDrawingPresetId, {
    name: activePreset.value.name.trim() || '未命名预设',
    instructionText: activePreset.value.instructionText,
  }).filter(preset => preset.id === settings.value.currentDrawingPresetId);
  if (!saved) return;
  settings.value.drawingPresets.splice(index, 1, saved);
  toastr.success('画图预设已保存。');
}

function deleteActivePreset(): void {
  const result = deleteDrawingPreset(
    settings.value.drawingPresets,
    settings.value.currentDrawingPresetId,
    settings.value.currentDrawingPresetId,
  );
  if (!result.deleted) return;
  settings.value.drawingPresets = result.presets;
  settings.value.currentDrawingPresetId = result.currentId;
}

function createOutputPresetEntry(): void {
  const preset = createOutputPreset({
    name: `新预设 ${settings.value.outputPresets.length + 1}`,
    templateText: activeOutputPreset.value.templateText,
    useAvatarReferences: activeOutputPreset.value.useAvatarReferences,
  });
  settings.value.outputPresets = [...settings.value.outputPresets, preset];
  settings.value.currentOutputPresetId = preset.id;
}

function saveOutputPresetEntry(): void {
  const index = settings.value.outputPresets.findIndex(preset => preset.id === settings.value.currentOutputPresetId);
  if (index < 0) return;
  const [saved] = updateOutputPreset(settings.value.outputPresets, settings.value.currentOutputPresetId, {
    name: activeOutputPreset.value.name.trim() || '未命名出图预设',
    templateText: activeOutputPreset.value.templateText,
    useAvatarReferences: activeOutputPreset.value.useAvatarReferences,
  }).filter(preset => preset.id === settings.value.currentOutputPresetId);
  if (!saved) return;
  settings.value.outputPresets.splice(index, 1, saved);
  toastr.success('出图预设已保存。');
}

function deleteActiveOutputPreset(): void {
  const result = deleteOutputPreset(
    settings.value.outputPresets,
    settings.value.currentOutputPresetId,
    settings.value.currentOutputPresetId,
  );
  if (!result.deleted) return;
  settings.value.outputPresets = result.presets;
  settings.value.currentOutputPresetId = result.currentId;
}

function createProfileId(): string {
  return `profile-${Date.now()}-${profileSequence++}`;
}

function createProfile(): void {
  const id = createProfileId();
  settings.value.apiProfiles.push({
    id,
    name: `配置 ${settings.value.apiProfiles.length + 1}`,
    serviceUrl: '',
    modelListUrl: '',
    apiKey: '',
    model: '',
    imageSize: '1024x1024',
    timeoutMs: 120_000,
    retryAttempts: 0,
    retryDelayMs: 1_500,
    requestMode: 'auto',
    multipartImageField: 'auto',
    jsonReferenceField: 'images',
    extraBody: {},
  });
  settings.value.activeApiProfileId = id;
}

function deleteActiveProfile(): void {
  if (settings.value.apiProfiles.length <= 1) return;
  const deletedId = activeProfile.value.id;
  const deletedIndex = settings.value.apiProfiles.findIndex(profile => profile.id === deletedId);
  settings.value.apiProfiles.splice(deletedIndex, 1);
  const adjacentProfile = settings.value.apiProfiles[Math.min(deletedIndex, settings.value.apiProfiles.length - 1)];
  repairApiProfileRouteIds(settings.value, adjacentProfile.id);
}

async function saveRecentImageToGallery(artifactId: string): Promise<void> {
  if (!props.runtime.saveRecentImageToGallery) {
    saveGalleryError.value = artifactId;
    toastr.info('角色图库保存接口将在运行时验收阶段接入。');
    return;
  }
  savingGalleryImageId.value = artifactId;
  saveGalleryError.value = null;
  try {
    await props.runtime.saveRecentImageToGallery(artifactId);
    toastr.success('已保存到当前角色图库。');
  } catch {
    saveGalleryError.value = artifactId;
    toastr.error('保存到角色图库失败，图片仍保留在本页内存中。');
  } finally {
    savingGalleryImageId.value = null;
  }
}

function removeRecentImage(id: string): void {
  props.runtime.removeRecentImage(id);
}

function normalizeRecentImageLimitInput(): void {
  settings.value.recentImageLimit = normalizeRecentImageLimit(settings.value.recentImageLimit);
}

async function pullModels(): Promise<void> {
  modelRequestController?.abort();
  const controller = new AbortController();
  modelRequestController = controller;
  modelFetchState.value = 'loading';
  modelFetchError.value = '';
  try {
    const models = await fetchModelList(activeProfile.value, controller.signal);
    if (modelRequestController !== controller) return;
    const state = activeProfileState.value;
    modelCache.set(state.id, { signature: state.signature, models });
    modelOptions.value = [...models];
    modelFetchState.value = 'success';
  } catch (error) {
    if (modelRequestController !== controller) return;
    modelOptions.value = [];
    modelFetchState.value = 'error';
    modelFetchError.value = error instanceof ModelListApiError ? error.message : '模型列表拉取失败，请稍后重试。';
  } finally {
    if (modelRequestController === controller) modelRequestController = null;
  }
}

watch(
  activeProfileState,
  state => {
    modelRequestController?.abort();
    modelRequestController = null;
    const cached = modelCache.get(state.id);
    if (!cached || cached.signature !== state.signature) {
      modelCache.delete(state.id);
      modelOptions.value = [];
      modelFetchState.value = 'idle';
      modelFetchError.value = '';
      return;
    }
    modelOptions.value = [...cached.models];
    modelFetchState.value = 'success';
    modelFetchError.value = '';
  },
  { immediate: true },
);

watch(
  () => activeProfile.value.extraBody,
  value => {
    extraBodyText.value = JSON.stringify(value, null, 2);
  },
  { deep: true },
);

function applyExtraBody(): void {
  try {
    const parsed: unknown = JSON.parse(extraBodyText.value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 JSON 对象');
    activeProfile.value.extraBody = parsed as Record<string, unknown>;
    extraBodyError.value = '';
  } catch {
    extraBodyError.value = '额外请求 JSON 无效，未保存这次修改。';
  }
}

onBeforeUnmount(() => {
  modelRequestController?.abort();
});
</script>
