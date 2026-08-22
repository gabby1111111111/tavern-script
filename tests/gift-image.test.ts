import { composeGiftImagePrompt } from '../src/杠杠の生图机/gift-prompt';
import type { GiftContextSnapshot } from '../src/杠杠の生图机/gift-context';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const settings = {
  enabled: true,
  triggerInterval: 'manual' as const,
  requestMode: 'auto' as const,
  jsonReferenceField: 'images' as const,
  identityPrompt: '角色身份来自参考图。',
  templatePrompt: '模板图只提供动作和构图。',
  scenePrompt: '正文决定服装和氛围。',
  stylePrompt: '2.5D 精致数字绘画风。',
  outputPrompt: '只输出一条中文提示词，保持纯 SFW。',
};
const context: GiftContextSnapshot = {
  chatId: 'chat-test',
  messageId: 12,
  swipeId: 0,
  floor: 12,
  characterName: '角色卡',
  characterDescription: '角色简介',
  characterPersonality: '角色人设',
  characterScenario: '公寓场景',
  recentMessages: [
    { messageId: 12, role: 'assistant', name: '角色卡', message: '傍晚回到公寓，角色换上宽松针织外套。' },
  ],
  currentAssistantMessage: '傍晚回到公寓，角色换上宽松针织外套。',
};
const prompt = composeGiftImagePrompt(settings, context);
assert(prompt.includes('角色身份来自参考图'), '礼物 CG prompt 应明确角色参考图的职责');
assert(prompt.includes('模板图只提供动作和构图'), '礼物 CG prompt 应明确模板图的职责');
assert(prompt.includes('最近聊天消息'), '礼物 CG prompt 应包含当前聊天上下文');
assert(prompt.includes('纯 SFW'), '礼物 CG prompt 应包含安全边界');
assert(!prompt.includes('image2store://'), '礼物 CG prompt 不应引入旧图库引用');

console.info('<杠杠の生图机> gift image tests passed');
