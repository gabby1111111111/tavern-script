/**
 * Page-only floor eligibility ledger for BGM prompt cadence.
 *
 * 帧设计参考 `src/杠杠の生图机/generation-eligibility.ts`（杠杠の生图机）：
 * - 同款 WeakMap records + bounded current-chat tail + replacement/pending 状态机
 * - 防 stale / duplicate commit
 * - swipe 资格可从 `chat[targetMessageId]` 直接定位，不依赖 host 事件
 *
 * 业务差异：
 * - 调音台只需 'normal' | 'swipe'，无 'regenerate' 类型。prepare 拒绝了 regenerate。
 * - 调音台的 cadence 数学由 `bgm-settings.ts` 的 `bgmPromptCadenceState` 独占，
 *   本 ledger 只负责 message ↔ decision 映射 + stale/duplicate 校验，不参与
 *   skippedCount / completedCount 维护。
 * - 不引入生图机的 displayPolicy / MessageAdvanceGate 等其它业务字段。
 *
 * 用途：
 * - normal 提交：`prepare({type:'normal', chat, freshUserInput, decide})` →
 *   `commit(plan, message, chat, appendedUserMessage)`。
 * - swipe 资格：`get(rawMessageRef(swipeMessageId))` 直接读原楼层 decision，
 *   不需要 `MESSAGE_SWIPED` 事件或全局 `pendingSwipeTarget` 状态。
 * - 同步：聊天变更后调一次 `sync(SillyTavern.chat)` 维护替换记录。
 */

import type { BgmPromptFloorDecision } from './bgm-settings';

export type BgmGenerationType = 'normal' | 'swipe';

export type BgmFloorPlan<T> = {
  decision: T;
  nextFloorCount: number;
  reused: boolean;
};

type BgmFloorRecord<T> = { decision: T; floorCount: number };
type BgmFloorReplacement<T> = { index: number; predecessor: object | null; record: BgmFloorRecord<T> };
type BgmFloorPendingPlan<T> = BgmFloorReplacement<T> & {
  plan: BgmFloorPlan<T>;
  original: object | null;
  allowUserAppend: boolean;
};

/** Page-memory floor ledger for BGM prompt cadence eligibility. */
export class BgmFloorEligibilityLedger<T> {
  private records = new WeakMap<object, BgmFloorRecord<T>>();
  private tail: readonly object[] = [];
  private length = 0;
  private tailStart = 0;
  private replacement: BgmFloorReplacement<T> | null = null;
  private pending: BgmFloorPendingPlan<T> | null = null;
  private completedCount = 0;

  get count(): number {
    return this.completedCount;
  }

  get(message: object | null | undefined): T | undefined {
    return message ? this.records.get(message)?.decision : undefined;
  }

  /** Re-derive replacement slot after chat deletion/truncation; only strict tail truncation inherits. */
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
    this.tailStart = Math.max(0, chat.length - 256);
    this.tail = chat.slice(this.tailStart);
    this.length = chat.length;
  }

  prepare(input: {
    type: BgmGenerationType;
    chat: readonly object[];
    targetMessageId?: number;
    freshUserInput?: boolean;
    decide: (nextFloorCount: number) => T;
  }): BgmFloorPlan<T> | null {
    this.sync(input.chat);
    this.pending = null;
    const index = input.targetMessageId ?? input.chat.length;
    if (!Number.isInteger(index) || index < 0 || index > input.chat.length) return null;
    const original = input.chat[index] ?? null;
    if (input.type === 'normal' && original) return null;
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
    const plan: BgmFloorPlan<T> = {
      decision: record.decision,
      nextFloorCount: record.floorCount,
      reused: !!inherited,
    };
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

  /**
   * Commit must match the pending plan exactly.
   * Returns false on stale / duplicate / chat-shape mismatch.
   */
  commit(
    plan: BgmFloorPlan<T>,
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

// Re-export BgmPromptFloorDecision type at module level for convenience.
export type { BgmPromptFloorDecision };

// -----------------------------------------------------------------------------
// Helpers that bridge cadence state → ledger decision without leaking state.
// -----------------------------------------------------------------------------

export type BgmFloorDecideFn<T> = (nextFloorCount: number) => T;

/** Wrap the cadence state reader as a `decide` callback for ledger.prepare. */
export function asBgmFloorDecide<T>(
  decide: (nextFloorCount: number) => T,
): BgmFloorDecideFn<T> {
  return decide;
}

/** Compose a ledger prepare call for BGM prompt floor eligibility. */
export function prepareBgmFloorDecision<T>(
  ledger: BgmFloorEligibilityLedger<T>,
  input: {
    type: BgmGenerationType;
    chat: readonly object[];
    targetMessageId?: number;
    freshUserInput?: boolean;
    decide: BgmFloorDecideFn<T>;
  },
): BgmFloorPlan<T> | null {
  return ledger.prepare({
    type: input.type,
    chat: input.chat,
    targetMessageId: input.targetMessageId,
    freshUserInput: input.freshUserInput,
    decide: input.decide,
  });
}
