import type { ImageResource } from '../src/杠杠の生图机/image-api';
import { ImagePlacementCache } from '../src/杠杠の生图机/image-placement';
import type { InlineImagePrompt } from '../src/杠杠の生图机/marker';
import { RecentImageCache } from '../src/杠杠の生图机/recent-image-cache';
import { createImageTask, ImageTaskCache } from '../src/杠杠の生图机/task-cache';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const prompt: InlineImagePrompt = {
  index: 0,
  prompt: 'portrait',
  start: 0,
  end: 23,
  paragraphIndex: 0,
  anchorTextBefore: '',
  anchorTextAfter: '',
};
const taskCache = new ImageTaskCache();
for (const swipeId of [0, 1, 2]) {
  taskCache.set(createImageTask(prompt, { chatId: 'chat', messageId: 8, swipeId, generationId: `g-${swipeId}` }));
}
assert(taskCache.removeSwipe('chat', 8, 1) === 1, 'deleting one swipe should remove exactly one task');
assert(taskCache.shiftSwipeIdsAfterDeletion('chat', 8, 1) === 1, 'higher swipe task ids should follow the host splice');
assert(taskCache.getForMessage('chat', 8).length === 2, 'sibling swipe tasks must remain in memory');
assert(
  taskCache
    .getForMessage('chat', 8)
    .map(task => task.swipeId)
    .sort()
    .join(',') === '0,1',
  'surviving task ids should be compact after swipe deletion',
);
assert(
  taskCache.getForMessage('chat', 8).every(task => task.intent.requestedTarget?.swipeId === task.swipeId),
  'task intent targets must stay aligned with shifted task identities',
);

let revokeCount = 0;
const resource = (): ImageResource => ({
  url: 'blob:test',
  kind: 'object-url',
  revoke: () => {
    revokeCount += 1;
  },
  clone: resource,
});
const recent = new RecentImageCache();
const deletedMessage = {};
const survivingMessage = {};
const artifact = recent.add(
  {
    sourceIntentId: 'intent',
    purpose: 'current',
    origin: 'generated',
    chatId: 'chat',
    target: { messageId: 8, swipeId: 1, imageIndex: 0 },
  },
  resource(),
  deletedMessage,
);
assert(artifact, 'test artifact should enter the recent cache');
const placements = new ImagePlacementCache(id => recent.cloneResource(id));
const deletedSwipePlacement = placements.place({
  artifactId: artifact.id,
  target: {
    kind: 'inline-anchor',
    messageId: 8,
    swipeId: 1,
    imageIndex: 0,
    paragraphIndex: 0,
    anchorTextBefore: '',
    anchorTextAfter: '',
  },
});
assert(deletedSwipePlacement, 'test placement should be created');
const survivorArtifact = recent.add(
  {
    sourceIntentId: 'intent-2',
    purpose: 'current',
    origin: 'generated',
    chatId: 'chat',
    target: { messageId: 8, swipeId: 2, imageIndex: 0 },
  },
  resource(),
  survivingMessage,
);
assert(survivorArtifact, 'survivor artifact should enter the recent cache');
assert(
  placements.place({
    artifactId: survivorArtifact.id,
    target: {
      kind: 'inline-anchor',
      messageId: 8,
      swipeId: 2,
      imageIndex: 0,
      paragraphIndex: 0,
      anchorTextBefore: '',
      anchorTextAfter: '',
    },
  }),
  'survivor placement should be created',
);
assert(placements.removeSwipe(8, 1) === 1, 'deleting one swipe should remove its placement');
assert(placements.shiftSwipeIdsAfterDeletion(8, 1) === 1, 'higher swipe placement ids should follow the host splice');
assert(placements.placements.value[0]?.target.swipeId === 1, 'surviving placement should point to its new swipe id');
assert(recent.reconcileDeletedSwipe('chat', 8, 1) === 2, 'recent artifacts should detach or follow the host splice');
assert(recent.images.value.length === 2, 'removing message-bound placement must preserve recent images');
assert(
  recent.images.value.some(item => item.sourceIntentId === 'intent' && item.swipeId === null),
  'an image from the deleted swipe must not claim a live swipe id',
);
assert(
  recent.images.value.some(item => item.sourceIntentId === 'intent-2' && item.swipeId === 1),
  'a surviving recent image should follow its swipe to the compacted id',
);
const revokesBeforeFloorDelete = revokeCount;
assert(
  recent.reconcileMessageIndexes('chat', [{}, survivingMessage]) === 2,
  'deleting a middle floor should detach its image and shift the surviving raw message reference',
);
assert(
  recent.images.value.some(item => item.sourceIntentId === 'intent' && item.messageId === null && item.swipeId === null),
  'an image whose raw message object disappeared should stay recent but detach from the deleted floor',
);
assert(
  recent.images.value.some(item => item.sourceIntentId === 'intent-2' && item.messageId === 1),
  'a surviving image should receive the current index of its stable raw message object',
);
assert(recent.images.value.length === 2, 'reconciling floor indexes must not remove recent images');
assert(revokeCount === revokesBeforeFloorDelete, 'reconciling floor indexes must not revoke image resources');

const placementRecent = new RecentImageCache();
const placementMessages = [{ floor: 0 }, { floor: 1 }, { floor: 2 }];
const placementLifecycle = new ImagePlacementCache(id => placementRecent.cloneResource(id));
const lifecyclePlacements = placementMessages.map((messageRef, messageId) => {
  const lifecycleArtifact = placementRecent.add(
    {
      sourceIntentId: `placement-${messageId}`,
      purpose: 'current',
      origin: 'generated',
      chatId: 'chat',
      target: { messageId, swipeId: 2, imageIndex: 3 },
    },
    resource(),
    messageRef,
  );
  assert(lifecycleArtifact, 'placement lifecycle artifact should be created');
  const lifecyclePlacement = placementLifecycle.place({
    artifactId: lifecycleArtifact.id,
    target: {
      kind: 'inline-anchor',
      messageId,
      swipeId: 2,
      imageIndex: 3,
      paragraphIndex: 4,
      anchorTextBefore: 'before',
      anchorTextAfter: 'after',
    },
    variantIndex: 1,
    revisionIndex: 5,
    prompt: 'stored prompt',
    messageRef,
  });
  assert(lifecyclePlacement, 'placement lifecycle placement should be created');
  return lifecyclePlacement;
});
const placementRevokesBeforeDelete = revokeCount;
const reconciledPlacements = placementLifecycle.reconcileMessageIndexes([
  placementMessages[1],
  placementMessages[2],
]);
assert(reconciledPlacements.removed === 1, 'deleted floor placement should be removed');
assert(reconciledPlacements.shifted === 2, 'surviving placements should follow their raw message objects');
assert(!placementLifecycle.get(lifecyclePlacements[0].id), 'deleted floor placement must no longer exist');
assert(revokeCount === placementRevokesBeforeDelete + 1, 'deleted floor placement should release exactly one clone');
for (const [index, original] of lifecyclePlacements.slice(1).entries()) {
  const survivor = placementLifecycle.get(original.id);
  assert(survivor, 'surviving placement must remain available');
  assert(survivor.target.messageId === index, 'surviving placement message id should shift to current chat index');
  assert(survivor.target.swipeId === 2 && survivor.target.imageIndex === 3, 'swipe and image index must remain');
  assert(survivor.variantIndex === 1 && survivor.revisionIndex === 5, 'variant and revision metadata must remain');
  assert(survivor.prompt === 'stored prompt' && survivor.url === original.url, 'prompt and URL must remain unchanged');
}
const placementRevokesBeforeMiddleDelete = revokeCount;
const reconciledMiddle = placementLifecycle.reconcileMessageIndexes([placementMessages[2]]);
assert(reconciledMiddle.removed === 1 && reconciledMiddle.shifted === 1, 'deleting original middle floor should preserve and shift the last survivor');
assert(!placementLifecycle.get(lifecyclePlacements[1].id), 'original middle floor placement should be released');
const finalSurvivor = placementLifecycle.get(lifecyclePlacements[2].id);
assert(finalSurvivor?.target.messageId === 0, 'last surviving placement should follow its message to index zero');
assert(
  finalSurvivor.variantIndex === 1 && finalSurvivor.revisionIndex === 5 && finalSurvivor.url === lifecyclePlacements[2].url,
  'middle deletion must preserve survivor variant, revision, and URL',
);
assert(revokeCount === placementRevokesBeforeMiddleDelete + 1, 'middle deletion should release only its target clone');

console.info('<杠杠の生图机> lifecycle cache tests passed');
