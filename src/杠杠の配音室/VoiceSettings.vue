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
                <option value="fish">Fish Audio</option>
              </select>
            </label>
            <label v-if="profile.type === 'openai-compatible'" class="ganggang-voice-field">
              <span>语音接口地址</span>
              <input v-model.trim="profile.endpoint" type="url" placeholder="https://…/audio/speech" />
            </label>
            <label v-if="profile.type !== 'edge'" class="ganggang-voice-field">
              <span>API Key</span>
              <input v-model="profile.apiKey" type="password" autocomplete="off" />
            </label>
            <p v-if="profile.type === 'doubao'" class="ganggang-voice-hint">
              豆包合成经酒馆自带的 /proxy 转发（浏览器跨域不放行新版 X-Api-Key 头）：请先在 config.yaml 打开
              enableCorsProxy 并重启酒馆。旧版 APP ID + Access Key 已弃用，只填新版 API Key。
            </p>
            <p v-if="profile.type === 'fish'" class="ganggang-voice-hint">
              Fish 合成经酒馆自带的 /proxy 转发：请先在 config.yaml 打开 enableCorsProxy 并重启酒馆。音色市场
              （GET /model）不需要该开关；模型留空时使用免费档 s2.1-pro-free。
            </p>
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
            <label v-if="profile.type === 'minimax'" class="ganggang-voice-field">
              <span>Group ID</span>
              <input v-model.trim="profile.groupId" type="text" autocomplete="off" placeholder="控制台 → 账户管理 → 基本信息" />
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
              <p class="ganggang-voice-hint">发送角色设定、用户 persona 设定、绑定世界书的启用条目、最近聊天和音色元数据，不发送任何 TTS 密钥。</p>
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
              <input :value="entry.displayName" type="text" @change="setEntryDisplayName(entry, $event)" />
            </label>
            <label class="ganggang-voice-field">
              <span>别名（顿号分隔）</span>
              <input :value="entry.aliases.join('、')" type="text" @change="setEntryAliases(entry, $event)" />
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
            <div class="ganggang-voice-actions">
              <button v-if="entry.role !== 'narrator'" class="menu_button" type="button" @click="promoteToNarrator(entry)">
                设为旁白
              </button>
              <button class="menu_button" type="button" @click="removeCastEntry(entry)">删除</button>
            </div>
          </div>
          <div class="ganggang-voice-actions">
            <button class="menu_button" type="button" @click="addCastEntry">新增角色</button>
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

      <template v-else-if="activeTab === 'audition'">
        <article class="ganggang-voice-card">
          <div class="ganggang-voice-grid">
            <label class="ganggang-voice-field">
              <span>引擎来源</span>
              <select v-model="auditionProfileId">
                <option v-for="profile in enabledProfiles" :key="profile.id" :value="profile.id">
                  {{ profile.name || profile.id }}
                </option>
              </select>
            </label>
            <label class="ganggang-voice-field">
              <span>音色（可手填 voiceId）</span>
              <input
                v-model.trim="auditionVoiceId"
                type="text"
                list="ganggang-voice-options"
                :placeholder="auditionProfile ? `留空则用默认音色 ${auditionProfile.defaultVoiceId || '（未设置）'}` : '留空则用默认音色'"
              />
            </label>
          </div>
          <p class="ganggang-voice-hint">
            已读取 {{ auditionProfile ? voicesFor(auditionProfile.id).length : 0 }} 个候选音色；不在列表里的 voiceId
            可直接手填。
          </p>

          <label class="ganggang-voice-field">
            <span>例句</span>
            <textarea v-model="auditionText" rows="3"></textarea>
          </label>

          <label v-if="auditionProfileType === 'xiaomi-mimo'" class="ganggang-voice-field">
            <span>导演台本（user 指令，可留空）</span>
            <textarea v-model="auditionInstruction" rows="3" placeholder="角色：… 场景：… 指导：…"></textarea>
          </label>
          <label v-else-if="auditionProfileType === 'doubao'" class="ganggang-voice-field">
            <span>导演指令 context_texts（可留空，不计费）</span>
            <input v-model.trim="auditionContextText" type="text" placeholder="用黏人撒娇的语气，尾音上扬…" />
          </label>
          <label v-else-if="auditionProfileType === 'minimax'" class="ganggang-voice-field">
            <span>情绪档位</span>
            <select v-model="auditionEmotion">
              <option value="">不指定</option>
              <option value="happy">happy · 开心</option>
              <option value="sad">sad · 难过</option>
              <option value="angry">angry · 生气</option>
              <option value="neutral">neutral · 平静</option>
            </select>
          </label>
          <p v-else-if="auditionProfileType === 'fish'" class="ganggang-voice-hint">
            Fish 用 FAS2 情绪标签：把 [happy]、[slight pause] 等直接写进例句即可。
          </p>
          <p v-else class="ganggang-voice-hint">当前来源没有原生情绪控制；情绪例句请换用小米/豆包/MiniMax/Fish。</p>

          <div class="ganggang-voice-actions">
            <button class="menu_button" type="button" :disabled="auditionBusy" @click="startAudition">
              {{ auditionBusy ? '合成中…' : '试听' }}
            </button>
            <span class="ganggang-voice-hint">样本会进入"最近 10 条"，可重播/下载。</span>
          </div>
        </article>

        <article class="ganggang-voice-card">
          <div class="ganggang-voice-card-header">
            <strong>测试连接</strong>
            <button
              class="menu_button"
              type="button"
              :disabled="providerBusy"
              @click="probeAllEnabledProfiles"
            >
              全部测试
            </button>
          </div>
          <p class="ganggang-voice-hint">
            对每个启用的来源真实合成一句"你好"，验证凭据与额度（消耗极少量额度）。
          </p>
          <div v-for="profile in enabledProfiles" :key="`probe-${profile.id}`" class="ganggang-voice-probe-row">
            <span :class="probeDotClass(profile.id)"></span>
            <strong>{{ profile.name || profile.id }}</strong>
            <button
              class="menu_button"
              type="button"
              :disabled="providerBusy"
              @click="runtime.probeAndLoadVoices(profile.id)"
            >
              {{ probeStateFor(profile.id) === 'busy' ? '测试中…' : '测试连接' }}
            </button>
            <span class="ganggang-voice-hint">{{ probeMessageFor(profile.id) || '未测试' }}</span>
          </div>
        </article>
      </template>

      <template v-else-if="activeTab === 'casting-room'">
        <article class="ganggang-voice-card">
          <div class="ganggang-voice-grid">
            <label class="ganggang-voice-field">
              <span>目标角色（配音表条目或新名）</span>
              <input
                v-model.trim="castingRoomRoleName"
                type="text"
                list="ganggang-casting-room-roles"
                placeholder="如：邹峥 / 叙述者"
              />
            </label>
            <datalist id="ganggang-casting-room-roles">
              <option v-for="roleName in castingRoomRoleOptions" :key="roleName" :value="roleName"></option>
            </datalist>
            <label class="ganggang-voice-field">
              <span>候选数量上限</span>
              <input v-model.number="castingRoomLimit" type="number" min="1" max="12" step="1" />
            </label>
          </div>
          <label class="ganggang-voice-field">
            <span>口味档案（AI 提名与例句生成都会参考）</span>
            <textarea v-model="castingRoomTasteNotes" rows="2"></textarea>
          </label>
          <div class="ganggang-voice-actions">
            <button
              class="menu_button"
              type="button"
              :disabled="castingRoomBusy"
              @click="startCastingRoom"
            >
              {{ castingRoomBusy ? 'AI 海选中…' : '开始 AI 海选' }}
            </button>
            <span class="ganggang-voice-hint">
              提名 ≤ {{ castingRoomLimit }} 个候选并逐个合成例句；小米/Fish 免费，豆包/MiniMax 按字符小额计费。
            </span>
          </div>
          <p v-if="castingRoomPhaseText" class="ganggang-voice-hint">{{ castingRoomPhaseText }}</p>
        </article>

        <article v-if="castingRoomCandidates.length" class="ganggang-voice-card">
          <div class="ganggang-voice-card-header">
            <strong>候选试音（例句：{{ runtime.castingRoom.exampleLine }}）</strong>
          </div>
          <div v-for="(candidate, index) in castingRoomCandidates" :key="`${candidate.providerProfileId}-${candidate.voiceId}`" class="ganggang-voice-grid">
            <label class="ganggang-voice-field">
              <span>#{{ index + 1 }} · {{ profileName(candidate.providerProfileId) }}</span>
              <input :value="candidate.voiceId" type="text" readonly />
            </label>
            <label class="ganggang-voice-field">
              <span>提名理由</span>
              <input :value="candidate.reason" type="text" readonly />
            </label>
            <div class="ganggang-voice-actions">
              <button
                class="menu_button"
                type="button"
                :disabled="candidate.status !== 'ready'"
                @click="playCastingRoomSample(candidate)"
              >
                试听
              </button>
              <button
                class="menu_button"
                type="button"
                :disabled="candidate.status !== 'ready' || castingRoomBusy"
                @click="pinCastingRoomChoice(candidate)"
              >
                定角
              </button>
              <span class="ganggang-voice-hint">{{ candidateStatusText(candidate) }}</span>
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
import { computed, ref, watch } from 'vue';
import { createManualCastEntry, findCastingEntryError, parseAliasInput } from './casting';
import type { CastingRoomCandidateView, VoiceRuntime } from './runtime';
import type { CastEntry, CastRole, RecentVoiceStatus, VoiceOption } from './types';

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
  { value: 'casting-room', label: '选角间' },
  { value: 'audition', label: '试音台' },
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

function currentCastingEntries(): CastEntry[] | null {
  const table = currentCasting.value;
  return table ? table.entries : null;
}

function applyCastingEntries(next: CastEntry[]): boolean {
  const table = currentCasting.value;
  if (!table) return false;
  const problem = findCastingEntryError(next);
  if (problem) {
    error.value = problem;
    return false;
  }
  table.entries = next;
  error.value = '';
  return true;
}

function setEntryDisplayName(entry: CastEntry, event: Event): void {
  const input = event.target as HTMLInputElement;
  const next = input.value.trim();
  if (next === entry.displayName) {
    input.value = entry.displayName;
    return;
  }
  const previous = entry.displayName;
  entry.displayName = next;
  const entries = currentCastingEntries();
  if (!entries || !applyCastingEntries(entries)) {
    entry.displayName = previous;
    input.value = previous;
  }
}

function setEntryAliases(entry: CastEntry, event: Event): void {
  const input = event.target as HTMLInputElement;
  const next = parseAliasInput(input.value);
  if (next.join('、') === entry.aliases.join('、')) {
    input.value = entry.aliases.join('、');
    return;
  }
  const previous = entry.aliases;
  entry.aliases = next;
  const entries = currentCastingEntries();
  if (!entries || !applyCastingEntries(entries)) {
    entry.aliases = previous;
    input.value = previous.join('、');
  }
}

function removeCastEntry(entry: CastEntry): void {
  if (entry.role === 'narrator') {
    error.value = '旁白是配音表必需身份，不能删除。';
    return;
  }
  const entries = currentCastingEntries();
  if (!entries) return;
  if (entries.length <= 1) {
    error.value = '配音表至少需要保留一项音色映射。';
    return;
  }
  applyCastingEntries(entries.filter(item => item.id !== entry.id));
}

function promoteToNarrator(entry: CastEntry): void {
  const entries = currentCastingEntries();
  if (!entries || entry.role === 'narrator') return;
  const next = entries.map(item => {
    if (item.id === entry.id) return { ...item, role: 'narrator' as const };
    if (item.role === 'narrator') return { ...item, role: 'character' as const };
    return item;
  });
  applyCastingEntries(next);
}

function addCastEntry(): void {
  const entries = currentCastingEntries();
  if (!entries) return;
  const profile = enabledProfiles.value[0];
  const voice = profile ? voicesFor(profile.id)[0] : null;
  if (!profile || !voice) {
    error.value = '请先在 TTS 来源里启用来源并读取至少一个音色。';
    return;
  }
  const taken = new Set(
    entries.flatMap(item => [item.displayName, ...item.aliases].map(name => name.trim().toLowerCase())),
  );
  let ordinal = entries.length + 1;
  while (taken.has(`角色${ordinal}`.toLowerCase())) ordinal += 1;
  const entry = createManualCastEntry('character', { providerProfileId: profile.id, voiceId: voice.voiceId }, ordinal - 1);
  entry.displayName = `角色${ordinal}`;
  applyCastingEntries([...entries, entry]);
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

const DEFAULT_AUDITION_TEXT =
  '你还在生气吗……我错啦，真的。晚上请你吃火锅，好不好嘛？我还给你带了那家的栗子，就是……在路上被压扁了几个。';
const castingRoomRoleName = ref('');
const castingRoomLimit = ref(8);
const castingRoomTasteNotes = ref(runtime.settings.value.tasteProfile.styleNotes);
const castingRoomCandidates = computed(() => runtime.castingRoom.value.candidates);
const castingRoomPhaseText = computed(() => {
  const room = runtime.castingRoom.value;
  if (room.phase === 'idle') return '';
  if (room.phase === 'nominating') return 'AI 正在阅读人设与音色目录，提名候选并生成例句…';
  if (room.phase === 'synthesizing') return `批量出样中（${room.progress.done}/${room.progress.total}）…`;
  if (room.phase === 'failed') return '本轮海选没有可用样本，请查看错误提示后重试。';
  if (room.phase === 'done') return `海选完成：${room.progress.total} 个候选已出样，试听后点"定角"。`;
  return '';
});
const castingRoomRoleOptions = computed(() => {
  const names = new Set<string>();
  for (const table of Object.values(runtime.settings.value.castingByCharacter)) {
    for (const entry of table.entries) {
      if (entry.displayName.trim()) names.add(entry.displayName.trim());
    }
  }
  if (runtime.currentCharacterName.value.trim()) names.add(runtime.currentCharacterName.value.trim());
  return [...names];
});

function startCastingRoom(): void {
  const roleName = castingRoomRoleName.value.trim() || runtime.currentCharacterName.value.trim();
  if (!roleName) {
    return;
  }
  castingRoomRoleName.value = roleName;
  runtime.settings.value.tasteProfile.styleNotes = castingRoomTasteNotes.value.trim();
  void runtime.generateCastingCandidates(roleName, castingRoomLimit.value);
}

function playCastingRoomSample(candidate: { recentItemId?: string }): void {
  if (candidate.recentItemId) {
    void runtime.playRecent(candidate.recentItemId);
  }
}

function pinCastingRoomChoice(candidate: CastingRoomCandidateView): void {
  runtime.pinCastingChoice(candidate);
}

function candidateStatusText(candidate: { status: string; error?: string }): string {
  if (candidate.status === 'ready') return '可试听';
  if (candidate.status === 'synthesizing') return '合成中…';
  if (candidate.status === 'pending') return '排队中';
  return candidate.error || '合成失败';
}
const auditionProfileId = ref('');
const auditionVoiceId = ref('');
const auditionText = ref(DEFAULT_AUDITION_TEXT);
const auditionInstruction = ref('');
const auditionContextText = ref('');
const auditionEmotion = ref('');
const auditionProfile = computed(() => {
  const list = enabledProfiles.value;
  return list.find(profile => profile.id === auditionProfileId.value) ?? list[0] ?? null;
});
const auditionProfileType = computed(() => auditionProfile.value?.type ?? '');

watch(
  () => enabledProfiles.value.map(profile => profile.id).join('\u0000'),
  () => {
    if (!enabledProfiles.value.some(profile => profile.id === auditionProfileId.value)) {
      auditionProfileId.value = enabledProfiles.value[0]?.id ?? '';
    }
  },
  { immediate: true },
);

// 切换引擎时清空手填音色——上一家的 voiceId 对新引擎无效（会 400）
watch(auditionProfileId, () => {
  auditionVoiceId.value = '';
});

function probeStateFor(profileId: string): string {
  return runtime.providerProbeStatus.value[profileId]?.state ?? 'idle';
}

const PROBE_DOT_CLASSES: Record<string, string> = {
  idle: 'ganggang-voice-probe-dot',
  busy: 'ganggang-voice-probe-dot is-busy',
  ok: 'ganggang-voice-probe-dot is-ok',
  fail: 'ganggang-voice-probe-dot is-fail',
};

function probeDotClass(profileId: string): string {
  return PROBE_DOT_CLASSES[probeStateFor(profileId)] ?? PROBE_DOT_CLASSES.idle;
}

function probeMessageFor(profileId: string): string {
  return runtime.providerProbeStatus.value[profileId]?.message ?? '';
}

async function probeAllEnabledProfiles(): Promise<void> {
  // probeAndLoadVoices 是单飞设计（新探测会废止旧探测），必须顺序执行。
  for (const profile of enabledProfiles.value) {
    await runtime.probeAndLoadVoices(profile.id);
  }
}

async function startAudition(): Promise<void> {
  const profile = auditionProfile.value;
  if (!profile) {
    return;
  }
  await runtime.synthesizeAudition(profile.id, auditionVoiceId.value, auditionText.value, {
    instruction: auditionInstruction.value.trim() || undefined,
    contextText: auditionContextText.value.trim() || undefined,
    emotion: auditionEmotion.value || undefined,
  });
}
</script>
