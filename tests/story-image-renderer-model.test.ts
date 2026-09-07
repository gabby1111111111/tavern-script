import type { ImagePlacement } from '../src/杠杠の生图机/image-placement';
import { groupImagePlacements } from '../src/杠杠の生图机/renderer-model';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function placement(imageIndex: number, variantIndex: number, revisionIndex: number, messageId = 8, swipeId = 2) {
  return {
    id: `${imageIndex}-${variantIndex}-${revisionIndex}`,
    artifactId: 'artifact',
    target: {
      kind: 'inline-anchor',
      messageId,
      swipeId,
      imageIndex,
      paragraphIndex: 0,
      anchorTextBefore: '',
      anchorTextAfter: '',
    },
    caption: '',
    variantIndex,
    revisionIndex,
    prompt: '',
    url: 'blob:test',
    createdAt: revisionIndex,
  } as ImagePlacement;
}

const grouped = groupImagePlacements(
  [
    placement(1, 1, 0),
    placement(0, 1, 1),
    placement(0, 0, 0),
    placement(0, 1, 0),
    placement(0, 1, 0, 9),
    placement(0, 1, 0, 8, 3),
  ],
  8,
  2,
);

assert(grouped.length === 2, 'same pic position should form one stable slot group');
assert(grouped[0].imageIndex === 0 && grouped[1].imageIndex === 1, 'slot groups should be sorted by imageIndex');
assert(grouped[0].variants.length === 2, 'API results should form horizontal variants');
assert(grouped[0].variants[0].variantIndex === 0, 'variants should be sorted');
assert(
  grouped[0].variants[1].revisions.map(item => item.revisionIndex).join(',') === '0,1',
  'regenerations should form sorted vertical revision history',
);

console.log('story image renderer model tests passed');
