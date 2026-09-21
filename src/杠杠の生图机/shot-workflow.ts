import type { ImagePlacement } from './image-placement';
import { imageRetentionScopeForPlacement, imageRetentionScopeKey } from './image-retention';

/** Confirmation belongs to an image identity, never to the last button click or numeric floor alone. */
export class ShotWorkflow {
  private readonly bases = new Set<string>();
  private readonly confirmed = new Set<string>();
  private advancedMessages = new WeakSet<object>();

  isConfirmed(id: string): boolean {
    return this.confirmed.has(id);
  }

  base(placements: ReadonlyArray<ImagePlacement>): ImagePlacement | undefined {
    return (
      placements.find(placement => this.bases.has(placement.id)) ??
      [...placements].sort(
        (a, b) => a.createdAt - b.createdAt || a.variantIndex - b.variantIndex || a.revisionIndex - b.revisionIndex,
      )[0]
    );
  }

  keepBase(placement: ImagePlacement, siblings: ReadonlyArray<ImagePlacement>): void {
    siblings.forEach(item => this.bases.delete(item.id));
    this.bases.add(placement.id);
  }

  confirm(placement: ImagePlacement, siblings: ReadonlyArray<ImagePlacement>): void {
    this.keepBase(placement, siblings);
    siblings.forEach(item => this.confirmed.delete(item.id));
    this.confirmed.add(placement.id);
  }

  /** Only the first forward transition may clean pre-existing candidates. */
  advance(messageRef: object): boolean {
    if (this.advancedMessages.has(messageRef)) return false;
    this.advancedMessages.add(messageRef);
    return true;
  }

  forget(id: string): void {
    this.bases.delete(id);
    this.confirmed.delete(id);
  }

  clear(): void {
    this.bases.clear();
    this.confirmed.clear();
    this.advancedMessages = new WeakSet();
  }
}

export function groupWorkbenchPlacements(
  chatId: string,
  placements: ReadonlyArray<ImagePlacement>,
): Map<string, ImagePlacement[]> {
  const groups = new Map<string, ImagePlacement[]>();
  for (const placement of placements) {
    const key = imageRetentionScopeKey(imageRetentionScopeForPlacement(chatId, placement));
    const siblings = groups.get(key) ?? [];
    siblings.push(placement);
    groups.set(key, siblings);
  }
  return groups;
}
