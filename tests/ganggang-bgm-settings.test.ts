import {
  DEFAULT_AMBIENT_PROMPT_CONTENT,
  DEFAULT_BGM_PROMPT_PRESET,
  areBgmPromptPresetsEqual,
  createBgmPromptCadenceState,
  createBgmPromptGenerationLifecycle,
  createBgmPromptSkippedSwipeLifecycle,
  createBgmPromptPreset,
  BgmMessageIdentityStore,
  decideBgmPromptCadenceAtFloor,
  decideBgmPromptCadence,
  advanceBgmPromptSkippedSwipeLifecycle,
  deleteBgmPromptPreset,
  isBgmPromptGenerationReady,
  markBgmPromptGenerationAborted,
  markBgmPromptAfterCommandsAccepted,
  markBgmPromptGenerationStarted,
  markBgmPromptGenerationSettled,
  mergeBgmPromptSwipeAudit,
  migrateBgmSettings,
  normalizeBgmPromptInterval,
  normalizeBgmPromptPresets,
  shouldArmBgmPromptGeneration,
  shouldHandleBgmGeneration,
  settleBgmPromptCadence,
  shouldTrackBgmGeneration,
  shouldTrackAudioGeneration,
  updateBgmPromptCadenceInterval,
  updateBgmPromptPreset,
  upsertBgmPromptPreset,
} from '../src/杠杠の调音台/bgm-settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const legacy = {
  bgm_injection_location: ' legacy injection ',
  ambient_prompt_content: 'legacy ambient {{current_ambient_location}}',
  bgm_prompt_content: 'legacy BGM',
  bgm_forbidden_list_prompt: 'legacy forbidden {{current_bgm_playlist}}',
  bgm_required_list_prompt: 'legacy required {{required_candidates}}',
};
const migrated = migrateBgmSettings(legacy);

assert(migrated.prompt_presets.length === 1, '旧五字段应迁移为一套提示词');
equal(migrated.prompt_presets[0].id, DEFAULT_BGM_PROMPT_PRESET.id, '迁移后的默认提示词 ID');
equal(migrated.prompt_presets[0].name, '默认提示词', '迁移后的默认提示词名称');
equal(migrated.current_prompt_preset_id, migrated.prompt_presets[0].id, '迁移后当前 ID 应可用');
equal(migrated.bgm_prompt_content, legacy.bgm_prompt_content, '迁移不得丢失 BGM 提示词');
equal(migrated.ambient_prompt_content, legacy.ambient_prompt_content, '迁移不得丢失环境音提示词');
equal(migrated.bgm_forbidden_list_prompt, legacy.bgm_forbidden_list_prompt, '迁移不得丢失禁选列表');
assert(migrated.generate_on_swipe, '旧设置迁移时 Swipe 出歌默认开启');
equal(
  migrateBgmSettings({ ...legacy, generate_on_swipe: false }).generate_on_swipe,
  false,
  '已有 Swipe 开关关闭状态应在迁移后保留',
);

const blankAmbientMigrated = migrateBgmSettings({ ...legacy, ambient_prompt_content: ' \n\t' });
equal(blankAmbientMigrated.ambient_prompt_content, DEFAULT_AMBIENT_PROMPT_CONTENT, '空环境音提示词应恢复默认值');
equal(
  blankAmbientMigrated.prompt_presets[0].ambient_prompt_content,
  DEFAULT_AMBIENT_PROMPT_CONTENT,
  '恢复默认环境音提示词后 active preset 应保持一致',
);
equal(
  migrateBgmSettings({
    ...legacy,
    prompt_presets: [{ ...legacy, id: 'blank', name: '空环境音', ambient_prompt_content: '  ' }],
    current_prompt_preset_id: 'blank',
  }).ambient_prompt_content,
  DEFAULT_AMBIENT_PROMPT_CONTENT,
  'preset 内的空环境音提示词也应恢复默认值',
);

const selectedPreset = createBgmPromptPreset({ id: 'selected', name: '已选方案', bgm_prompt_content: 'selected content' });
assert(areBgmPromptPresetsEqual(selectedPreset, { ...selectedPreset }), '相同提示词字段应判定为未修改');
assert(
  !areBgmPromptPresetsEqual(selectedPreset, { ...selectedPreset, name: '另一个名称' }),
  '方案名称变化应判定为已修改',
);
assert(
  !areBgmPromptPresetsEqual(selectedPreset, { ...selectedPreset, bgm_prompt_content: 'changed content' }),
  '提示词字段变化应判定为已修改',
);
const selectedSettings = migrateBgmSettings({
  ...legacy,
  bgm_prompt_content: 'stale flat value',
  prompt_presets: [selectedPreset],
  current_prompt_preset_id: selectedPreset.id,
});
equal(selectedSettings.bgm_prompt_content, 'selected content', '当前提示词应成为 index 兼容字段');
equal(selectedSettings.current_prompt_preset_id, selectedPreset.id, '已有当前提示词 ID 应保留');

const malformed = normalizeBgmPromptPresets([
  { id: 'same', name: '  场景\n一  ', ...legacy },
  { id: 'same', name: '', ...legacy, bgm_prompt_content: 'second' },
]);
equal(malformed.map(preset => preset.id), ['same', 'same-2'], '重复 ID 应稳定加后缀');
equal(malformed[0].name, '场景 一', '提示词名称应去除首尾空白并折叠换行');
equal(malformed[1].name, '提示词 2', '空名称应使用可识别的默认名称');

const first = createBgmPromptPreset({ id: 'first', name: '第一套', bgm_prompt_content: 'first content' });
const second = createBgmPromptPreset({ name: '第二套', bgm_prompt_content: 'second content' }, [first.id]);
assert(first.id !== second.id, '新增提示词必须使用唯一 ID');
const added = upsertBgmPromptPreset([first], second);
equal(added.presets.map(preset => preset.id), ['first', second.id], 'upsert 应新增一套提示词');
const updated = updateBgmPromptPreset(added.presets, second.id, {
  name: '  第二套修改后  ',
  bgm_prompt_content: 'updated content',
});
equal(updated[1].name, '第二套修改后', '更新应规范化名称');
equal(updated[1].bgm_prompt_content, 'updated content', '更新应只改变草稿传入的字段');

const removedCurrent = deleteBgmPromptPreset(updated, second.id, second.id);
assert(removedCurrent.deleted, '删除现有提示词应成功');
equal(removedCurrent.currentId, 'first', '删除当前提示词后应选择剩余提示词');
equal(removedCurrent.presets.length, 1, '删除后应保留剩余提示词');

const restored = deleteBgmPromptPreset(removedCurrent.presets, 'first', 'first');
assert(restored.deleted && restored.restoredDefault, '删除最后一套时应恢复默认提示词');
equal(restored.presets, [DEFAULT_BGM_PROMPT_PRESET], '删除最后一套的默认恢复内容');
equal(restored.currentId, DEFAULT_BGM_PROMPT_PRESET.id, '默认恢复后当前 ID 应可用');

function cadenceSequence(interval: number, rounds: number): boolean[] {
  let state = createBgmPromptCadenceState(interval);
  const decisions: boolean[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const decision = decideBgmPromptCadence(state);
    decisions.push(decision.bgmPromptIncluded);
    state = settleBgmPromptCadence(state, decision.bgmPromptIncluded, 'completed');
  }
  return decisions;
}

equal(cadenceSequence(0, 4), [true, true, true, true], '间隔 0 应每楼注入 BGM 提示词');
equal(cadenceSequence(1, 5), [true, false, true, false, true], '间隔 1 应注入、跳 1 楼后再次注入');
equal(cadenceSequence(2, 6), [true, false, false, true, false, false], '间隔 2 应注入、跳 2 楼后再次注入');

const floorSequenceState = createBgmPromptCadenceState(2);
equal(
  [1, 2, 3, 4, 5].map(floor => decideBgmPromptCadenceAtFloor(floorSequenceState, floor).bgmPromptIncluded),
  [true, false, false, true, false],
  'normal assistant 楼层资格应按 1、4、7 的成熟机制计算',
);
assert(!decideBgmPromptCadenceAtFloor(floorSequenceState, 0).bgmPromptIncluded, '零楼数不应获得 Swipe 资格');

let sourceErrorState = createBgmPromptCadenceState(1);
const sourceErrorDecision = decideBgmPromptCadence(sourceErrorState);
sourceErrorState = settleBgmPromptCadence(sourceErrorState, sourceErrorDecision.bgmPromptIncluded, 'source_error');
assert(!decideBgmPromptCadence(sourceErrorState).bgmPromptIncluded, '正文已落地但来源失败仍应推进楼层相位');
const abortedDecision = decideBgmPromptCadence(sourceErrorState);
sourceErrorState = settleBgmPromptCadence(sourceErrorState, abortedDecision.bgmPromptIncluded, 'aborted');
assert(!decideBgmPromptCadence(sourceErrorState).bgmPromptIncluded, 'aborted 不应消耗待跳过楼层');
sourceErrorState = settleBgmPromptCadence(sourceErrorState, abortedDecision.bgmPromptIncluded, 'completed');
assert(decideBgmPromptCadence(sourceErrorState).bgmPromptIncluded, '完成被跳过的一楼后应恢复注入');

let intervalChangeState = createBgmPromptCadenceState(2);
intervalChangeState = settleBgmPromptCadence(intervalChangeState, true, 'completed');
intervalChangeState = updateBgmPromptCadenceInterval(intervalChangeState, 1);
equal(intervalChangeState.completedCount, 1, '修改间隔不得重置已落地 normal 楼数');
assert(!decideBgmPromptCadence(intervalChangeState).bgmPromptIncluded, '修改间隔后应按已有楼数计算下一楼资格');
intervalChangeState = settleBgmPromptCadence(intervalChangeState, false, 'completed');
assert(decideBgmPromptCadence(intervalChangeState).bgmPromptIncluded, '按新间隔完成一楼后应正确进入下一资格');

const normalMessage = {};
const swipeMessage = {};
const messageDecisions = new BgmMessageIdentityStore<{ eligible: boolean }>();
assert(messageDecisions.set(normalMessage, { eligible: true }), 'raw message identity 应可保存资格');
equal(messageDecisions.get(normalMessage), { eligible: true }, '应从原始消息对象读取资格');
assert(messageDecisions.get(swipeMessage) === undefined, '未保存的消息不得误判 Swipe 资格');
messageDecisions.reset();
assert(messageDecisions.get(normalMessage) === undefined, '聊天重置后应清空 raw message 资格');

let startedBeforeAfter = createBgmPromptGenerationLifecycle();
startedBeforeAfter = markBgmPromptGenerationStarted(startedBeforeAfter);
assert(!isBgmPromptGenerationReady(startedBeforeAfter), 'STARTED 先到时，尚未接受 AFTER 不应结算');
startedBeforeAfter = markBgmPromptAfterCommandsAccepted(startedBeforeAfter);
assert(isBgmPromptGenerationReady(startedBeforeAfter), 'STARTED -> AFTER 后应允许 MESSAGE_RECEIVED 结算');
let afterBeforeStarted = createBgmPromptGenerationLifecycle();
afterBeforeStarted = markBgmPromptAfterCommandsAccepted(afterBeforeStarted);
assert(!isBgmPromptGenerationReady(afterBeforeStarted), 'AFTER 先到时，尚未 STARTED 不应结算');
afterBeforeStarted = markBgmPromptGenerationStarted(afterBeforeStarted);
assert(isBgmPromptGenerationReady(afterBeforeStarted), 'AFTER -> STARTED 后应允许 MESSAGE_RECEIVED 结算');

let settlementState = createBgmPromptGenerationLifecycle();
let settlementCount = 0;
for (const event of ['started', 'after', 'received', 'ended']) {
  if (event === 'started') settlementState = markBgmPromptGenerationStarted(settlementState);
  if (event === 'after') settlementState = markBgmPromptAfterCommandsAccepted(settlementState);
  if ((event === 'received' || event === 'ended') && isBgmPromptGenerationReady(settlementState)) {
    settlementState = markBgmPromptGenerationSettled(settlementState);
    settlementCount += 1;
  }
}
assert(settlementCount === 1, 'MESSAGE_RECEIVED 与 GENERATION_ENDED 重复到达时只能结算一次');
assert(!isBgmPromptGenerationReady(settlementState), '已结算 generation 不得再次进入 ready 状态');
let abortedState = createBgmPromptGenerationLifecycle();
abortedState = markBgmPromptGenerationStarted(abortedState);
abortedState = markBgmPromptAfterCommandsAccepted(abortedState);
abortedState = markBgmPromptGenerationAborted(abortedState);
assert(!isBgmPromptGenerationReady(abortedState), 'abort 后不得结算当前 generation');

const resetPlaylistPrompt = {
  status: 'pending',
  swipe_enabled: true,
  swipe_message_id: null,
  swipe_eligible: null,
  swipe_started: false,
  swipe_skipped: false,
};
const skippedSwipeAudit = {
  swipe_enabled: false,
  swipe_message_id: 42,
  swipe_eligible: false,
  swipe_started: false,
  swipe_skipped: true,
};
equal(
  mergeBgmPromptSwipeAudit({ ...resetPlaylistPrompt, status: 'success' }, skippedSwipeAudit),
  { ...resetPlaylistPrompt, status: 'success', ...skippedSwipeAudit },
  '重建 playlist_prompt 后应保留跳过 Swipe 的审计事实',
);

for (const firstEvent of ['started', 'after_commands'] as const) {
  const pairEvent = firstEvent === 'started' ? 'after_commands' : 'started';
  const bgmEnabled = false;
  const ambientEnabled = true;
  assert(!bgmEnabled && ambientEnabled, 'BGM disabled + ambient enabled 应仍保留 Swipe 生命周期');
  assert(
    !shouldArmBgmPromptGeneration({
      enabled: bgmEnabled,
      type: 'swipe',
      dryRun: false,
      generateOnSwipe: true,
      swipeFloorEligible: true,
    }),
    'BGM disabled + ambient enabled 时 Swipe 应走 non-candidate 分支',
  );
  assert(shouldTrackAudioGeneration('swipe', false), 'BGM disabled + ambient enabled 仍应接收真实 Swipe 事件');
  let skippedSwipe = createBgmPromptSkippedSwipeLifecycle(firstEvent, skippedSwipeAudit.swipe_message_id);
  const firstTransition = advanceBgmPromptSkippedSwipeLifecycle(skippedSwipe, firstEvent);
  assert(firstTransition.action === 'wait', `${firstEvent} 首次到达时应等待配对事件`);
  skippedSwipe = firstTransition.state;
  const secondTransition = advanceBgmPromptSkippedSwipeLifecycle(skippedSwipe, pairEvent);
  assert(secondTransition.action === 'reuse', `${firstEvent} -> ${pairEvent} 应复用已消费的 Swipe 目标`);
  skippedSwipe = secondTransition.state;
  equal(skippedSwipe.messageId, 42, `${firstEvent} -> ${pairEvent} 不得丢失原 Swipe message id`);
  const rebuiltAudit = mergeBgmPromptSwipeAudit(resetPlaylistPrompt, skippedSwipeAudit);
  equal(
    rebuiltAudit,
    { ...resetPlaylistPrompt, ...skippedSwipeAudit },
    `${firstEvent} -> ${pairEvent} 的第二事件重建提示后仍应保留跳过审计`,
  );
  const duplicateTransition = advanceBgmPromptSkippedSwipeLifecycle(skippedSwipe, pairEvent);
  assert(duplicateTransition.action === 'ignore', '已完成的 skipped Swipe lifecycle 不得再次消费目标');
}

assert(shouldTrackBgmGeneration('normal', false), 'normal 应计入正文楼');
for (const type of ['regenerate', 'swipe']) {
  assert(!shouldTrackBgmGeneration(type, false), `${type} 不应推进 normal 正文楼计数`);
}
assert(shouldHandleBgmGeneration('normal', false), 'normal 应可进入 BGM 生成流程');
assert(shouldHandleBgmGeneration('swipe', false), 'swipe 应可进入 BGM 生成流程');
for (const type of ['regenerate', 'quiet', 'impersonate', 'command', 'extension', 'first_message', 'continue', 'append', 'appendFinal']) {
  assert(!shouldHandleBgmGeneration(type, false), `${type} 不应进入 BGM 生成流程`);
}
for (const type of ['quiet', 'impersonate', 'command', 'extension', 'first_message', 'continue', 'append', 'appendFinal']) {
  assert(!shouldTrackBgmGeneration(type, false), `${type} 不应计入正文楼`);
}
assert(!shouldTrackBgmGeneration('normal', true), 'dry_run 不应计入正文楼');
assert(
  shouldArmBgmPromptGeneration({ enabled: true, type: 'normal', dryRun: false }),
  'normal 应可创建 BGM 生成门控',
);
assert(
  shouldArmBgmPromptGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    generateOnSwipe: true,
    swipeFloorEligible: true,
  }),
  '开启 Swipe 且原楼符合频率时应创建 BGM 生成门控',
);
assert(
  !shouldArmBgmPromptGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    generateOnSwipe: false,
    swipeFloorEligible: true,
  }),
  '关闭 Swipe 开关时不得创建 BGM 生成门控',
);
assert(
  !shouldArmBgmPromptGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    generateOnSwipe: true,
    swipeFloorEligible: false,
  }),
  '原楼不符合频率时不得创建 Swipe BGM 生成门控',
);
assert(
  !shouldArmBgmPromptGeneration({ enabled: true, type: 'normal', dryRun: true }),
  'dry_run 不得创建 BGM 生成门控',
);
assert(shouldTrackAudioGeneration('continue', false), 'continue 应继续进入环境音生命周期');
assert(shouldTrackAudioGeneration('appendFinal', false), 'appendFinal 应继续进入环境音生命周期');
assert(!shouldTrackAudioGeneration('quiet', false), 'quiet 不应进入环境音生命周期');
assert(!shouldTrackAudioGeneration('normal', true), 'dry_run 不应进入环境音生命周期');

equal(normalizeBgmPromptInterval(undefined), 0, '缺失间隔应归一化为 0');
equal(normalizeBgmPromptInterval('not-a-number'), 0, '非法间隔应归一化为 0');
equal(normalizeBgmPromptInterval(-1), 0, '负数间隔应归一化为 0');
equal(normalizeBgmPromptInterval(2.9), 2, '小数间隔应向下取整');
equal(migrateBgmSettings({ ...legacy, bgm_prompt_interval: 'bad' }).bgm_prompt_interval, 0, '迁移非法间隔应使用 0');

console.info('<杠杠の调音台> prompt preset migration and CRUD tests passed');
