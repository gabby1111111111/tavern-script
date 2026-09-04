import {
  isMatchingNormalAssistantReply,
  isNormalGeneration,
  isSingleCharacterChat,
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

assertEqual(isSingleCharacterChat(''), true);
assertEqual(isSingleCharacterChat(undefined), true);
assertEqual(isSingleCharacterChat('group-1'), false);

assertEqual(shouldArmStoryImageGeneration({ enabled: true, type: 'normal', dryRun: false, groupId: '' }), true);
assertEqual(shouldArmStoryImageGeneration({ enabled: true, type: 'normal', dryRun: false, groupId: 'group-1' }), false);

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

console.info('<杠杠の生图机> runtime policy tests passed');
