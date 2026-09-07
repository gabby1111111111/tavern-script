import {
  isMatchingAssistantReply,
  isMatchingNormalAssistantReply,
  isNormalGeneration,
  isSwipeGeneration,
  isSingleCharacterChat,
  MessageIdentityStore,
  shouldArmStoryImageGeneration,
} from '../src/杠杠の生图机/runtime-policy';

function assertEqual(actual: unknown, expected: unknown, message = 'values should be equal'): void {
  if (actual !== expected) throw new Error(`${message}: actual=${String(actual)} expected=${String(expected)}`);
}

assertEqual(isNormalGeneration('normal'), true);
assertEqual(isNormalGeneration('normal', true), false);
for (const type of ['quiet', 'regenerate', 'impersonate', 'continue', 'swipe', 'append', 'extension']) {
  assertEqual(isNormalGeneration(type), false, `${type} must not count as a normal floor`);
}
assertEqual(isSwipeGeneration('swipe'), true);
assertEqual(isSwipeGeneration('swipe', true), false);
assertEqual(isSwipeGeneration('normal'), false);

assertEqual(isSingleCharacterChat(''), true);
assertEqual(isSingleCharacterChat(undefined), true);
assertEqual(isSingleCharacterChat('group-1'), false);

const firstMessage = {};
const deletedMessage = {};
const survivingMessage = {};
const chat = [firstMessage, deletedMessage, survivingMessage];
const identities = new MessageIdentityStore<string>();
assertEqual(identities.set(survivingMessage, 'eligible'), true);
chat.splice(1, 1);
assertEqual(identities.get(chat[1]), 'eligible', 'array index shifts must not erase a surviving floor decision');
identities.reset();
assertEqual(identities.get(survivingMessage), undefined, 'chat changes must reset page-memory floor decisions');

assertEqual(shouldArmStoryImageGeneration({ enabled: true, type: 'normal', dryRun: false, groupId: '' }), true);
assertEqual(shouldArmStoryImageGeneration({ enabled: true, type: 'normal', dryRun: false, groupId: 'group-1' }), false);
assertEqual(
  shouldArmStoryImageGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    groupId: '',
    generateOnSwipe: true,
    swipeFloorEligible: true,
  }),
  true,
  'an eligible swipe generation should arm when the user switch is enabled',
);
assertEqual(
  shouldArmStoryImageGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    groupId: '',
    generateOnSwipe: false,
    swipeFloorEligible: true,
  }),
  false,
  'disabling swipe generation should preserve the v0.3 behavior',
);
assertEqual(
  shouldArmStoryImageGeneration({
    enabled: true,
    type: 'swipe',
    dryRun: false,
    groupId: '',
    generateOnSwipe: true,
    swipeFloorEligible: false,
  }),
  false,
  'a swipe on a floor skipped by cadence must not generate an image',
);

assertEqual(
  isMatchingNormalAssistantReply({ type: 'normal', role: 'assistant', expectedMessageId: 8, receivedMessageId: 8 }),
  true,
);
assertEqual(
  isMatchingNormalAssistantReply({ type: 'swipe', role: 'assistant', expectedMessageId: 8, receivedMessageId: 8 }),
  false,
);
assertEqual(
  isMatchingNormalAssistantReply({ type: 'normal', role: 'user', expectedMessageId: 8, receivedMessageId: 8 }),
  false,
);
assertEqual(
  isMatchingAssistantReply({
    generationType: 'swipe',
    receivedType: 'swipe',
    role: 'assistant',
    expectedMessageId: 8,
    receivedMessageId: 8,
  }),
  true,
  'a newly generated swipe reply should match its armed swipe generation',
);
assertEqual(
  isMatchingAssistantReply({
    generationType: 'swipe',
    receivedType: 'normal',
    role: 'assistant',
    expectedMessageId: 8,
    receivedMessageId: 8,
  }),
  false,
  'an unrelated normal reply must not consume a swipe generation',
);

console.info('<杠杠の生图机> runtime policy tests passed');
