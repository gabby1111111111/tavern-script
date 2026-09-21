import assert from 'node:assert/strict';
import { GenerationEligibilityLedger } from '../src/杠杠の生图机/generation-eligibility';

const ledger = new GenerationEligibilityLedger<boolean>();
const decide = (count: number) => (count - 1) % 5 === 0;
const user = {};
const chat: object[] = [user];
const first = ledger.prepare({ type: 'normal', chat, decide })!;
assert.equal(first.decision, true);
assert.equal(ledger.count, 0, 'preparing/cancelling does not consume cadence');
const retry = ledger.prepare({ type: 'normal', chat, decide })!;
const reply = {};
chat.push(reply);
assert.equal(ledger.commit(first, reply, chat), false, 'superseded completion cannot consume cadence');
assert.equal(ledger.commit(retry, reply, chat), true);
assert.equal(ledger.commit(retry, reply, chat), false, 'duplicate completion is ignored');
assert.equal(ledger.count, 1);

const swipe = ledger.prepare({ type: 'swipe', chat, targetMessageId: 1, decide })!;
assert.equal(swipe.reused, true);
assert.equal(swipe.decision, true);
assert.equal(ledger.commit(swipe, reply, chat), true);
assert.equal(ledger.count, 1, 'swiping an existing reply slot must not advance cadence');

const regenerate = ledger.prepare({ type: 'regenerate', chat, targetMessageId: 1, decide })!;
chat.pop();
ledger.sync(chat);
const regeneratedReply = {};
chat.push(regeneratedReply);
assert.equal(ledger.commit(regenerate, regeneratedReply, chat), true);
assert.equal(ledger.count, 1);
assert.equal(ledger.get(regeneratedReply), true);

chat.pop();
ledger.sync(chat);
const afterDelete = ledger.prepare({ type: 'normal', chat, decide })!;
assert.equal(afterDelete.reused, true, 'delete tail + generate inherits the same logical position');
const recreatedReply = {};
chat.push(recreatedReply);
assert.equal(ledger.commit(afterDelete, recreatedReply, chat), true);
assert.equal(ledger.count, 1);

chat.push({});
const next = ledger.prepare({ type: 'normal', chat, decide })!;
assert.equal(next.decision, false);
chat.push({});
assert.equal(ledger.commit(next, chat.at(-1)!, chat), true);
assert.equal(ledger.count, 2);
const skippedSwipe = ledger.prepare({ type: 'swipe', chat, targetMessageId: 3, decide })!;
assert.equal(skippedSwipe.decision, false, 'ineligible slots retain their decision too');
chat.pop();
ledger.sync(chat);
const skippedReplacement = ledger.prepare({ type: 'regenerate', chat, decide })!;
assert.equal(skippedReplacement.decision, false);
assert.equal(skippedReplacement.reused, true);
chat.push({});
assert.equal(ledger.commit(skippedReplacement, chat.at(-1)!, chat), true);
assert.equal(ledger.count, 2);

// Deleting an interior reply does not reserve its numeric index for unrelated new content.
chat.splice(1, 1);
ledger.sync(chat);
chat.push({});
const afterInteriorDelete = ledger.prepare({ type: 'normal', chat, decide })!;
assert.equal(afterInteriorDelete.reused, false);
assert.equal(afterInteriorDelete.nextFloorCount, 3);

// Even the same length/index cannot inherit a deleted slot when its predecessor has changed.
const isolated = new GenerationEligibilityLedger<boolean>();
const originalPrefix = {};
const branch: object[] = [originalPrefix];
const originalPlan = isolated.prepare({ type: 'normal', chat: branch, decide })!;
branch.push({});
isolated.commit(originalPlan, branch[1], branch);
branch.pop();
isolated.sync(branch);
branch[0] = {};
const otherBranch = isolated.prepare({ type: 'normal', chat: branch, decide })!;
assert.equal(otherBranch.reused, false);
branch.push({});
branch[0] = originalPrefix;
assert.equal(isolated.commit(otherBranch, branch[1], branch), false, 'changed predecessor rejects a late completion');

ledger.reset();
assert.equal(ledger.count, 0);
assert.equal(ledger.get(recreatedReply), undefined);
assert.equal(ledger.prepare({ type: 'swipe', chat, targetMessageId: 0, decide }), null);
assert.equal(ledger.commit(afterInteriorDelete, {}, chat), false, 'reset invalidates pending generations');

// GENERATION_STARTED can precede the host appending the user's input and then its assistant reply.
const hostChat: object[] = [{}];
const hostLedger = new GenerationEligibilityLedger<boolean>();
const hostPlan = hostLedger.prepare({ type: 'normal', chat: hostChat, decide })!;
const sentUser = {};
const hostReply = {};
hostChat.push(sentUser, hostReply);
assert.equal(
  hostLedger.commit(hostPlan, hostReply, hostChat),
  false,
  'a shifted reply requires an identified new user',
);
assert.equal(hostLedger.commit(hostPlan, hostReply, hostChat, sentUser), true);
assert.equal(hostLedger.count, 1);
assert.equal(hostLedger.get(hostReply), true);
hostChat.pop();
hostLedger.sync(hostChat);
const emptySend = hostLedger.prepare({ type: 'normal', chat: hostChat, decide })!;
assert.equal(emptySend.reused, true);
const automaticUser = {};
const replacedReply = {};
hostChat.push(automaticUser, replacedReply);
assert.equal(
  hostLedger.commit(emptySend, replacedReply, hostChat, automaticUser),
  true,
  'host send_if_empty user does not remove replacement eligibility',
);
assert.equal(hostLedger.count, 1);
hostChat.pop();
hostLedger.sync(hostChat);
const explicitSend = hostLedger.prepare({ type: 'normal', chat: hostChat, freshUserInput: true, decide })!;
assert.equal(
  explicitSend.reused,
  false,
  'explicit new user input moves the story forward even after deleting the tail',
);
assert.equal(explicitSend.nextFloorCount, 2);
const staleHostPlan = hostLedger.prepare({ type: 'normal', chat: hostChat, decide })!;
const newUser = {};
const newReply = {};
hostChat[hostChat.length - 1] = {};
hostChat.push(newUser, newReply);
assert.equal(
  hostLedger.commit(staleHostPlan, newReply, hostChat, newUser),
  false,
  'replaced old predecessor cannot rebind',
);
console.info('<杠杠の生图机> generation eligibility tests passed');
