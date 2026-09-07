export function isNormalGeneration(type: string, dryRun = false): boolean {
  return !dryRun && type === 'normal';
}

export function isSwipeGeneration(type: string, dryRun = false): boolean {
  return !dryRun && type === 'swipe';
}

export function isSingleCharacterChat(groupId: unknown): boolean {
  return typeof groupId !== 'string' || groupId.trim().length === 0;
}

function isObjectIdentity(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Page-memory state keyed by the raw SillyTavern chat object, which survives array index shifts. */
export class MessageIdentityStore<T> {
  private values = new WeakMap<object, T>();

  set(message: unknown, value: T): boolean {
    if (!isObjectIdentity(message)) return false;
    this.values.set(message, value);
    return true;
  }

  get(message: unknown): T | undefined {
    return isObjectIdentity(message) ? this.values.get(message) : undefined;
  }

  reset(): void {
    this.values = new WeakMap<object, T>();
  }
}

export function shouldArmStoryImageGeneration(input: {
  enabled: boolean;
  type: string;
  dryRun: boolean;
  groupId: unknown;
  generateOnSwipe?: boolean;
  swipeFloorEligible?: boolean;
}): boolean {
  if (!input.enabled || !isSingleCharacterChat(input.groupId)) return false;
  if (isNormalGeneration(input.type, input.dryRun)) return true;
  return (
    input.generateOnSwipe === true &&
    input.swipeFloorEligible === true &&
    isSwipeGeneration(input.type, input.dryRun)
  );
}

export function isMatchingAssistantReply(input: {
  generationType: 'normal' | 'swipe';
  receivedType: string;
  role: string | undefined;
  expectedMessageId: number | null;
  receivedMessageId: number;
}): boolean {
  return (
    input.receivedType === input.generationType &&
    input.role === 'assistant' &&
    (input.expectedMessageId === null || input.expectedMessageId === input.receivedMessageId)
  );
}

export function isMatchingNormalAssistantReply(input: {
  type: string;
  role: string | undefined;
  expectedMessageId: number | null;
  receivedMessageId: number;
}): boolean {
  return isMatchingAssistantReply({
    generationType: 'normal',
    receivedType: input.type,
    role: input.role,
    expectedMessageId: input.expectedMessageId,
    receivedMessageId: input.receivedMessageId,
  });
}
