export type GiftTriggerInterval = 'manual' | '3' | '5';

export type GiftScheduleDecision = {
  assistantReplyCount: number;
  shouldAttempt: boolean;
  skipReason: 'duplicate_message' | null;
};

export class GiftScheduler {
  private assistantReplyCount = 0;
  private readonly seenMessages = new Set<string>();
  private readonly attemptedMessages = new Set<string>();

  registerAssistantReply(chatId: string, messageId: number, interval: GiftTriggerInterval): GiftScheduleDecision {
    const messageKey = `${chatId}::${messageId}`;
    if (this.seenMessages.has(messageKey)) {
      return {
        assistantReplyCount: this.assistantReplyCount,
        shouldAttempt: false,
        skipReason: 'duplicate_message',
      };
    }

    this.seenMessages.add(messageKey);
    this.assistantReplyCount += 1;
    if (interval === 'manual' || this.assistantReplyCount % Number(interval) !== 0) {
      return {
        assistantReplyCount: this.assistantReplyCount,
        shouldAttempt: false,
        skipReason: null,
      };
    }

    // 到点即登记为已尝试；运行时即使因为缺参考图或忙碌而跳过，也不会排队或补跑。
    this.attemptedMessages.add(messageKey);
    return {
      assistantReplyCount: this.assistantReplyCount,
      shouldAttempt: true,
      skipReason: null,
    };
  }

  hasAttempted(chatId: string, messageId: number): boolean {
    return this.attemptedMessages.has(`${chatId}::${messageId}`);
  }

  reset(): void {
    this.assistantReplyCount = 0;
    this.seenMessages.clear();
    this.attemptedMessages.clear();
  }
}
