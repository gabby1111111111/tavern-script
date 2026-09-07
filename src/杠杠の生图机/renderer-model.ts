import type { ImagePlacement } from './image-placement';

export type PlacementRevisionGroup = Readonly<{
  variantIndex: number;
  revisions: ReadonlyArray<ImagePlacement>;
}>;

export type PlacementSlotGroup = Readonly<{
  imageIndex: number;
  variants: ReadonlyArray<PlacementRevisionGroup>;
}>;

/**
 * Builds the two-axis presentation model for one displayed message swipe.
 * Horizontal pages are API variants; vertical pages are revision history.
 */
export function groupImagePlacements(
  placements: ReadonlyArray<ImagePlacement>,
  messageId: number,
  swipeId: number,
): ReadonlyArray<PlacementSlotGroup> {
  const slots = new Map<number, Map<number, ImagePlacement[]>>();
  placements.forEach(placement => {
    if (placement.target.messageId !== messageId || placement.target.swipeId !== swipeId) return;
    const variants = slots.get(placement.target.imageIndex) ?? new Map<number, ImagePlacement[]>();
    const revisions = variants.get(placement.variantIndex) ?? [];
    revisions.push(placement);
    variants.set(placement.variantIndex, revisions);
    slots.set(placement.target.imageIndex, variants);
  });

  return [...slots.entries()]
    .sort(([lhs], [rhs]) => lhs - rhs)
    .map(([imageIndex, variants]) => ({
      imageIndex,
      variants: [...variants.entries()]
        .sort(([lhs], [rhs]) => lhs - rhs)
        .map(([variantIndex, revisions]) => ({
          variantIndex,
          revisions: [...revisions].sort(
            (lhs, rhs) => lhs.revisionIndex - rhs.revisionIndex || lhs.createdAt - rhs.createdAt,
          ),
        })),
    }));
}
