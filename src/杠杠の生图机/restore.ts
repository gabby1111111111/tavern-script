import type { ImageMemoryKey } from './pipeline-types';
import {
  CONFIRMED_SHOT_FOLDER_NAME,
  getChatConfirmedShots,
  pruneConfirmedShots,
  readConfirmedShotIndex,
  type ConfirmedShotEntry,
  type ShotVariablesReader,
  type ShotVariablesUpdater,
} from './shot-storage';

/**
 * Refresh-restore planning for confirmed shots (v0.5 执行简报 §4.5).
 *
 * This module is the data layer only: it validates the index against the live
 * chat, prunes dead entries from the index, and produces a restore plan for
 * the runtime to materialize and mark confirmed. It never talks to the server
 * (no fetch at all), so a restore pass can never delete a server file and a
 * failed restore can never stall the chat.
 *
 * ### 已知残留风险（位置身份的边界，评审已确认记录）
 *
 * 索引身份是纯位置身份（楼层号 + Swipe 位 + 图序），不绑定消息内容。会话内的
 * 删楼 / 删 Swipe 由 runtime 观测并同步迁移索引，覆盖良好；但删除发生在脚本
 * 未运行期间（页面未打开、脚本停用）时，本模块下次只能看到“同编号新回答存在
 * 且为 assistant、Swipe 有效”，旧图会被同编号新回答认领并标记已确认（错位恢
 * 复）。彻底修复需要给索引条目增加有界内容指纹（schema 升 v2、兼容读 v1），
 * 该 schema 属 shot-storage 的文件所有权，须由父 Agent 排期；当前以本注释与
 * 产品验收记录该残留风险，是否接受由 Gabby 拍板。
 */

const LOG_PREFIX = '<杠杠の生图机>';

/** SillyTavern serves user images under this root; the probe verified GET on it. */
const USER_IMAGES_URL_ROOT = '/user/images/';

/** What restore needs to know about one live message floor. */
export type RestorableMessageSnapshot = {
  role: 'system' | 'assistant' | 'user';
  /** Currently displayed swipe; mirrors the runtime's fallback of 0 when absent. */
  swipeId: number;
  /** Swipes that still exist on the floor; at least the displayed one. */
  swipeCount: number;
};

/** Reads the live identity of one message floor; null when the floor is gone. */
export type ShotMessageReader = (messageId: number) => RestorableMessageSnapshot | null;

/** One valid entry the runtime should materialize and mark confirmed. */
export type ConfirmedShotRestorePlanEntry = {
  /** Full page-memory identity, ready for placement targeting. */
  identity: ImageMemoryKey;
  /** Server-relative path exactly as recorded in the index. Never log it. */
  path: string;
  /** Browser URL resolved from the path for a `remote-url` image resource. */
  url: string;
  filename: string;
  shotPrompt?: string;
  confirmedAt: number;
};

export type ShotRestoreKeptReason =
  /** The recorded swipe still exists but is not the displayed one. */
  | 'inactive-swipe'
  /** The recorded path does not point into the dedicated folder, so it is never restored. */
  | 'unrestorable-path';

/** An entry that stays in the index but is not part of this pass's plan. */
export type ConfirmedShotRestoreKeptEntry = {
  entry: ConfirmedShotEntry;
  reason: ShotRestoreKeptReason;
};

export type ShotRestoreReport = {
  chatId: string;
  plan: ConfirmedShotRestorePlanEntry[];
  /** Dead-identity entries removed from the index. Their server files stay. */
  pruned: ConfirmedShotEntry[];
  /** Entries kept in the index yet not planned this pass. */
  kept: ConfirmedShotRestoreKeptEntry[];
  /** Bounded message when the pass itself failed; never contains paths or URLs. */
  lastError: string | null;
};

export type ShotRestoreOptions = {
  /** Defaults to `SillyTavern.getCurrentChatId()`. */
  chatId?: string;
  /** Defaults to `getChatMessages(messageId, { include_swipes: true })`. */
  readMessage?: ShotMessageReader;
  /** Injected for tests; production defaults to the script variable table. */
  readVariables?: ShotVariablesReader;
  /** Injected for tests; production defaults to `updateVariablesWith` on the script variable table. */
  updateVariables?: ShotVariablesUpdater;
};

/**
 * Mirror of the delete-path folder guard in `shot-storage.ts` (kept local
 * because that private helper is not exported and the storage module must not
 * be modified). A restored path must point directly into the dedicated folder
 * so a corrupt index entry can never project an arbitrary server path into
 * the page as an image.
 */
function resolvePathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const rawSegment of path.split(/[\\/]+/)) {
    if (!rawSegment || rawSegment === '.') continue;
    if (rawSegment === '..') {
      segments.pop();
      continue;
    }
    segments.push(rawSegment);
  }
  return segments;
}

function isInsideConfirmedShotFolder(path: string): boolean {
  const segments = resolvePathSegments(path);
  return segments.length >= 2 && segments[segments.length - 2] === CONFIRMED_SHOT_FOLDER_NAME;
}

/**
 * Resolve a recorded index path into a browser URL for the image resource.
 * Server-returned paths (probe-verified: `/user/images/<folder>/<file>.png`)
 * are used as-is; a folder-relative path is prefixed with the user-image
 * root. Returns null for anything outside the dedicated folder — callers keep
 * such entries in the index and skip restoring them.
 */
export function confirmedShotImageUrl(path: string): string | null {
  const target = path.trim();
  if (!target || !isInsideConfirmedShotFolder(target)) return null;
  if (target.startsWith('/')) return target;
  return `${USER_IMAGES_URL_ROOT}${target}`;
}

function defaultReadMessageSnapshot(messageId: number): RestorableMessageSnapshot | null {
  const message = getChatMessages(messageId, { include_swipes: true })[0];
  if (!message) return null;
  return {
    role: message.role,
    swipeId: typeof message.swipe_id === 'number' ? message.swipe_id : 0,
    swipeCount: Array.isArray(message.swipes) ? Math.max(message.swipes.length, 1) : 1,
  };
}

function emptyReport(chatId: string, lastError: string | null = null): ShotRestoreReport {
  return { chatId, plan: [], pruned: [], kept: [], lastError };
}

/**
 * Validate the current chat's confirmed-shot index against the live chat and
 * build the restore plan. Dead identities (floor gone, floor no longer an
 * assistant reply, recorded swipe deleted, malformed identity fields) are
 * pruned from the index only — `pruneConfirmedShots` never touches server
 * files. Entries whose swipe still exists but is not displayed stay recorded
 * so a later refresh on that swipe restores them. Any pass-level failure
 * returns a bounded `lastError` and leaves the chat and the index alone.
 */
export function planConfirmedShotRestore(options: ShotRestoreOptions = {}): ShotRestoreReport {
  const chatId = (options.chatId ?? SillyTavern.getCurrentChatId() ?? '').trim();
  if (!chatId) return emptyReport(chatId);

  const variableOptions = {
    ...(options.readVariables ? { readVariables: options.readVariables } : {}),
    ...(options.updateVariables ? { updateVariables: options.updateVariables } : {}),
  };

  let entries: ConfirmedShotEntry[];
  try {
    entries = getChatConfirmedShots(readConfirmedShotIndex(variableOptions), chatId);
  } catch {
    const lastError = '读取确认镜头索引失败，本次不恢复';
    console.warn(LOG_PREFIX, lastError);
    return emptyReport(chatId, lastError);
  }
  if (entries.length === 0) return emptyReport(chatId);

  const readMessage = options.readMessage ?? defaultReadMessageSnapshot;
  const plan: ConfirmedShotRestorePlanEntry[] = [];
  const kept: ConfirmedShotRestoreKeptEntry[] = [];
  const dead: ConfirmedShotEntry[] = [];
  let hasUnrestorablePath = false;

  for (const entry of entries) {
    // The entry schema guarantees integers; negatives are corrupt because no
    // real floor or marker position is negative. Reject them before the floor
    // lookup so a negative messageId can never reach getChatMessages, where
    // negative numbers mean "depth from the end", not a floor id.
    if (entry.messageId < 0 || entry.imageIndex < 0) {
      dead.push(entry);
      continue;
    }
    let snapshot: RestorableMessageSnapshot | null;
    try {
      snapshot = readMessage(entry.messageId);
    } catch {
      // Uncertain validation must not guess: abandon the whole pass without
      // pruning or planning, and let the next refresh retry from scratch.
      const lastError = '确认镜头恢复校验失败，本次不恢复';
      console.warn(LOG_PREFIX, lastError);
      return emptyReport(chatId, lastError);
    }
    if (!snapshot || snapshot.role !== 'assistant') {
      dead.push(entry);
      continue;
    }
    if (entry.swipeId < 0 || entry.swipeId >= snapshot.swipeCount) {
      dead.push(entry);
      continue;
    }
    if (entry.swipeId !== snapshot.swipeId) {
      kept.push({ entry, reason: 'inactive-swipe' });
      continue;
    }
    const url = confirmedShotImageUrl(entry.path);
    if (!url) {
      hasUnrestorablePath = true;
      kept.push({ entry, reason: 'unrestorable-path' });
      continue;
    }
    plan.push({
      identity: { chatId, messageId: entry.messageId, swipeId: entry.swipeId, imageIndex: entry.imageIndex },
      path: entry.path,
      url,
      filename: entry.filename,
      ...(entry.shotPrompt !== undefined ? { shotPrompt: entry.shotPrompt } : {}),
      confirmedAt: entry.confirmedAt,
    });
  }

  let pruned: ConfirmedShotEntry[] = [];
  let lastError: string | null = null;
  if (dead.length > 0) {
    const deadKeys = new Set(
      dead.map(deadEntry => `${deadEntry.messageId}:${deadEntry.swipeId}:${deadEntry.imageIndex}`),
    );
    try {
      pruned = pruneConfirmedShots(
        chatId,
        entry => {
          const key = `${entry.messageId}:${entry.swipeId}:${entry.imageIndex}`;
          return !deadKeys.has(key);
        },
        variableOptions,
      );
    } catch {
      // 剪除失败不阻塞恢复：失效条目保留到下次刷新再清理，服务器文件照旧不动。
      lastError = '失效确认镜头索引剪除失败';
      console.warn(LOG_PREFIX, lastError);
    }
  }

  if (hasUnrestorablePath) {
    console.warn(LOG_PREFIX, '存在不在专用文件夹内的确认镜头路径，已跳过恢复并保留索引');
  }
  console.info(LOG_PREFIX, '确认镜头恢复', {
    planned: plan.length,
    pruned: pruned.length,
    kept: kept.length,
  });

  return { chatId, plan, pruned, kept, lastError };
}
