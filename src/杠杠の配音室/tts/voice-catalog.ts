import type { TtsProviderProfile, VoiceOption } from '../types';
import type { DiscoveredMinimaxVoice } from './cloud-request';

type CatalogVoice = Omit<VoiceOption, 'providerProfileId'>;

const EDGE_VOICES: ReadonlyArray<CatalogVoice> = [
  { voiceId: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 中文女声', locale: 'zh-CN', gender: 'Female' },
  { voiceId: 'zh-CN-XiaoyiNeural', name: '晓伊 · 中文女声', locale: 'zh-CN', gender: 'Female' },
  { voiceId: 'zh-CN-YunjianNeural', name: '云健 · 中文男声', locale: 'zh-CN', gender: 'Male' },
  { voiceId: 'zh-CN-YunxiNeural', name: '云希 · 中文男声', locale: 'zh-CN', gender: 'Male' },
  { voiceId: 'zh-CN-YunxiaNeural', name: '云夏 · 中文男声', locale: 'zh-CN', gender: 'Male' },
  { voiceId: 'zh-CN-YunyangNeural', name: '云扬 · 中文男声', locale: 'zh-CN', gender: 'Male' },
  { voiceId: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 辽宁女声', locale: 'zh-CN', gender: 'Female' },
  { voiceId: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 陕西女声', locale: 'zh-CN', gender: 'Female' },
  { voiceId: 'zh-HK-HiuGaaiNeural', name: '晓佳 · 粤语女声', locale: 'zh-HK', gender: 'Female' },
  { voiceId: 'zh-HK-WanLungNeural', name: '云龙 · 粤语男声', locale: 'zh-HK', gender: 'Male' },
  { voiceId: 'zh-TW-HsiaoChenNeural', name: '晓臻 · 台湾女声', locale: 'zh-TW', gender: 'Female' },
  { voiceId: 'zh-TW-YunJheNeural', name: '云哲 · 台湾男声', locale: 'zh-TW', gender: 'Male' },
  { voiceId: 'en-US-AriaNeural', name: 'Aria · English female', locale: 'en-US', gender: 'Female' },
  { voiceId: 'en-US-GuyNeural', name: 'Guy · English male', locale: 'en-US', gender: 'Male' },
  { voiceId: 'ja-JP-NanamiNeural', name: 'Nanami · 日本語女声', locale: 'ja-JP', gender: 'Female' },
  { voiceId: 'ja-JP-KeitaNeural', name: 'Keita · 日本語男声', locale: 'ja-JP', gender: 'Male' },
];

const DOUBAO_VOICE_ROWS: ReadonlyArray<readonly [string, string, 'Male' | 'Female']> = [
  ['傲气凌人', 'ICL_uranus_zh_male_aoqilingren_tob', 'Male'],
  ['傲娇公子', 'ICL_uranus_zh_male_aojiaogongzi_tob', 'Male'],
  ['病娇弟弟', 'ICL_uranus_zh_male_bingjiaodidi_tob', 'Male'],
  ['病娇哥哥', 'ICL_uranus_zh_male_bingjiaogege_tob', 'Male'],
  ['清冷矜贵', 'ICL_uranus_zh_male_qinglengjingui_tob', 'Male'],
  ['寡言小哥', 'ICL_uranus_zh_male_guayanxiaoge_tob', 'Male'],
  ['清朗温润', 'ICL_uranus_zh_male_qinglangwenrun_tob', 'Male'],
  ['青涩小生', 'ICL_uranus_zh_male_qingsexiaosheng_tob', 'Male'],
  ['温柔内敛', 'ICL_uranus_zh_male_wenrouneilian_tob', 'Male'],
  ['沉稳优雅', 'ICL_uranus_zh_male_chenwenyouya_tob', 'Male'],
  ['活泼爽朗', 'ICL_uranus_zh_male_huoposhuanglang_tob', 'Male'],
  ['诡异神秘', 'ICL_uranus_zh_male_guiyishenmi_tob', 'Male'],
  ['贴心男友', 'ICL_uranus_zh_male_tiexinnanyou_tob', 'Male'],
  ['傲娇女友', 'ICL_uranus_zh_female_aojiaonvyou_tob', 'Female'],
  ['病娇姐姐', 'ICL_uranus_zh_female_bingjiaojiejie_tob', 'Female'],
  ['病娇萌妹', 'ICL_uranus_zh_female_bingjiaomengmei_tob', 'Female'],
  ['成熟姐姐', 'ICL_uranus_zh_female_chengshujiejie_tob', 'Female'],
  ['娇弱萝莉', 'ICL_uranus_zh_female_jiaoruoluoli_tob', 'Female'],
  ['清冷高雅', 'ICL_uranus_zh_female_qinglenggaoya_tob', 'Female'],
  ['甜美娇俏', 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', 'Female'],
  ['温柔文雅', 'ICL_uranus_zh_female_wenrouwenya_tob', 'Female'],
  ['妩媚御姐', 'ICL_uranus_zh_female_wumeiyujie_tob', 'Female'],
  ['知性温婉', 'ICL_uranus_zh_female_zhixingwenwan_tob', 'Female'],
];

const DOUBAO_VOICES: ReadonlyArray<CatalogVoice> = DOUBAO_VOICE_ROWS.map(([name, voiceId, gender]) => ({
  voiceId,
  name,
  gender,
  locale: 'zh-CN',
}));

const MIMO_VOICES: ReadonlyArray<CatalogVoice> = [
  { voiceId: 'mimo_default', name: 'MiMo · 默认', locale: 'zh-CN', description: '通用' },
  { voiceId: '冰糖', name: '冰糖', locale: 'zh-CN', gender: 'Female' },
  { voiceId: '茉莉', name: '茉莉', locale: 'zh-CN', gender: 'Female' },
  { voiceId: '苏打', name: '苏打', locale: 'zh-CN', gender: 'Male' },
  { voiceId: '白桦', name: '白桦', locale: 'zh-CN', gender: 'Male' },
  { voiceId: 'Mia', name: 'Mia', locale: 'en-US', gender: 'Female' },
  { voiceId: 'Chloe', name: 'Chloe', locale: 'en-US', gender: 'Female' },
  { voiceId: 'Milo', name: 'Milo', locale: 'en-US', gender: 'Male' },
  { voiceId: 'Dean', name: 'Dean', locale: 'en-US', gender: 'Male' },
];

export const EDGE_VOICE_CATALOG: ReadonlyArray<CatalogVoice> = EDGE_VOICES;
export const DOUBAO_VOICE_CATALOG: ReadonlyArray<CatalogVoice> = DOUBAO_VOICES;
export const MIMO_VOICE_CATALOG: ReadonlyArray<CatalogVoice> = MIMO_VOICES;

function normalizeVoice(value: CatalogVoice, providerProfileId: string): VoiceOption {
  return { providerProfileId, ...value };
}

function includeProfileDefaultVoice(catalog: ReadonlyArray<CatalogVoice>, profile: TtsProviderProfile): VoiceOption[] {
  const result = catalog.map(value => normalizeVoice(value, profile.id));
  const defaultVoiceId = String(profile.defaultVoiceId || '').trim();
  if (defaultVoiceId && !result.some(value => value.voiceId === defaultVoiceId)) {
    result.push(
      normalizeVoice({ voiceId: defaultVoiceId, name: defaultVoiceId, description: 'Profile 默认音色' }, profile.id),
    );
  }
  return result;
}

export function normalizeDiscoveredMinimaxVoices(
  voices: DiscoveredMinimaxVoice[],
  providerProfileId: string,
  limit = 2_000,
): VoiceOption[] {
  const result: VoiceOption[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(voices) ? voices : []) {
    const voiceId = String(value?.voiceId || '')
      .trim()
      .slice(0, 500);
    if (!voiceId || seen.has(voiceId)) continue;
    seen.add(voiceId);
    result.push(
      normalizeVoice(
        {
          voiceId,
          name:
            String(value?.name || voiceId)
              .trim()
              .slice(0, 300) || voiceId,
          description: String(value?.description || '')
            .trim()
            .slice(0, 1_000),
          tags: value?.kind ? [value.kind] : undefined,
        },
        providerProfileId,
      ),
    );
    if (result.length >= limit) break;
  }
  return result;
}

export function getStaticVoiceCatalog(profile: TtsProviderProfile): VoiceOption[] {
  const providerProfileId = profile.id;
  if (profile.type === 'edge') return includeProfileDefaultVoice(EDGE_VOICE_CATALOG, profile);
  if (profile.type === 'doubao') return includeProfileDefaultVoice(DOUBAO_VOICE_CATALOG, profile);
  if (profile.type === 'xiaomi-mimo') return includeProfileDefaultVoice(MIMO_VOICE_CATALOG, profile);
  if (profile.defaultVoiceId) {
    return [
      normalizeVoice(
        { voiceId: profile.defaultVoiceId, name: profile.defaultVoiceId, description: 'Profile 默认音色' },
        providerProfileId,
      ),
    ];
  }
  return [];
}
