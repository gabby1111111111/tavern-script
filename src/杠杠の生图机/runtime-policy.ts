export function isNormalGeneration(type: string, dryRun = false): boolean {
  return !dryRun && type === 'normal';
}

export function isSingleCharacterChat(groupId: unknown): boolean {
  return typeof groupId !== 'string' || groupId.trim().length === 0;
}

export function shouldArmStoryImageGeneration(input: {
  enabled: boolean;
  type: string;
  dryRun: boolean;
  groupId: unknown;
}): boolean {
  return input.enabled && isNormalGeneration(input.type, input.dryRun) && isSingleCharacterChat(input.groupId);
}

export function isMatchingNormalAssistantReply(input: {
  type: string;
  role: string | undefined;
  expectedMessageId: number | null;
  receivedMessageId: number;
}): boolean {
  return (
    input.type === 'normal' &&
    input.role === 'assistant' &&
    (input.expectedMessageId === null || input.expectedMessageId === input.receivedMessageId)
  );
}
