import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { z } from 'zod';
import { DEFAULT_NETEASE_PLAYLISTS } from './bgm-playlist';

const PlaylistEntry = z.object({
  id: z.string(),
  name: z.string(),
});

const ModuleEnabled = z.object({
  bgm: z.boolean().default(true),
  ambient: z.boolean().default(false),
  tts: z.boolean().default(false),
  image: z.boolean().default(false),
  stage: z.boolean().default(false),
});

const BgmSettings = z
  .object({
    module_enabled: ModuleEnabled.default({}),
    source_mode: z.enum(['random', 'netease_playlist']).default('random'),
    playlist_id: z.string().default(''),
    playlist_name_overrides: z.record(z.string(), z.string()).default({}),
    playlist_catalog: z
      .array(PlaylistEntry)
      .default(DEFAULT_NETEASE_PLAYLISTS.map(playlist => ({ id: playlist.id, name: playlist.name }))),
  })
  .prefault({});

export type BgmSourceMode = z.infer<typeof BgmSettings>['source_mode'];

const scriptVariableOption = { type: 'script' as const, script_id: getScriptId() };

export const useBgmSettingsStore = defineStore('st-bgm-settings', () => {
  const rawSettings = getVariables(scriptVariableOption);
  const parsedSettings = BgmSettings.safeParse(rawSettings);
  const settings = ref(parsedSettings.success ? parsedSettings.data : BgmSettings.parse({}));

  watch(
    settings,
    nextSettings => {
      updateVariablesWith(variables => ({ ...variables, ...klona(nextSettings) }), scriptVariableOption);
    },
    { deep: true },
  );

  return { settings };
});
