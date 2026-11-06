import type { CastingContext, ContextMessage, VoiceOption } from './types';

const DEFAULT_RECENT_MESSAGE_COUNT = 10;
const MAX_RECENT_MESSAGE_COUNT = 50;
const MAX_CARD_FIELD_LENGTH = 20_000;
const MAX_MESSAGE_LENGTH = 8_000;

type CharacterCardLike = {
  name?: unknown;
  description?: unknown;
  personality?: unknown;
  scenario?: unknown;
  avatar?: unknown;
};

type ChatMessageLike = {
  message_id?: unknown;
  name?: unknown;
  role?: unknown;
  message?: unknown;
  is_hidden?: unknown;
};

export type ContextRuntime = {
  getCharData: (name: 'current') => unknown | null;
  getCurrentCharacterName: () => string | null;
  getCurrentCharacterId: () => string | null;
  getLastMessageId: () => number;
  getChatMessages: (
    range: string | number,
    options?: {
      role?: 'all' | 'system' | 'assistant' | 'user';
      hide_state?: 'all' | 'hidden' | 'unhidden';
      include_swipes?: false;
    },
  ) => ChatMessageLike[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function limitedText(value: unknown, limit: number): string {
  return textValue(value).trim().slice(0, limit);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function normalizedCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECENT_MESSAGE_COUNT;
  return Math.min(MAX_RECENT_MESSAGE_COUNT, Math.max(1, Math.floor(value)));
}

function normalizeRole(value: unknown): ContextMessage['role'] {
  return value === 'system' || value === 'assistant' || value === 'user' ? value : 'assistant';
}

export function deriveCharacterKey(
  card: CharacterCardLike | null | undefined,
  currentCharacterId = '',
  currentCharacterName = '',
): string {
  const record = card ?? {};
  const stableId = textValue(record.avatar).trim() || textValue(currentCharacterId).trim();
  if (stableId) return `character:${stableId}`;
  const name = textValue(currentCharacterName).trim() || textValue(record.name).trim();
  return `character:${name || 'unknown'}`;
}

export function buildCastingContext(
  card: CharacterCardLike | null | undefined,
  recentMessages: ChatMessageLike[],
  options: { characterId?: string; characterName?: string } = {},
): CastingContext {
  const record = card ?? {};
  const characterName = limitedText(options.characterName, 500) || limitedText(record.name, 500) || '当前角色';
  const contextMessages = recentMessages
    .filter(message => message && message.is_hidden !== true)
    .map((message, index): ContextMessage => ({
      messageId: numberValue(message.message_id, index),
      role: normalizeRole(message.role),
      name: limitedText(message.name, 300),
      message: limitedText(message.message, MAX_MESSAGE_LENGTH),
    }))
    .filter(message => message.message.length > 0);

  return {
    characterKey: deriveCharacterKey(record, options.characterId, characterName),
    characterName,
    characterDescription: limitedText(record.description, MAX_CARD_FIELD_LENGTH),
    characterPersonality: limitedText(record.personality, MAX_CARD_FIELD_LENGTH),
    scenario: limitedText(record.scenario, MAX_CARD_FIELD_LENGTH),
    recentMessages: contextMessages,
  };
}

function resolveContextRuntime(runtime?: Partial<ContextRuntime>): ContextRuntime {
  const globalRuntime = globalThis as typeof globalThis & {
    getCharData?: ContextRuntime['getCharData'];
    getCurrentCharacterName?: ContextRuntime['getCurrentCharacterName'];
    getCurrentCharacterId?: ContextRuntime['getCurrentCharacterId'];
    getLastMessageId?: ContextRuntime['getLastMessageId'];
    getChatMessages?: ContextRuntime['getChatMessages'];
  };
  const resolved: Partial<ContextRuntime> = {
    getCharData: runtime?.getCharData ?? globalRuntime.getCharData,
    getCurrentCharacterName: runtime?.getCurrentCharacterName ?? globalRuntime.getCurrentCharacterName,
    getCurrentCharacterId: runtime?.getCurrentCharacterId ?? globalRuntime.getCurrentCharacterId,
    getLastMessageId: runtime?.getLastMessageId ?? globalRuntime.getLastMessageId,
    getChatMessages: runtime?.getChatMessages ?? globalRuntime.getChatMessages,
  };
  if (
    typeof resolved.getCharData !== 'function' ||
    typeof resolved.getCurrentCharacterName !== 'function' ||
    typeof resolved.getCurrentCharacterId !== 'function' ||
    typeof resolved.getLastMessageId !== 'function' ||
    typeof resolved.getChatMessages !== 'function'
  ) {
    throw new Error('杠杠の配音台需要 Tavern Helper 的角色卡与聊天接口');
  }
  return resolved as ContextRuntime;
}

export function readCurrentCastingContext(
  recentMessageCount = DEFAULT_RECENT_MESSAGE_COUNT,
  runtime?: Partial<ContextRuntime>,
): CastingContext {
  const helper = resolveContextRuntime(runtime);
  const count = normalizedCount(recentMessageCount);
  const card = helper.getCharData('current');
  const characterName = helper.getCurrentCharacterName() ?? '';
  const characterId = helper.getCurrentCharacterId() ?? '';
  const lastMessageId = Math.max(0, numberValue(helper.getLastMessageId(), 0));
  const firstMessageId = Math.max(0, lastMessageId - count + 1);
  const range = `${firstMessageId}-${lastMessageId}`;
  const messages = helper.getChatMessages(range, { hide_state: 'unhidden', include_swipes: false });
  return buildCastingContext(card && isRecord(card) ? card : null, messages, { characterId, characterName });
}

/**
 * Keep only the voice metadata that can be sent to the casting model. Provider
 * profiles and their credentials are deliberately not accepted by this function.
 */
export function sanitizeVoiceOptions(voices: VoiceOption[]): VoiceOption[] {
  const seen = new Set<string>();
  const result: VoiceOption[] = [];
  voices.forEach(voice => {
    if (!voice || typeof voice.providerProfileId !== 'string' || typeof voice.voiceId !== 'string') return;
    const providerProfileId = voice.providerProfileId.trim();
    const voiceId = voice.voiceId.trim();
    const name = typeof voice.name === 'string' ? voice.name.trim() : '';
    if (!providerProfileId || !voiceId || !name) return;
    const key = `${providerProfileId}\u0000${voiceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const option: VoiceOption = { providerProfileId, voiceId, name };
    if (typeof voice.locale === 'string' && voice.locale.trim()) option.locale = voice.locale.trim().slice(0, 80);
    if (typeof voice.gender === 'string' && voice.gender.trim()) option.gender = voice.gender.trim().slice(0, 80);
    if (typeof voice.description === 'string' && voice.description.trim()) {
      option.description = voice.description.trim().slice(0, 500);
    }
    if (Array.isArray(voice.tags)) {
      option.tags = [
        ...new Set(
          voice.tags
            .filter(tag => typeof tag === 'string')
            .map(tag => tag.trim())
            .filter(Boolean),
        ),
      ].slice(0, 24);
    }
    result.push(option);
  });
  return result;
}

export function buildCastingRequestPayload(context: CastingContext, voices: VoiceOption[]) {
  return {
    context: {
      characterKey: context.characterKey,
      characterName: context.characterName,
      characterDescription: context.characterDescription,
      characterPersonality: context.characterPersonality,
      scenario: context.scenario,
      recentMessages: context.recentMessages.map(message => ({ ...message })),
    },
    voices: sanitizeVoiceOptions(voices),
  };
}

export function createCastingInputSignature(
  context: CastingContext,
  voices: VoiceOption[],
  recentMessageCount: number,
  enabledProfiles: ReadonlyArray<{ id: string; type: string }>,
): string {
  const payload = buildCastingRequestPayload(context, voices);
  const profiles = enabledProfiles
    .map(profile => ({ id: profile.id.trim(), type: profile.type.trim() }))
    .filter(profile => profile.id && profile.type)
    .sort((left, right) => `${left.id}\u0000${left.type}`.localeCompare(`${right.id}\u0000${right.type}`));
  return JSON.stringify({ recentMessageCount: normalizedCount(recentMessageCount), profiles, ...payload });
}
