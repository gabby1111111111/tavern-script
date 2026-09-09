import { ImagePlacementCache, type ImagePlacement } from '../src/杠杠の生图机/image-placement';
import {
  createStoryContinuitySnapshot,
  isStoryContinuitySnapshotValid,
  MAX_STORY_SHOT_PROMPT_LENGTH,
  releaseStoryContinuitySnapshot,
  selectPreviousStoryImage,
} from '../src/杠杠の生图机/story-continuity';
import type { ImageResource } from '../src/杠杠の生图机/image-api';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const revoked: string[] = [];
let resourceId = 0;
function resource(): ImageResource {
  const url = `blob:continuity-${resourceId++}`;
  return { url, kind: 'object-url', clone: resource, revoke: () => revoked.push(url) };
}
const cache = new ImagePlacementCache(() => resource());
function place(
  messageId: number,
  imageIndex = 0,
  options: {
    swipeId?: number;
    drawingPresetId?: string;
    outputPresetId?: string;
    chatId?: string;
    revisionIndex?: number;
    variantIndex?: number;
    shotPrompt?: string;
  } = {},
): ImagePlacement {
  const placement = cache.place({
    artifactId: `artifact-${resourceId}`,
    target: {
      kind: 'inline-anchor',
      messageId,
      imageIndex,
      swipeId: options.swipeId ?? 0,
      paragraphIndex: imageIndex,
      anchorTextBefore: '',
      anchorTextAfter: '',
    },
    variantIndex: options.variantIndex,
    revisionIndex: options.revisionIndex,
    prompt: 'expanded request with previous shot that must never become continuity text',
    continuity: {
      chatId: options.chatId ?? 'chat',
      drawingPresetId: options.drawingPresetId ?? 'A',
      outputPresetId: options.outputPresetId ?? 'out',
      shotPrompt: options.shotPrompt ?? 'one raw shot',
    },
  });
  assert(placement, 'placement is created');
  return placement;
}
const first = place(1);
const middle = place(3, 0);
const lastPosition = place(3, 1, { variantIndex: 1, revisionIndex: 2 });
const otherCombo = place(4, 0, { drawingPresetId: 'B' });
const otherOutput = place(4, 0, { outputPresetId: 'other' });
const pinnedInactiveSwipe = place(4, 2, { swipeId: 1 });
const otherChat = place(4, 0, { chatId: 'other' });
const sameFloor = place(5);
const laterCompletionOnEarlierFloor = place(1, 1);
const selectedPlacements = [
  first,
  middle,
  lastPosition,
  otherCombo,
  otherOutput,
  pinnedInactiveSwipe,
  otherChat,
  sameFloor,
  laterCompletionOnEarlierFloor,
];
const selection = {
  chatId: 'chat',
  beforeMessageId: 5,
  drawingPresetId: 'A',
  outputPresetId: 'out',
  selectedPlacements,
  activeSwipeId: () => 0,
};
assert(
  selectPreviousStoryImage(selection)?.id === lastPosition.id,
  'select latest prior floor and final image position; exclude other combo/chat/swipe/current floor',
);
assert(
  selectPreviousStoryImage({ ...selection, drawingPresetId: 'B' })?.id === otherCombo.id,
  'alternating preset lines retain independent sources',
);
assert(selectPreviousStoryImage({ ...selection, beforeMessageId: 1 }) === null, 'first shot has no reference');
assert(
  selectPreviousStoryImage({ ...selection, selectedPlacements: [first, middle] })?.id === middle.id,
  'deleting last position falls back to earlier displayed position',
);
assert(
  selectPreviousStoryImage({ ...selection, activeSwipeId: () => null }) === null,
  'missing source floors are never selected',
);

const snapshot = createStoryContinuitySnapshot({ ...selection, cloneResource: id => cache.cloneResource(id) });
assert(
  snapshot.source?.placementId === lastPosition.id &&
    snapshot.source.revisionIndex === 2 &&
    snapshot.source.variantIndex === 1,
  'snapshot identifies exactly the displayed candidate and revision',
);
assert(snapshot.shotPrompt === 'one raw shot', 'snapshot stores raw shot rather than recursive expanded request');
assert(snapshot.resource && snapshot.resource.url !== lastPosition.url, 'snapshot owns a separate object URL');
const snapshotUrl = snapshot.resource.url;
const validity = { chatId: 'chat', getPlacement: (id: string) => cache.get(id) };
assert(isStoryContinuitySnapshotValid(snapshot, validity), 'locked source is initially valid');
assert(
  isStoryContinuitySnapshotValid(snapshot, {
    ...validity,
    getPlacement: () => ({ ...lastPosition, target: { ...lastPosition.target, messageId: 2, swipeId: 3 } }),
  }),
  'surviving source keeps its stable identity when earlier messages or Swipes are deleted',
);
assert(
  isStoryContinuitySnapshotValid(snapshot, { ...validity, activeSwipeId: () => 99 }),
  'switching displayed swipe after lock cannot mutate this round reference',
);
assert(!isStoryContinuitySnapshotValid(snapshot, { ...validity, chatId: 'else' }), 'chat change invalidates snapshot');
cache.remove(lastPosition.id);
assert(
  !isStoryContinuitySnapshotValid(snapshot, validity),
  'deleting source invalidates snapshot without replacing it',
);
assert(!revoked.includes(snapshotUrl), 'placement deletion cannot revoke snapshot owned resource');
releaseStoryContinuitySnapshot(snapshot);
releaseStoryContinuitySnapshot(snapshot);
assert(revoked.filter(url => url === snapshotUrl).length === 1, 'snapshot release is idempotent');
assert(snapshot.resource === null && !isStoryContinuitySnapshotValid(snapshot, validity), 'released snapshot unusable');

const long = place(2, 0, { shotPrompt: 'x'.repeat(MAX_STORY_SHOT_PROMPT_LENGTH + 100) });
assert(long.continuity?.shotPrompt.length === MAX_STORY_SHOT_PROMPT_LENGTH, 'single shot text bounded');
const fabricated = createStoryContinuitySnapshot({
  ...selection,
  selectedPlacements: [{ ...long, continuity: { ...long.continuity!, shotPrompt: 'x'.repeat(20000) } }],
  cloneResource: () => null,
});
assert(fabricated.shotPrompt.length === MAX_STORY_SHOT_PROMPT_LENGTH, 'snapshot bounds even external input metadata');
releaseStoryContinuitySnapshot(fabricated);
assert(Object.isFrozen(long.continuity), 'preset association cannot mutate after placement creation');
const unavailable = createStoryContinuitySnapshot({
  ...selection,
  selectedPlacements: [first],
  cloneResource: () => {
    throw new Error('unavailable');
  },
});
assert(unavailable.resource === null && unavailable.shotPrompt === 'one raw shot', 'image read failure preserves text');
releaseStoryContinuitySnapshot(unavailable);
const empty = createStoryContinuitySnapshot({ ...selection, selectedPlacements: [], cloneResource: () => null });
assert(empty.source === null && empty.shotPrompt === '' && empty.resource === null, 'no source degrades to first shot');
releaseStoryContinuitySnapshot(empty);
cache.clear();
console.info('<杠杠の生图机> continuity selection and snapshot tests passed');
