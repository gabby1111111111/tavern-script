<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div class="st-bgm-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>杠杠の舞台演出</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>

      <div class="inline-drawer-content">
        <nav class="st-bgm-settings__module-tabs" aria-label="舞台演出模块">
          <button
            v-for="module in modules"
            :key="module.key"
            class="st-bgm-settings__module-tab"
            :class="{ 'st-bgm-settings__module-tab--active': activeModule === module.key }"
            :disabled="module.key !== 'bgm'"
            type="button"
            :aria-current="activeModule === module.key ? 'page' : undefined"
            @click="activeModule = module.key"
          >
            {{ module.label }}
          </button>
        </nav>

        <div v-if="activeModule === 'bgm'" class="st-bgm-settings__module-panel">
          <div class="st-bgm-settings__enable-row">
            <label class="st-bgm-settings__enable-label" for="st-bgm-enabled">
              <input id="st-bgm-enabled" v-model="settings.module_enabled.bgm" type="checkbox" />
              <span>启用 BGM</span>
            </label>
            <span class="st-bgm-settings__enable-hint">取消后保留当前播放，等待下一次 AI 回复恢复。</span>
          </div>

          <div class="st-bgm-settings__row">
            <label for="st-bgm-source-mode">BGM来源</label>
            <select id="st-bgm-source-mode" v-model="settings.source_mode" class="text_pole st-bgm-settings__control">
              <option value="random">模式1：完全随机</option>
              <option value="netease_playlist">模式2：指定网易云歌单</option>
            </select>
          </div>

          <div v-if="settings.source_mode === 'netease_playlist'" class="st-bgm-settings__playlist">
            <div class="st-bgm-settings__row">
              <label for="st-bgm-playlist-presets">歌单</label>
              <div class="st-bgm-settings__playlist-picker">
                <button
                  id="st-bgm-playlist-presets"
                  class="text_pole st-bgm-settings__picker-trigger"
                  type="button"
                  :aria-expanded="playlistMenuOpen"
                  @click="playlistMenuOpen = !playlistMenuOpen"
                >
                  <span>{{ selectedPlaylistName }}</span>
                  <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
                </button>

                <div v-if="playlistMenuOpen" class="st-bgm-settings__playlist-menu">
                  <button
                    class="st-bgm-settings__playlist-option st-bgm-settings__playlist-option--new"
                    type="button"
                    @click="selectPlaylistOption(NEW_PLAYLIST_VALUE)"
                  >
                    <span>导入新歌单</span>
                  </button>
                  <div v-for="playlist in playlistOptions" :key="playlist.id" class="st-bgm-settings__playlist-option">
                    <button type="button" @click="selectPlaylistOption(playlist.id)">
                      {{ playlist.name }}
                    </button>
                    <button
                      class="st-bgm-settings__playlist-delete"
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

            <div class="st-bgm-settings__row">
              <label for="st-bgm-playlist-id">歌单 ID</label>
              <div class="st-bgm-settings__input-group">
                <input
                  id="st-bgm-playlist-id"
                  v-model="playlistInput"
                  class="text_pole st-bgm-settings__control"
                  inputmode="numeric"
                  placeholder="输入网易云歌单 ID"
                  type="text"
                />
                <button
                  class="menu_button st-bgm-settings__icon-button"
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

            <div class="st-bgm-settings__row">
              <label for="st-bgm-playlist-name">显示名称</label>
              <div class="st-bgm-settings__input-group">
                <input
                  id="st-bgm-playlist-name"
                  v-model="renameInput"
                  class="text_pole st-bgm-settings__control"
                  placeholder="输入本地显示名称，留空可恢复原名"
                  type="text"
                />
                <button
                  class="menu_button st-bgm-settings__icon-button"
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

            <div v-if="loadedSampleTracks.length" class="st-bgm-settings__sampled-tracks">
              <p class="st-bgm-settings__sampled-title">本次随机抽取的歌曲</p>
              <ol>
                <li v-for="track in loadedSampleTracks" :key="`${track.name}-${track.artist.join('、')}`">
                  {{ track.name }} - {{ track.artist.join('、') }}
                </li>
              </ol>
            </div>

            <p class="st-bgm-settings__status" :class="{ 'st-bgm-settings__status--error': errorMessage }">
              {{ statusMessage }}
            </p>
            <p class="st-bgm-settings__hint">点击“加载”后随机抽取最多 5 首歌名和歌手；AI 将从这组歌曲中选择。</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { computed, onMounted, ref, watch } from 'vue';
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
const activeModule = ref<'bgm' | 'ambient' | 'tts' | 'image' | 'stage'>('bgm');
const modules = [
  { key: 'bgm', label: 'BGM' },
  { key: 'ambient', label: '环境音' },
  { key: 'tts', label: 'TTS' },
  { key: 'image', label: '生图' },
  { key: 'stage', label: '舞台' },
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
    const tracks = await refreshNeteasePlaylist(normalizedPlaylistId, { manual });
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
.st-bgm-settings__module-tabs {
  display: flex;
  gap: 0.35em;
  margin-bottom: 0.75em;
  overflow-x: auto;
  border-bottom: 1px solid var(--SmartThemeBorderColor, #555);
}

.st-bgm-settings__module-tab {
  flex: 0 0 auto;
  padding: 0.45em 0.75em;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.st-bgm-settings__module-tab--active {
  border-bottom-color: var(--SmartThemeQuoteColor, #8ab4f8);
  color: var(--SmartThemeQuoteColor, #8ab4f8);
  font-weight: 600;
}

.st-bgm-settings__module-tab:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.st-bgm-settings__enable-row {
  display: flex;
  align-items: center;
  gap: 0.75em;
  margin: 0.5em 0 0.75em;
  padding: 0.45em 0.6em;
  border: 1px solid var(--SmartThemeBorderColor, #555);
  border-radius: 0.4em;
}

.st-bgm-settings__enable-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  flex: 0 0 auto;
  cursor: pointer;
  font-weight: 600;
}

.st-bgm-settings__enable-hint {
  opacity: 0.75;
  font-size: 0.9em;
}

.st-bgm-settings__row {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0.5em 0;
}

.st-bgm-settings__row > label {
  min-width: 5em;
}

.st-bgm-settings__control {
  min-width: 0;
  flex: 1;
}

.st-bgm-settings__playlist {
  padding-top: 0.25em;
}

.st-bgm-settings__input-group {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 0.4em;
}

.st-bgm-settings__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6em;
  min-width: 2.6em;
  padding: 0.45em;
}

.st-bgm-settings__playlist-picker {
  position: relative;
  min-width: 0;
  flex: 1;
}

.st-bgm-settings__picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  text-align: left;
  cursor: pointer;
}

.st-bgm-settings__picker-trigger > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-bgm-settings__playlist-menu {
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

.st-bgm-settings__playlist-option {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
}

.st-bgm-settings__playlist-option:last-child {
  border-bottom: 0;
}

.st-bgm-settings__playlist-option > button:first-child {
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

.st-bgm-settings__playlist-option > button:first-child:hover,
.st-bgm-settings__playlist-delete:hover {
  background: rgb(255 255 255 / 10%);
}

.st-bgm-settings__playlist-delete {
  width: 2.5em;
  min-width: 2.5em;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.st-bgm-settings__playlist-option--new {
  width: 100%;
  border-bottom: 1px solid var(--SmartThemeBorderColor, #555);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.st-bgm-settings__playlist-option--new:hover {
  background: rgb(255 255 255 / 10%);
}

.st-bgm-settings__playlist-option--new > span {
  width: 100%;
  padding: 0.55em 0.7em;
  cursor: pointer;
}

.st-bgm-settings__sampled-tracks {
  margin: 0.75em 0;
  padding: 0.5em 0.75em;
  border: 1px solid var(--SmartThemeBorderColor, #555);
  border-radius: 0.4em;
}

.st-bgm-settings__sampled-title {
  margin: 0;
  font-weight: 600;
}

.st-bgm-settings__sampled-tracks ol {
  margin: 0.35em 0 0;
  padding-left: 1.5em;
}

.st-bgm-settings__status,
.st-bgm-settings__hint {
  margin: 0.5em 0;
  opacity: 0.85;
}

.st-bgm-settings__status--error {
  color: var(--SmartThemeQuoteColor, #d66);
}

@media (max-width: 600px) {
  .st-bgm-settings__row {
    align-items: stretch;
    flex-direction: column;
  }

  .st-bgm-settings__row > label {
    min-width: auto;
  }
}
</style>
