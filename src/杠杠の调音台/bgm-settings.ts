import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { z } from 'zod';
import { DEFAULT_NETEASE_PLAYLISTS } from './bgm-playlist';

export const DEFAULT_BGM_INJECTION_LOCATION = '需要 BGM 时，必须在正文内容之前单独输出一行 <杠杠-BGM=歌曲名-歌手> 标记。';

export const DEFAULT_AMBIENT_PROMPT_CONTENT = [
  '1. 必须在 <content> 标签的正文内容之前单独输出一行 <杠杠-环境音=白噪音-地点> 标记，必须在 <content> 标签外部。',
  '2. 上一轮的地点是 {{current_ambient_location}}；如果现在地点不变，请原样输出 <杠杠-环境音=白噪音-{{current_ambient_location}}> 标记，否则输出的地点改成新地点。',
].join('\n');

export const DEFAULT_BGM_PROMPT_CONTENT = [
  '你正在正常生成角色回复正文。除非用户明确要求不要配 BGM，否则每次正常回复必须按当前正文氛围追加一条歌曲 BGM。',
  '保持正常的角色回复和剧情正文，不要输出候选列表、分析过程或选曲理由。',
  '【选曲流程（仅在内部完成）】1. 分析当前场景的情绪基调、人物心理状态、剧情节奏，重点看情绪、氛围和节奏的契合度，而不是只看歌词字面意思。',
  '2. 在心中列出 3-5 首不同歌手或乐队的候选曲目。3. 排除本次对话历史中已经在 BGM 标记出现过的歌曲，不能重复同一首。',
  '4. 优先选择该歌手的非代表作、专辑曲目、B 面曲或冷门单曲，不要每次都选最热门歌曲。5. 剧情出现明显转折时必须重新选曲。',
  '【硬性规则】更像电视剧、电影或 Galgame 的 BGM 选曲逻辑；可以使用中文、日文、韩文、英文歌曲，但不能使用纯音乐或器乐曲；歌名与歌手必须真实准确，不可编造。',
].join('');

export const DEFAULT_BGM_FORBIDDEN_LIST =
  '本次选曲时不得选择当前 BGM 播放列表中的歌曲（歌名和歌手组合），必须选择未出现在当前列表中的新 BGM：\n{{current_bgm_playlist}}';

export const DEFAULT_BGM_REQUIRED_LIST = '{{required_candidates}}';

const PlaylistEntry = z.object({
  id: z.string(),
  name: z.string(),
});

const ModuleEnabled = z.object({
  bgm: z.boolean().default(true),
  ambient: z.boolean().default(false),
});

const BgmSettings = z
  .object({
    bgm_injection_location: z.string().default(DEFAULT_BGM_INJECTION_LOCATION),
    ambient_prompt_content: z.string().default(DEFAULT_AMBIENT_PROMPT_CONTENT),
    bgm_prompt_content: z.string().default(DEFAULT_BGM_PROMPT_CONTENT),
    bgm_forbidden_list_prompt: z.string().default(DEFAULT_BGM_FORBIDDEN_LIST),
    bgm_required_list_prompt: z.string().default(DEFAULT_BGM_REQUIRED_LIST),
    playlist_limit: z.coerce.number().int().min(1).max(20).default(5),
    playlist_sample_count: z.coerce.number().int().min(1).max(20).default(5),
    ambient_fallback_bv_ids: z.array(z.string()).default([]),
    debug_mode: z.boolean().default(false),
    module_enabled: ModuleEnabled.prefault({}),
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

export const useBgmSettingsStore = defineStore('ganggang-console-settings', () => {
  const rawSettings = getVariables(scriptVariableOption);
  const parsedSettings = BgmSettings.safeParse(rawSettings);
  const initialSettings = parsedSettings.success ? parsedSettings.data : BgmSettings.parse({});
  if (!initialSettings.ambient_prompt_content.trim()) {
    initialSettings.ambient_prompt_content = DEFAULT_AMBIENT_PROMPT_CONTENT;
  }
  const settings = ref(initialSettings);

  watch(
    settings,
    nextSettings => {
      updateVariablesWith(variables => ({ ...variables, ...klona(nextSettings) }), scriptVariableOption);
    },
    { deep: true },
  );

  return { settings };
});
