import { cleanInlineImageMessage } from './marker';

export type GiftContextMessage = {
  messageId: number;
  role: 'assistant' | 'user';
  name: string;
  message: string;
};

export type GiftContextSnapshot = {
  chatId: string;
  messageId: number | null;
  swipeId: number | null;
  floor: number | null;
  characterName: string | null;
  characterDescription: string;
  characterPersonality: string;
  characterScenario: string;
  recentMessages: GiftContextMessage[];
  currentAssistantMessage: string;
};

const MAX_RECENT_MESSAGES = 12;
const MAX_FIELD_LENGTH = 2_000;

function clip(value: unknown, max = MAX_FIELD_LENGTH): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function currentSwipeId(messageId: number | null): number | null {
  if (messageId === null) return null;
  const message = getChatMessages(messageId, { include_swipes: true })[0];
  return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}

function currentCharacterData(): SillyTavern.v1CharData | null {
  try {
    return getCharData('current');
  } catch {
    return null;
  }
}

export function collectGiftContext(): GiftContextSnapshot {
  const chatId = SillyTavern.getCurrentChatId();
  const lastMessageId = getLastMessageId();
  const firstMessageId = Math.max(0, lastMessageId - MAX_RECENT_MESSAGES + 1);
  const messages = getChatMessages(`${firstMessageId}-${lastMessageId}`)
    .filter(message => message.role === 'assistant' || message.role === 'user')
    .slice(-MAX_RECENT_MESSAGES)
    .map(message => ({
      messageId: message.message_id,
      role: message.role as 'assistant' | 'user',
      name: clip(message.name, 120),
      message: clip(cleanInlineImageMessage(message.message)),
    }));
  const current = [...messages].reverse().find(message => message.role === 'assistant');
  const character = currentCharacterData();
  return {
    chatId,
    messageId: current?.messageId ?? null,
    swipeId: currentSwipeId(current?.messageId ?? null),
    floor: current?.messageId ?? null,
    characterName: getCurrentCharacterName(),
    characterDescription: clip(character?.description),
    characterPersonality: clip(character?.personality),
    characterScenario: clip(character?.scenario),
    recentMessages: messages,
    currentAssistantMessage: current?.message ?? '',
  };
}

export function formatGiftContext(context: GiftContextSnapshot): string {
  const recent = context.recentMessages
    .map(message => `[${message.role}] ${message.name || '未知'}（楼层 ${message.messageId}）：\n${message.message}`)
    .join('\n\n');
  return [
    `当前聊天 ID：${context.chatId}`,
    `当前楼层：${context.floor ?? '无'}`,
    `当前角色卡：${context.characterName ?? '无'}`,
    context.characterDescription ? `角色卡简介：\n${context.characterDescription}` : '',
    context.characterPersonality ? `角色卡人设：\n${context.characterPersonality}` : '',
    context.characterScenario ? `当前场景设定：\n${context.characterScenario}` : '',
    recent ? `最近聊天消息：\n${recent}` : '最近聊天消息：无',
  ]
    .filter(Boolean)
    .join('\n\n');
}
