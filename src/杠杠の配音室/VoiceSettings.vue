<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <section class="ganggang-voice-panel" data-testid="ganggang-voice-panel">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>杠杠の配音室 v{{ VOICE_CONSOLE_VERSION }}</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>

      <div class="inline-drawer-content">
        <div class="ganggang-voice-tabbar">
          <nav class="ganggang-voice-tabs" role="tablist" aria-label="配音室功能">
            <button
              v-for="tab in tabs"
              :key="tab.value"
              class="ganggang-voice-tab"
              :class="{ 'is-active': activeTab === tab.value }"
              :data-testid="`ganggang-voice-tab-${tab.value}`"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.value"
              @click="activeTab = tab.value"
            >
              {{ tab.label }}
            </button>
          </nav>
        </div>

        <div class="ganggang-voice-content">
          <p v-if="error" class="ganggang-voice-status is-error">{{ error }}</p>

          <template v-if="activeTab === 'sources'">
            <div class="ganggang-voice-toolbar">
              <select id="ganggang-voice-profile-select" v-model="selectedProfileId" class="text_pole" aria-label="TTS 来源">
                <option v-for="profile in settings.profiles" :key="profile.id" :value="profile.id">
                  {{ profile.name || '未命名来源' }}
                </option>
              </select>
              <div class="ganggang-voice-actions">
                <button class="menu_button fa-solid fa-plus ganggang-voice-icon-action" type="button" title="新建来源" @click="addSourceProfile"></button>
                <button class="menu_button fa-solid fa-check ganggang-voice-icon-action" type="button" title="保存来源" @click="saveSourceProfile"></button>
                <button class="menu_button fa-solid fa-trash-can ganggang-voice-icon-action" type="button" title="删除来源" @click="removeSourceProfile"></button>
              </div>
            </div>

            <section v-if="selectedProfile" class="ganggang-voice-section">
              <label class="ganggang-voice-enable-row">
                <input v-model="selectedProfile.enabled" type="checkbox" />
                <span>启用这个来源</span>
              </label>

              <div class="ganggang-voice-grid">
                <label class="ganggang-voice-field">
                  <span>名称</span>
                  <input v-model.trim="selectedProfile.name" class="text_pole" type="text" />
                </label>
                <label class="ganggang-voice-field">
                  <span>TTS 来源</span>
                  <select v-model="selectedProfile.type" class="text_pole">
                    <option value="edge">Edge TTS 插件</option>
                    <option value="openai-compatible">OpenAI 兼容</option>
                    <option value="doubao">豆包</option>
                    <option value="minimax">MiniMax</option>
                    <option value="xiaomi-mimo">小米 MiMo</option>
                    <option value="fish">Fish Audio</option>
                  </select>
                </label>
                <label v-if="selectedProfile.type === 'openai-compatible'" class="ganggang-voice-field">
                  <span>语音接口地址</span>
                  <input v-model.trim="selectedProfile.endpoint" class="text_pole" type="url" placeholder="https://…/audio/speech" />
                </label>
                <label v-if="selectedProfile.type !== 'edge'" class="ganggang-voice-field">
                  <span>API Key</span>
                  <input v-model="selectedProfile.apiKey" class="text_pole" type="password" autocomplete="off" />
                </label>
                <label v-if="selectedProfile.type === 'doubao'" class="ganggang-voice-field">
                  <span>Resource ID</span>
                  <input v-model.trim="selectedProfile.resourceId" class="text_pole" type="text" placeholder="seed-tts-2.0" />
                </label>
                <label v-if="selectedProfile.type === 'minimax'" class="ganggang-voice-field">
                  <span>平台</span>
                  <select v-model="selectedProfile.platform" class="text_pole">
                    <option value="cn">中国大陆</option>
                    <option value="io">国际站</option>
                  </select>
                </label>
                <label v-if="selectedProfile.type === 'minimax'" class="ganggang-voice-field">
                  <span>Group ID</span>
                  <input v-model.trim="selectedProfile.groupId" class="text_pole" type="text" autocomplete="off" placeholder="控制台 → 账户管理 → 基本信息" />
                </label>
                <label v-if="selectedProfile.type !== 'edge' && selectedProfile.type !== 'doubao'" class="ganggang-voice-field">
                  <span>模型</span>
                  <input v-model.trim="selectedProfile.model" class="text_pole" type="text" />
                </label>
                <label class="ganggang-voice-field">
                  <span>默认音色 ID</span>
                  <input v-model.trim="selectedProfile.defaultVoiceId" class="text_pole" type="text" list="ganggang-voice-options" />
                </label>
                <label v-if="selectedProfile.type === 'edge'" class="ganggang-voice-field">
                  <span>合成语速</span>
                  <input v-model.number="selectedProfile.edgeRate" class="text_pole" type="number" min="-100" max="100" step="5" />
                </label>
              </div>

              <div class="ganggang-voice-actions">
                <button
                  class="menu_button ganggang-voice-icon-action"
                  :class="providerBusy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-satellite-dish'"
                  type="button"
                  :disabled="providerBusy"
                  title="检查并读取音色"
                  @click="runtime.probeAndLoadVoices(selectedProfile.id)"
                ></button>
                <span :class="probeDotClass(selectedProfile.id)"></span>
                <span class="ganggang-voice-hint">
                  {{ probeMessageFor(selectedProfile.id) || `已读取 ${voicesFor(selectedProfile.id).length} 个音色` }}
                </span>
              </div>
            </section>
            <p v-else class="ganggang-voice-hint">还没有 TTS 来源，点上面的「＋」新建一个。</p>
            <datalist id="ganggang-voice-options">
              <option v-for="voice in voices" :key="`${voice.providerProfileId}:${voice.voiceId}`" :value="voice.voiceId">
                {{ voice.name }}
              </option>
            </datalist>
          </template>

          <template v-else-if="activeTab === 'casting'">
            <section class="ganggang-voice-section">
              <div class="ganggang-voice-section-head ganggang-voice-section-head--title">
                <h4 class="ganggang-voice-section-title">配音表</h4>
                <button
                  class="menu_button ganggang-voice-icon-action"
                  :class="castingBusy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate'"
                  type="button"
                  title="一键 AI 配音：重新给全部角色分配音色"
                  aria-label="一键 AI 配音"
                  :disabled="castingBusy"
                  @click="runtime.generateCasting"
                ></button>
                <button
                  class="menu_button ganggang-voice-icon-action fa-solid fa-user-plus"
                  type="button"
                  title="新增角色"
                  @click="addCastEntry"
                ></button>
              </div>
              <template v-if="currentCasting">
                <details v-for="entry in currentCasting.entries" :key="entry.id" class="ganggang-voice-entry">
                <summary class="ganggang-voice-entry-head">
                  <span class="ganggang-voice-entry-name">{{ roleLabel(entry.role) }} · {{ entry.displayName }}</span>
                  <span class="ganggang-voice-entry-voice">{{ voiceLabelFor(entry) }}</span>
                </summary>
                <div class="ganggang-voice-grid">
                  <label class="ganggang-voice-field">
                    <span>名称</span>
                    <input class="text_pole" :value="entry.displayName" type="text" @change="setEntryDisplayName(entry, $event)" />
                  </label>
                  <label class="ganggang-voice-field">
                    <span>别名（顿号分隔）</span>
                    <input class="text_pole" :value="entry.aliases.join('、')" type="text" @change="setEntryAliases(entry, $event)" />
                  </label>
                  <label class="ganggang-voice-field">
                    <span>来源</span>
                    <select v-model="entry.voice.providerProfileId" class="text_pole">
                      <option v-for="profile in enabledProfiles" :key="profile.id" :value="profile.id">
                        {{ profile.name }}
                      </option>
                    </select>
                  </label>
                  <label class="ganggang-voice-field">
                    <span>音色</span>
                    <select v-model="entry.voice.voiceId" class="text_pole">
                      <option
                        v-for="voice in voicesFor(entry.voice.providerProfileId)"
                        :key="voice.voiceId"
                        :value="voice.voiceId"
                      >
                        {{ voice.name }}（{{ voice.voiceId }}）
                      </option>
                    </select>
                  </label>
                </div>
                <p v-if="entry.reason" class="ganggang-voice-hint">{{ entry.reason }}</p>
                <div class="ganggang-voice-actions">
                  <button class="menu_button ganggang-voice-primary fa-solid fa-headphones ganggang-voice-icon-action" type="button" title="精选这个角色" @click="focusCastingEntry(entry)"></button>
                  <button v-if="entry.role !== 'narrator'" class="menu_button fa-solid fa-quote-left ganggang-voice-icon-action" type="button" title="设为旁白" @click="promoteToNarrator(entry)"></button>
                  <button class="menu_button fa-solid fa-trash-can ganggang-voice-icon-action" type="button" title="删除" @click="removeCastEntry(entry)"></button>
                </div>
              </details>
              </template>
              <p v-else class="ganggang-voice-hint">还没有配音表，点右边的图标生成。</p>
            </section>
          </template>

          <template v-else-if="activeTab === 'studio'">
            <section class="ganggang-voice-section">
              <div class="ganggang-voice-grid">
                <label class="ganggang-voice-field">
                  <span>目标角色</span>
                  <input
                    v-model.trim="castingRoomRoleName"
                    class="text_pole"
                    type="text"
                    list="ganggang-casting-room-roles"
                    placeholder="如：邹峥 / 旁白"
                  />
                </label>
                <datalist id="ganggang-casting-room-roles">
                  <option v-for="roleName in castingRoomRoleOptions" :key="roleName" :value="roleName"></option>
                </datalist>
                <label class="ganggang-voice-field">
                  <span>候选数量</span>
                  <input v-model.number="settings.castingRoomCandidateCount" class="text_pole" type="number" min="1" max="10" step="1" />
                </label>
              </div>
              <div class="ganggang-voice-field">
                <div class="ganggang-voice-field-head">
                  <span>口味档案</span>
                  <button
                    class="menu_button ganggang-voice-primary ganggang-voice-icon-action"
                    :class="castingRoomBusy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles'"
                    type="button"
                    :disabled="castingRoomBusy"
                    title="开始 AI 海选"
                    @click="startCastingRoom"
                  ></button>
                </div>
                <textarea
                  v-model="castingRoomTasteNotes"
                  class="text_pole"
                  rows="2"
                  placeholder="如：干净、温和、低唤起；拒绝拖长音与播音腔。"
                ></textarea>
              </div>
              <p v-if="castingRoomPhaseText" class="ganggang-voice-hint">{{ castingRoomPhaseText }}</p>
            </section>

            <p v-if="!castingRoomBusy && castingRoomCandidates.length === 0" class="ganggang-voice-empty">
              填角色 → 开始 AI 海选 → 试听后定角。
            </p>

            <section v-if="castingRoomCandidates.length" class="ganggang-voice-section">
              <label class="ganggang-voice-field">
                <span>试音例句</span>
                <textarea v-model="castingRoomExampleLine" class="text_pole" rows="2" @change="applyCastingRoomExampleLine"></textarea>
              </label>
              <p v-if="exampleLineSourceLabel" class="ganggang-voice-hint">{{ exampleLineSourceLabel }}</p>
              <div class="ganggang-voice-actions">
                <button class="menu_button fa-solid fa-rotate ganggang-voice-icon-action" type="button" :disabled="castingRoomBusy" title="按这句重新出样" @click="rerunCastingRoom"></button>
                <button
                  class="menu_button fa-solid fa-forward ganggang-voice-icon-action"
                  type="button"
                  :disabled="castingRoomBusy"
                  title="把当前候选整批换成备选池里的下一批"
                  @click="runtime.refreshCastingRoomBatch"
                ></button>
              </div>
            </section>

            <ul v-if="castingRoomCandidates.length" class="ganggang-voice-candidates">              <li
                v-for="(candidate, index) in castingRoomCandidates"
                :key="`${candidate.providerProfileId}-${candidate.voiceId}`"
                class="ganggang-voice-cand"
                :class="{
                  'is-cast': isCandidatePinned(candidate),
                  'is-failed': candidate.status === 'failed',
                }"
              >
                <div class="ganggang-voice-cand-row1">
                  <span class="ganggang-voice-cand-num">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span class="ganggang-voice-cand-engine">{{ profileName(candidate.providerProfileId) }}</span>
                  <span
                    class="ganggang-voice-cand-status"
                    :class="{
                      'st-ready': candidate.status === 'ready',
                      'st-busy': candidate.status === 'synthesizing',
                      'st-queue': candidate.status === 'pending',
                      'st-fail': candidate.status === 'failed',
                    }"
                  >
                    {{ candidateStatusText(candidate) }}
                  </span>
                  <span v-if="isCandidatePinned(candidate)" class="ganggang-voice-cand-flag">已定角</span>
                  <span class="ganggang-voice-cand-actions">
                    <button
                      class="menu_button fa-solid fa-play ganggang-voice-icon-action"
                      type="button"
                      :disabled="candidate.status !== 'ready'"
                      title="试听"
                     @click="playCastingRoomSample(candidate)"></button>
                    <button
                      class="menu_button fa-solid fa-shuffle ganggang-voice-icon-action"
                      type="button"
                      :disabled="castingRoomBusy"
                      title="换一个备选音色（不用重新问 AI）"
                      @click="runtime.replaceCastingRoomCandidate(index)"
                    ></button>
                    <button
                      class="menu_button ganggang-voice-primary fa-solid fa-thumbtack ganggang-voice-icon-action"
                      type="button"
                      :disabled="candidate.status !== 'ready' || castingRoomBusy"
                      title="定角"
                     @click="pinCastingRoomChoice(candidate)"></button>
                  </span>
                </div>
                <div class="ganggang-voice-cand-voice">{{ candidate.voiceId }}</div>
                <p v-if="candidate.reason" class="ganggang-voice-cand-reason">{{ candidate.reason }}</p>
                <p v-if="candidate.status === 'failed'" class="ganggang-voice-cand-error">
                  {{ candidate.error || '合成失败' }}
                </p>
              </li>
            </ul>

            <details class="ganggang-voice-fold">
              <summary class="ganggang-voice-fold-head">
                <b>手动试音</b>
                <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
              </summary>
              <div class="ganggang-voice-fold-body">
                <div class="ganggang-voice-grid">
                  <label class="ganggang-voice-field">
                    <span>引擎来源</span>
                    <select v-model="auditionProfileId" class="text_pole">
                      <option v-for="profile in enabledProfiles" :key="profile.id" :value="profile.id">
                        {{ profile.name || profile.id }}
                      </option>
                    </select>
                  </label>
                  <label class="ganggang-voice-field">
                    <span>音色（可手填 voiceId）</span>
                    <input
                      v-model.trim="auditionVoiceId"
                      class="text_pole"
                      type="text"
                      list="ganggang-voice-options"
                      :placeholder="auditionProfile ? `留空则用默认音色 ${auditionProfile.defaultVoiceId || '（未设置）'}` : '留空则用默认音色'"
                    />
                  </label>
                </div>
                <p class="ganggang-voice-hint">
                  已读取 {{ auditionProfile ? voicesFor(auditionProfile.id).length : 0 }} 个候选音色；不在列表里的 voiceId 可直接手填。
                </p>

                <label class="ganggang-voice-field">
                  <span>例句</span>
                  <textarea v-model="auditionText" class="text_pole" rows="3"></textarea>
                </label>

                <label v-if="auditionProfileType === 'xiaomi-mimo'" class="ganggang-voice-field">
                  <span>导演台本（user 指令，可留空）</span>
                  <textarea v-model="auditionInstruction" class="text_pole" rows="3" placeholder="角色：… 场景：… 指导：…"></textarea>
                </label>
                <label v-else-if="auditionProfileType === 'doubao'" class="ganggang-voice-field">
                  <span>导演指令 context_texts（可留空，不计费）</span>
                  <input v-model.trim="auditionContextText" class="text_pole" type="text" placeholder="用黏人撒娇的语气，尾音上扬…" />
                </label>
                <label v-else-if="auditionProfileType === 'minimax'" class="ganggang-voice-field">
                  <span>情绪档位</span>
                  <select v-model="auditionEmotion" class="text_pole">
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
                  <button
                    class="menu_button ganggang-voice-icon-action"
                    :class="auditionBusy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'"
                    type="button"
                    :disabled="auditionBusy"
                    title="试听"
                    @click="startAudition"
                  ></button>
                  <button class="menu_button ganggang-voice-primary fa-solid fa-thumbtack ganggang-voice-icon-action" type="button" :disabled="auditionBusy" title="用这个音色定角" @click="pinAuditionVoice"></button>
                </div>
              </div>
            </details>
          </template>

          <template v-else>
            <div class="ganggang-voice-toolbar">
              <select
                id="ganggang-voice-tts-preset-select"
                v-model="settings.currentTtsPresetId"
                class="text_pole"
                aria-label="TTS 预设"
              >
                <option v-for="preset in settings.ttsPresets" :key="preset.id" :value="preset.id">
                  {{ preset.name || '未命名预设' }}
                </option>
              </select>
              <div class="ganggang-voice-actions">
                <button class="menu_button fa-solid fa-plus ganggang-voice-icon-action" type="button" title="新建预设" @click="createTtsPreset"></button>
                <button class="menu_button fa-solid fa-check ganggang-voice-icon-action" type="button" title="保存预设" @click="runtime.saveSettings"></button>
                <button
                  class="menu_button fa-solid fa-trash-can ganggang-voice-icon-action"
                  type="button"
                  title="删除预设"
                  :disabled="settings.ttsPresets.length <= 1"
                  @click="deleteTtsPreset"
                ></button>
              </div>
            </div>

            <section class="ganggang-voice-section">
              <label class="ganggang-voice-enable-row">
                <input v-model="settings.ttsPresetEnabled" type="checkbox" />
                <span>启用 TTS 预设</span>
              </label>
              <template v-if="activeTtsPreset">
                <label class="ganggang-voice-field">
                  <span>预设名称</span>
                  <input v-model="activeTtsPreset.name" class="text_pole" type="text" />
                </label>
                <label class="ganggang-voice-field">
                  <span>发送给正文 AI 的指令</span>
                  <textarea v-model="activeTtsPreset.instructionText" class="text_pole" rows="14"></textarea>
                </label>
              </template>
            </section>
          </template>
        </div>

        <details class="ganggang-voice-fold ganggang-voice-reading">
          <summary class="ganggang-voice-fold-head">
            <b>朗读与最近语音</b>
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
          </summary>
          <div class="ganggang-voice-fold-body">
            <section class="ganggang-voice-section">
              <div class="ganggang-voice-grid">
                <label class="ganggang-voice-field">
                  <span>朗读方式</span>
                  <select v-model="settings.readingDefaults.mode" class="text_pole">
                    <option value="full">旁白 + 对白</option>
                    <option value="dialogue-only">只读对白</option>
                    <option value="single-voice">全文单音色</option>
                    <option value="selected-text">只读选中文本</option>
                    <option value="character-only">只读指定角色</option>
                  </select>
                </label>
                <label v-if="settings.readingDefaults.mode === 'character-only'" class="ganggang-voice-field">
                  <span>角色名</span>
                  <input v-model.trim="settings.readingDefaults.characterName" class="text_pole" type="text" />
                </label>
                <label v-if="settings.readingDefaults.mode === 'single-voice'" class="ganggang-voice-field">
                  <span>单音色</span>
                  <select class="text_pole" :value="singleVoiceKey" @change="setSingleVoice">
                    <option value="">请选择</option>
                    <option v-for="voice in voices" :key="voiceKey(voice)" :value="voiceKey(voice)">
                      {{ voice.name }} · {{ profileName(voice.providerProfileId) }}
                    </option>
                  </select>
                </label>
              </div>
              <label class="ganggang-voice-enable-row">
                <input
                  v-model="settings.readingDefaults.includeSoundEffects"
                  data-testid="ganggang-voice-include-sfx"
                  type="checkbox"
                />
                <span>启用原文小喇叭；已规划的短音效会依次插入整段朗读</span>
              </label>
              <div class="ganggang-voice-actions">
                <button
                  class="menu_button fa-solid fa-volume-high ganggang-voice-icon-action"
                  data-testid="ganggang-voice-read-latest"
                  type="button"
                  title="朗读最新消息"
                  @click="runtime.readLatest"
                ></button>
                <button class="menu_button fa-solid fa-volume-high ganggang-voice-icon-action" type="button" title="朗读当前选区" @click="runtime.readSelection"></button>
                <button
                  class="menu_button fa-solid fa-wand-magic-sparkles ganggang-voice-icon-action"
                  data-testid="ganggang-voice-plan-latest-sfx"
                  type="button"
                  :disabled="!settings.readingDefaults.includeSoundEffects || soundCatalogBusy"
                  title="AI 配最新音效"
                  @click="runtime.planLatestSoundEffects"
                ></button>
                <button class="menu_button fa-solid fa-rotate ganggang-voice-icon-action" type="button" title="刷新原文小喇叭" @click="runtime.refreshInlineControls"></button>
              </div>
            </section>

            <section v-if="builtinSoundCatalogPresentation" class="ganggang-voice-section">
              <div class="ganggang-voice-section-head">
                <strong>{{ builtinSoundCatalogPresentation.title }}</strong>
                <button
                  class="menu_button ganggang-voice-icon-action"
                  :class="soundCatalogBusy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-arrows-rotate'"
                  data-testid="ganggang-voice-load-sound-catalog"
                  type="button"
                  :disabled="soundCatalogBusy"
                  title="读取音效目录"
                  @click="runtime.loadSoundCatalog"
                ></button>
              </div>
              <p class="ganggang-voice-hint">
                页面内存目录：{{ soundCatalogCount }} 条（短音效 {{ soundCatalogSfxCount }} / 环境音
                {{ soundCatalogAmbienceCount }}）；版本 {{ soundCatalogRevisionLabel }}。刷新后目录会重新读取。
              </p>
              <p v-for="hint in builtinSoundCatalogPresentation.hints" :key="hint" class="ganggang-voice-hint">
                {{ hint }}
              </p>
            </section>

            <section class="ganggang-voice-section">
              <div class="ganggang-voice-section-head">
                <strong>{{ runtime.edition.id === 'custom-only' ? '自定义音效' : '自定义音效（可选）' }}</strong>
                <button class="menu_button fa-solid fa-plus ganggang-voice-icon-action" type="button" title="新增音效" @click="runtime.addSoundEffect"></button>
              </div>
              <div v-for="effect in settings.soundEffects" :key="effect.id" class="ganggang-voice-grid">
                <label class="ganggang-voice-enable-row">
                  <input v-model="effect.enabled" type="checkbox" />
                  <span>启用这个音效</span>
                </label>
                <label class="ganggang-voice-field">
                  <span>名称</span>
                  <input v-model.trim="effect.name" class="text_pole" type="text" />
                </label>
                <label class="ganggang-voice-field">
                  <span>播放种类</span>
                  <select v-model="effect.kind" class="text_pole">
                    <option value="sfx">短音效（可进入整段朗读）</option>
                    <option value="ambience">环境音（独立播放）</option>
                  </select>
                </label>
                <label class="ganggang-voice-field">
                  <span>分类</span>
                  <input v-model.trim="effect.category" class="text_pole" type="text" placeholder="门 / 脚步 / 环境" />
                </label>
                <label class="ganggang-voice-field">
                  <span>音频 URL</span>
                  <input v-model.trim="effect.url" class="text_pole" type="url" />
                </label>
                <label class="ganggang-voice-field">
                  <span>给 AI 的说明</span>
                  <textarea v-model.trim="effect.description" class="text_pole" rows="2" placeholder="例如：木门缓慢推开的吱呀声"></textarea>
                </label>
                <label class="ganggang-voice-field">
                  <span>试听音量</span>
                  <input v-model.number="effect.volume" type="range" min="0" max="1" step="0.05" />
                </label>
                <div class="ganggang-voice-actions">
                  <button class="menu_button fa-solid fa-play ganggang-voice-icon-action" type="button" title="试听" @click="runtime.playSoundEffect(effect.id)"></button>
                  <button class="menu_button fa-solid fa-trash-can ganggang-voice-icon-action" type="button" title="删除" @click="runtime.removeSoundEffect(effect.id)"></button>
                </div>
              </div>
            </section>

            <section class="ganggang-voice-section">
              <div class="ganggang-voice-section-head">
                <strong>最近语音</strong>
                <button class="menu_button fa-solid fa-broom ganggang-voice-icon-action" type="button" title="清空" @click="runtime.clearRecent"></button>
              </div>
              <p class="ganggang-voice-hint">最多 10 条；刷新网页即清空。</p>
              <ul class="ganggang-voice-list">
                <li v-for="item in recentVoices" :key="item.id" class="ganggang-voice-recent">
                  <div class="ganggang-voice-recent-text">
                    <div class="ganggang-voice-preview">{{ item.characterName || '旁白' }} · {{ item.textPreview }}</div>
                    <small class="ganggang-voice-hint">{{ recentStatus(item.status) }}</small>
                  </div>
                  <div class="ganggang-voice-actions">
                    <button
                      class="menu_button ganggang-voice-icon-action"
                      :class="item.status === 'playing' ? 'fa-solid fa-pause' : 'fa-solid fa-play'"
                      type="button"
                      :disabled="!item.objectUrl"
                      :title="item.status === 'playing' ? '暂停' : '播放'"
                      @click="runtime.playRecent(item.id)"
                    ></button>
                    <button class="menu_button fa-solid fa-rotate-right ganggang-voice-icon-action" type="button" title="重做" @click="runtime.regenerateRecent(item.id)"></button>
                    <button class="menu_button fa-solid fa-download ganggang-voice-icon-action" type="button" :disabled="!item.blob" title="下载" @click="runtime.downloadRecent(item.id)"></button>
                    <button class="menu_button fa-solid fa-trash-can ganggang-voice-icon-action" type="button" title="删除" @click="runtime.removeRecent(item.id)"></button>
                  </div>
                </li>
              </ul>
              <p v-if="recentVoices.length === 0" class="ganggang-voice-hint">这一页还没有生成语音。</p>
            </section>
          </div>
        </details>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { createManualCastEntry, findCastingEntryError, parseAliasInput } from './casting';
import { VOICE_CONSOLE_VERSION } from './edition';
import type { CastingRoomCandidateView, VoiceRuntime } from './runtime';
import type { CastEntry, CastRole, RecentVoiceStatus, VoiceOption } from './types';

const props = defineProps<{ runtime: VoiceRuntime }>();
const runtime = props.runtime;
const settings = runtime.settings;
const voices = runtime.voices;
const recentVoices = runtime.recentVoices;
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
  { value: 'sources', label: '来源' },
  { value: 'casting', label: '配音表' },
  { value: 'studio', label: '精选' },
  { value: 'preset', label: 'TTS 预设' },
] as const;
type TabValue = (typeof tabs)[number]['value'];
const activeTab = ref<TabValue>('sources');
const enabledProfiles = computed(() => settings.value.profiles.filter(profile => profile.enabled));
const selectedProfileId = ref(settings.value.profiles[0]?.id ?? '');
const selectedProfile = computed(
  () =>
    settings.value.profiles.find(profile => profile.id === selectedProfileId.value) ??
    settings.value.profiles[0] ??
    null,
);
watch(
  () => settings.value.profiles.map(profile => profile.id).join('|'),
  () => {
    if (!settings.value.profiles.some(profile => profile.id === selectedProfileId.value)) {
      selectedProfileId.value = settings.value.profiles[0]?.id ?? '';
    }
  },
);

function addSourceProfile(): void {
  selectedProfileId.value = runtime.addProfile('openai-compatible');
}

function saveSourceProfile(): void {
  runtime.saveSettings();
}

function removeSourceProfile(): void {
  if (!selectedProfile.value) return;
  runtime.removeProfile(selectedProfile.value.id);
  selectedProfileId.value = settings.value.profiles[0]?.id ?? '';
}
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

const activeTtsPreset = computed(
  () =>
    settings.value.ttsPresets.find(preset => preset.id === settings.value.currentTtsPresetId) ??
    settings.value.ttsPresets[0] ??
    null,
);

/** 与生图机「画图预设」的 ＋ 一致：新建即选中，正文指令留空由用户写。 */
function createTtsPreset(): void {
  const used = new Set(settings.value.ttsPresets.map(preset => preset.id));
  let id = `tts-preset-${Date.now()}`;
  let suffix = 2;
  while (used.has(id)) {
    id = `tts-preset-${Date.now()}-${suffix}`;
    suffix += 1;
  }
  settings.value.ttsPresets.push({ id, name: '新建预设', instructionText: '' });
  settings.value.currentTtsPresetId = id;
}

function deleteTtsPreset(): void {
  const presets = settings.value.ttsPresets;
  if (presets.length <= 1) return;
  const index = presets.findIndex(preset => preset.id === settings.value.currentTtsPresetId);
  if (index < 0) return;
  presets.splice(index, 1);
  settings.value.currentTtsPresetId = presets[Math.max(0, index - 1)]?.id ?? presets[0].id;
}

function profileName(profileId: string): string {
  return settings.value.profiles.find(profile => profile.id === profileId)?.name ?? profileId;
}

function roleLabel(role: CastRole): string {
  if (role === 'narrator') return '旁白';
  if (role === 'fallback') return '其他角色';
  return '角色';
}

/** 配音表行里显示的"谁的什么声音"：音色名优先，缺目录时回落到 voiceId。 */
function voiceLabelFor(entry: CastEntry): string {
  const voice = voices.value.find(
    item => item.providerProfileId === entry.voice.providerProfileId && item.voiceId === entry.voice.voiceId,
  );
  return `${voice?.name || entry.voice.voiceId} · ${profileName(entry.voice.providerProfileId)}`;
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

/** 配音表 → 精选：带着角色名跳过去，省得再手打一遍。 */
function focusCastingEntry(entry: CastEntry): void {
  castingRoomRoleName.value = entry.role === 'narrator' ? '旁白' : entry.displayName;
  activeTab.value = 'studio';
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
const castingRoomExampleLine = ref(runtime.castingRoom.value.exampleLine);
const castingRoomExampleDirty = ref(false);
/** 例句从哪来：用户手填（强制） / 聊天记录（可改写） / AI 自拟。 */
const exampleLineSourceLabel = computed(() => {
  if (castingRoomExampleDirty.value) return '例句来源：手动填写，会强制使用';
  const source = runtime.castingRoomExampleSource.value;
  if (source === 'chat') return '例句来源：最近聊天记录，AI 可改写';
  if (source === 'ai') return '例句来源：AI 自拟';
  return '';
});
const castingRoomTasteNotes = ref(runtime.settings.value.tasteProfile.styleNotes);
const castingRoomBusy = runtime.castingRoomBusy;

// 一键配音收尾会自动给主角挑候选：把角色名与例句同步到输入框，用户能看见也能改。
watch(
  () => runtime.castingRoom.value.roleName,
  value => {
    if (value && value !== castingRoomRoleName.value) castingRoomRoleName.value = value;
  },
);
watch(
  () => runtime.castingRoom.value.exampleLine,
  value => {
    if (value !== castingRoomExampleLine.value) {
      castingRoomExampleLine.value = value;
      castingRoomExampleDirty.value = false;
    }
  },
);

function applyCastingRoomExampleLine(): void {
  castingRoomExampleDirty.value = true;
  runtime.setCastingRoomExampleLine(castingRoomExampleLine.value);
}

function rerunCastingRoom(): void {
  applyCastingRoomExampleLine();
  void runtime.rerunCastingRoomBatch();
}

// 一键配音收尾会自动出候选：这时用户还停在「配音表」，把页面带到「精选」看结果。
watch(
  [() => runtime.castingRoom.value.candidates.length, () => castingBusy.value],
  ([count, busy]) => {
    if (count > 0 && !busy && activeTab.value === 'casting') activeTab.value = 'studio';
  },
);
const castingRoomCandidates = computed(() => runtime.castingRoom.value.candidates);
const castingRoomPhaseText = computed(() => {
  const room = runtime.castingRoom.value;
  if (room.phase === 'idle') return '';
  if (room.phase === 'nominating') return 'AI 正在阅读人设与音色目录，提名候选并生成例句…';
  if (room.phase === 'synthesizing') return `批量出样中（${room.progress.done}/${room.progress.total}）…`;
  if (room.phase === 'failed') return '本轮海选没有可用样本，请查看错误提示后重试。';
  if (room.phase === 'done') return `海选完成：${room.progress.total} 个候选已出样，试听后点「定角」。`;
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
    error.value = '请先填目标角色名';
    return;
  }
  castingRoomRoleName.value = roleName;
  runtime.settings.value.tasteProfile.styleNotes = castingRoomTasteNotes.value.trim();
  void runtime.generateCastingCandidates(roleName, settings.value.castingRoomCandidateCount, {
    exampleLine: castingRoomExampleDirty.value ? castingRoomExampleLine.value.trim() : '',
  });
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
  if (candidate.status === 'synthesizing') return '合成中';
  if (candidate.status === 'pending') return '排队中';
  return '失败';
}

/** 该候选的引擎+音色是否就是当前配音表条目已定的那一个。 */
function isCandidatePinned(candidate: CastingRoomCandidateView): boolean {
  const roleName = runtime.castingRoom.value.roleName.trim();
  if (!roleName) return false;
  const normalized = roleName.toLocaleLowerCase();
  const isNarrator = normalized === '旁白' || normalized === 'narrator';
  const table = runtime.settings.value.castingByCharacter[runtime.currentCharacterKey.value];
  if (!table) return false;
  const entry = table.entries.find(item =>
    isNarrator
      ? item.role === 'narrator'
      : item.role === 'character' &&
        [item.displayName, ...item.aliases].some(alias => alias.trim().toLocaleLowerCase() === normalized),
  );
  return (
    !!entry?.voice &&
    entry.voice.providerProfileId === candidate.providerProfileId &&
    entry.voice.voiceId === candidate.voiceId
  );
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

/** 手动试音定角：把当前引擎+音色写回精选页指定的角色（与 AI 海选定角同一条路径）。 */
function pinAuditionVoice(): void {
  const profile = auditionProfile.value;
  if (!profile) return;
  const voiceId = auditionVoiceId.value.trim() || profile.defaultVoiceId.trim();
  if (!voiceId) {
    error.value = '请先选择或填写音色';
    return;
  }
  const roleName = castingRoomRoleName.value.trim() || runtime.currentCharacterName.value.trim();
  if (!roleName) {
    error.value = '请先填目标角色名';
    return;
  }
  castingRoomRoleName.value = roleName;
  runtime.pinVoiceToRole(roleName, { providerProfileId: profile.id, voiceId }, '精选手动试音定角');
}
</script>
