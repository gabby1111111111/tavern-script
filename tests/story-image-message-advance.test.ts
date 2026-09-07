import { MessageAdvanceGate } from '../src/杠杠の生图机/message-advance';

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: actual=${String(actual)} expected=${String(expected)}`);
}

function testNormalUserAndAssistant(): void {
  const chat: Array<object> = [{ role: 'user' }, { role: 'assistant' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);
  gate.onGenerationStarted('normal', false, chat);

  chat.push({ role: 'user' });
  equal(gate.observeMessage('user', 2, chat), 1, '新用户尾对象应返回上一楼');
  equal(gate.observeMessage('user', 2, chat), null, '重复 MESSAGE_SENT 不应重复推进');

  chat.push({ role: 'assistant' });
  equal(gate.observeMessage('assistant', 3, chat), 2, '同一 normal generation 的 assistant 应推进一次');
  equal(gate.observeMessage('assistant', 3, chat), null, 'MESSAGE_RECEIVED/RENDERED 重复事件应去重');
}

function testNormalAssistantWithoutUser(): void {
  const chat: Array<object> = [{ role: 'assistant' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);
  gate.onGenerationStarted('normal', false, chat);

  chat.push({ role: 'assistant' });
  equal(gate.observeMessage('assistant', 1, chat), 0, '没有新用户楼时 normal assistant 仍应推进');
}

function testAssistantWithoutGeneration(): void {
  const chat: Array<object> = [{ role: 'user' }, { role: 'assistant' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);

  chat.push({ role: 'assistant' });
  equal(gate.observeMessage('assistant', 2, chat), 1, '高层追加的新 assistant 没有 generation 也应推进');
  equal(gate.observeMessage('assistant', 2, chat), null, '无 generation 的新 assistant 重复事件应去重');

  const continueChat: Array<object> = [{ role: 'user' }];
  const continueGate = new MessageAdvanceGate();
  continueGate.reset(continueChat);
  continueChat.push({ role: 'assistant' });
  equal(
    continueGate.observeMessage('assistant', 1, continueChat, 'continue'),
    null,
    '没有 generation 但显式标记为 continue 也不得推进',
  );
}

function testFirstMessageWithoutGeneration(): void {
  const chat: Array<object> = [{ role: 'user' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);

  chat.push({ role: 'assistant' });
  equal(
    gate.observeMessage('assistant', 1, chat, 'first_message'),
    null,
    '没有 generation 的 first_message 也不得清理上一楼',
  );

  const generatedFirstMessageChat: Array<object> = [{ role: 'user' }];
  const generatedFirstMessageGate = new MessageAdvanceGate();
  generatedFirstMessageGate.reset(generatedFirstMessageChat);
  generatedFirstMessageGate.onGenerationStarted('first_message', false, generatedFirstMessageChat);
  generatedFirstMessageChat.push({ role: 'assistant' });
  equal(
    generatedFirstMessageGate.observeMessage('assistant', 1, generatedFirstMessageChat),
    null,
    'first_message generation 不得推进',
  );
}

function testStreamingFirstObservation(): void {
  const chat: Array<object> = [{ role: 'user' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);
  gate.onGenerationStarted('normal', false, chat);

  const streamingAssistant = {};
  chat.push(streamingAssistant);
  equal(gate.observeMessage('assistant', 1, chat), 0, '流式首 token 看到的新 assistant 应推进');
  equal(gate.observeMessage('assistant', 1, chat), null, '流式首 token 后的 receive/render 应去重');
}

function testRegenerateReplacement(): void {
  const oldAssistant = { role: 'assistant', content: 'old' };
  const chat: Array<object> = [{ role: 'user' }, oldAssistant];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);
  gate.onGenerationStarted('regenerate', false, chat);

  chat.pop();
  gate.reseed(chat);
  chat.push({ role: 'assistant', content: 'replacement' });
  equal(gate.observeMessage('assistant', 1, chat), null, 'regenerate 替换同一楼不得推进');
  equal(gate.observeMessage('assistant', 1, chat), null, 'regenerate 替换的重复事件仍应去重');
}

function testSwipeContinueAndDryRun(): void {
  const swipeChat: Array<object> = [{ role: 'user' }, { role: 'assistant' }];
  const swipeGate = new MessageAdvanceGate();
  swipeGate.reset(swipeChat);
  swipeGate.onGenerationStarted('swipe', false, swipeChat);
  equal(swipeGate.observeMessage('assistant', 1, swipeChat), null, 'swipe 修改既有尾对象不得推进');

  const continueChat: Array<object> = [{ role: 'user' }];
  const continueGate = new MessageAdvanceGate();
  continueGate.reset(continueChat);
  continueGate.onGenerationStarted('continue', false, continueChat);
  continueChat.push({ role: 'assistant' });
  equal(continueGate.observeMessage('assistant', 1, continueChat), null, 'continue 不得推进新图片楼');

  const dryRunChat: Array<object> = [{ role: 'user' }];
  const dryRunGate = new MessageAdvanceGate();
  dryRunGate.reset(dryRunChat);
  dryRunGate.onGenerationStarted('normal', true, dryRunChat);
  dryRunChat.push({ role: 'assistant' });
  equal(dryRunGate.observeMessage('assistant', 1, dryRunChat), null, 'dry run 不得推进');
}

function testHistoryAndNonTail(): void {
  const chat: Array<object> = [{ role: 'user' }, { role: 'assistant' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);
  equal(gate.observeMessage('assistant', 1, chat), null, '历史 render 没有 generation 不得推进');

  chat.splice(1, 0, { role: 'assistant', content: 'history' });
  equal(gate.observeMessage('assistant', 1, chat), null, '非尾历史对象不得推进');
  equal(gate.observeMessage('assistant', 2, chat), null, '历史插入后的既有尾对象不得推进');

  const firstMessageChat: Array<object> = [{ role: 'assistant' }];
  const firstMessageGate = new MessageAdvanceGate();
  firstMessageGate.reset(firstMessageChat);
  equal(firstMessageGate.observeMessage('assistant', 0, firstMessageChat), null, 'first_message 没有 normal generation 不得推进');
}

function testOrdinaryDeleteThenAppend(): void {
  const chat: Array<object> = [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }];
  const gate = new MessageAdvanceGate();
  gate.reset(chat);

  chat.pop();
  gate.reseed(chat);
  chat.push({ role: 'user' });
  equal(gate.observeMessage('user', 2, chat), 1, '普通删除后新用户尾仍应返回上一楼');

  gate.onGenerationStarted('normal', false, chat);
  chat.push({ role: 'assistant' });
  equal(gate.observeMessage('assistant', 3, chat), 2, '普通删除后新 normal assistant 应推进');
}

function testReset(): void {
  const chat: Array<object> = [{ role: 'user' }];
  const gate = new MessageAdvanceGate();
  gate.onGenerationStarted('normal', false, chat);
  gate.reset(chat);

  chat.push({ role: 'assistant' });
  equal(gate.observeMessage('assistant', 1, chat), 0, 'reset 应清除旧 generation 并允许新的无代际 assistant');
}

testNormalUserAndAssistant();
testNormalAssistantWithoutUser();
testAssistantWithoutGeneration();
testFirstMessageWithoutGeneration();
testStreamingFirstObservation();
testRegenerateReplacement();
testSwipeContinueAndDryRun();
testHistoryAndNonTail();
testOrdinaryDeleteThenAppend();
testReset();

console.info('<杠杠の生图机> message advance gate tests passed');
