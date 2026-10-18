import type { VoiceOption } from '../types';

/**
 * Fish 白名单（40 条，用户手工筛选定稿，2026-10-18）。
 *
 * Fish 音色市场是 UGC：上千条标题杂乱、分页还不稳定。改成固定白名单后
 * 不联网、不吃分页，AI 配音导演只会在这 40 条里挑。
 * 原始清单：`.workbuddy/voice-audition/fish-whitelist-final-40.txt`
 */
export type FishWhitelistVoice = Omit<VoiceOption, 'providerProfileId'>;

export const FISH_WHITELIST: ReadonlyArray<FishWhitelistVoice> = [
  { voiceId: '4f25ceb3b95241308fd5c2bfe144f6de', name: '女·初恋少女', locale: 'zh-CN', gender: 'Female', description: '［女声］18岁校园感，音色清澈通透，轻气声、句尾干净，书卷气' },
  { voiceId: 'd586e5d1aea54f3bb121f4882fff97c0', name: '女·少女漫女主', locale: 'zh-CN', gender: 'Female', description: '［女声］甜美明亮、灵动跳脱，撒娇黏人，低声像耳边吹气' },
  { voiceId: '7d841ebceee6424b92f9c52cb8c849a6', name: '女·甜妹', locale: 'zh-CN', gender: 'Female', description: '［女声］甜度高、撒娇感强，亲昵可爱' },
  { voiceId: '13106103983a4646b38fed73dd475310', name: '女·清冷知性', locale: 'zh-CN', gender: 'Female', description: '［女声］清澈带冷感，克制客观，适合学霸/冷淡女主' },
  { voiceId: '0ac8995eeb9446b7ac1ad65347d3dd6f', name: '女·古风公主', locale: 'zh-CN', gender: 'Female', description: '［女声］矜贵端庄、字正腔圆，对心上人口是心非的傲娇' },
  { voiceId: '7b0ed69df2984a0a9268c0cc36421183', name: '女·年上姐姐', locale: 'zh-CN', gender: 'Female', description: '［女声］磁性耳语、轻笑声，亲密舒适，撩而不俗' },
  { voiceId: '5cf52382f1a348cfb7c83c0cc11b873a', name: '女·甜御姐', locale: 'zh-CN', gender: 'Female', description: '［女声］甜美而带磁性，轻快自信，一丝俏皮魅惑' },
  { voiceId: 'eabda5567d604cd7bbf162e7c3f6bbe4', name: '女·病娇', locale: 'zh-CN', gender: 'Female', description: '［女声］软糯气声贴身低语，音量小、气息重，依恋到不安' },
  { voiceId: '3c34056cbfa647339b559d64304f0901', name: '女·哄睡御姐', locale: 'zh-CN', gender: 'Female', description: '［女声］温柔轻声伴眠，ASMR 贴耳，慢' },
  { voiceId: '08b3334713f940c3ba560a83c6e45844', name: '女·温柔姐姐', locale: 'zh-CN', gender: 'Female', description: '［女声］甜美亲和，讲故事/哄睡都稳' },
  { voiceId: '24b3862c09434930ace0091e5548ec18', name: '男·宠溺青叔', locale: 'zh-CN', gender: 'Male', description: '［温柔宠溺］28岁低音，dom 感但温柔，轻呼吸+轻笑（最贴乙游）' },
  { voiceId: 'c2b3fc06d91d49d8b31d50f96b690837', name: '男·温柔宠溺青年音', locale: 'zh-CN', gender: 'Male', description: '［温柔宠溺］磁性带宠溺，最直给的一条' },
  { voiceId: '8f9240ff05ea4b4fb4f78a706435758f', name: '男·深情暖男青叔音', locale: 'zh-CN', gender: 'Male', description: '［温柔宠溺］磁性温柔，语气诚恳' },
  { voiceId: 'f7696d0c2c7c41219a41fb599b0a35ad', name: '男·温柔男友苏音', locale: 'zh-CN', gender: 'Male', description: '［温柔宠溺］清润绅士，都市职场型' },
  { voiceId: '4cb2a7f8377640fb97c7849e19d70d65', name: '男·陪伴青年', locale: 'zh-CN', gender: 'Male', description: '［温柔宠溺］温柔细腻，深夜陪伴感' },
  { voiceId: '66448843fdbd4e4fbddb30b82fb1e1a0', name: '男·温柔青攻', locale: 'zh-CN', gender: 'Male', description: '［温柔宠溺］温柔磁性里带一点玩味' },
  { voiceId: '2949b4d041e449be910bdfff8854c9c0', name: '男·高冷音', locale: 'zh-CN', gender: 'Male', description: '［清冷禁欲］冷静不悦 ↔ 温柔宠溺，双面切换' },
  { voiceId: 'dd9124d812334ca6882b7746ed5676bb', name: '男·清冷儒雅青年音', locale: 'zh-CN', gender: 'Male', description: '［清冷禁欲］深沉内敛，温柔而坚定' },
  { voiceId: 'cae4e4ef84924f58ace3d1468ac608b2', name: '男·清冷温柔男声', locale: 'zh-CN', gender: 'Male', description: '［清冷禁欲］温柔深情，安慰感强' },
  { voiceId: 'd8f6577a6996404cac98c6d2430dcbdd', name: '男·清冷男声', locale: 'zh-CN', gender: 'Male', description: '［清冷禁欲］略带磁性，深夜谈心' },
  { voiceId: 'd8aecd0df61a4896bb6c0a8d9fb743bd', name: '男·青涩少年（坚定向）', locale: 'zh-CN', gender: 'Male', description: '［少年感］17岁干净清亮，关键处变坚定' },
  { voiceId: 'cca21fdc85a54dc3863afb4ddb1df343', name: '男·撒娇少年', locale: 'zh-CN', gender: 'Male', description: '［少年感］音色可爱，亲昵黏人' },
  { voiceId: '657346baf0fd4e12b94661bdcf897758', name: '男·撒娇少年（霸道版）', locale: 'zh-CN', gender: 'Male', description: '［少年感］撒娇里带占有，情绪起伏大' },
  { voiceId: '103a97a4bd974a38ba57664a9ca72c50', name: '男·青涩少年（治愈向）', locale: 'zh-CN', gender: 'Male', description: '［少年感］朝气+温柔，共情力强' },
  { voiceId: 'e0120449c30541af92cf6f591a9f02e8', name: '男·腹黑少年', locale: 'zh-CN', gender: 'Male', description: '［少年感］小狐狸型，适合藏着心思的角色' },
  { voiceId: '176b48d588de4933bc2f526e05134930', name: '男·霸道总裁', locale: 'zh-CN', gender: 'Male', description: '［霸总强势］磁性自信、沉稳深情，专为此类设计' },
  { voiceId: '8cc69d6ceef744b08f1a39ed4fc64982', name: '男·霸总声线', locale: 'zh-CN', gender: 'Male', description: '［霸总强势］深沉严厉，压迫感强' },
  { voiceId: 'e0da26edfacb4a3aa43b62cff07b5063', name: '男·霸总（低音厚实）', locale: 'zh-CN', gender: 'Male', description: '［霸总强势］30岁胸腔低音，低中频饱满' },
  { voiceId: 'ba40b695bde64f3a9cd7091d4e026a10', name: '男·低音炮（硬）', locale: 'zh-CN', gender: 'Male', description: '［霸总强势］深沉严肃有权威，力量型' },
  { voiceId: 'e3755027a6c2456988e88b50329496bf', name: '男·醋意男友', locale: 'zh-CN', gender: 'Male', description: '［病娇占有］撒娇+占有欲，语气生动' },
  { voiceId: 'd7edc6e5dd1a46f3bad1e0cede93c09b', name: '男·病娇公子', locale: 'zh-CN', gender: 'Male', description: '［病娇占有］玉面公子，清朗却病态偏执（古风病娇）' },
  { voiceId: '973dfabd5f504bb9801e37f3a07c372c', name: '男·亲密低语', locale: 'zh-CN', gender: 'Male', description: '［病娇占有］低沉耳语，张力强、危险感' },
  { voiceId: 'dbb78153309442f9a81cf3d11ddd7876', name: '男·守护系', locale: 'zh-CN', gender: 'Male', description: '［病娇占有］温柔→严肃→略带威胁，三档切换' },
  { voiceId: '9927a47b9bd0490abaa81dd3b45dc0dc', name: '男·慵懒轻熟', locale: 'zh-CN', gender: 'Male', description: '［慵懒痞帅］磁性低沉，亲密深情氛围' },
  { voiceId: '32f63907d01246959ad8d9c71fcff5ed', name: '男·颓废侦探', locale: 'zh-CN', gender: 'Male', description: '［慵懒痞帅］30岁，慵懒冷静、极低沉' },
  { voiceId: 'ee0a2c89d5c04288a695e741a748b8a9', name: '男·磁性轻语', locale: 'zh-CN', gender: 'Male', description: '［慵懒痞帅］沉稳磁性+温柔玩味' },
  { voiceId: 'f83935501c604e7d9766333d3b03a8d0', name: '男·低音炮（软）', locale: 'zh-CN', gender: 'Male', description: '［慵懒痞帅］低沉但松软亲近，私密场景' },
  { voiceId: '7236048f227847489e64ecab6e0e9ca2', name: '男·年上贴耳', locale: 'zh-CN', gender: 'Male', description: '［年上沉稳］低沉贴耳、语速慢、气息明显、尾音压情绪' },
  { voiceId: 'e000ef5eac7b455cb0754dd9dbbebf22', name: '男·青叔', locale: 'zh-CN', gender: 'Male', description: '［年上沉稳］低沉磁性中年音，旁白/对白通吃' },
  { voiceId: '642aa2ea091347c5a3d9da0d68f5dfbc', name: '男·都市大叔', locale: 'zh-CN', gender: 'Male', description: '［年上沉稳］生活气，无奈里带宠溺' },
];

/** 白名单 +（可选）Profile 自己填的默认音色：目录、试音、配音表共用同一份。 */
export function getFishWhitelistCatalog(providerProfileId: string, defaultVoiceId = ''): VoiceOption[] {
  const result = FISH_WHITELIST.map(voice => ({ providerProfileId, ...voice }));
  const fallback = String(defaultVoiceId || '').trim();
  if (fallback && !result.some(voice => voice.voiceId === fallback)) {
    result.unshift({
      providerProfileId,
      voiceId: fallback,
      name: fallback,
      description: 'Profile 默认音色（不在白名单内）',
    });
  }
  return result;
}
