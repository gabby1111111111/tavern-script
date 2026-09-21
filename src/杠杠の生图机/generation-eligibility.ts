export type StoryGenerationType = 'normal' | 'swipe' | 'regenerate';

export type GenerationEligibilityPlan<T> = {
  decision: T;
  nextFloorCount: number;
  reused: boolean;
};

type EligibilityRecord<T> = { decision: T; floorCount: number };
type Replacement<T> = { index: number; predecessor: object | null; record: EligibilityRecord<T> };
type PendingPlan<T> = Replacement<T> & {
  plan: GenerationEligibilityPlan<T>;
  original: object | null;
  allowUserAppend: boolean;
};

/** Page-only cadence: reply identity owns images, while a tail replacement can inherit its slot's decision. */
export class GenerationEligibilityLedger<T> {
  private records = new WeakMap<object, EligibilityRecord<T>>();
  private tail: readonly object[] = [];
  private length = 0;
  private tailStart = 0;
  private replacement: Replacement<T> | null = null;
  private pending: PendingPlan<T> | null = null;
  private completedCount = 0;

  get count(): number {
    return this.completedCount;
  }

  get(message: object | null | undefined): T | undefined {
    return message ? this.records.get(message)?.decision : undefined;
  }

  /** Call after message deletion and before preparing a generation. Only a strict tail truncation inherits a slot. */
  sync(chat: readonly object[]): void {
    if (chat.length < this.length) {
      const firstRemoved = chat.length - this.tailStart;
      const retainedTailMatches =
        firstRemoved >= 0 &&
        this.tail.slice(0, firstRemoved).every((message, index) => chat[this.tailStart + index] === message);
      const removed = retainedTailMatches ? this.tail[firstRemoved] : undefined;
      const record = removed ? this.records.get(removed) : undefined;
      this.replacement = record ? { index: chat.length, predecessor: chat.at(-1) ?? null, record } : null;
    }
    if (
      this.replacement &&
      (chat.length !== this.replacement.index || (chat.at(-1) ?? null) !== this.replacement.predecessor)
    ) {
      this.replacement = null;
    }
    // WeakMap records do not retain removed messages. Only a bounded current-chat tail is held strongly.
    this.tailStart = Math.max(0, chat.length - 256);
    this.tail = chat.slice(this.tailStart);
    this.length = chat.length;
  }

  prepare(input: {
    type: StoryGenerationType;
    chat: readonly object[];
    targetMessageId?: number;
    freshUserInput?: boolean;
    decide: (nextFloorCount: number) => T;
  }): GenerationEligibilityPlan<T> | null {
    this.sync(input.chat);
    this.pending = null;
    const index = input.targetMessageId ?? input.chat.length;
    if (!Number.isInteger(index) || index < 0 || index > input.chat.length) return null;
    const original = input.chat[index] ?? null;
    if (input.type === 'normal' && original) return null;
    if (input.type === 'regenerate' && original && index !== input.chat.length - 1) return null;
    const predecessor = input.chat[index - 1] ?? null;
    const existing = original ? this.records.get(original) : undefined;
    const replacement =
      !original &&
      !input.freshUserInput &&
      this.replacement?.index === index &&
      this.replacement.predecessor === predecessor
        ? this.replacement.record
        : undefined;
    const inherited = existing ?? replacement;
    if (input.type === 'swipe' && (!original || !inherited)) return null;
    const record = inherited ?? {
      decision: input.decide(this.completedCount + 1),
      floorCount: this.completedCount + 1,
    };
    const plan = { decision: record.decision, nextFloorCount: record.floorCount, reused: !!inherited };
    this.pending = {
      index,
      predecessor,
      record,
      plan,
      original: input.type === 'swipe' ? original : null,
      allowUserAppend: input.type === 'normal',
    };
    return plan;
  }

  /** A cancelled/quiet/dry generation must never call commit. Duplicate or stale completion is ignored. */
  commit(
    plan: GenerationEligibilityPlan<T>,
    message: object,
    chat: readonly object[],
    appendedUserMessage?: object,
  ): boolean {
    const pending = this.pending;
    const appendedAfterStart =
      pending?.allowUserAppend &&
      appendedUserMessage !== undefined &&
      chat[pending.index] === appendedUserMessage &&
      chat[pending.index + 1] === message;
    if (
      !pending ||
      pending.plan !== plan ||
      (chat[pending.index] !== message && !appendedAfterStart) ||
      (chat[pending.index - 1] ?? null) !== pending.predecessor ||
      (pending.original !== null && pending.original !== message)
    ) {
      return false;
    }
    this.pending = null;
    this.records.set(message, pending.record);
    if (!plan.reused) this.completedCount = pending.record.floorCount;
    this.replacement = null;
    this.sync(chat);
    return true;
  }

  reset(): void {
    this.records = new WeakMap();
    this.tail = [];
    this.length = 0;
    this.tailStart = 0;
    this.replacement = null;
    this.pending = null;
    this.completedCount = 0;
  }
}
