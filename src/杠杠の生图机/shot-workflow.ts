import type { ImagePlacement } from './image-placement';
import { imageRetentionScopeForPlacement, imageRetentionScopeKey } from './image-retention';
import { GalleryStorageError, imageResourceToDataUrl } from './gallery-storage';
import {
  ShotStorageError,
  uploadConfirmedShot,
  type ConfirmedShotEntry,
  type ShotStorageOptions,
} from './shot-storage';
import type { ImageMemoryKey } from './pipeline-types';

/** Everything the persist hook needs besides the placement itself. */
export type ConfirmedShotPersistContext = {
  /** Chat scope of the confirmed shot; combined with the placement target it forms the storage identity. */
  chatId: string;
  /** Recorded shot prompt override; defaults to the placement's own prompt. */
  shotPrompt?: string;
};

export type ConfirmedShotPersistHooks = {
  /** Injected for tests; production uploads through real fetch and the script variable table. */
  storageOptions?: ShotStorageOptions;
  /** Success side channel for the runtime audit (`storage.uploaded`); receives the recorded index entry. */
  onUploaded?: (entry: ConfirmedShotEntry) => void;
  /** Failure side channel for the runtime audit (`storage.last_error`); the error message is bounded. */
  onStorageError?: (error: ShotStorageError) => void;
};

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

  /**
   * Confirm-and-persist hook of "确认即存": the local confirmation runs first
   * and synchronously, so the interaction never waits for storage and no
   * storage failure can undo it.  Afterwards the confirmed base image is
   * uploaded to the dedicated server folder and `uploadConfirmedShot` records
   * the index entry (single request, no retry queue).  A failure only warns
   * through the console and `hooks.onStorageError`: the local confirmation
   * stays, no index entry is written, and re-confirming the same shot later
   * naturally retries with the same deterministic filename so the server
   * overwrites the previous file.  The returned promise never rejects;
   * `hooks.onUploaded` fires with the recorded entry on success.
   */
  async confirmAndPersist(
    placement: ImagePlacement,
    siblings: ReadonlyArray<ImagePlacement>,
    context: ConfirmedShotPersistContext,
    hooks: ConfirmedShotPersistHooks = {},
  ): Promise<void> {
    this.confirm(placement, siblings);
    const identity: ImageMemoryKey = {
      chatId: context.chatId,
      messageId: placement.target.messageId,
      swipeId: placement.target.swipeId,
      imageIndex: placement.target.imageIndex,
    };
    const storageOptions = hooks.storageOptions ?? {};
    try {
      // The placement URL may be a data, object, or remote URL; resolving it
      // here keeps the base64 out of any state until the request body itself.
      const dataUrl = await imageResourceToDataUrl({ url: placement.url }, { fetchImpl: storageOptions.fetchImpl });
      const entry = await uploadConfirmedShot(
        { identity, dataUrl, shotPrompt: context.shotPrompt ?? placement.prompt },
        storageOptions,
      );
      hooks.onUploaded?.(entry);
    } catch (error) {
      const known = error instanceof ShotStorageError || error instanceof GalleryStorageError;
      const detail = known ? error.message : error instanceof Error ? error.name : '';
      const status = error instanceof ShotStorageError && error.status !== null ? `（HTTP ${error.status}）` : '';
      // Bounded by construction: no image path, URL, or image data may appear here.
      console.warn(`<杠杠の生图机> 确认镜头上传失败，已保留本地确认状态${status}${detail ? `：${detail}` : ''}`);
      hooks.onStorageError?.(
        error instanceof ShotStorageError ? error : new ShotStorageError(detail || '确认镜头存储失败'),
      );
    }
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
