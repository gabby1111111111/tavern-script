import type { TtsProviderProfile, VoiceOption } from '../types';
import type { DiscoveredMinimaxVoice } from './cloud-request';

type CatalogVoice = Omit<VoiceOption, 'providerProfileId'>;

// 说明文字是给 AI 配音导演读的：名称只有"晓晓"这种字号时，模型无从判断音色，
// 因此每条都补一句音高/年龄感/质地/适用角色。不要写营销词，写能区分音色的差异点。
const EDGE_VOICES: ReadonlyArray<CatalogVoice> = [
  {
    voiceId: 'zh-CN-XiaoxiaoNeural',
    name: '晓晓 · 中文女声',
    locale: 'zh-CN',
    gender: 'Female',
    description: '清亮年轻女声，语气自然亲切，起伏适中，通用旁白首选',
  },
  {
    voiceId: 'zh-CN-XiaoyiNeural',
    name: '晓伊 · 中文女声',
    locale: 'zh-CN',
    gender: 'Female',
    description: '少女音，音调偏高、轻软带鼻音，适合活泼或撒娇的年轻女性',
  },
  {
    voiceId: 'zh-CN-YunjianNeural',
    name: '云健 · 中文男声',
    locale: 'zh-CN',
    gender: 'Male',
    description: '低沉稳重的成熟男声，语速偏慢，适合中年男性或严肃旁白',
  },
  {
    voiceId: 'zh-CN-YunxiNeural',
    name: '云希 · 中文男声',
    locale: 'zh-CN',
    gender: 'Male',
    description: '清朗青年男声，温柔克制、尾音略收，适合青年男主',
  },
  {
    voiceId: 'zh-CN-YunxiaNeural',
    name: '云夏 · 中文男声',
    locale: 'zh-CN',
    gender: 'Male',
    description: '轻快少年音，明亮跳跃，适合少年感或话多的角色',
  },
  {
    voiceId: 'zh-CN-YunyangNeural',
    name: '云扬 · 中文男声',
    locale: 'zh-CN',
    gender: 'Male',
    description: '明亮厚实的青年男声，播报感强，适合正剧旁白或解说',
  },
  {
    voiceId: 'zh-CN-liaoning-XiaobeiNeural',
    name: '晓北 · 辽宁女声',
    locale: 'zh-CN',
    gender: 'Female',
    description: '东北口音女声，直爽接地气，适合乡土或喜剧角色',
  },
  {
    voiceId: 'zh-CN-shaanxi-XiaoniNeural',
    name: '晓妮 · 陕西女声',
    locale: 'zh-CN',
    gender: 'Female',
    description: '陕西口音女声，朴实亲和，适合地方角色',
  },
  {
    voiceId: 'zh-HK-HiuGaaiNeural',
    name: '晓佳 · 粤语女声',
    locale: 'zh-HK',
    gender: 'Female',
    description: '粤语清亮女声，语调轻快，适合粤语对白',
  },
  {
    voiceId: 'zh-HK-WanLungNeural',
    name: '云龙 · 粤语男声',
    locale: 'zh-HK',
    gender: 'Male',
    description: '粤语沉稳男声，音色偏低，适合粤语对白',
  },
  {
    voiceId: 'zh-TW-HsiaoChenNeural',
    name: '晓臻 · 台湾女声',
    locale: 'zh-TW',
    gender: 'Female',
    description: '台湾腔软糯女声，语气柔和，适合温柔女性',
  },
  {
    voiceId: 'zh-TW-YunJheNeural',
    name: '云哲 · 台湾男声',
    locale: 'zh-TW',
    gender: 'Male',
    description: '台湾腔温和男声，咬字偏软，适合青年男性',
  },
  {
    voiceId: 'en-US-AriaNeural',
    name: 'Aria · English female',
    locale: 'en-US',
    gender: 'Female',
    description: '英语女声，温暖有表现力，适合英文旁白',
  },
  {
    voiceId: 'en-US-GuyNeural',
    name: 'Guy · English male',
    locale: 'en-US',
    gender: 'Male',
    description: '英语男声，低沉平稳，适合英文旁白',
  },
  {
    voiceId: 'ja-JP-NanamiNeural',
    name: 'Nanami · 日本語女声',
    locale: 'ja-JP',
    gender: 'Female',
    description: '日语柔和女声，语速平缓，适合日语对白',
  },
  {
    voiceId: 'ja-JP-KeitaNeural',
    name: 'Keita · 日本語男声',
    locale: 'ja-JP',
    gender: 'Male',
    description: '日语沉稳男声，音色偏低，适合日语对白',
  },
];

const DOUBAO_VOICE_ROWS: ReadonlyArray<readonly [string, string, 'Male' | 'Female', string]> = [
  ['傲气凌人', 'ICL_uranus_zh_male_aoqilingren_tob', 'Male', '男声，冷硬有压迫感，咬字利落'],
  ['傲娇公子', 'ICL_uranus_zh_male_aojiaogongzi_tob', 'Male', '少年男声，嘴硬心虚、情绪起伏明显'],
  ['病娇弟弟', 'ICL_uranus_zh_male_bingjiaodidi_tob', 'Male', '少年男声，甜软中带偏执，气声多'],
  ['病娇哥哥', 'ICL_uranus_zh_male_bingjiaogege_tob', 'Male', '青年男声，低沉执念感，语速慢'],
  ['清冷矜贵', 'ICL_uranus_zh_male_qinglengjingui_tob', 'Male', '男声，疏离高冷，音色干净、少起伏'],
  ['寡言小哥', 'ICL_uranus_zh_male_guayanxiaoge_tob', 'Male', '青年男声，短句低沉，情绪内敛'],
  ['清朗温润', 'ICL_uranus_zh_male_qinglangwenrun_tob', 'Male', '青年男声，清澈温和，适合温润型角色'],
  ['青涩小生', 'ICL_uranus_zh_male_qingsexiaosheng_tob', 'Male', '少年男声，生涩紧张，带一点局促'],
  ['温柔内敛', 'ICL_uranus_zh_male_wenrouneilian_tob', 'Male', '男声，克制内收，音量偏低'],
  ['沉稳优雅', 'ICL_uranus_zh_male_chenwenyouya_tob', 'Male', '成熟男声，从容优雅，节奏稳定'],
  ['活泼爽朗', 'ICL_uranus_zh_male_huoposhuanglang_tob', 'Male', '青年男声，明亮爽快，笑声感强'],
  ['诡异神秘', 'ICL_uranus_zh_male_guiyishenmi_tob', 'Male', '男声，气声与停顿刻意，带诡异感'],
  ['贴心男友', 'ICL_uranus_zh_male_tiexinnanyou_tob', 'Male', '青年男声，关切细语，句尾放轻'],
  ['傲娇女友', 'ICL_uranus_zh_female_aojiaonvyou_tob', 'Female', '少女音，嘴硬心软、尾音上翘'],
  ['病娇姐姐', 'ICL_uranus_zh_female_bingjiaojiejie_tob', 'Female', '女声，柔和中透阴郁，语速偏慢'],
  ['病娇萌妹', 'ICL_uranus_zh_female_bingjiaomengmei_tob', 'Female', '少女音，甜腻偏执，气声黏'],
  ['成熟姐姐', 'ICL_uranus_zh_female_chengshujiejie_tob', 'Female', '女声，低沉从容，有掌控感'],
  ['娇弱萝莉', 'ICL_uranus_zh_female_jiaoruoluoli_tob', 'Female', '幼女声，气声多、音量小，易受惊'],
  ['清冷高雅', 'ICL_uranus_zh_female_qinglenggaoya_tob', 'Female', '女声，清淡疏离，咬字干净'],
  ['甜美娇俏', 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', 'Female', '少女音，明亮甜美，语调跳脱'],
  ['温柔文雅', 'ICL_uranus_zh_female_wenrouwenya_tob', 'Female', '女声，柔和文静，语速平缓'],
  ['妩媚御姐', 'ICL_uranus_zh_female_wumeiyujie_tob', 'Female', '女声，低哑撩人，尾音拖长'],
  ['知性温婉', 'ICL_uranus_zh_female_zhixingwenwan_tob', 'Female', '女声，知性温和，吐字清晰'],
];

const DOUBAO_VOICES: ReadonlyArray<CatalogVoice> = DOUBAO_VOICE_ROWS.map(([name, voiceId, gender, description]) => ({
  voiceId,
  name,
  gender,
  locale: 'zh-CN',
  description,
}));

// 小米 MiMo 的音色名是代号（冰糖/茉莉/苏打/白桦），模型完全无法从名字判断音色，必须写清质地。
const MIMO_VOICES: ReadonlyArray<CatalogVoice> = [
  { voiceId: 'mimo_default', name: 'MiMo · 默认', locale: 'zh-CN', description: '通用中性音色，语气平稳，适合旁白' },
  { voiceId: '冰糖', name: '冰糖', locale: 'zh-CN', gender: 'Female', description: '清甜少女音，音调偏高，尾音轻' },
  { voiceId: '茉莉', name: '茉莉', locale: 'zh-CN', gender: 'Female', description: '柔和女声，气声多、语速慢，偏温柔' },
  { voiceId: '苏打', name: '苏打', locale: 'zh-CN', gender: 'Male', description: '清爽少年音，明亮轻快' },
  { voiceId: '白桦', name: '白桦', locale: 'zh-CN', gender: 'Male', description: '沉稳青年男声，音色偏低、起伏克制' },
  { voiceId: 'Mia', name: 'Mia', locale: 'en-US', gender: 'Female', description: '英语女声，柔和自然' },
  { voiceId: 'Chloe', name: 'Chloe', locale: 'en-US', gender: 'Female', description: '英语女声，明亮清晰' },
  { voiceId: 'Milo', name: 'Milo', locale: 'en-US', gender: 'Male', description: '英语男声，年轻清爽' },
  { voiceId: 'Dean', name: 'Dean', locale: 'en-US', gender: 'Male', description: '英语男声，低沉厚实' },
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
