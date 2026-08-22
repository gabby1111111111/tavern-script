<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <section class="story-image-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>杠杠の生图机</b>
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

        <div v-if="activeTab === 'inline'" class="story-image-settings__panel">
          <label class="story-image-settings__enable-row" for="story-image-enabled">
            <input id="story-image-enabled" v-model="settings.enabled" type="checkbox" />
            <span>启用随文插图</span>
          </label>

          <div class="story-image-settings__prompt-fields">
            <details class="story-image-settings__prompt-section">
              <summary class="story-image-settings__prompt-summary">
                <span class="story-image-settings__label">基础任务与输出格式</span>
                <small class="story-image-settings__description"
                  >规定什么时候生成标记、标记放在哪里，以及最多生成几张图片。</small
                >
              </summary>
              <textarea
                id="story-image-prompt-base"
                v-model="settings.basePrompt"
                class="text_pole story-image-settings__textarea"
                rows="10"
                placeholder='填写基础任务与 <pic prompt="..."> 输出格式'
              ></textarea>
            </details>

            <details class="story-image-settings__prompt-section">
              <summary class="story-image-settings__prompt-summary">
                <span class="story-image-settings__label">整体审美、场景和人物规则</span>
                <small class="story-image-settings__description"
                  >规定环境、物件、时间、光线、情绪、场景连续性、画面丰富度和人物占比。</small
                >
              </summary>
              <textarea
                id="story-image-prompt-scene"
                v-model="settings.scenePrompt"
                class="text_pole story-image-settings__textarea"
                rows="12"
                placeholder="填写整体审美、场景和人物规则"
              ></textarea>
            </details>

            <details class="story-image-settings__prompt-section">
              <summary class="story-image-settings__prompt-summary">
                <span class="story-image-settings__label">视觉风格库</span>
                <small class="story-image-settings__description"
                  >保留视觉类型和强制开头句式；运行时只注入这一份可编辑文本。</small
                >
              </summary>
              <textarea
                id="story-image-prompt-style"
                v-model="settings.stylePrompt"
                class="text_pole story-image-settings__textarea"
                rows="18"
                placeholder="填写视觉风格类型和强制开头句式"
              ></textarea>
            </details>

            <details class="story-image-settings__prompt-section">
              <summary class="story-image-settings__prompt-summary">
                <span class="story-image-settings__label">安全限制与生成前自检</span>
                <small class="story-image-settings__description"
                  >规定纯 SFW、敏感措辞替换和生成前检查；只输出最终结果。</small
                >
              </summary>
              <textarea
                id="story-image-prompt-safety"
                v-model="settings.safetyPrompt"
                class="text_pole story-image-settings__textarea"
                rows="12"
                placeholder="填写安全限制与生成前自检规则"
              ></textarea>
            </details>
          </div>

          <p
            class="story-image-settings__status"
            :class="{ 'story-image-settings__status--error': runtimeStatus === 'error' }"
          >
            当前状态：{{ statusLabel }}
          </p>
          <p class="story-image-settings__hint">
            每条 AI 回复最多处理两个标记；图片只保存在当前网页内存，不会写回正文或数据库。
          </p>
        </div>

        <div v-else-if="activeTab === 'gift'" class="story-image-settings__panel story-image-settings__gift-panel">
          <div class="story-image-settings__gift-intro">
            <h4 class="story-image-settings__section-title">礼物 CG／图生图</h4>
            <p class="story-image-settings__description">
              三张参考图只保存在当前网页内存：角色 1、角色 2
              决定人物身份，模板图决定动作、姿势、镜头和构图；正文上下文决定服装、场景、道具、表情、光线和氛围。
            </p>
          </div>

          <label class="story-image-settings__enable-row" for="story-image-gift-enabled">
            <input id="story-image-gift-enabled" v-model="settings.gift.enabled" type="checkbox" />
            <span>启用礼物 CG</span>
          </label>

          <div class="story-image-settings__gift-options">
            <label class="story-image-settings__field" for="story-image-gift-trigger">
              <span class="story-image-settings__label">触发方式</span>
              <select id="story-image-gift-trigger" v-model="settings.gift.triggerInterval" class="text_pole">
                <option value="manual">手动生成</option>
                <option value="3">每 3 条 AI 回复（预留）</option>
                <option value="5">每 5 条 AI 回复（预留）</option>
              </select>
              <small class="story-image-settings__description">当前只执行手动按钮，自动楼层触发暂不发起请求。</small>
            </label>
            <label class="story-image-settings__field" for="story-image-gift-request-mode">
              <span class="story-image-settings__label">图生图请求模式</span>
              <select id="story-image-gift-request-mode" v-model="settings.gift.requestMode" class="text_pole">
                <option value="auto">自动判断</option>
                <option value="multipart-edit">multipart／images/edits</option>
                <option value="chat-multimodal">chat/completions 多模态</option>
                <option value="json-reference">JSON 参考图</option>
              </select>
            </label>
            <label
              v-if="settings.gift.requestMode === 'json-reference' || settings.gift.requestMode === 'auto'"
              class="story-image-settings__field"
              for="story-image-gift-reference-field"
            >
              <span class="story-image-settings__label">JSON 参考图字段</span>
              <select
                id="story-image-gift-reference-field"
                v-model="settings.gift.jsonReferenceField"
                class="text_pole"
              >
                <option value="images">images</option>
                <option value="reference_images">reference_images</option>
                <option value="image">image</option>
              </select>
            </label>
          </div>

          <div class="story-image-settings__gift-input-grid story-image-settings__gift-input-grid--three">
            <div v-for="slot in giftReferenceSlots" :key="slot.id" class="story-image-settings__gift-reference-card">
              <div class="story-image-settings__gift-reference-heading">
                <span class="story-image-settings__label">{{ slot.label }}</span>
                <button
                  v-if="referenceFor(slot.id)"
                  class="story-image-settings__button story-image-settings__button--quiet"
                  type="button"
                  @click="removeGiftReference(slot.id)"
                >
                  删除
                </button>
              </div>
              <small class="story-image-settings__description">{{ slot.description }}</small>
              <div class="story-image-settings__gift-file-picker">
                <button
                  class="story-image-settings__button story-image-settings__button--primary"
                  type="button"
                  @click="openGiftFilePicker(slot.id)"
                >
                  选择本地图片
                </button>
                <input
                  :id="`story-image-gift-file-${slot.id}`"
                  class="story-image-settings__gift-file-input"
                  type="file"
                  accept="image/*"
                  :aria-label="`${slot.label}：选择本地图片`"
                  @change="onGiftFileChange($event, slot.id)"
                />
              </div>
              <div v-if="referenceFor(slot.id)" class="story-image-settings__gift-selected">
                <span class="story-image-settings__gift-selected-name">
                  已选择：{{ referenceFor(slot.id)?.fileName }}
                </span>
                <img :src="referencePreview(referenceFor(slot.id))" :alt="`${slot.label}缩略图`" />
              </div>
              <input
                :value="giftNameInputs[slot.id]"
                class="text_pole"
                type="text"
                placeholder="可选：给这张图起个名字"
                @change="renameGiftReference(slot.id, $event)"
              />
              <input
                v-model="giftUrlInputs[slot.id]"
                class="text_pole"
                type="url"
                placeholder="或者填写图片 URL"
                @change="setGiftReferenceUrl(slot.id)"
              />
            </div>
          </div>

          <p class="story-image-settings__hint">当前模板只在本次网页会话有效；刷新网页或脚本重载后需要重新选择。</p>
          <div class="story-image-settings__gift-actions">
            <button
              class="story-image-settings__button story-image-settings__button--primary"
              type="button"
              :disabled="giftBusy || !settings.gift.enabled || !hasAllGiftReferences"
              @click="generateGift"
            >
              {{ giftBusy ? '礼物 CG 准备中…' : '读取当前上下文并生成礼物 CG' }}
            </button>
            <button
              class="story-image-settings__button story-image-settings__button--quiet"
              type="button"
              :disabled="giftTasks.length === 0"
              @click="clearGiftImages"
            >
              清空本页结果
            </button>
          </div>
          <p v-if="giftError" class="story-image-settings__error">{{ giftError }}</p>

          <div class="story-image-settings__gift-prompt-fields">
            <details
              v-for="section in giftPromptSections"
              :key="section.key"
              class="story-image-settings__prompt-section"
            >
              <summary class="story-image-settings__prompt-summary">
                <span class="story-image-settings__label">{{ section.label }}</span>
                <small class="story-image-settings__description">{{ section.description }}</small>
              </summary>
              <textarea
                v-model="settings.gift[section.key]"
                class="text_pole story-image-settings__textarea"
                rows="5"
              ></textarea>
            </details>
          </div>

          <div class="story-image-settings__gift-results">
            <h4 class="story-image-settings__section-title">本页礼物 CG 结果</h4>
            <p v-if="giftTasks.length === 0" class="story-image-settings__recent-empty">尚未生成礼物 CG。</p>
            <div v-else class="story-image-settings__recent-grid" role="list">
              <article
                v-for="task in giftTasks"
                :key="task.id"
                class="story-image-settings__recent-card"
                role="listitem"
              >
                <div v-if="task.image" class="story-image-settings__recent-thumbnail">
                  <img :src="task.image.url" alt="礼物 CG 结果" loading="lazy" />
                </div>
                <div v-else class="story-image-settings__gift-result-state">
                  {{ giftTaskStatus(task.status, task.error) }}
                </div>
                <div v-if="task.image" class="story-image-settings__recent-actions">
                  <button class="story-image-settings__button" type="button" @click="downloadGiftImage(task)">
                    下载
                  </button>
                </div>
              </article>
            </div>
          </div>
        </div>

        <div v-else-if="activeTab === 'recent'" class="story-image-settings__panel story-image-settings__recent-panel">
          <div class="story-image-settings__recent-intro">
            <h4 class="story-image-settings__section-title">最近生成</h4>
            <p class="story-image-settings__description">
              仅保留本次网页会话内最近成功生成的 10 张图片；刷新网页或脚本重载后会清空。
            </p>
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
                <img :src="image.url" alt="" loading="lazy" />
              </div>
              <div class="story-image-settings__recent-actions">
                <button class="story-image-settings__button" type="button" @click="downloadRecentImage(image)">
                  下载
                </button>
              </div>
            </article>
          </div>
        </div>

        <div v-else class="story-image-settings__panel story-image-settings__settings-panel">
          <h4 class="story-image-settings__section-title">API 配置档案</h4>
          <p class="story-image-settings__description">每个档案独立保存图片接口、认证信息和生成参数。</p>
          <div class="story-image-settings__advanced-content">
            <div class="story-image-settings__profile-toolbar">
              <label class="story-image-settings__field" for="story-image-profile-select">
                <span class="story-image-settings__label">当前配置</span>
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
                  class="text_pole"
                  min="1000"
                  step="1000"
                  type="number"
                />
              </label>
              <label class="story-image-settings__field" for="story-image-retry">
                <span class="story-image-settings__label">失败重试次数</span>
                <input
                  id="story-image-retry"
                  v-model.number="activeProfile.retryAttempts"
                  class="text_pole"
                  min="0"
                  max="5"
                  type="number"
                />
              </label>
              <label class="story-image-settings__field" for="story-image-retry-delay">
                <span class="story-image-settings__label">重试间隔（毫秒）</span>
                <input
                  id="story-image-retry-delay"
                  v-model.number="activeProfile.retryDelayMs"
                  class="text_pole"
                  min="0"
                  step="100"
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
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { GiftImageReference } from './reference-image-memory';
import { fetchModelList, ModelListApiError } from './model-api';
import type { GiftImageTask } from './gift-image-cache';
import type { RecentGeneratedImage } from './recent-image-cache';
import type { StoryImageRuntime } from './runtime';
import type { GiftReferenceSlot, GiftSettings, ImageApiProfile } from './settings';
import { useStoryImageSettingsStore } from './settings';

const props = defineProps<{ runtime: StoryImageRuntime }>();
const { settings } = storeToRefs(useStoryImageSettingsStore());
const tabs = [
  { value: 'inline', label: '随文插图' },
  { value: 'gift', label: '礼物 CG' },
  { value: 'recent', label: '最近生成' },
  { value: 'settings', label: '设置' },
] as const;
type TabValue = (typeof tabs)[number]['value'];
const giftReferenceSlots: Array<{
  id: GiftReferenceSlot;
  label: string;
  description: string;
}> = [
  { id: 'character-1', label: '角色 1 参考图', description: '决定角色 1 的身份特征。' },
  { id: 'character-2', label: '角色 2 参考图', description: '决定角色 2 的身份特征。' },
  { id: 'template', label: '当前模板图', description: '决定动作、姿势、镜头和构图。' },
];
const giftPromptSections: Array<{
  key: keyof Pick<GiftSettings, 'identityPrompt' | 'templatePrompt' | 'scenePrompt' | 'stylePrompt' | 'outputPrompt'>;
  label: string;
  description: string;
}> = [
  { key: 'identityPrompt', label: '身份规则', description: '角色身份只来自角色参考图。' },
  { key: 'templatePrompt', label: '模板图规则', description: '模板图只提供动作和构图信息。' },
  { key: 'scenePrompt', label: '正文场景规则', description: '从当前聊天上下文读取剧情、服装、场景和氛围。' },
  { key: 'stylePrompt', label: '画风规则', description: '控制二次元重绘和礼物 CG 的视觉风格。' },
  { key: 'outputPrompt', label: '输出规则', description: '只输出一条安全的中文图生图提示词。' },
];
const activeTab = ref<TabValue>(settings.value.mode);
const activeProfile = computed<ImageApiProfile>(
  () =>
    settings.value.apiProfiles.find(profile => profile.id === settings.value.activeApiProfileId) ??
    settings.value.apiProfiles[0],
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

const runtimeStatus = computed(() => props.runtime.status.value);
const recentImages = computed(() => props.runtime.recentImages.value);
const giftTasks = computed(() => props.runtime.giftImages.value);
const giftReferences = computed(() => props.runtime.referenceImages.value);
const giftNameInputs = reactive<Record<GiftReferenceSlot, string>>({
  'character-1': '',
  'character-2': '',
  template: '',
});
const giftUrlInputs = reactive<Record<GiftReferenceSlot, string>>({
  'character-1': '',
  'character-2': '',
  template: '',
});
const hasAllGiftReferences = computed(() => giftReferences.value.length === 3);
const giftBusy = computed(() => giftTasks.value.some(task => task.status === 'pending' || task.status === 'running'));
const giftError = ref('');
const statusLabel = computed(() => {
  if (settings.value.mode === 'gift')
    return settings.value.gift.enabled ? '礼物 CG 图生图模块已就绪' : '礼物 CG 已关闭';
  if (!settings.value.enabled) return '已关闭';
  if (runtimeStatus.value === 'generating') return '正在生成，聊天正文不受阻塞';
  if (runtimeStatus.value === 'error') return '最近一次图片任务失败';
  if (runtimeStatus.value === 'ready') return '图片任务已完成或可恢复';
  if (runtimeStatus.value === 'stopped') return '脚本已卸载';
  return '等待 AI 回复';
});

function selectTab(tab: TabValue) {
  activeTab.value = tab;
  if (tab === 'inline' || tab === 'gift') settings.value.mode = tab;
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
    retryAttempts: 1,
    retryDelayMs: 1_500,
    extraBody: {},
  });
  settings.value.activeApiProfileId = id;
}

function deleteActiveProfile(): void {
  if (settings.value.apiProfiles.length <= 1) return;
  const deletedId = activeProfile.value.id;
  const deletedIndex = settings.value.apiProfiles.findIndex(profile => profile.id === deletedId);
  settings.value.apiProfiles.splice(deletedIndex, 1);
  modelCache.delete(deletedId);
  if (settings.value.activeApiProfileId === deletedId) {
    settings.value.activeApiProfileId = settings.value.apiProfiles[Math.max(0, deletedIndex - 1)].id;
  }
}

function referenceFor(slot: GiftReferenceSlot): GiftImageReference | undefined {
  return giftReferences.value.find(reference => reference.id === slot);
}

function referencePreview(reference: GiftImageReference | undefined): string {
  return reference?.dataUrl || reference?.url || '';
}

function openGiftFilePicker(slot: GiftReferenceSlot): void {
  document.getElementById(`story-image-gift-file-${slot}`)?.click();
}

function syncReferenceInputs(reference: GiftImageReference): void {
  giftNameInputs[reference.id] = reference.name;
  giftUrlInputs[reference.id] = reference.source === 'url' ? reference.url || '' : '';
}

async function onGiftFileChange(event: Event, slot: GiftReferenceSlot): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    giftError.value = '请选择图片文件。';
    input.value = '';
    return;
  }
  giftError.value = '';
  try {
    const reference = await props.runtime.setGiftReferenceFile(slot, file, giftNameInputs[slot]);
    syncReferenceInputs(reference);
  } catch (error) {
    giftError.value = error instanceof Error ? error.message : '参考图读取失败。';
  } finally {
    input.value = '';
  }
}

function setGiftReferenceUrl(slot: GiftReferenceSlot): void {
  const url = giftUrlInputs[slot].trim();
  if (!url) return;
  try {
    const reference = props.runtime.setGiftReferenceUrl(slot, url, giftNameInputs[slot]);
    syncReferenceInputs(reference);
    giftError.value = '';
  } catch (error) {
    giftError.value = error instanceof Error ? error.message : '参考图 URL 无效。';
  }
}

function renameGiftReference(slot: GiftReferenceSlot, event: Event): void {
  const input = event.target as HTMLInputElement;
  giftNameInputs[slot] = input.value;
  props.runtime.renameGiftReference(slot, input.value);
}

function removeGiftReference(slot: GiftReferenceSlot): void {
  props.runtime.removeGiftReference(slot);
  giftNameInputs[slot] = '';
  giftUrlInputs[slot] = '';
  giftError.value = '';
}

function generateGift(): void {
  giftError.value = '';
  if (!settings.value.gift.enabled) {
    giftError.value = '请先启用礼物 CG。';
    return;
  }
  if (!hasAllGiftReferences.value) {
    giftError.value = '请先准备角色 1、角色 2 和模板图。';
    return;
  }
  const task = props.runtime.generateGift(getLastMessageId());
  if (!task) giftError.value = '礼物 CG 任务未能启动，请检查参考图和 API 配置。';
}

function giftTaskStatus(status: GiftImageTask['status'], error: string | null): string {
  if (status === 'pending') return '等待生成…';
  if (status === 'running') return '正在生成…';
  if (status === 'cancelled') return '已取消';
  return error ? `生成失败：${error}` : '生成失败';
}

function downloadGiftImage(task: GiftImageTask): void {
  if (!task.image) return;
  const link = document.createElement('a');
  link.href = task.image.url;
  link.download = `gift-cg-${task.id}.png`;
  link.rel = 'noopener';
  link.click();
}

function clearGiftImages(): void {
  props.runtime.clearGiftImages();
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

function downloadRecentImage(image: RecentGeneratedImage): void {
  const link = document.createElement('a');
  link.href = image.url;
  link.download =
    image.source === '礼物 CG'
      ? `gift-cg-${image.giftTaskId || image.createdAt}.png`
      : `story-image-${image.messageId ?? 'unknown'}-${image.swipeId ?? 0}-${(image.imageIndex ?? 0) + 1}.png`;
  link.rel = 'noopener';
  link.click();
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

function applyExtraBody() {
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
