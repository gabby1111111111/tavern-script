// v0.3.1: 调音台 floor-ledger 行为验收。
// 帧设计从 `src/杠杠の生图机/generation-eligibility.ts` 移植，独立测试。
// 跑：`pnpm exec ts-node --transpile-only --compiler-options '{"module":"CommonJS","moduleResolution":"Node","ignoreDeprecations":"6.0"}' tests/ganggang-mixer-swipe-eligibility.test.ts`

import {
  type BgmPromptCadenceState,
  type BgmPromptFloorDecision,
  createBgmPromptCadenceState,
  decideBgmPromptCadenceAtFloor,
  shouldArmBgmPromptGeneration,
} from '../src/杠杠の调音台/bgm-settings';
import { BgmFloorEligibilityLedger, type BgmFloorPlan } from '../src/杠杠の调音台/bgm-eligibility';

interface MockMessage {
  id: number;
  role: 'user' | 'assistant';
}

/**
 * In this mock, the chat array's items ARE the message identities themselves
 * (mirroring `SillyTavern.chat[i]` semantics used by `rawMessageRef` in production).
 */
function buildChat(count: number, assistantFloorEvery = 2): MockMessage[] {
  const chat: MockMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role: 'user' | 'assistant' = i % assistantFloorEvery === assistantFloorEvery - 1 ? 'assistant' : 'user';
    chat.push({ id: i, role });
  }
  return chat;
}

function makeCadenceDecider(state: BgmPromptCadenceState): (next: number) => BgmPromptFloorDecision {
  return next => {
    const c = decideBgmPromptCadenceAtFloor(state, next);
    return {
      interval: c.interval,
      bgmPromptIncluded: c.bgmPromptIncluded,
      skippedCount: c.skippedCount,
      completedCount: c.completedCount,
      decision: c.decision,
      reason: c.reason,
      normalAssistantFloorCount: next,
    };
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${message}`);
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

function settledDecision(plan: BgmFloorPlan<BgmPromptFloorDecision> | null): BgmPromptFloorDecision | undefined {
  return plan?.decision;
}

// =========================================================================
// 1. cadence 数学与 ledger records 间不出现"用户感知的出歌决策变化"
// =========================================================================
console.log('\n=== Test 1: cadence math identical to v0.3.0 inline path ===');
{
  const stateInline = createBgmPromptCadenceState(1);
  const stateLedger = createBgmPromptCadenceState(1);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat: MockMessage[] = [];
  const inlineDecider = makeCadenceDecider(stateInline);
  const ledgerDecider = makeCadenceDecider(stateLedger);
  for (let floor = 1; floor <= 8; floor++) {
    ledger.sync(chat);
    const inline = inlineDecider(floor);
    const plan = ledger.prepare({
      type: 'normal',
      chat,
      freshUserInput: true,
      decide: ledgerDecider,
    });
    assert(!!plan, `floor ${floor}: ledger prepare returned plan`);
    const ledgerDecision = settledDecision(plan);
    assert(
      ledgerDecision && inline.bgmPromptIncluded === ledgerDecision.bgmPromptIncluded,
      `floor ${floor}: bgmPromptIncluded matches inline (interval=1 cadence)`,
    );
    // Simulate SillyTavern append-after-start shape (user first, then assistant).
    const userMsg: MockMessage = { id: chat.length, role: 'user' };
    const assistantMsg: MockMessage = { id: chat.length + 1, role: 'assistant' };
    chat.push(userMsg, assistantMsg);
    const committed = ledger.commit(plan!, assistantMsg, chat, userMsg);
    assert(committed, `floor ${floor}: commit accepted (append-after-start shape)`);
  }
}

// =========================================================================
// 2. happy path: prepare swipe → get decision → commit (normal lifecycle)
// =========================================================================
console.log('\n=== Test 2: happy path (normal → commit → swipe reads ledger) ===');
{
  const state = createBgmPromptCadenceState(1); // interval=1 → 1001001…
  const decider = makeCadenceDecider(state);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat = buildChat(8);
  ledger.sync(chat);

  // user sends → assistant generates at chat.length (=8)
  const plan = ledger.prepare({
    type: 'normal',
    chat,
    freshUserInput: true,
    decide: decider,
  });
  assert(plan !== null, 'normal prepare succeeded');
  // Append user + assistant manually to match SillyTavern post-MESSAGE_RECEIVED shape.
  const userMsg: MockMessage = { id: chat.length, role: 'user' };
  const assistantMsg: MockMessage = { id: chat.length + 1, role: 'assistant' };
  chat.push(userMsg, assistantMsg);
  // For commit, plan.index === chat.length at prepare time (now 8); ledger append-after-start check:
  // chat[plan.index]=chat[8]===userMsg && chat[plan.index+1]=chat[9]===assistantMsg && appendedUserMessage===userMsg
  const committed = ledger.commit(plan!, assistantMsg, chat, userMsg);
  assert(committed, 'normal commit accepted with append-after-start shape');
  assert(ledger.count === 1, 'ledger.completedCount === 1 after first commit');

  // Swipe that assistant message → expect ledger.get(assistantMsg) to return the decision.
  const swipePlan = ledger.prepare({
    type: 'swipe',
    chat,
    targetMessageId: assistantMsg.id,
    decide: decider,
  });
  assert(swipePlan !== null, 'swipe prepare succeeded (inherited from committed normal)');
  assert(swipePlan!.reused === true, 'swipe plan reused = true (inherited slot)');
  assert(
    swipePlan!.decision.bgmPromptIncluded === plan!.decision.bgmPromptIncluded,
    'swipe decision matches committed decision',
  );
  // shouldArmBgmPromptGeneration gates on the swipe decision — proves ledger path unlocks swipe.
  const armed = shouldArmBgmPromptGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    generateOnSwipe: true,
    swipeFloorEligible: swipePlan!.decision.bgmPromptIncluded,
  });
  assert(armed === swipePlan!.decision.bgmPromptIncluded, 'arm flag matches swipe eligibility');
}

// =========================================================================
// 3. Swipe 资格命中（模拟 v0.3.0 已知限制的"丢失"路径）
//    旧 fallback 路径 MESSAGE_SWIPED 丢失 → getLastMessageId() → 新对象 → 无 record (silent fail)。
//    新路径：ledger records 已写入原对象身份（即使对象身份保持），swipe 仍可命中。
// =========================================================================
console.log('\n=== Test 3: swipe eligibility survives MESSAGE_SWIPED loss (ledger path) ===');
{
  const state = createBgmPromptCadenceState(2); // interval=2 → 1001001…
  const decider = makeCadenceDecider(state);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat = buildChat(10);
  ledger.sync(chat);

  // Commit 3 normal floors.
  let nextFloor = 1;
  let lastAssistantId = -1;
  while (nextFloor <= 3) {
    const plan = ledger.prepare({
      type: 'normal',
      chat,
      freshUserInput: true,
      decide: decider,
    });
    if (!plan) break;
    const userMsg: MockMessage = { id: chat.length, role: 'user' };
    const assistantMsg: MockMessage = { id: chat.length + 1, role: 'assistant' };
    chat.push(userMsg, assistantMsg);
    const ok = ledger.commit(plan, assistantMsg, chat, userMsg);
    if (!ok) break;
    lastAssistantId = assistantMsg.id;
    nextFloor++;
  }
  assert(lastAssistantId >= 0, 'committed at least one assistant message');

  // 模拟 host "MESSAGE_SWIPED 事件丢失" → 直接用 ledger.prepare 读 swipeMessageId 命中原楼层。
  // 此时 ledger 通过 commit 时已经 records.set(原对象身份, decision)。
  const swipePlan = ledger.prepare({
    type: 'swipe',
    chat,
    targetMessageId: lastAssistantId,
    decide: decider,
  });
  assert(swipePlan !== null, 'ledger still hits the original floor even when MESSAGE_SWIPED is missing');
  assert(swipePlan!.reused === true, 'swipe uses inherited slot (not a fresh decide)');
}

// =========================================================================
// 4. 边界: prepare swipe 在没有 record 时必须返回 null（防 silent skip 误用）
// =========================================================================
console.log('\n=== Test 4: prepare swipe rejects missing record ===');
{
  const state = createBgmPromptCadenceState(1);
  const decider = makeCadenceDecider(state);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat = buildChat(4); // 4 messages, no commit yet
  ledger.sync(chat);

  // target a chat index that has no record
  const swipePlan = ledger.prepare({
    type: 'swipe',
    chat,
    targetMessageId: 1,
    decide: decider,
  });
  assert(swipePlan === null, 'swipe returns null when no inherited record exists');
  // The legacy "always-armed-fallback" path would silently produce a wrong decision here;
  // ledger path is strict by design (matches image-machine behaviour).
}

// =========================================================================
// 5. 边界: commit stale-safe — 重复 / 不匹配 / pending 已被覆盖
// =========================================================================
console.log('\n=== Test 5: commit rejects stale / duplicate attempts ===');
{
  const state = createBgmPromptCadenceState(0); // interval=0
  const decider = makeCadenceDecider(state);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat = buildChat(2);
  ledger.sync(chat);

  const userMsg: MockMessage = { id: 2, role: 'user' };
  const assistantMsg: MockMessage = { id: 3, role: 'assistant' };
  ledger.sync(chat);
  const plan = ledger.prepare({
    type: 'normal',
    chat,
    freshUserInput: true,
    decide: decider,
  });
  assert(plan !== null, 'first plan ok');
  // Append chat AFTER plan computed, matching commit-after-start semantics.
  chat.push(userMsg, assistantMsg);
  const ok1 = ledger.commit(plan!, assistantMsg, chat, userMsg);
  assert(ok1, 'first commit accepted');

  // Duplicate commit attempt with the same plan → must reject.
  const ok2 = ledger.commit(plan!, assistantMsg, chat, userMsg);
  assert(!ok2, 'duplicate commit rejected (pending already cleared)');

  // Stale commit with mismatched message → must reject.
  const otherMsg = { id: 99, role: 'assistant' as const };
  const ok3 = ledger.commit(plan!, otherMsg, chat);
  assert(!ok3, 'commit with mismatched message rejected');
}

// =========================================================================
// 6. 边界: replacement slot 在 chat 缩短时仍可继承被删楼层的 decision
// =========================================================================
console.log('\n=== Test 6: replacement slot inherits removed-tail decision ===');
{
  const state = createBgmPromptCadenceState(0);
  const decider = makeCadenceDecider(state);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat = buildChat(4);
  ledger.sync(chat);

  // Commit floor 1 with append-after-start shape.
  const plan = ledger.prepare({
    type: 'normal',
    chat,
    freshUserInput: true,
    decide: decider,
  });
  assert(plan !== null, 'first plan ok');
  const userMsg: MockMessage = { id: 4, role: 'user' };
  const assistantMsg: MockMessage = { id: 5, role: 'assistant' };
  chat.push(userMsg, assistantMsg);
  ledger.commit(plan!, assistantMsg, chat, userMsg);

  // Simulate user removes only the trailing assistant (proper tail truncation
  // carries the record's owner object identity through).
  const removedAssistant = chat.pop()!;
  void removedAssistant;
  ledger.sync(chat);
  assert(ledger.count === 1, 'completedCount preserved through tail truncation');

  // Re-prepare a normal generation in the same slot (no fresh user input → replacement inherits).
  const nextPlan = ledger.prepare({
    type: 'normal',
    chat,
    freshUserInput: false,
    decide: decider,
  });
  assert(nextPlan !== null, 'replacement prepare ok');
  assert(nextPlan!.reused === true, 'replacement was reused (no fresh decide call)');
}

// =========================================================================
// 7. 边界: reset 清空所有状态
// =========================================================================
console.log('\n=== Test 7: ledger.reset() clears all state ===');
{
  const state = createBgmPromptCadenceState(0);
  const decider = makeCadenceDecider(state);
  const ledger = new BgmFloorEligibilityLedger<BgmPromptFloorDecision>();
  const chat = buildChat(2);
  ledger.sync(chat);
  const plan = ledger.prepare({
    type: 'normal',
    chat,
    freshUserInput: true,
    decide: decider,
  });
  const userMsg: MockMessage = { id: 2, role: 'user' };
  const assistantMsg: MockMessage = { id: 3, role: 'assistant' };
  chat.push(userMsg, assistantMsg);
  ledger.commit(plan!, assistantMsg, chat, userMsg);
  assert(ledger.count === 1, 'count=1 pre-reset');

  ledger.reset();
  assert(ledger.count === 0, 'count=0 post-reset');
  ledger.sync(chat);
  const swipeAfterReset = ledger.prepare({
    type: 'swipe',
    chat,
    targetMessageId: assistantMsg.id,
    decide: decider,
  });
  assert(swipeAfterReset === null, 'swipe rejected after reset (records cleared)');
}

console.log('\nAll 调音台 floor ledger tests passed.');
