import {
  deleteConfirmedShotFile,
  findConfirmedShotEntry,
  removeConfirmedShotEntry,
  type ConfirmedShotEntry,
  type ConfirmedShotIdentity,
  type ConfirmedShotStorageIndex,
  type ShotStorageOptions,
} from './shot-storage';

/**
 * Lifecycle deletion sync for confirmed shots (v0.5 存储简报 Step 4).
 *
 * A confirmed shot's server file is deleted ONLY from the explicit lifecycle
 * removal points the storage brief authorizes: message deletion, swipe
 * deletion/overwrite, removing a confirmed image (×), and abandoning a
 * confirmed shot.  Restore-time mismatches (404, identity mismatch, unreadable
 * index) must never route through this module: restore paths prune the index
 * exclusively through shot-storage's `pruneConfirmedShots`, which never
 * touches server files, so stale or foreign index state can never erase
 * gallery files.  A pruned entry also makes any accidental later call a no-op
 * (`none`), which keeps the two paths mutually safe.
 *
 * Runtime wiring stays in `runtime.ts`; this module only translates a shot
 * identity into the removal decision and performs the single delete request
 * (one request per action, no retries, no queue).  Failures warn only and
 * never block the chat.
 *
 * Race safety with the confirm path: the confirm wiring writes its index
 * entry only when its upload finishes, so a removal that runs while the
 * upload is still in flight would see no entry and let the late upsert
 * resurrect a deleted shot.  The confirm wiring MUST therefore register every
 * `uploadConfirmedShot` promise through `trackConfirmedShotUpload`; a removal
 * whose first pass finds no entry then waits for the paired in-flight upload
 * before deciding.  A removal can only pair with uploads it can see — an
 * untracked upload keeps its race.
 */

/** Lifecycle events allowed to trigger a server-file deletion, per the brief §4.4. */
export type ConfirmedShotRemovalReason =
  | 'message-deleted'
  | 'swipe-deleted'
  | 'image-removed'
  | 'shot-abandoned';

/**
 * Pure decision for one shot identity: `delete-server-file` only when the
 * index still records a confirmed entry for it, otherwise `none`.
 */
export type ConfirmedShotRemovalAction =
  | { kind: 'none'; reason: ConfirmedShotRemovalReason; identity: ConfirmedShotIdentity }
  | {
      kind: 'delete-server-file';
      reason: ConfirmedShotRemovalReason;
      identity: ConfirmedShotIdentity;
      entry: ConfirmedShotEntry;
    };

/**
 * - `none`: no confirmed entry was recorded, so nothing was touched.
 * - `deleted`: index pruned and the server file confirmed gone (404 included).
 * - `index-pruned`: the lifecycle removal stands, but the server delete failed;
 *   only a warning is left behind, no retry, no queue.
 * - `blocked`: the index could not be updated safely, so the server file was
 *   deliberately left in place (anti-accidental-delete).
 */
export type ConfirmedShotRemovalStatus = 'none' | 'deleted' | 'index-pruned' | 'blocked';

export type ConfirmedShotRemovalOutcome = {
  reason: ConfirmedShotRemovalReason;
  identity: ConfirmedShotIdentity;
  status: ConfirmedShotRemovalStatus;
  /** Bounded, path/URL/Base64-free message for audit `storage.last_error`; null when nothing failed. */
  warning: string | null;
};

/**
 * Pure lookup used by the runtime to preview the removal decision (and by
 * tests to pin the shared semantics).  Identities without a recorded confirmed
 * entry — unconfirmed candidates, redraw intermediates, already-pruned shots —
 * resolve to `none`, so only confirmed shots can ever reach the server.
 */
export function resolveConfirmedShotRemovalAction(
  chatId: string,
  identity: ConfirmedShotIdentity,
  reason: ConfirmedShotRemovalReason,
  index: ConfirmedShotStorageIndex,
): ConfirmedShotRemovalAction {
  const entry = chatId.trim() ? findConfirmedShotEntry(index, chatId, identity) : undefined;
  if (!entry) return { kind: 'none', reason, identity };
  return { kind: 'delete-server-file', reason, identity, entry };
}

function boundedErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return '未知错误';
}

/** In-flight confirmed-shot uploads keyed by chat + shot identity. */
const inFlightUploads = new Map<string, Promise<unknown>>();

function shotUploadKey(chatId: string, identity: ConfirmedShotIdentity): string {
  return `${chatId}::${identity.messageId}::${identity.swipeId}::${identity.imageIndex}`;
}

/**
 * Register an in-flight confirmed-shot upload so a removal of the same shot
 * identity waits for it instead of racing past it.  The confirm wiring MUST
 * wrap every `uploadConfirmedShot` promise with this call (the place that
 * owns the promise keeps awaiting the returned chain unchanged); a removal
 * can only pair with uploads it can see.  Registration clears itself when the
 * upload settles, and a failed upload is swallowed here only as an
 * unhandled-rejection guard — callers awaiting the returned promise still
 * receive the rejection.
 */
export function trackConfirmedShotUpload<T>(
  chatId: string,
  identity: ConfirmedShotIdentity,
  upload: Promise<T>,
): Promise<T> {
  const key = shotUploadKey(chatId, identity);
  const tracked = upload.finally(() => {
    if (inFlightUploads.get(key) === tracked) inFlightUploads.delete(key);
  });
  tracked.catch(() => undefined);
  inFlightUploads.set(key, tracked);
  return tracked;
}

/**
 * One decision-and-delete pass over the current index state.  Expects a
 * non-empty `chatId`.
 */
async function performConfirmedShotRemoval(
  chatId: string,
  identity: ConfirmedShotIdentity,
  reason: ConfirmedShotRemovalReason,
  options: ShotStorageOptions,
): Promise<ConfirmedShotRemovalOutcome> {
  let entry: ConfirmedShotEntry | null;
  try {
    entry = removeConfirmedShotEntry(chatId, identity, options);
  } catch (error) {
    // 防误删（简报 §4.4）：索引无法安全解读时不得依据本地状态删除服务器文件。
    const warning = `确认镜头索引更新失败，已保留服务器文件（${boundedErrorMessage(error)}）`;
    console.warn(`<杠杠の生图机> ${warning}`);
    return { reason, identity, status: 'blocked', warning };
  }
  if (!entry) return { reason, identity, status: 'none', warning: null };
  try {
    await deleteConfirmedShotFile(entry.path, options);
  } catch (error) {
    // 生命周期移除已落定：索引保持剪除，服务器清理失败仅警告，不重试、不排队。
    const warning = `确认镜头服务器文件删除失败（${boundedErrorMessage(error)}）`;
    console.warn(`<杠杠の生图机> ${warning}`);
    return { reason, identity, status: 'index-pruned', warning };
  }
  return { reason, identity, status: 'deleted', warning: null };
}

/**
 * Prune the confirmed entry of one removed shot from the index and delete its
 * server file.  Call this from the runtime's existing lifecycle removal
 * points, passing the identity of the shot that was just removed:
 *
 * - The index entry is pruned first, so the removal stands even when the
 *   server request fails (the warning-only path leaves an orphan file for a
 *   later same-name overwrite, never a resurrected image).
 * - When the index cannot be updated safely (unsupported version, variable
 *   write failure) the server file is deliberately NOT deleted: an unreadable
 *   index is not a trustworthy basis for erasing files.
 * - Exactly one delete request is sent per confirmed entry; failures warn only.
 * - A missing server file (404) already matches the requested end state and
 *   resolves as `deleted`.
 * - When the same shot identity has an in-flight upload (registered via
 *   `trackConfirmedShotUpload`), the first pass finds no entry yet, so this
 *   function waits for that upload to settle — its upsert must land or fail —
 *   and then decides once more.  A removal therefore never runs ahead of the
 *   paired confirm write, and a deleted shot cannot be resurrected by the
 *   late upsert.  The wait is bounded only by the upload request itself; no
 *   retry or queue is involved.
 *
 * Await sequential calls per chat: each call performs its own variable write,
 * and concurrent writes to the same script variable table would race.
 */
export async function executeConfirmedShotRemoval(
  chatId: string,
  identity: ConfirmedShotIdentity,
  reason: ConfirmedShotRemovalReason,
  options: ShotStorageOptions = {},
): Promise<ConfirmedShotRemovalOutcome> {
  if (!chatId.trim()) return { reason, identity, status: 'none', warning: null };
  const first = await performConfirmedShotRemoval(chatId, identity, reason, options);
  if (first.status !== 'none') return first;
  const pending = inFlightUploads.get(shotUploadKey(chatId, identity));
  if (!pending) return first;
  try {
    await pending;
  } catch {
    // 上传失败不会写索引，二次判定自然为 none。
  }
  return performConfirmedShotRemoval(chatId, identity, reason, options);
}
