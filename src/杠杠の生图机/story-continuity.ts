import type { ImageResource } from './image-api';
import type { ImagePlacement } from './image-placement';

/** Only one raw <pic> shot, never an expanded output/API prompt. */
export const MAX_STORY_SHOT_PROMPT_LENGTH = 6000;

export type StoryContinuityMetadata = Readonly<{
  chatId: string;
  drawingPresetId: string;
  outputPresetId: string;
  shotPrompt: string;
}>;

export function normalizeStoryContinuityMetadata(value: StoryContinuityMetadata): StoryContinuityMetadata {
  return Object.freeze({
    chatId: value.chatId,
    drawingPresetId: value.drawingPresetId,
    outputPresetId: value.outputPresetId,
    shotPrompt: value.shotPrompt.trim().slice(0, MAX_STORY_SHOT_PROMPT_LENGTH),
  });
}

export type StoryContinuitySelectionInput = {
  chatId: string;
  beforeMessageId: number;
  drawingPresetId: string;
  outputPresetId: string;
  /** The renderer's selected candidate/revision for each position, not all cached images. */
  selectedPlacements: ReadonlyArray<ImagePlacement>;
  activeSwipeId: (messageId: number) => number | null;
};

export function selectPreviousStoryImage(input: StoryContinuitySelectionInput): ImagePlacement | null {
  let selected: ImagePlacement | null = null;
  for (const placement of input.selectedPlacements) {
    const { continuity, target } = placement;
    if (
      !continuity ||
      continuity.chatId !== input.chatId ||
      continuity.drawingPresetId !== input.drawingPresetId ||
      continuity.outputPresetId !== input.outputPresetId ||
      target.messageId >= input.beforeMessageId ||
      target.messageId < 0 ||
      input.activeSwipeId(target.messageId) !== target.swipeId ||
      !placement.url.trim()
    )
      continue;
    if (
      !selected ||
      target.messageId > selected.target.messageId ||
      (target.messageId === selected.target.messageId && target.imageIndex > selected.target.imageIndex)
    )
      selected = placement;
  }
  return selected;
}

export type StoryContinuitySource = Readonly<{
  placementId: string;
  artifactId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
  variantIndex: number;
  revisionIndex: number;
}>;

export type StoryContinuitySnapshot = {
  readonly chatId: string;
  readonly drawingPresetId: string;
  readonly outputPresetId: string;
  readonly source: StoryContinuitySource | null;
  readonly shotPrompt: string;
  resource: ImageResource | null;
  released: boolean;
};

export function createStoryContinuitySnapshot(
  input: StoryContinuitySelectionInput & { cloneResource: (placementId: string) => ImageResource | null },
): StoryContinuitySnapshot {
  const placement = selectPreviousStoryImage(input);
  let resource: ImageResource | null = null;
  if (placement) {
    try {
      resource = input.cloneResource(placement.id);
    } catch {
      // A failed image clone must not block the text generation or substitute another source.
    }
  }
  return {
    chatId: input.chatId,
    drawingPresetId: input.drawingPresetId,
    outputPresetId: input.outputPresetId,
    source: placement
      ? Object.freeze({
          placementId: placement.id,
          artifactId: placement.artifactId,
          messageId: placement.target.messageId,
          swipeId: placement.target.swipeId,
          imageIndex: placement.target.imageIndex,
          variantIndex: placement.variantIndex,
          revisionIndex: placement.revisionIndex,
        })
      : null,
    shotPrompt: (placement?.continuity?.shotPrompt ?? '').trim().slice(0, MAX_STORY_SHOT_PROMPT_LENGTH),
    resource,
    released: false,
  };
}

export function releaseStoryContinuitySnapshot(snapshot: StoryContinuitySnapshot): void {
  if (snapshot.released) return;
  snapshot.released = true;
  const resource = snapshot.resource;
  snapshot.resource = null;
  resource?.revoke?.();
}

export function isStoryContinuitySnapshotValid(
  snapshot: StoryContinuitySnapshot,
  context: {
    chatId: string;
    getPlacement: (id: string) => ImagePlacement | undefined;
    /** Deliberately ignored after lock: changing the displayed branch affects only the next round. */
    activeSwipeId?: (messageId: number) => number | null;
  },
): boolean {
  if (snapshot.released || context.chatId !== snapshot.chatId) return false;
  const source = snapshot.source;
  if (!source) return true;
  const placement = context.getPlacement(source.placementId);
  return Boolean(
    placement &&
    placement.artifactId === source.artifactId &&
    // Surviving message/Swipe indices may shift when an earlier sibling is deleted.
    // Stable placement and artifact IDs track the original image through that remap.
    placement.target.imageIndex === source.imageIndex &&
    placement.variantIndex === source.variantIndex &&
    placement.revisionIndex === source.revisionIndex,
  );
}
