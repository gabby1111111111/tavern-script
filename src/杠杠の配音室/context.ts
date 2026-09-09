import type { CastingContext, ContextMessage, VoiceOption } from './types';

const DEFAULT_RECENT_MESSAGE_COUNT = 5;
const MAX_RECENT_MESSAGE_COUNT = 5;
const MAX_CARD_FIELD_LENGTH = 2_500;
const MAX_EXAMPLE_LENGTH = 1_000;
const MAX_PERSONA_TEXT_LENGTH = 1_600;
const MAX_WORLD_BOOK_ENTRY_LENGTH = 800;
const MAX_WORLD_BOOK_ENTRIES = 8;
const MAX_WORLD_BOOK_TOTAL_LENGTH = 4_000;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_VOICE_OPTIONS = 64;
const MAX_VOICE_DESCRIPTION_LENGTH = 180;
const MAX_VOICE_TAG_LENGTH = 40;
const MAX_CASTING_PAYLOAD_LENGTH = 48_000;

type CharacterCardLike = {
  name?: unknown;
  description?: unknown;
  personality?: unknown;
  scenario?: unknown;
  first_mes?: unknown;
  mes_example?: unknown;
  avatar?: unknown;
  data?: unknown;
};

type ChatMessageLike = {
  message_id?: unknown;
  name?: unknown;
  role?: unknown;
  message?: unknown;
  mes?: unknown;
  is_hidden?: unknown;
};

type PersonaLike = {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  /** Local-only binding; never included in the outbound persona object. */
  lorebook?: unknown;
};

type EffectiveCardFieldsLike = {
  description?: unknown;
  personality?: unknown;
  scenario?: unknown;
  firstMessage?: unknown;
  mesExamples?: unknown;
};

/**
 * The adapter must return only entries that the host has already determined to
 * be both bound to the current persona/character and active for this capture.
 * This module deliberately does not inspect worldbook catalogs or infer
 * activation from global/chat books. A missing or failing adapter is treated
 * as an empty snapshot so an unverified worldbook is never sent to the model.
 */
export type ActivatedBoundWorldbooks = {
  personaWorldbook?: unknown;
  characterWorldbook?: unknown;
};

export type ActivatedBoundWorldbooksAdapter = (input: {
  readonly characterKey: string;
  readonly characterName: string;
  readonly persona: CastingContext['persona'];
  readonly characterDescription: string;
  readonly characterPersonality: string;
  readonly scenario: string;
}) => ActivatedBoundWorldbooks | Promise<ActivatedBoundWorldbooks>;

type WorldInfoEventTypesLike = {
  WORLDINFO_ENTRIES_LOADED?: unknown;
  WORLDINFO_SCAN_DONE?: unknown;
};

type WorldInfoHostLike = {
  getContext?: () => unknown;
  eventTypes?: WorldInfoEventTypesLike;
  maxContext?: unknown;
  powerUserSettings?: {
    world_info_include_names?: unknown;
  };
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, string>,
  ) => Promise<unknown>;
};

type WorldInfoListenerHandleLike = {
  stop?: () => void;
};

type WorldInfoEventOnLike = (
  eventType: string,
  listener: (payload: unknown) => void,
) => WorldInfoListenerHandleLike | undefined;

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
  getPersona?: (name: 'current') => unknown | null;
  /** Optional host-provided effective fields for shallow/lazy cards. */
  getEffectiveCharacterCardFields?: () => unknown;
  /** Character-bound worldbook names; used only to classify source-owned active entries. */
  getCharWorldbookNames?: (name: 'current') => unknown;
  /** Optional world-info scanner override for narrow tests or a matching host adapter. */
  getWorldInfoPrompt?: WorldInfoHostLike['getWorldInfoPrompt'];
  /** Optional Tavern Helper event bridge override for narrow tests. */
  getWorldInfoEventOn?: WorldInfoEventOnLike;
  /** Optional event constants override for narrow tests. */
  getWorldInfoEventTypes?: WorldInfoEventTypesLike;
  /** Optional max context override for narrow tests. */
  getWorldInfoMaxContext?: number;
  /** Optional world-info name scanning override for narrow tests. */
  getWorldInfoIncludeNames?: boolean;
  /** Source-restricted active lore snapshot override; never falls back to catalog reads. */
  getActivatedBoundWorldbooks?: ActivatedBoundWorldbooksAdapter;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function normalizedCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RECENT_MESSAGE_COUNT;
  return Math.min(MAX_RECENT_MESSAGE_COUNT, Math.max(0, Math.floor(value)));
}

function normalizeRole(value: unknown): ContextMessage['role'] {
  return value === 'system' || value === 'assistant' || value === 'user' ? value : 'assistant';
}

function redactSensitiveText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(
      /((?:api[\s_-]*key|access[\s_-]*key|secret(?:[\s_-]*key)?|authorization|password|token)\s*[:=]\s*)(["']?)[^\s"',;\]}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED]');
}

function limitedText(value: unknown, limit: number): string {
  return redactSensitiveText(value).trim().slice(0, limit);
}

function credentialLike(value: string): boolean {
  return /(?:api[\s_-]*key|access[\s_-]*key|secret|authorization|password|token)\s*[:=]|\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i.test(
    value,
  );
}

function safeIdentifier(value: unknown, limit: number): string {
  const identifier = textValue(value).trim().slice(0, limit);
  return identifier && !credentialLike(identifier) ? identifier : '';
}

function recordData(record: CharacterCardLike): Record<string, unknown> {
  return isRecord(record.data) ? record.data : {};
}

function effectiveFields(value: unknown): EffectiveCardFieldsLike {
  return isRecord(value) ? value : {};
}

function sanitizePersona(value: unknown): CastingContext['persona'] {
  if (!isRecord(value)) return null;
  const persona: NonNullable<CastingContext['persona']> = {
    name: limitedText(value.name, 240),
    title: limitedText(value.title, 240),
    description: limitedText(value.description, MAX_PERSONA_TEXT_LENGTH),
  };
  return persona.name || persona.title || persona.description ? persona : null;
}

function sanitizeWorldbookContents(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const result: string[] = [];
  let total = 0;
  for (const item of source) {
    if (result.length >= MAX_WORLD_BOOK_ENTRIES || total >= MAX_WORLD_BOOK_TOTAL_LENGTH) break;
    const content = isRecord(item) ? item.content : item;
    const remaining = Math.min(MAX_WORLD_BOOK_ENTRY_LENGTH, MAX_WORLD_BOOK_TOTAL_LENGTH - total);
    const safeContent = limitedText(content, remaining);
    if (!safeContent) continue;
    result.push(safeContent);
    total += safeContent.length;
  }
  return result;
}

function readPersonaRecord(runtime: ContextRuntime): PersonaLike | null {
  if (typeof runtime.getPersona !== 'function') return null;
  try {
    const persona = runtime.getPersona('current');
    return isRecord(persona) ? persona : null;
  } catch {
    return null;
  }
}

function resolveCardFields(runtime: ContextRuntime): EffectiveCardFieldsLike {
  if (typeof runtime.getEffectiveCharacterCardFields !== 'function') return {};
  try {
    return effectiveFields(runtime.getEffectiveCharacterCardFields());
  } catch {
    return {};
  }
}

function unknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (isRecord(value)) return Object.values(value);
  return [];
}

function worldbookIdentity(value: unknown): string {
  if (!isRecord(value)) return '';
  const world = safeIdentifier(value.world, 500);
  const uid = value.uid;
  if (!world || typeof uid !== 'number' || !Number.isFinite(uid)) return '';
  return `${world}\u0000${Math.trunc(uid)}`;
}

function worldbookIdentitySet(value: unknown): Set<string> {
  const result = new Set<string>();
  for (const entry of unknownArray(value)) {
    const identity = worldbookIdentity(entry);
    if (identity) result.add(identity);
  }
  return result;
}

function boundWorldbookNames(runtime: ContextRuntime): {
  persona: Set<string>;
  character: Set<string>;
} {
  const globalRuntime = globalThis as typeof globalThis & Record<string, unknown>;
  const getCharWorldbookNames =
    runtime.getCharWorldbookNames ?? (globalRuntime.getCharWorldbookNames as ContextRuntime['getCharWorldbookNames']);
  const persona = new Set<string>();
  const character = new Set<string>();

  const personaRecord = readPersonaRecord(runtime);
  const personaWorldbook = personaRecord ? safeIdentifier(personaRecord.lorebook, 500) : '';
  if (personaWorldbook) persona.add(personaWorldbook);

  if (typeof getCharWorldbookNames === 'function') {
    try {
      const names = getCharWorldbookNames('current');
      if (isRecord(names)) {
        const primary = safeIdentifier(names.primary, 500);
        if (primary) character.add(primary);
        for (const additional of Array.isArray(names.additional) ? names.additional : []) {
          const name = safeIdentifier(additional, 500);
          if (name) character.add(name);
        }
      }
    } catch {
      // A missing character binding is safe to treat as no character lore.
    }
  }

  return { persona, character };
}

function worldInfoHost(runtime: ContextRuntime): WorldInfoHostLike {
  const globalRuntime = globalThis as typeof globalThis & Record<string, unknown>;
  const exportedHost = isRecord(globalRuntime.SillyTavern) ? (globalRuntime.SillyTavern as WorldInfoHostLike) : {};
  let host = exportedHost;
  if (typeof exportedHost.getContext === 'function') {
    try {
      const context = exportedHost.getContext.call(exportedHost);
      if (isRecord(context)) host = context as WorldInfoHostLike;
    } catch {
      // The direct export remains a safe fallback for Helper's iframe bridge.
    }
  }
  return {
    getContext: exportedHost.getContext,
    eventTypes: runtime.getWorldInfoEventTypes ?? host.eventTypes ?? exportedHost.eventTypes,
    maxContext: runtime.getWorldInfoMaxContext ?? host.maxContext ?? exportedHost.maxContext,
    powerUserSettings: host.powerUserSettings ?? exportedHost.powerUserSettings,
    getWorldInfoPrompt: runtime.getWorldInfoPrompt ?? host.getWorldInfoPrompt ?? exportedHost.getWorldInfoPrompt,
  };
}

function worldInfoEventOn(runtime: ContextRuntime): WorldInfoEventOnLike | null {
  if (runtime.getWorldInfoEventOn) return runtime.getWorldInfoEventOn;
  const globalRuntime = globalThis as typeof globalThis & Record<string, unknown>;
  return typeof globalRuntime.eventOn === 'function' ? (globalRuntime.eventOn as WorldInfoEventOnLike) : null;
}

function worldInfoEventType(
  host: WorldInfoHostLike,
  runtime: ContextRuntime,
  key: keyof WorldInfoEventTypesLike,
): string {
  const configured = runtime.getWorldInfoEventTypes?.[key] ?? host.eventTypes?.[key];
  return typeof configured === 'string' ? configured : '';
}

function stopWorldInfoListener(handle: WorldInfoListenerHandleLike | undefined): void {
  if (handle && typeof handle.stop === 'function') handle.stop();
}

function warnWorldInfoUnavailable(reason: string): void {
  console.warn(`<杠杠の配音室> 未发送绑定世界书：${reason}`);
}

function worldInfoScanChat(runtime: ContextRuntime): string[] | null {
  try {
    const messages = readVisibleChatMessages(runtime);
    const host = worldInfoHost(runtime);
    const includeNames = runtime.getWorldInfoIncludeNames ?? host.powerUserSettings?.world_info_include_names !== false;
    return messages
      .filter(message => message && message.is_hidden !== true)
      .map(message => {
        const content = textValue(message.message ?? message.mes).trim();
        if (!includeNames) return content;
        const name = textValue(message.name).trim();
        return name ? `${name}: ${content}` : content;
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return null;
  }
}

async function readDefaultActivatedBoundWorldbooks(
  runtime: ContextRuntime,
  context: CastingContext,
): Promise<ActivatedBoundWorldbooks> {
  const bound = boundWorldbookNames(runtime);
  if (bound.persona.size === 0 && bound.character.size === 0) {
    return { personaWorldbook: [], characterWorldbook: [] };
  }

  const host = worldInfoHost(runtime);
  const scanChat = worldInfoScanChat(runtime);
  const maxContext = numberValue(host.maxContext, 0);
  const eventOn = worldInfoEventOn(runtime);
  const prompt = host.getWorldInfoPrompt;
  const entriesLoadedType = worldInfoEventType(host, runtime, 'WORLDINFO_ENTRIES_LOADED');
  const scanDoneType = worldInfoEventType(host, runtime, 'WORLDINFO_SCAN_DONE');
  if (
    scanChat === null ||
    maxContext <= 0 ||
    typeof prompt !== 'function' ||
    !eventOn ||
    !entriesLoadedType ||
    !scanDoneType
  ) {
    warnWorldInfoUnavailable('目标酒馆缺少已声明的世界书 dry-run 能力');
    return { personaWorldbook: [], characterWorldbook: [] };
  }

  let loadedPersona = new Set<string>();
  let loadedCharacter = new Set<string>();
  let loaded = false;
  let scanCompleted = false;
  let activatedEntries: unknown[] = [];
  const loadedListener = (payload: unknown): void => {
    if (!isRecord(payload)) return;
    loadedPersona = worldbookIdentitySet(payload.personaLore);
    loadedCharacter = worldbookIdentitySet(payload.characterLore);
    loaded = true;
  };
  const scanListener = (payload: unknown): void => {
    if (!isRecord(payload) || !isRecord(payload.state) || payload.state.next !== 0) return;
    const activated = isRecord(payload.activated) ? payload.activated.entries : undefined;
    activatedEntries = unknownArray(activated);
    scanCompleted = true;
  };

  let loadedHandle: WorldInfoListenerHandleLike | undefined;
  let scanHandle: WorldInfoListenerHandleLike | undefined;
  try {
    loadedHandle = eventOn.call(globalThis, entriesLoadedType, loadedListener);
    scanHandle = eventOn.call(globalThis, scanDoneType, scanListener);
    if (!loadedHandle || !scanHandle) {
      warnWorldInfoUnavailable('世界书事件监听未建立');
      return { personaWorldbook: [], characterWorldbook: [] };
    }
    const globalScanData = {
      personaDescription: context.persona?.description ?? '',
      characterDescription: context.characterDescription,
      characterPersonality: context.characterPersonality,
      characterDepthPrompt: '',
      scenario: context.scenario,
      creatorNotes: '',
      trigger: 'normal',
    };
    await prompt(scanChat, maxContext, true, globalScanData);
  } catch {
    warnWorldInfoUnavailable('世界书 dry-run 扫描失败');
    return { personaWorldbook: [], characterWorldbook: [] };
  } finally {
    stopWorldInfoListener(loadedHandle);
    stopWorldInfoListener(scanHandle);
  }

  if (!loaded || !scanCompleted) {
    warnWorldInfoUnavailable('未收到完整的世界书来源/激活结果');
    return { personaWorldbook: [], characterWorldbook: [] };
  }
  const personaEntries: unknown[] = [];
  const characterEntries: unknown[] = [];
  for (const entry of activatedEntries) {
    const identity = worldbookIdentity(entry);
    if (!identity) continue;
    const world = identity.split('\u0000', 1)[0];
    if (loadedPersona.has(identity) && bound.persona.has(world)) {
      personaEntries.push(entry);
    } else if (loadedCharacter.has(identity) && bound.character.has(world)) {
      characterEntries.push(entry);
    }
  }
  return { personaWorldbook: personaEntries, characterWorldbook: characterEntries };
}

async function readActivatedBoundWorldbooks(
  runtime: ContextRuntime,
  context: CastingContext,
): Promise<{
  personaWorldbook: string[];
  characterWorldbook: string[];
}> {
  const adapter = runtime.getActivatedBoundWorldbooks;
  if (typeof adapter !== 'function') return { personaWorldbook: [], characterWorldbook: [] };
  try {
    const snapshot = await adapter({
      characterKey: context.characterKey,
      characterName: context.characterName,
      persona: context.persona,
      characterDescription: context.characterDescription,
      characterPersonality: context.characterPersonality,
      scenario: context.scenario,
    });
    if (!isRecord(snapshot)) return { personaWorldbook: [], characterWorldbook: [] };
    return {
      personaWorldbook: sanitizeWorldbookContents(snapshot.personaWorldbook),
      characterWorldbook: sanitizeWorldbookContents(snapshot.characterWorldbook),
    };
  } catch {
    return { personaWorldbook: [], characterWorldbook: [] };
  }
}

function buildContext(
  card: CharacterCardLike | null,
  recentMessages: ChatMessageLike[],
  options: {
    characterId?: string;
    characterName?: string;
    effectiveFields?: unknown;
    persona?: unknown;
    personaWorldbook?: unknown;
    characterWorldbook?: unknown;
  },
): CastingContext {
  const record = card ?? {};
  const data = recordData(record);
  const fields = effectiveFields(options.effectiveFields);
  const fieldOrCard = (field: keyof EffectiveCardFieldsLike, cardValue: unknown, dataKey: string): unknown =>
    fields[field] !== undefined ? fields[field] : (cardValue ?? data[dataKey]);
  const characterName =
    limitedText(options.characterName, 500) ||
    limitedText(record.name, 500) ||
    limitedText(data.name, 500) ||
    '当前角色';
  const contextMessages = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter(message => message && message.is_hidden !== true)
    .map((message, index): ContextMessage => ({
      messageId: numberValue(message.message_id, index),
      role: normalizeRole(message.role),
      name: limitedText(message.name, 300),
      message: limitedText(message.message ?? message.mes, MAX_MESSAGE_LENGTH),
    }))
    .filter(message => message.message.length > 0)
    .slice(-MAX_RECENT_MESSAGE_COUNT);
  const characterDescription = limitedText(
    fieldOrCard('description', record.description, 'description'),
    MAX_CARD_FIELD_LENGTH,
  );
  const characterPersonality = limitedText(
    fieldOrCard('personality', record.personality, 'personality'),
    MAX_CARD_FIELD_LENGTH,
  );
  const scenario = limitedText(fieldOrCard('scenario', record.scenario, 'scenario'), MAX_CARD_FIELD_LENGTH);
  const characterFirstMessage = limitedText(
    fieldOrCard('firstMessage', record.first_mes, 'first_mes'),
    MAX_EXAMPLE_LENGTH,
  );
  const characterExampleDialog = limitedText(
    fieldOrCard('mesExamples', record.mes_example, 'mes_example'),
    MAX_EXAMPLE_LENGTH,
  );

  return {
    characterKey: deriveCharacterKey(record, options.characterId, characterName),
    characterName,
    characterDescription,
    characterPersonality,
    scenario,
    ...(characterFirstMessage ? { characterFirstMessage } : {}),
    ...(characterExampleDialog ? { characterExampleDialog } : {}),
    persona: sanitizePersona(options.persona),
    personaWorldbook: sanitizeWorldbookContents(options.personaWorldbook),
    characterWorldbook: sanitizeWorldbookContents(options.characterWorldbook),
    recentMessages: contextMessages,
  };
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
  options: {
    characterId?: string;
    characterName?: string;
    effectiveFields?: unknown;
    persona?: unknown;
    personaWorldbook?: unknown;
    characterWorldbook?: unknown;
  } = {},
): CastingContext {
  return buildContext(card ?? null, recentMessages, options);
}

function resolveContextRuntime(runtime?: Partial<ContextRuntime>): ContextRuntime {
  const globalRuntime = globalThis as typeof globalThis & Record<string, unknown>;
  const resolved: Partial<ContextRuntime> = {
    getCharData: runtime?.getCharData ?? (globalRuntime.getCharData as ContextRuntime['getCharData']),
    getCurrentCharacterName:
      runtime?.getCurrentCharacterName ??
      (globalRuntime.getCurrentCharacterName as ContextRuntime['getCurrentCharacterName']),
    getCurrentCharacterId:
      runtime?.getCurrentCharacterId ??
      (globalRuntime.getCurrentCharacterId as ContextRuntime['getCurrentCharacterId']),
    getLastMessageId:
      runtime?.getLastMessageId ?? (globalRuntime.getLastMessageId as ContextRuntime['getLastMessageId']),
    getChatMessages: runtime?.getChatMessages ?? (globalRuntime.getChatMessages as ContextRuntime['getChatMessages']),
    getPersona: runtime?.getPersona ?? (globalRuntime.getPersona as ContextRuntime['getPersona']),
    getEffectiveCharacterCardFields:
      runtime?.getEffectiveCharacterCardFields ??
      (globalRuntime.getEffectiveCharacterCardFields as ContextRuntime['getEffectiveCharacterCardFields']),
    getCharWorldbookNames:
      runtime?.getCharWorldbookNames ??
      (globalRuntime.getCharWorldbookNames as ContextRuntime['getCharWorldbookNames']),
    getWorldInfoPrompt: runtime?.getWorldInfoPrompt,
    getWorldInfoEventOn: runtime?.getWorldInfoEventOn,
    getWorldInfoEventTypes: runtime?.getWorldInfoEventTypes,
    getWorldInfoMaxContext: runtime?.getWorldInfoMaxContext,
    getWorldInfoIncludeNames: runtime?.getWorldInfoIncludeNames,
  };
  if (
    typeof resolved.getCharData !== 'function' ||
    typeof resolved.getCurrentCharacterName !== 'function' ||
    typeof resolved.getCurrentCharacterId !== 'function' ||
    typeof resolved.getLastMessageId !== 'function' ||
    typeof resolved.getChatMessages !== 'function'
  ) {
    throw new Error('杠杠の配音室需要 Tavern Helper 的角色卡与聊天接口');
  }
  const contextRuntime = resolved as ContextRuntime;
  contextRuntime.getActivatedBoundWorldbooks =
    runtime?.getActivatedBoundWorldbooks ??
    (input =>
      readDefaultActivatedBoundWorldbooks(contextRuntime, {
        characterKey: input.characterKey,
        characterName: input.characterName,
        characterDescription: input.characterDescription,
        characterPersonality: input.characterPersonality,
        scenario: input.scenario,
        persona: input.persona,
        recentMessages: [],
      }));
  return contextRuntime;
}

function readVisibleChatMessages(helper: ContextRuntime, minimumCount = 0): ChatMessageLike[] {
  const lastMessageId = numberValue(helper.getLastMessageId(), -1);
  if (lastMessageId < 0) return [];
  const readRange = (firstMessageId: number): ChatMessageLike[] => {
    const messages = helper.getChatMessages(`${firstMessageId}-${lastMessageId}`, {
      hide_state: 'unhidden',
      include_swipes: false,
    });
    return Array.isArray(messages) ? messages.filter(message => message && message.is_hidden !== true) : [];
  };
  let firstMessageId = minimumCount > 0 ? Math.max(0, lastMessageId - minimumCount + 1) : 0;
  let messages = readRange(firstMessageId);
  while (messages.length < minimumCount && firstMessageId > 0) {
    firstMessageId = Math.max(0, firstMessageId - Math.max(minimumCount, 1));
    messages = readRange(firstMessageId);
  }
  return messages;
}

function readRecentMessages(helper: ContextRuntime, count: number): ChatMessageLike[] {
  if (count <= 0) return [];
  return readVisibleChatMessages(helper, count).slice(-count);
}

function readBaseContext(recentMessageCount: number, helper: ContextRuntime): CastingContext {
  const count = normalizedCount(recentMessageCount);
  const card = helper.getCharData('current');
  const characterName = helper.getCurrentCharacterName() ?? '';
  const characterId = helper.getCurrentCharacterId() ?? '';
  const persona = readPersonaRecord(helper);
  return buildContext(card && isRecord(card) ? card : null, readRecentMessages(helper, count), {
    characterId,
    characterName,
    effectiveFields: resolveCardFields(helper),
    persona,
  });
}

/**
 * Synchronous compatibility capture for lifecycle/UI refresh and the current
 * casting validator callback. It intentionally leaves async active-lore data
 * empty; generation uses readCurrentCastingContext below.
 */
export function readCurrentCastingContextSync(
  recentMessageCount = DEFAULT_RECENT_MESSAGE_COUNT,
  runtime?: Partial<ContextRuntime>,
): CastingContext {
  return readBaseContext(recentMessageCount, resolveContextRuntime(runtime));
}

/**
 * Full capture used before sending the casting request. The default runtime
 * adapter performs a source-restricted SillyTavern dry-run; a caller may
 * replace it with an equally source-restricted adapter. Unavailable lore is
 * omitted rather than guessed from enabled/global/chat worldbooks.
 */
export async function readCurrentCastingContext(
  recentMessageCount = DEFAULT_RECENT_MESSAGE_COUNT,
  runtime?: Partial<ContextRuntime>,
): Promise<CastingContext> {
  const helper = resolveContextRuntime(runtime);
  const baseContext = readBaseContext(recentMessageCount, helper);
  const worldbooks = await readActivatedBoundWorldbooks(helper, baseContext);
  return { ...baseContext, ...worldbooks };
}

/**
 * Keep only voice metadata that can be sent to the casting model. Provider
 * profiles and their credentials are deliberately not accepted by this
 * function.
 */
export function sanitizeVoiceOptions(voices: VoiceOption[]): VoiceOption[] {
  const seen = new Set<string>();
  const result: VoiceOption[] = [];
  for (const voice of Array.isArray(voices) ? voices : []) {
    if (result.length >= MAX_VOICE_OPTIONS) break;
    if (!voice || typeof voice.providerProfileId !== 'string' || typeof voice.voiceId !== 'string') continue;
    const providerProfileId = safeIdentifier(voice.providerProfileId, 240);
    const voiceId = safeIdentifier(voice.voiceId, 240);
    const name = limitedText(voice.name, 240);
    if (!providerProfileId || !voiceId || !name) continue;
    const key = `${providerProfileId}\u0000${voiceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const option: VoiceOption = { providerProfileId, voiceId, name };
    const locale = limitedText(voice.locale, 80);
    const gender = limitedText(voice.gender, 80);
    const description = limitedText(voice.description, MAX_VOICE_DESCRIPTION_LENGTH);
    if (locale) option.locale = locale;
    if (gender) option.gender = gender;
    if (description) option.description = description;
    if (Array.isArray(voice.tags)) {
      option.tags = [
        ...new Set(
          voice.tags
            .filter(tag => typeof tag === 'string')
            .map(tag => limitedText(tag, MAX_VOICE_TAG_LENGTH))
            .filter(Boolean),
        ),
      ].slice(0, 8);
    }
    result.push(option);
  }
  return result;
}

export function buildCastingRequestPayload(
  context: CastingContext,
  voices: VoiceOption[],
): {
  context: {
    characterName: string;
    characterDescription: string;
    characterPersonality: string;
    scenario: string;
    characterFirstMessage?: string;
    characterExampleDialog?: string;
    persona: CastingContext['persona'];
    personaWorldbook: string[];
    characterWorldbook: string[];
    recentChat?: Array<{ role: ContextMessage['role']; name: string; message: string }>;
  };
  voices: VoiceOption[];
} {
  const payloadContext: {
    characterName: string;
    characterDescription: string;
    characterPersonality: string;
    scenario: string;
    characterFirstMessage?: string;
    characterExampleDialog?: string;
    persona: CastingContext['persona'];
    personaWorldbook: string[];
    characterWorldbook: string[];
    recentChat?: Array<{ role: ContextMessage['role']; name: string; message: string }>;
  } = {
    characterName: limitedText(context.characterName, 500),
    characterDescription: limitedText(context.characterDescription, MAX_CARD_FIELD_LENGTH),
    characterPersonality: limitedText(context.characterPersonality, MAX_CARD_FIELD_LENGTH),
    scenario: limitedText(context.scenario, MAX_CARD_FIELD_LENGTH),
    persona: sanitizePersona(context.persona),
    personaWorldbook: sanitizeWorldbookContents(context.personaWorldbook),
    characterWorldbook: sanitizeWorldbookContents(context.characterWorldbook),
  };
  const firstMessage = limitedText(context.characterFirstMessage, MAX_EXAMPLE_LENGTH);
  const exampleDialog = limitedText(context.characterExampleDialog, MAX_EXAMPLE_LENGTH);
  if (firstMessage) payloadContext.characterFirstMessage = firstMessage;
  if (exampleDialog) payloadContext.characterExampleDialog = exampleDialog;
  const recentChat = (Array.isArray(context.recentMessages) ? context.recentMessages : [])
    .slice(-MAX_RECENT_MESSAGE_COUNT)
    .map(message => ({
      role: normalizeRole(message.role),
      name: limitedText(message.name, 240),
      message: limitedText(message.message, MAX_MESSAGE_LENGTH),
    }))
    .filter(message => message.message.length > 0);
  if (recentChat.length > 0) payloadContext.recentChat = recentChat;
  const payload = { context: payloadContext, voices: sanitizeVoiceOptions(voices) };
  if (JSON.stringify(payload).length > MAX_CASTING_PAYLOAD_LENGTH) {
    throw new Error('配音资料包超过安全长度上限');
  }
  return payload;
}

export function createCastingInputSignature(
  context: CastingContext,
  voices: VoiceOption[],
  recentMessageCount: number,
  enabledProfiles: ReadonlyArray<{ id: string; type: string }>,
): string {
  const payload = buildCastingRequestPayload(context, voices);
  const profiles = enabledProfiles
    .map(profile => ({ id: safeIdentifier(profile.id, 240), type: safeIdentifier(profile.type, 80) }))
    .filter(profile => profile.id && profile.type)
    .sort((left, right) => `${left.id}\u0000${left.type}`.localeCompare(`${right.id}\u0000${right.type}`));
  return JSON.stringify({
    localCharacterKey: safeIdentifier(context.characterKey, 500),
    recentMessageCount: normalizedCount(recentMessageCount),
    profiles,
    ...payload,
  });
}
