export type MessageAdvanceKind = 'user' | 'assistant';

export type MessageAdvanceChat = ReadonlyArray<unknown>;

interface GenerationState {
  type: string;
  dryRun: boolean;
  startLength: number;
}

function isObjectIdentity(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function previousMessageId(messageId: number): number | null {
  return messageId > 0 ? messageId - 1 : null;
}

const NON_FLOOR_ASSISTANT_EVENT_TYPES = new Set([
  'first_message',
  'continue',
  'append',
  'appendFinal',
  'swipe',
  'regenerate',
  'quiet',
  'impersonate',
]);

/**
 * Detects one genuinely appended chat tail without treating render/receive
 * repeats, swipes, regenerations, or non-chat generation modes as new floors.
 * The chat is scanned only when the caller seeds or reseeds after a structural
 * chat change; normal event observation is tail-only.
 */
export class MessageAdvanceGate {
  private knownMessages = new WeakSet<object>();

  private knownLength = 0;

  private generation: GenerationState | null = null;

  /** Start a new chat baseline and clear any active generation. */
  seed(chat: MessageAdvanceChat = []): void {
    this.reset(chat);
  }

  /** Reset the chat baseline, as required when the chat or runtime starts. */
  reset(chat: MessageAdvanceChat = []): void {
    this.knownMessages = new WeakSet<object>();
    this.knownLength = chat.length;
    this.generation = null;
    this.remember(chat);
  }

  /**
   * Refresh object identities after a structural deletion while preserving
   * the current generation baseline (especially for regenerate).
   */
  reseed(chat: MessageAdvanceChat): void {
    this.knownMessages = new WeakSet<object>();
    this.knownLength = chat.length;
    this.remember(chat);
  }

  /** Record the generation that may append a new assistant floor. */
  onGenerationStarted(type: string, dryRun: boolean, chat: MessageAdvanceChat): void {
    this.generation = {
      type,
      dryRun,
      startLength: chat.length,
    };
  }

  /** Drop a generation that ended without a floor to observe. */
  onGenerationEnded(): void {
    this.generation = null;
  }

  /**
   * Observe a user or assistant event. A returned ID is the floor preceding
   * a newly appended tail and is null for all duplicate or ineligible events.
   * Pass the native event type when available so an ungenerated first message
   * can be excluded while extension-created assistant tails remain eligible.
   */
  observeMessage(
    kind: MessageAdvanceKind,
    messageId: number,
    chat: MessageAdvanceChat,
    eventType?: string,
  ): number | null {
    if (!Number.isInteger(messageId) || messageId < 0 || messageId !== chat.length - 1) return null;

    const tail = chat[messageId];
    if (!isObjectIdentity(tail) || chat.length <= this.knownLength || this.knownMessages.has(tail)) return null;

    this.knownMessages.add(tail);
    this.knownLength = chat.length;

    if (kind === 'user') return previousMessageId(messageId);
    if (eventType && NON_FLOOR_ASSISTANT_EVENT_TYPES.has(eventType)) return null;

    const generation = this.generation;
    if (generation === null) return previousMessageId(messageId);
    if (generation.dryRun || generation.type !== 'normal') return null;
    if (chat.length <= generation.startLength) return null;

    this.generation = null;
    return previousMessageId(messageId);
  }

  private remember(chat: MessageAdvanceChat): void {
    for (const message of chat) {
      if (isObjectIdentity(message)) this.knownMessages.add(message);
    }
  }
}
