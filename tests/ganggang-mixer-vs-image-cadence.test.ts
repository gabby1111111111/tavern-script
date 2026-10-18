// 调研用：调音台 vs 生图机 cadence + Swipe 资格路径对比
// 一次性脚本，仅断言等价性 + 打印对比证据，不参与产品验收

import {
  BgmMessageIdentityStore,
  createBgmPromptCadenceState,
  decideBgmPromptCadenceAtFloor,
  normalizeBgmPromptInterval,
  settleBgmPromptCadence,
  shouldArmBgmPromptGeneration,
} from '../src/杠杠の调音台/bgm-settings';
import {
  decideFloorTrigger,
  floorInterval,
} from '../src/杠杠の生图机/display-policy';
import { GenerationEligibilityLedger } from '../src/杠杠の生图机/generation-eligibility';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${message}`);
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

function mark(values: readonly boolean[]): string {
  return values.map(v => (v ? '●' : '·')).join('');
}

// =========================================================================
// 1. cadence 数学等价性：调音台 (interval) vs 生图机 (skipFloors)
// =========================================================================
console.log('\n=== Test 1: cadence math equivalence (interval 0..3, floors 1..10) ===');
const FLOORS = Array.from({ length: 10 }, (_, i) => i + 1);
for (const interval of [0, 1, 2, 3]) {
  const mixerState = createBgmPromptCadenceState(interval);
  const mixerSequence = FLOORS.map(f => decideBgmPromptCadenceAtFloor(mixerState, f).bgmPromptIncluded);

  const imageInterval = floorInterval(interval);
  const imageSequence = FLOORS.map(count =>
    decideFloorTrigger({
      normalAssistantFloorCount: count,
      enabled: true,
      isNormalGeneration: true,
      isGroupChat: false,
      displaySettings: { skipFloors: interval },
    }).shouldTrigger,
  );

  const header = `mixer interval=${interval} = image skipFloors=${interval} (imageInterval=${imageInterval})`;
  console.log(`\n${header}`);
  console.log(`  floors : [${FLOORS.map(String).join(' ')}]`);
  console.log(`  mixer  : [${mark(mixerSequence)}]  ${mixerSequence.map(Number).join('')}`);
  console.log(`  image  : [${mark(imageSequence)}]  ${imageSequence.map(Number).join('')}`);
  assert(
    JSON.stringify(mixerSequence) === JSON.stringify(imageSequence),
    `cadence sequences match at interval=${interval}`,
  );
}

// =========================================================================
// 2. Swipe 资格判定路径对比：调音台（事件驱动 + WeakMap）vs 生图机（ledger 直接 prepare）
// =========================================================================
console.log('\n=== Test 2: Swipe eligibility path comparison ===');

const imageLedger = new GenerationEligibilityLedger<{ willTrigger: boolean }>();

// --- 生图机：commit 5 个 normal 楼层（prepare 时不包含新楼层，commit 时已 append user + assistant） ---
let imageChat: object[] = [];
for (let floor = 1; floor <= 5; floor++) {
  // 1) user 消息落地：chat 长度 = floor（1 个 user + 0 个 assistant）
  const userMessage = { kind: 'user', marker: Symbol(`user${floor}`) };
  imageChat = [...imageChat, userMessage];
  imageLedger.sync(imageChat);
  // 2) prepare normal（targetMessageId = chat.length，意味着"在尾部生成"）
  const plan = imageLedger.prepare({
    type: 'normal',
    chat: imageChat,
    decide: next => ({
      willTrigger: decideFloorTrigger({
        normalAssistantFloorCount: next,
        enabled: true,
        isNormalGeneration: true,
        displaySettings: { skipFloors: 1 },
      }).shouldTrigger,
    }),
  });
  if (!plan) continue;
  // 3) AI 消息 append：chat 长度 = floor + 1
  const assistantMessage = { kind: 'assistant', marker: Symbol(`assistant${floor}`) };
  imageChat = [...imageChat, assistantMessage];
  // 4) commit：appendedUserMessage 是 plan.index 处的 user 消息
  const committed = imageLedger.commit(plan, assistantMessage, imageChat, userMessage);
  if (!committed) {
    console.warn(`  ⚠ commit failed at floor=${floor}`);
  }
}
console.log(`\n  image ledger count after 5 normal floors: ${imageLedger.count}`);

// 生图机直接 prepare swipe（不需要任何 swipe 事件；targetMessageId 来自 caller/UI）
// swipe assistantMessages[2]（floor 3，cadence 触发）
const imageSwipeAt3 = imageLedger.prepare({ type: 'swipe', chat: imageChat, targetMessageId: 3 });
console.log(`  image swipe→floor 3 (chat idx=3, plan): ${imageSwipeAt3 ? `reused=${imageSwipeAt3.reused}, nextFloorCount=${imageSwipeAt3.nextFloorCount}` : 'null'}`);
console.log(`  image count after swipe (must NOT advance): ${imageLedger.count}`);
assert(
  imageLedger.count === 5,
  `image ledger does not advance on swipe (count stays at 5)`,
);

// --- 调音台：用 BgmMessageIdentityStore 模拟 floorDecisions，再模拟 pendingSwipeTarget ---
const mixerFloorDecisions = new BgmMessageIdentityStore<{ bgmPromptIncluded: boolean; interval: number }>();
let mixerState = createBgmPromptCadenceState(1); // interval=1
let mixerFloorCount = 0;
const assistantMessages = imageChat.filter(m => (m as { kind?: string }).kind === 'assistant') as object[];
for (let floor = 1; floor <= 5; floor++) {
  const decision = decideBgmPromptCadenceAtFloor(mixerState, mixerFloorCount + 1);
  mixerFloorDecisions.set(assistantMessages[floor - 1], {
    bgmPromptIncluded: decision.bgmPromptIncluded,
    interval: decision.interval,
  });
  mixerState = settleBgmPromptCadence(mixerState, decision.bgmPromptIncluded, 'completed');
  mixerFloorCount += 1;
}
console.log(`  mixer floor count after 5 normal floors: ${mixerFloorCount}`);

// 模拟 MESSAGE_SWIPED 触发：pendingSwipeTarget = assistantMessages[2]（floor 3）
const mixerSwipeTarget = assistantMessages[2];
const mixerSwipeDecision = mixerFloorDecisions.get(mixerSwipeTarget);
console.log(`  mixer swipe→floor 3 (decision via pending target): ${JSON.stringify(mixerSwipeDecision)}`);
const mixerArmed = shouldArmBgmPromptGeneration({
  enabled: true,
  type: 'swipe',
  dryRun: false,
  generateOnSwipe: true,
  swipeFloorEligible: mixerSwipeDecision?.bgmPromptIncluded ?? false,
});
console.log(`  mixer swipe armed: ${mixerArmed}`);
const imageIsEligible = imageSwipeAt3 !== null && imageSwipeAt3.reused;
assert(
  mixerArmed === imageIsEligible,
  `mixer and image agree on swipe eligibility at floor 3 (mixer=${mixerArmed}, image=${imageIsEligible})`,
);

// =========================================================================
// 3. 边界 1：MESSAGE_SWIPED 没发 → 调音台 fallback 到当前 assistant tail
// =========================================================================
console.log('\n=== Test 3: edge case - MESSAGE_SWIPED not fired (mixer fallback to assistant tail) ===');

// 假设用户在 floor 3 swipe（target = assistantMessages[2]），但 MESSAGE_SWIPED 丢失
// 调音台 fallback 路径 (index.ts:1287-1294)：pendingSwipeTarget=null → 用 getLastMessageId()（=最后一条 assistant，即 floor 5）
const fallbackTail = assistantMessages[assistantMessages.length - 1]; // 最后一条 assistant = floor 5
const fallbackDecision = mixerFloorDecisions.get(fallbackTail);
const fallbackFloorNumber = mixerFloorCount; // tail 相当于第 N 楼
console.log(`  user swipe intent: floor 3 (target=assistantMessages[2])`);
console.log(`  fallback to tail (floor ${fallbackFloorNumber}, eligible=${fallbackDecision?.bgmPromptIncluded}): ⚠ mixer would inject BGM based on FALLBACK floor cadence, not the intended floor`);
console.log(`  → root cause candidate: stale fallback triggers wrong-floor injection OR no-op trigger (eligibility=false) when both floors disagree`);

// 生图机：在没有 MESSAGE_SWIPED 时，依然能从 ledger.prepare + targetMessageId 直接定位
const imageSwipeAt3NoEvent = imageLedger.prepare({ type: 'swipe', chat: imageChat, targetMessageId: 3 });
console.log(`  image still hits floor 3 via chat[targetMessageId]: ${imageSwipeAt3NoEvent !== null ? `reused=${imageSwipeAt3NoEvent.reused}, nextFloorCount=${imageSwipeAt3NoEvent.nextFloorCount}` : 'null'}`);
assert(
  imageSwipeAt3NoEvent !== null && imageSwipeAt3NoEvent.reused && imageLedger.count === 5,
  `image is robust to MESSAGE_SWIPED loss`,
);

// =========================================================================
// 4. 边界 2：用户切到一个从未结算的楼层（fresh 对象）—— 两个都应拒绝
// =========================================================================
console.log('\n=== Test 4: edge case - swipe to a never-committed message (fresh object) ===');

const freshMessage = { id: 99, marker: Symbol('fresh') };
const mixerFreshDecision = mixerFloorDecisions.get(freshMessage);
const mixerFreshArmed = shouldArmBgmPromptGeneration({
  enabled: true,
  type: 'swipe',
  dryRun: false,
  generateOnSwipe: true,
  swipeFloorEligible: mixerFreshDecision?.bgmPromptIncluded ?? false,
});
console.log(`  mixer swipe→fresh: decision=${mixerFreshDecision}, armed=${mixerFreshArmed}`);

const imageFreshPlan = imageLedger.prepare({ type: 'swipe', chat: imageChat, targetMessageId: 99 });
console.log(`  image swipe→idx=99 (out of range): plan=${imageFreshPlan}`);
assert(
  !mixerFreshArmed && imageFreshPlan === null,
  `both reject swipe to an uncommitted floor`,
);

// =========================================================================
// 5. 边界 3：cadence 边界 — interval=0 时每楼都该出歌
// =========================================================================
console.log('\n=== Test 5: cadence boundary — interval=0 must trigger every floor ===');
const everyFloorShouldTrigger = FLOORS.every(f =>
  decideBgmPromptCadenceAtFloor(createBgmPromptCadenceState(0), f).bgmPromptIncluded,
);
const everyFloorDecision = FLOORS.map(f =>
  decideFloorTrigger({
    normalAssistantFloorCount: f,
    enabled: true,
    isNormalGeneration: true,
    displaySettings: { skipFloors: 0 },
  }).shouldTrigger,
);
const imageEveryFloor = everyFloorDecision.every(Boolean);
assert(
  everyFloorShouldTrigger && imageEveryFloor,
  `both must trigger every floor at interval=0`,
);

// =========================================================================
// 6. cadence 归一化边界
// =========================================================================
console.log('\n=== Test 6: cadence normalization edge cases ===');
const normalizeCases: Array<[unknown, number]> = [
  [undefined, 0],
  ['bad', 0],
  [-1, 0],
  [2.9, 2],
  [3, 3],
];
for (const [input, expected] of normalizeCases) {
  const actual = normalizeBgmPromptInterval(input);
  assert(actual === expected, `normalizeBgmPromptInterval(${String(input)}) = ${actual} (expected ${expected})`);
}

// =========================================================================
// 7. cadence 在 completedCount 边界的行为（关键：覆盖已完成楼层数）
// =========================================================================
console.log('\n=== Test 7: cadence from completedCount state (interval=2, completed=4) ===');
// 模拟：已完成 4 楼，下一楼的决定应该按 floorCount=5 计算
const stateAt4 = settleBgmPromptCadence(
  settleBgmPromptCadence(
    settleBgmPromptCadence(
      settleBgmPromptCadence(createBgmPromptCadenceState(2), true, 'completed'),
      true,
      'completed',
    ),
    true,
    'completed',
  ),
  true,
  'completed',
);
const nextFloorDecision = decideBgmPromptCadenceAtFloor(stateAt4, 5);
console.log(`  interval=2, completed=4 → floor 5 decision: ${JSON.stringify(nextFloorDecision)}`);
// interval=2 → floor 1,4,7 → floor 5 should be skipped
assert(
  nextFloorDecision.bgmPromptIncluded === false,
  `floor 5 at interval=2 with 4 completed should be skipped`,
);

// =========================================================================
// 8. report-ready 摘要
// =========================================================================
console.log('\n=== Comparison Summary ===');
console.log('  cadence math        : EQUIVALENT (verified across interval 0..3, floors 1..10)');
console.log('  swipe eligibility   : EQUIVALENT at happy path (targetMessageId-based)');
console.log('  event dependency    :');
console.log('    - image : swipe needs only chat[targetMessageId] (event-free)');
console.log('    - mixer : swipe needs MESSAGE_SWIPED → pendingSwipeTarget → floorDecisions.get(messageRef)');
console.log('                       fallback: if MESSAGE_SWIPED lost → use current assistant tail');
console.log('  robustness gap      : mixer is sensitive to MESSAGE_SWIPED event order;');
console.log('                       image is robust because prepare() takes targetMessageId from caller');
console.log('\n✓ ALL INVESTIGATION ASSERTIONS PASSED');