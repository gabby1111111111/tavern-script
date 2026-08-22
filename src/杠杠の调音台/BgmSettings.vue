<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div class="ganggang-console-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>杠杠の调音台</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>

      <div class="inline-drawer-content">
        <nav class="ganggang-console-settings__module-tabs" aria-label="调音台模块">
          <button
            v-for="module in modules"
            :key="module.key"
            class="ganggang-console-settings__module-tab"
            :class="{ 'ganggang-console-settings__module-tab--active': activeModule === module.key }"
            type="button"
            :aria-current="activeModule === module.key ? 'page' : undefined"
            @click="activeModule = module.key"
          >
            {{ module.label }}
          </button>
        </nav>

        <div v-if="activeModule === 'bgm'" class="ganggang-console-settings__module-panel">
          <div class="ganggang-console-settings__enable-row">
            <label class="ganggang-console-settings__enable-label" for="ganggang-console-bgm-enabled">
              <input id="ganggang-console-bgm-enabled" v-model="settings.module_enabled.bgm" type="checkbox" />
              <span>启用 BGM</span>
            </label>
            <label class="ganggang-console-settings__enable-label" for="ganggang-console-debug-mode">
              <input id="ganggang-console-debug-mode" v-model="settings.debug_mode" type="checkbox" />
              <span>调试模式</span>
            </label>
          </div>

          <div class="ganggang-console-settings__row">
            <label for="ganggang-console-bgm-source-mode">BGM来源</label>
            <select
              id="ganggang-console-bgm-source-mode"
              v-model="settings.source_mode"
              class="text_pole ganggang-console-settings__control"
            >
              <option value="random">模式1：完全随机</option>
              <option value="netease_playlist">模式2：指定网易云歌单</option>
            </select>
          </div>

          <div v-if="settings.source_mode === 'netease_playlist'" class="ganggang-console-settings__playlist">
            <div class="ganggang-console-settings__row">
              <label for="ganggang-console-playlist-presets">歌单</label>
              <div class="ganggang-console-settings__playlist-picker">
                <button
                  id="ganggang-console-playlist-presets"
                  class="text_pole ganggang-console-settings__picker-trigger"
                  type="button"
                  :aria-expanded="playlistMenuOpen"
                  @click="playlistMenuOpen = !playlistMenuOpen"
                >
                  <span>{{ selectedPlaylistName }}</span>
                  <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </button>

                <div v-if="playlistMenuOpen" class="ganggang-console-settings__playlist-menu">
                  <button
                    class="ganggang-console-settings__playlist-option ganggang-console-settings__playlist-option--new"
                    type="button"
                    @click="selectPlaylistOption(NEW_PLAYLIST_VALUE)"
                  >
                    <span>导入新歌单</span>
                  </button>
                  <div
                    v-for="playlist in playlistOptions"
                    :key="playlist.id"
                    class="ganggang-console-settings__playlist-option"
                  >
                    <button type="button" @click="selectPlaylistOption(playlist.id)">
                      {{ playlist.name }}
                    </button>
                    <button
                      class="ganggang-console-settings__playlist-delete"
                      type="button"
                      :aria-label="`删除歌单 ${playlist.name}`"
                      :title="`删除歌单 ${playlist.name}`"
                      @click.stop="deletePlaylist(playlist.id)"
                    >
                      <i class="fa-solid fa-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="ganggang-console-settings__row">
              <label for="ganggang-console-playlist-id">歌单 ID</label>
              <div class="ganggang-console-settings__input-group">
                <input
                  id="ganggang-console-playlist-id"
                  v-model="playlistInput"
                  class="text_pole ganggang-console-settings__control"
                  inputmode="numeric"
                  placeholder="输入网易云歌单 ID"
                  type="text"
                />
                <button
                  class="menu_button ganggang-console-settings__icon-button"
                  type="button"
                  :disabled="loading"
                  title="加载"
                  aria-label="加载"
                  @click="loadPlaylist()"
                >
                  <i v-if="!loading" class="fa-solid fa-folder-open" aria-hidden="true"></i>
                  <i v-else class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
                </button>
              </div>
            </div>

            <div class="ganggang-console-settings__row">
              <label for="ganggang-console-playlist-name">显示名称</label>
              <div class="ganggang-console-settings__input-group">
                <input
                  id="ganggang-console-playlist-name"
                  v-model="renameInput"
                  class="text_pole ganggang-console-settings__control"
                  placeholder="输入本地显示名称，留空可恢复原名"
                  type="text"
                />
                <button
                  class="menu_button ganggang-console-settings__icon-button"
                  type="button"
                  :disabled="loading"
                  title="保存"
                  aria-label="保存"
                  @click="savePlaylist"
                >
                  <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                </button>
              </div>
            </div>

            <div v-if="loadedSampleTracks.length" class="ganggang-console-settings__sampled-tracks">
              <p class="ganggang-console-settings__sampled-title">本次随机抽取的歌曲</p>
              <ol>
                <li v-for="track in loadedSampleTracks" :key="`${track.name}-${track.artist.join('、')}`">
                  {{ track.name }} - {{ track.artist.join('、') }}
                </li>
              </ol>
            </div>

            <p
              class="ganggang-console-settings__status"
              :class="{ 'ganggang-console-settings__status--error': errorMessage }"
            >
              {{ statusMessage }}
            </p>
            <p class="ganggang-console-settings__hint">
              点击“加载”后随机抽取最多 {{ settings.playlist_sample_count }} 首歌名和歌手；AI 将从这组歌曲中选择。
            </p>
          </div>
        </div>

        <div v-else-if="activeModule === 'ambient'" class="ganggang-console-settings__module-panel">
          <div class="ganggang-console-settings__enable-row">
            <label class="ganggang-console-settings__enable-label" for="ganggang-console-ambient-enabled">
              <input id="ganggang-console-ambient-enabled" v-model="settings.module_enabled.ambient" type="checkbox" />
              <span>启用环境音</span>
            </label>
          </div>

          <p class="ganggang-console-settings__hint">
            AI 会在正文前输出环境音标签；地点不变时复用当前环境音，地点变化时才搜索并切换。
          </p>
        </div>

        <div v-else-if="activeModule === 'prompt'" class="ganggang-console-settings__module-panel">
          <div class="ganggang-console-settings__row ganggang-console-settings__row--stacked">
            <label for="ganggang-console-bgm-injection-location">BGM注入位置</label>
            <textarea
              id="ganggang-console-bgm-injection-location"
              v-model="settings.bgm_injection_location"
              class="text_pole ganggang-console-settings__textarea"
              rows="4"
            ></textarea>
          </div>

          <div class="ganggang-console-settings__row ganggang-console-settings__row--stacked">
            <label for="ganggang-console-ambient-prompt">环境音要求</label>
            <textarea
              id="ganggang-console-ambient-prompt"
              v-model="settings.ambient_prompt_content"
              class="text_pole ganggang-console-settings__textarea"
              rows="8"
            ></textarea>
            <span v-pre class="ganggang-console-settings__hint">
              对应模块二“环境音”；环境音功能启用后生效。当前地点占位符：{{current_ambient_location}}；当前标题占位符：{{current_ambient_title}}
            </span>
          </div>

          <div class="ganggang-console-settings__row ganggang-console-settings__row--stacked">
            <label for="ganggang-console-bgm-prompt">BGM选曲要求</label>
            <textarea
              id="ganggang-console-bgm-prompt"
              v-model="settings.bgm_prompt_content"
              class="text_pole ganggang-console-settings__textarea"
              rows="12"
            ></textarea>
          </div>

          <div class="ganggang-console-settings__row ganggang-console-settings__row--stacked">
            <label for="ganggang-console-bgm-forbidden-list">BGM禁选列表</label>
            <textarea
              id="ganggang-console-bgm-forbidden-list"
              v-model="settings.bgm_forbidden_list_prompt"
              class="text_pole ganggang-console-settings__textarea ganggang-console-settings__textarea--single-line"
              rows="1"
            ></textarea>
            <span v-pre class="ganggang-console-settings__hint">动态禁选歌曲占位符：{{current_bgm_playlist}}</span>
          </div>

          <div class="ganggang-console-settings__row ganggang-console-settings__row--stacked">
            <label for="ganggang-console-bgm-required-list">BGM必选列表</label>
            <textarea
              id="ganggang-console-bgm-required-list"
              v-model="settings.bgm_required_list_prompt"
              class="text_pole ganggang-console-settings__textarea ganggang-console-settings__textarea--single-line"
              rows="1"
            ></textarea>
            <span v-pre class="ganggang-console-settings__hint">
              动态候选占位符：{{required_candidates}}；歌单 ID 占位符：{{playlist_id}}
            </span>
          </div>

          <p class="ganggang-console-settings__hint">BGM 四个提示词框会按“注入位置、选曲要求、禁选列表、必选列表”的顺序合并发送。</p>
        </div>

        <div v-else-if="activeModule === 'more'" class="ganggang-console-settings__module-panel">
          <div class="ganggang-console-settings__row">
            <label for="ganggang-console-playlist-limit">播放列表缓存</label>
            <div class="ganggang-console-settings__input-group">
              <input
                id="ganggang-console-playlist-limit"
                v-model.number="settings.playlist_limit"
                class="text_pole ganggang-console-settings__control"
                type="number"
                min="1"
                max="20"
                step="1"
                @change="normalizeCountSetting('playlist_limit')"
              />
              <span>首</span>
            </div>
          </div>

          <div class="ganggang-console-settings__row">
            <label for="ganggang-console-playlist-sample-count">每次随机抽取</label>
            <div class="ganggang-console-settings__input-group">
              <input
                id="ganggang-console-playlist-sample-count"
                v-model.number="settings.playlist_sample_count"
                class="text_pole ganggang-console-settings__control"
                type="number"
                min="1"
                max="20"
                step="1"
                @change="normalizeCountSetting('playlist_sample_count')"
              />
              <span>首</span>
            </div>
          </div>

          <div class="ganggang-console-settings__row ganggang-console-settings__row--stacked">
            <label for="ganggang-console-ambient-fallback-bv">环境音保底 BV 号</label>
            <textarea
              id="ganggang-console-ambient-fallback-bv"
              v-model="fallbackBvInput"
              class="text_pole ganggang-console-settings__textarea"
              rows="4"
              placeholder="每行一个 BV 号，也可以粘贴带描述的文本"
              @change="normalizeFallbackBvIds"
            ></textarea>
            <span class="ganggang-console-settings__hint">保存时只保留 BV 号；B站搜索重试 4 次仍失败后按随机顺序使用。</span>
          </div>

          <p class="ganggang-console-settings__hint">两个数量的可设置范围都是 1–20。</p>
          <p class="ganggang-console-settings__hint">提示词修改后从下一轮 AI 回复开始生效。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { computed, onMounted, ref, watch } from 'vue';
import { extractBilibiliVideoIds } from './ambient-audio';
import {
  DEFAULT_NETEASE_PLAYLISTS,
  currentNeteaseSampleTracks,
  fetchNeteasePlaylistInfo,
  getCachedNeteasePlaylist,
  refreshNeteasePlaylist,
} from './bgm-playlist';
import { useBgmSettingsStore } from './bgm-settings';

const store = useBgmSettingsStore();
const { settings } = storeToRefs(store);
const activeModule = ref<'bgm' | 'ambient' | 'prompt' | 'more'>('bgm');
const modules = [
  { key: 'bgm', label: 'BGM' },
  { key: 'ambient', label: '环境音' },
  { key: 'prompt', label: '提示词' },
  { key: 'more', label: '更多' },
] as const;
const playlistInput = ref(settings.value.playlist_id);
const loadedPlaylistId = ref('');
const loadedTrackCount = ref(0);
const loading = ref(false);
const errorMessage = ref('');
const nameLoadError = ref('');
const renameInput = ref('');
const loadedSampleTracks = currentNeteaseSampleTracks;
const playlistMenuOpen = ref(false);
const NEW_PLAYLIST_VALUE = '__new_playlist__';
const playlistNames = ref<Record<string, string>>(
  Object.fromEntries(DEFAULT_NETEASE_PLAYLISTS.map(playlist => [playlist.id, playlist.name])),
);
const fallbackBvInput = ref(settings.value.ambient_fallback_bv_ids.join('\n'));

type CountSetting = 'playlist_limit' | 'playlist_sample_count';

function normalizeCountSetting(key: CountSetting) {
  const value = Math.floor(Number(settings.value[key]));
  settings.value[key] = Number.isFinite(value) ? Math.min(20, Math.max(1, value)) : 5;
}

function getPlaylistDisplayName(playlistId: string) {
  const catalogName = settings.value.playlist_catalog.find(playlist => playlist.id === playlistId)?.name;
  return (
    settings.value.playlist_name_overrides[playlistId] ||
    catalogName ||
    playlistNames.value[playlistId] ||
    `歌单 ${playlistId}`
  );
}

const playlistOptions = computed(() => {
  const options = settings.value.playlist_catalog.map(playlist => ({
    id: playlist.id,
    name: getPlaylistDisplayName(playlist.id),
  }));
  const selectedId = settings.value.playlist_id.trim();
  if (selectedId && !options.some(playlist => playlist.id === selectedId)) {
    options.push({ id: selectedId, name: getPlaylistDisplayName(selectedId) });
  }
  return options;
});

const selectedPlaylistName = computed(() => {
  const playlistId = settings.value.playlist_id.trim();
  return playlistId ? getPlaylistDisplayName(playlistId) : '导入新歌单';
});

const statusMessage = computed(() => {
  if (loading.value) return '正在拉取网易云歌单…';
  if (errorMessage.value) return `加载失败：${errorMessage.value}`;
  if (loadedPlaylistId.value && loadedPlaylistId.value === settings.value.playlist_id) {
    const nameWarning = nameLoadError.value ? `（名称获取失败：${nameLoadError.value}）` : '';
    return `已加载「${getPlaylistDisplayName(loadedPlaylistId.value)}」，共 ${loadedTrackCount.value} 首歌曲${nameWarning}。`;
  }
  if (playlistInput.value.trim()) return '新歌单信息已填写，请点击“保存”。';
  return '请先选择或输入歌单 ID。';
});

watch(
  () => settings.value.playlist_id,
  playlistId => {
    playlistInput.value = playlistId;
    renameInput.value = playlistId ? getPlaylistDisplayName(playlistId) : '';
  },
);

watch(
  () => settings.value.source_mode,
  sourceMode => {
    if (sourceMode === 'netease_playlist' && settings.value.playlist_id) {
      void loadPlaylist(settings.value.playlist_id, false);
    }
  },
);

watch(
  () => settings.value.ambient_fallback_bv_ids,
  fallbackBvIds => {
    const nextValue = fallbackBvIds.join('\n');
    if (fallbackBvInput.value !== nextValue) fallbackBvInput.value = nextValue;
  },
  { deep: true },
);

function normalizeFallbackBvIds() {
  const ids = extractBilibiliVideoIds(fallbackBvInput.value);
  settings.value.ambient_fallback_bv_ids = ids;
  fallbackBvInput.value = ids.join('\n');
}

async function loadPlaylist(playlistId = playlistInput.value, manual = true) {
  const normalizedPlaylistId = playlistId.trim();
  if (!/^\d+$/.test(normalizedPlaylistId)) {
    errorMessage.value = '歌单 ID 必须是数字';
    loadedPlaylistId.value = '';
    loadedTrackCount.value = 0;
    loadedSampleTracks.value = [];
    return;
  }

  settings.value.playlist_id = normalizedPlaylistId;
  playlistInput.value = normalizedPlaylistId;
  renameInput.value = getPlaylistDisplayName(normalizedPlaylistId);
  loading.value = true;
  errorMessage.value = '';
  nameLoadError.value = '';
  loadedSampleTracks.value = [];
  try {
    const tracks = await refreshNeteasePlaylist(normalizedPlaylistId, {
      manual,
      sampleCount: settings.value.playlist_sample_count,
    });
    loadedPlaylistId.value = normalizedPlaylistId;
    loadedTrackCount.value = tracks.length;
    loadedSampleTracks.value = getCachedNeteasePlaylist(normalizedPlaylistId)?.sampledTracks ?? [];
    try {
      const info = await fetchNeteasePlaylistInfo(normalizedPlaylistId);
      playlistNames.value[normalizedPlaylistId] = info.name;
      renameInput.value = getPlaylistDisplayName(normalizedPlaylistId);
    } catch (error) {
      nameLoadError.value = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    loadedPlaylistId.value = '';
    loadedTrackCount.value = 0;
    loadedSampleTracks.value = [];
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function clearLoadedPlaylistState() {
  loadedPlaylistId.value = '';
  loadedTrackCount.value = 0;
  loadedSampleTracks.value = [];
  errorMessage.value = '';
  nameLoadError.value = '';
}

function prepareNewPlaylist() {
  settings.value.playlist_id = '';
  playlistInput.value = '';
  renameInput.value = '';
  clearLoadedPlaylistState();
  playlistMenuOpen.value = false;
}

function selectPlaylistOption(playlistId: string) {
  if (playlistId === NEW_PLAYLIST_VALUE) {
    prepareNewPlaylist();
    return;
  }
  playlistMenuOpen.value = false;
  void loadPlaylist(playlistId);
}

function deletePlaylist(playlistId: string) {
  settings.value.playlist_catalog = settings.value.playlist_catalog.filter(playlist => playlist.id !== playlistId);
  const nextOverrides = { ...settings.value.playlist_name_overrides };
  delete nextOverrides[playlistId];
  settings.value.playlist_name_overrides = nextOverrides;
  if (settings.value.playlist_id === playlistId) prepareNewPlaylist();
  else playlistMenuOpen.value = false;
}

function savePlaylist() {
  const playlistId = playlistInput.value.trim();
  const name = renameInput.value.trim();
  const existingIndex = settings.value.playlist_catalog.findIndex(playlist => playlist.id === playlistId);

  if (!/^\d+$/.test(playlistId)) {
    errorMessage.value = '歌单 ID 必须是数字';
    return;
  }
  if (!name && existingIndex < 0) {
    errorMessage.value = '新歌单需要填写显示名称';
    return;
  }

  const fallbackName = playlistNames.value[playlistId] || `歌单 ${playlistId}`;
  const nextName = name || fallbackName;
  const nextCatalog = settings.value.playlist_catalog.slice();
  if (existingIndex >= 0) nextCatalog[existingIndex] = { id: playlistId, name: nextName };
  else nextCatalog.push({ id: playlistId, name: nextName });
  settings.value.playlist_catalog = nextCatalog;

  const nextOverrides = { ...settings.value.playlist_name_overrides };
  if (name) nextOverrides[playlistId] = name;
  else delete nextOverrides[playlistId];
  settings.value.playlist_name_overrides = nextOverrides;
  settings.value.playlist_id = playlistId;
  playlistInput.value = playlistId;
  renameInput.value = getPlaylistDisplayName(playlistId);
  errorMessage.value = '';
  playlistMenuOpen.value = false;
}

onMounted(() => {
  renameInput.value = settings.value.playlist_id ? getPlaylistDisplayName(settings.value.playlist_id) : '';
  if (settings.value.source_mode === 'netease_playlist' && settings.value.playlist_id) {
    void loadPlaylist(settings.value.playlist_id, false);
  }
});
</script>

<style scoped>
.ganggang-console-settings__module-tabs {
  display: flex;
  gap: 0.35em;
  margin-bottom: 0.75em;
  overflow-x: auto;
  border-bottom: 1px solid var(--SmartThemeBorderColor, #555);
}

.ganggang-console-settings__module-tab {
  flex: 0 0 auto;
  padding: 0.45em 0.75em;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.ganggang-console-settings__module-tab--active {
  border-bottom-color: var(--SmartThemeQuoteColor, #8ab4f8);
  color: var(--SmartThemeQuoteColor, #8ab4f8);
  font-weight: 600;
}

.ganggang-console-settings__module-tab:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ganggang-console-settings__enable-row {
  display: flex;
  align-items: center;
  gap: 0.75em;
  margin: 0.5em 0 0.75em;
  padding: 0.45em 0.6em;
  border: 1px solid var(--SmartThemeBorderColor, #555);
  border-radius: 0.4em;
}

.ganggang-console-settings__enable-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  flex: 0 0 auto;
  cursor: pointer;
  font-weight: 600;
}

.ganggang-console-settings__enable-hint {
  opacity: 0.75;
  font-size: 0.9em;
}

.ganggang-console-settings__row {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0.5em 0;
}

.ganggang-console-settings__row > label {
  min-width: 5em;
}

.ganggang-console-settings__row--stacked {
  align-items: stretch;
  flex-direction: column;
}

.ganggang-console-settings__textarea {
  width: 100%;
  min-height: 12em;
  resize: vertical;
}

.ganggang-console-settings__textarea--single-line {
  min-height: 2.4em;
  height: 2.4em;
  overflow-x: auto;
  resize: none;
  white-space: nowrap;
}

.ganggang-console-settings__control {
  min-width: 0;
  flex: 1;
}

.ganggang-console-settings__playlist {
  padding-top: 0.25em;
}

.ganggang-console-settings__input-group {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 0.4em;
}

.ganggang-console-settings__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6em;
  min-width: 2.6em;
  padding: 0.45em;
}

.ganggang-console-settings__playlist-picker {
  position: relative;
  min-width: 0;
  flex: 1;
}

.ganggang-console-settings__picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  text-align: left;
  cursor: pointer;
}

.ganggang-console-settings__picker-trigger > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ganggang-console-settings__playlist-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 0.25em);
  right: 0;
  left: 0;
  max-height: 16em;
  overflow-y: auto;
  border: 1px solid var(--SmartThemeBorderColor, #555);
  border-radius: 0.4em;
  background: var(--SmartThemeBodyColor, #222);
  box-shadow: 0 0.4em 1em rgb(0 0 0 / 35%);
}

.ganggang-console-settings__playlist-option {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
}

.ganggang-console-settings__playlist-option:last-child {
  border-bottom: 0;
}

.ganggang-console-settings__playlist-option > button:first-child {
  flex: 1;
  min-width: 0;
  padding: 0.55em 0.7em;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.ganggang-console-settings__playlist-option > button:first-child:hover,
.ganggang-console-settings__playlist-delete:hover {
  background: rgb(255 255 255 / 10%);
}

.ganggang-console-settings__playlist-delete {
  width: 2.5em;
  min-width: 2.5em;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ganggang-console-settings__playlist-option--new {
  width: 100%;
  border-bottom: 1px solid var(--SmartThemeBorderColor, #555);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.ganggang-console-settings__playlist-option--new:hover {
  background: rgb(255 255 255 / 10%);
}

.ganggang-console-settings__playlist-option--new > span {
  width: 100%;
  padding: 0.55em 0.7em;
  cursor: pointer;
}

.ganggang-console-settings__sampled-tracks {
  margin: 0.75em 0;
  padding: 0.5em 0.75em;
  border: 1px solid var(--SmartThemeBorderColor, #555);
  border-radius: 0.4em;
}

.ganggang-console-settings__sampled-title {
  margin: 0;
  font-weight: 600;
}

.ganggang-console-settings__sampled-tracks ol {
  margin: 0.35em 0 0;
  padding-left: 1.5em;
}

.ganggang-console-settings__status,
.ganggang-console-settings__hint {
  margin: 0.5em 0;
  opacity: 0.85;
}

.ganggang-console-settings__status--error {
  color: var(--SmartThemeQuoteColor, #d66);
}

@media (max-width: 600px) {
  .ganggang-console-settings__row {
    align-items: stretch;
    flex-direction: column;
  }

  .ganggang-console-settings__row > label {
    min-width: auto;
  }
}
</style>
