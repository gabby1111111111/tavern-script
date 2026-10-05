import { z } from 'zod';
import { decodeImageDataUrl, type DecodedImageDataUrl } from './gallery-storage';
import type { ImageMemoryKey } from './pipeline-types';

declare const SillyTavern: {
  getRequestHeaders: () => Record<string, string>;
};

/**
 * Server-side storage for confirmed shots only.  Candidates, redraw
 * intermediates, and unconfirmed base images never reach this module; the
 * index stores relative paths and bounded metadata, never image bytes.
 */

/** Dedicated SillyTavern user-image folder for this script's confirmed shots. */
export const CONFIRMED_SHOT_FOLDER_NAME = '杠杠の生图机';

/** Script variable key of the confirmed-shot index, kept beside `workbenchUi`. */
export const CONFIRMED_SHOT_STORAGE_KEY = 'confirmedShotStorage';

export class ShotStorageError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ShotStorageError';
    this.status = status;
  }
}

export const ConfirmedShotEntrySchema = z.object({
  messageId: z.number().int(),
  swipeId: z.number().int(),
  imageIndex: z.number().int(),
  filename: z.string().min(1),
  path: z.string().min(1),
  shotPrompt: z.string().optional(),
  confirmedAt: z.number().int(),
});

const ConfirmedShotChatSchema = z.object({
  shots: z.array(ConfirmedShotEntrySchema).default([]),
});

export const ConfirmedShotStorageSchema = z
  .object({
    version: z.literal(1).default(1),
    chats: z.record(z.string(), ConfirmedShotChatSchema).default({}),
  })
  .prefault({});

export type ConfirmedShotEntry = z.infer<typeof ConfirmedShotEntrySchema>;
export type ConfirmedShotStorageIndex = z.infer<typeof ConfirmedShotStorageSchema>;

/** Identity of a confirmed shot inside one chat, without its chat scope. */
export type ConfirmedShotIdentity = Pick<ImageMemoryKey, 'messageId' | 'swipeId' | 'imageIndex'>;

export type ShotVariablesReader = () => Record<string, unknown>;
export type ShotVariablesUpdater = (
  updater: (variables: Record<string, unknown>) => Record<string, unknown>,
) => Record<string, unknown>;

export type ShotStorageOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Injected for tests; production defaults to SillyTavern's request headers. */
  getRequestHeaders?: () => Record<string, string>;
  /** Injected for tests; production defaults to the script variable table. */
  readVariables?: ShotVariablesReader;
  /** Injected for tests; production defaults to `updateVariablesWith` on the script variable table. */
  updateVariables?: ShotVariablesUpdater;
  now?: () => number;
};

function defaultRequestHeaders(): Record<string, string> {
  try {
    return { ...SillyTavern.getRequestHeaders() };
  } catch {
    throw new ShotStorageError('未找到 SillyTavern 请求上下文');
  }
}

function defaultReadVariables(): Record<string, unknown> {
  try {
    const raw = getVariables({ type: 'script', script_id: getScriptId() });
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    throw new ShotStorageError('无法读取确认镜头索引变量');
  }
}

function defaultUpdateVariables(
  updater: (variables: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  try {
    return updateVariablesWith(updater, { type: 'script', script_id: getScriptId() });
  } catch (error) {
    if (error instanceof ShotStorageError) throw error;
    throw new ShotStorageError('无法写入确认镜头索引变量');
  }
}

const DEFAULT_IMAGE_FORMAT = 'png';

function normalizedFormat(value: string): string {
  const format = value.trim().replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]{0,15}$/.test(format)) return DEFAULT_IMAGE_FORMAT;
  return format === 'jpeg' ? 'jpg' : format;
}

/** Same cleaning rules as the character-gallery filename helper. */
function safePathPart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .split('')
    .map(character => {
      const code = character.charCodeAt(0);
      return character === '/' || character === '\\' || code < 0x20 || code === 0x7f ? '_' : character;
    })
    .join('')
    .replace(/^\.+$/, '')
    .slice(0, 160);
  return normalized || fallback;
}

/**
 * Deterministic filename from the shot identity so re-confirming the same shot
 * overwrites the previous server file.  The extension follows the uploaded
 * format (PNG data URLs, the pipeline norm, produce `*.png`); SillyTavern names
 * the stored file after the request's `format` field, so both must match.
 */
export function buildConfirmedShotFilename(identity: ImageMemoryKey, format = DEFAULT_IMAGE_FORMAT): string {
  const extension = normalizedFormat(format);
  const encoded = safePathPart(
    `${identity.chatId}_${identity.messageId}_${identity.swipeId}_${identity.imageIndex}`,
    'story-shot',
  );
  return `${encoded}.${extension}`;
}

type ParsedConfirmedShotIndex = {
  index: ConfirmedShotStorageIndex;
  /** False when the stored value cannot be interpreted at all (unknown version). */
  writable: boolean;
};

function parseConfirmedShotIndex(raw: unknown): ParsedConfirmedShotIndex {
  // Fault tolerance is per part, never all-or-nothing: a null chat section or a
  // single corrupt entry must not discard the other chats' valid entries on the
  // next write-back.  Only a foreign version number makes the whole table
  // unreadable, and that case refuses writes instead of overwriting it.
  if (!isRecord(raw)) return { index: ConfirmedShotStorageSchema.parse({}), writable: true };
  if (raw.version !== undefined && raw.version !== 1) {
    return { index: ConfirmedShotStorageSchema.parse({}), writable: false };
  }
  const rawChats = isRecord(raw.chats) ? raw.chats : {};
  const chats: Record<string, { shots: ConfirmedShotEntry[] }> = {};
  for (const [chatId, rawChat] of Object.entries(rawChats)) {
    // Validate the shots array manually instead of through
    // ConfirmedShotChatSchema: zod's array validation is itself all-or-nothing,
    // so one corrupt entry there would drop the whole chat again.
    if (!isRecord(rawChat) || !Array.isArray(rawChat.shots)) continue;
    const shots: ConfirmedShotEntry[] = [];
    for (const rawEntry of rawChat.shots) {
      const parsedEntry = ConfirmedShotEntrySchema.safeParse(rawEntry);
      if (parsedEntry.success) shots.push(parsedEntry.data);
    }
    // A chat whose entries are all corrupt (or whose shots array is empty) is
    // skipped entirely, matching the write paths that delete the chat key once
    // its shots list becomes empty.
    if (shots.length === 0) continue;
    chats[chatId] = { shots };
  }
  return { index: { version: 1, chats }, writable: true };
}

/** Read the confirmed-shot index; missing or corrupt parts yield an empty/salvaged index. */
export function readConfirmedShotIndex(options: ShotStorageOptions = {}): ConfirmedShotStorageIndex {
  const variables = (options.readVariables ?? defaultReadVariables)();
  return parseConfirmedShotIndex(variables[CONFIRMED_SHOT_STORAGE_KEY]).index;
}

function sameShotIdentity(entry: ConfirmedShotEntry, identity: ConfirmedShotIdentity): boolean {
  return (
    entry.messageId === identity.messageId &&
    entry.swipeId === identity.swipeId &&
    entry.imageIndex === identity.imageIndex
  );
}

/** All confirmed-shot entries recorded for one chat. */
export function getChatConfirmedShots(index: ConfirmedShotStorageIndex, chatId: string): ConfirmedShotEntry[] {
  return index.chats[chatId]?.shots ?? [];
}

/** Find the recorded entry of one shot identity inside a parsed index. */
export function findConfirmedShotEntry(
  index: ConfirmedShotStorageIndex,
  chatId: string,
  identity: ConfirmedShotIdentity,
): ConfirmedShotEntry | undefined {
  return getChatConfirmedShots(index, chatId).find(entry => sameShotIdentity(entry, identity));
}

function writeConfirmedShotIndex(
  mutate: (index: ConfirmedShotStorageIndex) => ConfirmedShotStorageIndex | null,
  options: ShotStorageOptions,
): void {
  const updateVariables = options.updateVariables ?? defaultUpdateVariables;
  updateVariables(variables => {
    const parsed = parseConfirmedShotIndex(variables[CONFIRMED_SHOT_STORAGE_KEY]);
    // Never overwrite an index whose version this module does not understand;
    // surface the failure instead of silently dropping the unknown data.
    if (!parsed.writable) throw new ShotStorageError('确认镜头索引版本不受支持，已保留原有数据');
    const next = mutate(parsed.index);
    // Returning the original table skips the variable write when nothing changed.
    if (!next) return variables;
    return { ...variables, [CONFIRMED_SHOT_STORAGE_KEY]: next };
  });
}

function assertChatId(chatId: string): void {
  if (!chatId.trim()) throw new ShotStorageError('确认镜头索引缺少聊天标识');
}

/**
 * Reject non-integer identity fields before any request is made; the entry
 * schema would only fail after the upload already spent a request.
 */
function assertIntegerIdentity(identity: ConfirmedShotIdentity): void {
  if (
    !Number.isInteger(identity.messageId) ||
    !Number.isInteger(identity.swipeId) ||
    !Number.isInteger(identity.imageIndex)
  ) {
    throw new ShotStorageError('确认镜头身份字段必须是整数');
  }
}

/**
 * Insert or replace the entry of one shot identity, keeping every other chat
 * and entry untouched.  The entry is re-parsed through the schema so unexpected
 * fields (and any image data) cannot enter the variable.
 */
export function upsertConfirmedShot(chatId: string, entry: ConfirmedShotEntry, options: ShotStorageOptions = {}): void {
  assertChatId(chatId);
  const parsed = ConfirmedShotEntrySchema.safeParse(entry);
  if (!parsed.success) throw new ShotStorageError('确认镜头索引条目无效');
  const safeEntry = parsed.data;
  writeConfirmedShotIndex(index => {
    const chat = index.chats[chatId] ?? { shots: [] };
    const shots = [...chat.shots.filter(existing => !sameShotIdentity(existing, safeEntry)), safeEntry];
    return { ...index, chats: { ...index.chats, [chatId]: { shots } } };
  }, options);
}

/**
 * Remove one shot's entry from the index and return it, or null when nothing
 * was recorded.  Callers use the returned path to delete the server file.
 */
export function removeConfirmedShotEntry(
  chatId: string,
  identity: ConfirmedShotIdentity,
  options: ShotStorageOptions = {},
): ConfirmedShotEntry | null {
  const removed: ConfirmedShotEntry[] = [];
  writeConfirmedShotIndex(index => {
    const chat = index.chats[chatId];
    if (!chat) return null;
    const shots = chat.shots.filter(entry => {
      if (sameShotIdentity(entry, identity)) {
        removed.push(entry);
        return false;
      }
      return true;
    });
    if (removed.length === 0) return null;
    const chats = { ...index.chats };
    if (shots.length > 0) chats[chatId] = { shots };
    else delete chats[chatId];
    return { ...index, chats };
  }, options);
  return removed[0] ?? null;
}

/**
 * Drop every entry of one chat that fails `shouldKeep` and return the removed
 * entries.  Pruning never touches server files and skips the variable write
 * when there is nothing to remove.
 */
export function pruneConfirmedShots(
  chatId: string,
  shouldKeep: (entry: ConfirmedShotEntry) => boolean,
  options: ShotStorageOptions = {},
): ConfirmedShotEntry[] {
  const removed: ConfirmedShotEntry[] = [];
  writeConfirmedShotIndex(index => {
    const chat = index.chats[chatId];
    if (!chat) return null;
    const shots = chat.shots.filter(entry => {
      if (shouldKeep(entry)) return true;
      removed.push(entry);
      return false;
    });
    if (removed.length === 0) return null;
    const chats = { ...index.chats };
    if (shots.length > 0) chats[chatId] = { shots };
    else delete chats[chatId];
    return { ...index, chats };
  }, options);
  return removed;
}

export type ConfirmedShotUploadInput = {
  identity: ImageMemoryKey;
  /** Data URL of the confirmed base image; only the plain base64 is sent and never stored. */
  dataUrl: string;
  shotPrompt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseUploadedPath(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ShotStorageError('确认镜头上传响应不是有效 JSON', response.status || null);
  }
  const path = isRecord(payload) && typeof payload.path === 'string' ? payload.path.trim() : '';
  if (!path) throw new ShotStorageError('确认镜头上传响应缺少图片路径', response.status || null);
  return path;
}

/**
 * When the same shot identity is re-confirmed with a different image format,
 * the new filename extension differs from the stored file, so the server-side
 * same-name overwrite cannot clean the old file up.  Delete the stale file
 * before uploading; a failed cleanup only warns and never blocks the upload.
 */
async function deleteStaleFormatFile(
  chatId: string,
  identity: ConfirmedShotIdentity,
  filename: string,
  options: ShotStorageOptions,
): Promise<void> {
  let existing: ConfirmedShotEntry | null;
  try {
    existing = findConfirmedShotEntry(readConfirmedShotIndex(options), chatId, identity) ?? null;
  } catch {
    // 索引读取失败不阻塞确认上传，仅跳过旧格式清理。
    console.warn('<杠杠の生图机> 读取确认镜头索引失败，跳过旧格式文件清理');
    return;
  }
  if (!existing || existing.filename === filename) return;
  try {
    await deleteConfirmedShotFile(existing.path, options);
  } catch {
    // 旧文件清理失败仅警告：孤儿文件可留待后续同名覆盖，确认流程不被阻塞。
    console.warn('<杠杠の生图机> 旧格式确认镜头文件删除失败，继续上传');
  }
}

/**
 * Upload a confirmed base image into the dedicated folder and record the
 * returned path in the index.  Throws without touching the index on failure;
 * the caller keeps the in-memory shot so the next confirmation retries.  A
 * re-confirmation whose image format changed deletes the stale extension's
 * server file before uploading so no orphan file is left behind.
 */
export async function uploadConfirmedShot(
  input: ConfirmedShotUploadInput,
  options: ShotStorageOptions = {},
): Promise<ConfirmedShotEntry> {
  assertChatId(input.identity.chatId);
  assertIntegerIdentity(input.identity);
  let decoded: DecodedImageDataUrl;
  try {
    decoded = decodeImageDataUrl(input.dataUrl);
  } catch {
    throw new ShotStorageError('确认镜头不是有效的图片 data URL');
  }
  const filename = buildConfirmedShotFilename(input.identity, decoded.format);
  await deleteStaleFormatFile(input.identity.chatId, input.identity, filename, options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? '/api/images/upload';

  let path: string;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ...(options.getRequestHeaders ?? defaultRequestHeaders)(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: decoded.base64,
        format: decoded.format,
        ch_name: CONFIRMED_SHOT_FOLDER_NAME,
        filename,
      }),
    });
    if (!response.ok) throw new ShotStorageError('确认镜头上传请求失败', response.status || null);
    path = await parseUploadedPath(response);
  } catch (error) {
    if (error instanceof ShotStorageError) throw error;
    // Do not expose the request URL, response body, or image data in the
    // user-facing error; callers log a bounded message and keep the local shot.
    throw new ShotStorageError('确认镜头上传请求失败');
  }

  const shotPrompt = typeof input.shotPrompt === 'string' ? input.shotPrompt.trim().slice(0, 4000) : undefined;
  const entry = ConfirmedShotEntrySchema.parse({
    messageId: input.identity.messageId,
    swipeId: input.identity.swipeId,
    imageIndex: input.identity.imageIndex,
    filename,
    path,
    confirmedAt: Math.floor(options.now?.() ?? Date.now()),
    ...(shotPrompt ? { shotPrompt } : {}),
  });
  upsertConfirmedShot(input.identity.chatId, entry, options);
  return entry;
}

/** Resolve `.`/`..` segments so traversal tricks cannot slip past the folder check. */
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

/** True only when the resolved path points at a file directly inside the dedicated folder. */
function isConfirmedShotFolderPath(path: string): boolean {
  const segments = resolvePathSegments(path);
  return segments.length >= 2 && segments[segments.length - 2] === CONFIRMED_SHOT_FOLDER_NAME;
}

/**
 * Delete one confirmed-shot file on the server.  A missing file (404) already
 * matches the requested end state and resolves without error.  Paths outside
 * the dedicated folder never reach the delete endpoint: they are warned about
 * and skipped, so a corrupt index entry cannot erase unrelated gallery files.
 */
export async function deleteConfirmedShotFile(path: string, options: ShotStorageOptions = {}): Promise<void> {
  const target = path.trim();
  if (!target) throw new ShotStorageError('确认镜头删除缺少文件路径');
  if (!isConfirmedShotFolderPath(target)) {
    // 防误删（简报 §4.4）：警告消息不得包含图片路径本身。
    console.warn('<杠杠の生图机> 确认镜头删除路径不在专用文件夹内，已跳过删除');
    return;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? '/api/images/delete';

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ...(options.getRequestHeaders ?? defaultRequestHeaders)(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: target }),
    });
    if (response.status === 404) return;
    if (!response.ok) throw new ShotStorageError('确认镜头删除请求失败', response.status || null);
  } catch (error) {
    if (error instanceof ShotStorageError) throw error;
    // Do not expose the request URL or response body in the user-facing error.
    throw new ShotStorageError('确认镜头删除请求失败');
  }
}
