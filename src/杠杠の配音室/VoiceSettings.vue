<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <section class="ganggang-voice-panel" data-testid="ganggang-voice-panel">
    <header class="ganggang-voice-header">
      <div>
        <h3 class="ganggang-voice-title">杠杠の配音室</h3>
        <p class="ganggang-voice-subtitle">配好一次，让 AI 认人选声；语音只留在当前页面。</p>
      </div>
      <button
        class="menu_button"
        data-testid="ganggang-voice-stop"
        type="button"
        title="停止当前声音"
        @click="runtime.stopAll"
      >
        停止
      </button>
    </header>

    <nav class="ganggang-voice-tabs" aria-label="配音室功能">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="ganggang-voice-tab"
        :class="{ 'is-active': activeTab === tab.value }"
        :data-testid="`ganggang-voice-tab-${tab.value}`"
        type="button"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="ganggang-voice-content">
      <p v-if="status" class="ganggang-voice-status">{{ status }}</p>
      <p v-if="error" class="ganggang-voice-status is-error">{{ error }}</p>

      <template v-if="activeTab === 'sources'">
        <div class="ganggang-voice-actions">
          <button class="menu_button" type="button" @click="runtime.addProfile('openai-compatible')">新增来源</button>
          <span class="ganggang-voice-hint">API Key 会保存到本脚本变量；不会发给配音表 AI。</span>
        </div>

        <article v-for="profile in settings.profiles" :key="profile.id" class="ganggang-voice-card">
          <div class="ganggang-voice-card-header">
            <label class="checkbox_label">
              <input v-model="profile.enabled" type="checkbox" />
              <span>{{ profile.name || '未命名来源' }}</span>
            </label>
            <button class="menu_button" type="button" @click="runtime.removeProfile(profile.id)">删除</button>
          </div>

          <div class="ganggang-voice-grid">
            <label class="ganggang-voice-field">
              <span>名称</span>
              <input v-model.trim="profile.name" type="text" />
            </label>
            <label class="ganggang-voice-field">
              <span>TTS 来源</span>
              <select v-model="profile.type">
                <option value="edge">Edge TTS 插件</option>
                <option value="openai-compatible">OpenAI 兼容</option>
                <option value="doubao">豆包</option>
                <option value="minimax">MiniMax</option>
                <option value="xiaomi-mimo">小米 MiMo</option>
              </select>
            </label>
            <label v-if="profile.type === 'openai-compatible'" class="ganggang-voice-field">
              <span>语音接口地址</span>
              <input v-model.trim="profile.endpoint" type="url" placeholder="https://…/audio/speech" />
            </label>
            <label v-if="profile.type !== 'edge'" class="ganggang-voice-field">
              <span>{{ profile.type === 'doubao' ? 'API Key（新版）' : 'API Key' }}</span>
              <input v-model="profile.apiKey" type="password" autocomplete="off" />
            </label>
            <p v-if="profile.type === 'doubao'" class="ganggang-voice-hint">
              新版控制台只填 API Key；旧版请留空 API Key，再填写 APP ID 和 Access Key。请求由 SillyTavern
              同源桥接转发，连接测试只验证桥接能力，不会联网校验凭据。
            </p>
            <label v-if="profile.type === 'doubao'" class="ganggang-voice-field">
              <span>APP ID（旧版）</span>
              <input v-model.trim="profile.appId" type="text" autocomplete="off" />
            </label>
            <label v-if="profile.type === 'doubao'" class="ganggang-voice-field">
              <span>Access Key（旧版）</span>
              <input v-model="profile.accessKey" type="password" autocomplete="off" />
            </label>
            <label v-if="profile.type === 'doubao'" class="ganggang-voice-field">
              <span>Resource ID</span>
              <input v-model.trim="profile.resourceId" type="text" placeholder="seed-tts-2.0" />
            </label>
            <label v-if="profile.type === 'minimax'" class="ganggang-voice-field">
              <span>平台</span>
              <select v-model="profile.platform">
                <option value="cn">中国大陆</option>
                <option value="io">国际站</option>
              </select>
            </label>
            <label v-if="profile.type !== 'edge' && profile.type !== 'doubao'" class="ganggang-voice-field">
              <span>模型</span>
              <input v-model.trim="profile.model" type="text" />
            </label>
            <label class="ganggang-voice-field">
              <span>默认音色 ID</span>
              <input v-model.trim="profile.defaultVoiceId" type="text" list="ganggang-voice-options" />
            </label>
            <label v-if="profile.type === 'edge'" class="ganggang-voice-field">
              <span>合成语速</span>
              <input v-model.number="profile.edgeRate" type="number" min="-100" max="100" step="5" />
            </label>
          </div>

          <div class="ganggang-voice-actions">
            <button
              class="menu_button"
              type="button"
              :disabled="providerBusy"
              @click="runtime.probeAndLoadVoices(profile.id)"
            >
              {{ providerBusy ? '读取中…' : '检查并读取音色' }}
            </button>
            <span class="ganggang-voice-hint">已读取 {{ voicesFor(profile.id).length }} 个音色</span>
          </div>
        </article>
        <datalist id="ganggang-voice-options">
          <option v-for="voice in voices" :key="`${voice.providerProfileId}:${voice.voiceId}`" :value="voice.voiceId">
            {{ voice.name }}
          </option>
        </datalist>
      </template>

      <template v-else-if="activeTab === 'casting'">
        <article class="ganggang-voice-card">
          <div class="ganggang-voice-card-header">
            <div>
              <strong>{{ currentCharacterName || '当前角色卡' }}</strong>
              <p class="ganggang-voice-hint">只发送角色设定、最近聊天和音色元数据，不发送任何 TTS 密钥。</p>
            </div>
            <button class="menu_button" type="button" :disabled="castingBusy" @click="runtime.generateCasting">
              {{ castingBusy ? 'AI 正在选声…' : '一键 AI 配音' }}
            </button>
          </div>
        </article>

        <article v-if="currentCasting" class="ganggang-voice-card">
          <div v-for="entry in currentCasting.entries" :key="entry.id" class="ganggang-voice-grid">
            <label class="ganggang-voice-field">
              <span>{{ roleLabel(entry.role) }}</span>
              <input v-model.trim="entry.displayName" type="text" />
            </label>
            <label class="ganggang-voice-field">
              <span>来源</span>
              <select v-model="entry.voice.providerProfileId">
                <option v-for="profile in enabledProfiles" :key="profile.id" :value="profile.id">
                  {{ profile.name }}
                </option>
              </select>
            </label>
            <label class="ganggang-voice-field">
              <span>音色</span>
              <select v-model="entry.voice.voiceId">
                <option
                  v-for="voice in voicesFor(entry.voice.providerProfileId)"
                  :key="voice.voiceId"
                  :value="voice.voiceId"
                >
                  {{ voice.name }}（{{ voice.voiceId }}）
                </option>
              </select>
            </label>
            <p v-if="entry.reason" class="ganggang-voice-hint">{{ entry.reason }}</p>
          </div>
        </article>
        <p v-else class="ganggang-voice-hint">还没有本角色卡的配音表。先读取音色，再点“一键 AI 配音”。</p>
      </template>

      <template v-else-if="activeTab === 'reading'">
        <article class="ganggang-voice-card">
          <div class="ganggang-voice-grid">
            <label class="ganggang-voice-field">
              <span>朗读方式</span>
              <select v-model="settings.readingDefaults.mode">
                <option value="full">旁白 + 对白</option>
                <option value="dialogue-only">只读对白</option>
                <option value="single-voice">全文单音色</option>
                <option value="selected-text">只读选中文本</option>
                <option value="character-only">只读指定角色</option>
              </select>
            </label>
            <label v-if="settings.readingDefaults.mode === 'character-only'" class="ganggang-voice-field">
              <span>角色名</span>
              <input v-model.trim="settings.readingDefaults.characterName" type="text" />
            </label>
            <label v-if="settings.readingDefaults.mode === 'single-voice'" class="ganggang-voice-field">
              <span>单音色</span>
              <select :value="singleVoiceKey" @change="setSingleVoice">
                <option value="">请选择</option>
                <option v-for="voice in voices" :key="voiceKey(voice)" :value="voiceKey(voice)">
                  {{ voice.name }} · {{ profileName(voice.providerProfileId) }}
                </option>
              </select>
            </label>
          </div>
          <label class="checkbox_label">
            <input
              v-model="settings.readingDefaults.includeSoundEffects"
              data-testid="ganggang-voice-include-sfx"
              type="checkbox"
            />
            <span>启用原文小喇叭；已规划的短音效会依次插入整段朗读</span>
          </label>
          <div class="ganggang-voice-actions">
            <button
              class="menu_button"
              data-testid="ganggang-voice-read-latest"
              type="button"
              @click="runtime.readLatest"
            >
              朗读最新消息
            </button>
            <button class="menu_button" type="button" @click="runtime.readSelection">朗读当前选区</button>
            <button
              class="menu_button"
              data-testid="ganggang-voice-plan-latest-sfx"
              type="button"
              :disabled="!settings.readingDefaults.includeSoundEffects || soundCatalogBusy"
              @click="runtime.planLatestSoundEffects"
            >
              AI 配最新音效
            </button>
            <button class="menu_button" type="button" @click="runtime.refreshInlineControls">刷新原文小喇叭</button>
          </div>
        </article>

        <article v-if="builtinSoundCatalogPresentation" class="ganggang-voice-card">
          <div class="ganggang-voice-card-header">
            <strong>{{ builtinSoundCatalogPresentation.title }}</strong>
            <button
              class="menu_button"
              data-testid="ganggang-voice-load-sound-catalog"
              type="button"
              :disabled="soundCatalogBusy"
              @click="runtime.loadSoundCatalog"
            >
              {{
                soundCatalogBusy
                  ? builtinSoundCatalogPresentation.loadingLabel
                  : builtinSoundCatalogPresentation.loadLabel
              }}
            </button>
          </div>
          <p class="ganggang-voice-hint">
            页面内存目录：{{ soundCatalogCount }} 条（短音效 {{ soundCatalogSfxCount }} / 环境音
            {{ soundCatalogAmbienceCount }}）；版本 {{ soundCatalogRevisionLabel }}。刷新后目录会重新读取。
          </p>
          <p v-for="hint in builtinSoundCatalogPresentation.hints" :key="hint" class="ganggang-voice-hint">
            {{ hint }}
          </p>
        </article>

        <article class="ganggang-voice-card">
          <div class="ganggang-voice-card-header">
            <strong>{{ runtime.edition.id === 'custom-only' ? '自定义音效' : '自定义音效（可选）' }}</strong>
            <button class="menu_button" type="button" @click="runtime.addSoundEffect">新增音效</button>
          </div>
          <div v-for="effect in settings.soundEffects" :key="effect.id" class="ganggang-voice-grid">
            <label class="checkbox_label">
              <input v-model="effect.enabled" type="checkbox" />
              <span>启用这个音效</span>
            </label>
            <label class="ganggang-voice-field">
              <span>名称</span>
              <input v-model.trim="effect.name" type="text" />
            </label>
            <label class="ganggang-voice-field">
              <span>播放种类</span>
              <select v-model="effect.kind">
                <option value="sfx">短音效（可进入整段朗读）</option>
                <option value="ambience">环境音（独立播放）</option>
              </select>
            </label>
            <label class="ganggang-voice-field">
              <span>分类</span>
              <input v-model.trim="effect.category" type="text" placeholder="门 / 脚步 / 环境" />
            </label>
            <label class="ganggang-voice-field">
              <span>音频 URL</span>
              <input v-model.trim="effect.url" type="url" />
            </label>
            <label class="ganggang-voice-field">
              <span>给 AI 的说明</span>
              <textarea v-model.trim="effect.description" rows="2" placeholder="例如：木门缓慢推开的吱呀声"></textarea>
            </label>
            <label class="ganggang-voice-field">
              <span>试听音量</span>
              <input v-model.number="effect.volume" type="range" min="0" max="1" step="0.05" />
            </label>
            <div class="ganggang-voice-actions">
              <button class="menu_button" type="button" @click="runtime.playSoundEffect(effect.id)">试听</button>
              <button class="menu_button" type="button" @click="runtime.removeSoundEffect(effect.id)">删除</button>
            </div>
          </div>
        </article>
      </template>

      <template v-else>
        <div class="ganggang-voice-card-header">
          <span class="ganggang-voice-hint">最多 10 条；刷新网页即清空。</span>
          <button class="menu_button" type="button" @click="runtime.clearRecent">清空</button>
        </div>
        <ul class="ganggang-voice-list">
          <li v-for="item in recentVoices" :key="item.id" class="ganggang-voice-card ganggang-voice-recent">
            <div>
              <div class="ganggang-voice-preview">{{ item.characterName || '旁白' }} · {{ item.textPreview }}</div>
              <small class="ganggang-voice-hint">{{ recentStatus(item.status) }}</small>
            </div>
            <div class="ganggang-voice-actions">
              <button
                class="menu_button"
                type="button"
                :disabled="!item.objectUrl"
                @click="runtime.playRecent(item.id)"
              >
                {{ item.status === 'playing' ? '暂停' : '播放' }}
              </button>
              <button class="menu_button" type="button" @click="runtime.regenerateRecent(item.id)">重做</button>
              <button class="menu_button" type="button" :disabled="!item.blob" @click="runtime.downloadRecent(item.id)">
                下载
              </button>
              <button class="menu_button" type="button" @click="runtime.removeRecent(item.id)">删除</button>
            </div>
          </li>
        </ul>
        <p v-if="recentVoices.length === 0" class="ganggang-voice-hint">这一页还没有生成语音。</p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { VoiceRuntime } from './runtime';
import type { CastRole, RecentVoiceStatus, VoiceOption } from './types';

const props = defineProps<{ runtime: VoiceRuntime }>();
const runtime = props.runtime;
const settings = runtime.settings;
const voices = runtime.voices;
const recentVoices = runtime.recentVoices;
const status = runtime.status;
const error = runtime.error;
const providerBusy = runtime.providerBusy;
const castingBusy = runtime.castingBusy;
const soundCatalogBusy = runtime.soundCatalogBusy;
const soundCatalogCount = runtime.soundCatalogCount;
const soundCatalogSfxCount = runtime.soundCatalogSfxCount;
const soundCatalogAmbienceCount = runtime.soundCatalogAmbienceCount;
const soundCatalogRevision = runtime.soundCatalogRevision;
const builtinSoundCatalogPresentation = runtime.builtinSoundCatalogPresentation;
const currentCharacterName = runtime.currentCharacterName;
const tabs = [
  { value: 'sources', label: 'TTS 来源' },
  { value: 'casting', label: 'AI 配音表' },
  { value: 'reading', label: '朗读方式' },
  { value: 'recent', label: '最近 10 条' },
] as const;
type TabValue = (typeof tabs)[number]['value'];
const activeTab = ref<TabValue>('sources');
const enabledProfiles = computed(() => settings.value.profiles.filter(profile => profile.enabled));
const currentCasting = computed(() => settings.value.castingByCharacter[runtime.currentCharacterKey.value] ?? null);
const singleVoiceKey = computed(() => {
  const voice = settings.value.readingDefaults.singleVoice;
  return voice ? `${voice.providerProfileId}\u0000${voice.voiceId}` : '';
});
const soundCatalogRevisionLabel = computed(() => soundCatalogRevision.value.slice(0, 8) || '尚未读取');

function voicesFor(profileId: string): VoiceOption[] {
  return voices.value.filter(voice => voice.providerProfileId === profileId);
}

function voiceKey(voice: VoiceOption): string {
  return `${voice.providerProfileId}\u0000${voice.voiceId}`;
}

function setSingleVoice(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) {
    settings.value.readingDefaults.singleVoice = null;
    return;
  }
  const [providerProfileId, voiceId] = value.split('\u0000');
  settings.value.readingDefaults.singleVoice = { providerProfileId, voiceId };
}

function profileName(profileId: string): string {
  return settings.value.profiles.find(profile => profile.id === profileId)?.name ?? profileId;
}

function roleLabel(role: CastRole): string {
  if (role === 'narrator') return '旁白';
  if (role === 'fallback') return '其他角色';
  return '角色';
}

function recentStatus(value: RecentVoiceStatus): string {
  const labels: Record<RecentVoiceStatus, string> = {
    generating: '生成中',
    ready: '可以播放',
    playing: '正在播放',
    paused: '已暂停',
    failed: '生成失败',
    cancelled: '已取消',
  };
  return labels[value];
}
</script>
