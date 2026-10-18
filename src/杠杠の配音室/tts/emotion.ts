/**
 * 对外只暴露一套情绪词（中文），对内翻译成各家 TTS 自己的机制：
 * - MiniMax：`voice_setting.emotion` 七档枚举
 * - 豆包：`additions.context_texts[0]` 自然语言"说戏"（短词无效，必须写画面）
 * - 小米 MiMo：`messages[0]` 导演台本里的一句语气指令
 * - Fish S2：正文里的 `[tag]` 内联标签（从标签生效到下一个标签/句末）
 * - Edge / OpenAI 兼容：没有情绪通道，直接忽略
 *
 * 归一化放在这一层，任何上游写法（AI 写的中文、用户手填的英文、配音表里的旧值）都先收敛成 EmotionKey。
 */
export type EmotionKey = 'calm' | 'gentle' | 'happy' | 'coquettish' | 'sad' | 'angry' | 'afraid' | 'cold';

export const EMOTION_LABELS: Readonly<Record<EmotionKey, string>> = {
  calm: '平静',
  gentle: '温柔',
  happy: '开心',
  coquettish: '撒娇',
  sad: '难过',
  angry: '生气',
  afraid: '害怕',
  cold: '冷淡',
};

const EMOTION_ALIASES: ReadonlyArray<readonly [EmotionKey, readonly string[]]> = [
  ['calm', ['平静', '平常', '自然', 'calm', 'neutral', 'normal']],
  ['gentle', ['温柔', '温和', '轻柔', 'gentle', 'soft', 'tender']],
  ['happy', ['开心', '高兴', '喜悦', '兴奋', '愉快', '欢快', 'happy', 'joyful', 'excited']],
  ['coquettish', ['撒娇', '甜腻', '黏人', '甜', 'coquettish', 'sweet', 'flirty']],
  ['sad', ['难过', '悲伤', '伤心', '低落', '哭', '哽咽', 'sad', 'sorrow', 'crying']],
  ['angry', ['生气', '愤怒', '恼怒', '凶', 'angry', 'furious']],
  ['afraid', ['害怕', '恐惧', '惊恐', '发抖', 'afraid', 'fearful', 'scared']],
  ['cold', ['冷淡', '冷漠', '疏离', '高冷', '冷', 'cold', 'cold tone', 'distant']],
];

/** 把任意情绪写法收敛成 8 个标准键；认不出来返回 null（表示"不指定"）。 */
export function normalizeEmotionKey(value: unknown): EmotionKey | null {
  const text = String(value ?? '')
    .trim()
    .toLocaleLowerCase();
  if (!text) return null;
  for (const [key, aliases] of EMOTION_ALIASES) {
    if (aliases.some(alias => text === alias || text.includes(alias))) return key;
  }
  return null;
}

/** MiniMax 只有 7 档，温柔/冷淡/平静都只能落到 neutral。 */
export const MINIMAX_EMOTION: Readonly<Record<EmotionKey, string>> = {
  calm: 'neutral',
  gentle: 'neutral',
  happy: 'happy',
  coquettish: 'happy',
  sad: 'sad',
  angry: 'angry',
  afraid: 'fearful',
  cold: 'neutral',
};

/** 豆包吃"画面"，短词几乎无效；每条都要写清声音质感与身体感。 */
export const DOUBAO_CONTEXT: Readonly<Record<EmotionKey, string>> = {
  calm: '用平静自然的语气，语速平稳，情绪内敛，像日常说话',
  gentle: '用温柔低缓的声音，句尾放轻，气声略多，像在耳边轻声安慰人',
  happy: '用明亮上扬的语气，情绪饱满，像刚听到好消息，语速稍快',
  coquettish: '用甜蜜撒娇的声音，像在跟男朋友撒娇，语调上扬，尾音拖长',
  sad: '用哭泣的声音，边哭边说，很伤心，声音颤抖带着哽咽',
  angry: '用愤怒的语气，非常不满，声音拔高，咬字用力',
  afraid: '用害怕的声音，微微发抖，气息不稳，说话断断续续',
  cold: '用冷淡疏离的语气，音调平直，几乎没有起伏，不投入情绪',
};

/** MiMo 的导演台本：一句可执行的表演指令。 */
export const MIMO_STYLE: Readonly<Record<EmotionKey, string>> = {
  calm: '语气：平静，语速正常，情绪收敛。',
  gentle: '语气：温柔低缓，尾音放轻，气声略多，像在安抚人。',
  happy: '语气：明亮愉悦，语速稍快，句尾上扬。',
  coquettish: '语气：撒娇，尾音上扬拖长，带一点黏人的鼻音。',
  sad: '语气：难过，语速放慢，气息断续，像在忍住哭。',
  angry: '语气：生气，咬字用力，语速偏快，音量抬高。',
  afraid: '语气：害怕，声音发抖，气息不稳，停顿多。',
  cold: '语气：冷淡疏离，音调平直，不投入情绪。',
};

/** Fish S2 的内联标签（英文体系），插在每句开头。 */
export const FISH_TAG: Readonly<Record<EmotionKey, string>> = {
  calm: '[calm]',
  gentle: '[soft voice]',
  happy: '[happy]',
  coquettish: '[happy]',
  sad: '[sad]',
  angry: '[angry]',
  afraid: '[scared]',
  cold: '[monotone]',
};

export const EMOTION_KEYS: readonly EmotionKey[] = [
  'calm',
  'gentle',
  'happy',
  'coquettish',
  'sad',
  'angry',
  'afraid',
  'cold',
];
