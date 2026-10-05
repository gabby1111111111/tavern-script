import { CONFIRMED_SHOT_FOLDER_NAME } from './shot-storage';

declare const SillyTavern: {
  getRequestHeaders: () => Record<string, string>;
};

/**
 * 图鉴匹配参考图（声明制匹配，v0.5.2 执行简报 §0.2/§3）。
 *
 * 图鉴即词典：专用图库文件夹内按 `参考-<标签>-<别名1>,<别名2>.png` 命名的文件是可匹配参考图，
 * 标签只是人读说明（本版不参与匹配逻辑）；正文 AI 在镜头提示词中输出 `当前出场角色：a2，b1`
 * 声明，只有声明中出现的别名才触发匹配；声明缺失或为空 → 一张不附。
 *
 * 本模块只做本地字符串操作与一次图库列表请求：不读取、不存储、不传输任何图片数据，
 * 只处理文件名文本（标签与别名）；日志与错误消息不含图片路径、URL 或图片数据。
 */

/** 全角拉丁字母与数字（U+FF10–U+FF19 / U+FF21–U+FF3A / U+FF41–U+FF5A）转半角。 */
function toHalfwidthLatin(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isFullwidthDigit = code >= 0xff10 && code <= 0xff19;
    const isFullwidthUpper = code >= 0xff21 && code <= 0xff3a;
    const isFullwidthLower = code >= 0xff41 && code <= 0xff5a;
    result += isFullwidthDigit || isFullwidthUpper || isFullwidthLower ? String.fromCharCode(code - 0xfee0) : character;
  }
  return result;
}

/**
 * 标签/别名归一化：去首尾空格、全角拉丁转半角、拉丁字母 casefold（简报 §3.1）。
 * 幂等：归一化结果再次归一化保持不变，因此匹配入口可以放心重复归一化。
 */
function normalizeAlias(value: unknown): string {
  if (typeof value !== 'string') return '';
  return toHalfwidthLatin(value.trim()).toLowerCase();
}

const DECLARED_CHARACTERS_PATTERN = /当前出场角色\s*[:：]\s*([^\n;；]+)/;
const ALIAS_SEPARATOR_PATTERN = /[,，、]/;

/**
 * 从镜头提示词原文提取 `当前出场角色：…` 声明清单（简报 §3.1）。
 * 兼容全半角冒号，以半角逗号、全角逗号、顿号分割，遇到换行或半/全角分号截断；
 * 返回归一化后的别名，保持首次出现顺序并去重、剔除空项；多次声明只取第一处。
 * 解析不到声明（或声明内容为空）→ 空数组。
 */
export function parseDeclaredCharacters(promptText: string): string[] {
  if (typeof promptText !== 'string') return [];
  const match = DECLARED_CHARACTERS_PATTERN.exec(promptText);
  if (!match) return [];
  const seen = new Set<string>();
  const declared: string[] = [];
  for (const part of match[1].split(ALIAS_SEPARATOR_PATTERN)) {
    const alias = normalizeAlias(part);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    declared.push(alias);
  }
  return declared;
}

/** 别名索引中的一个图鉴条目。 */
export type GalleryAliasEntry = {
  /** 图库文件名（去首尾空白的原始名）；匹配身份，后续物化也以它定位服务器文件。 */
  filename: string;
  /** 归一化后的人读标签（`参考-` 与其后第一个 `-` 之间）；本版不参与匹配逻辑。 */
  label: string;
  /** 归一化并去重后的别名集，保持文件名中的出现顺序。 */
  aliases: string[];
};

const GALLERY_FILE_PREFIX = '参考-';
const GALLERY_EXTENSION_PATTERN = /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i;

/**
 * 解析图鉴文件名列表为别名索引（简报 §0.1/§3.2）。
 * 只收 `参考-` 前缀、且能拆出 `参考-<标签>-<别名区>` 完整结构的文件名；末尾图片扩展名剥离。
 * 容错：空标签（`参考--别名.png`）仍保留条目（标签不参与逻辑）；缺别名区
 * （无第二个 `-`，或别名区为空）的文件无法被匹配，跳过；同一文件名重复出现只保留一条。
 */
export function buildGalleryAliasIndex(files: string[]): GalleryAliasEntry[] {
  const seenFilenames = new Set<string>();
  const entries: GalleryAliasEntry[] = [];
  for (const rawFile of Array.isArray(files) ? files : []) {
    if (typeof rawFile !== 'string') continue;
    const filename = rawFile.trim();
    if (!filename || seenFilenames.has(filename)) continue;
    seenFilenames.add(filename);
    if (!filename.startsWith(GALLERY_FILE_PREFIX)) continue;
    const body = filename.replace(GALLERY_EXTENSION_PATTERN, '').slice(GALLERY_FILE_PREFIX.length);
    const separatorIndex = body.indexOf('-');
    // 缺别名区：既不能匹配声明，也当不成风格图，直接跳过。
    if (separatorIndex < 0) continue;
    const label = normalizeAlias(body.slice(0, separatorIndex));
    const aliases: string[] = [];
    const seenAliases = new Set<string>();
    for (const part of body.slice(separatorIndex + 1).split(ALIAS_SEPARATOR_PATTERN)) {
      const alias = normalizeAlias(part);
      if (!alias || seenAliases.has(alias)) continue;
      seenAliases.add(alias);
      aliases.push(alias);
    }
    if (aliases.length === 0) continue;
    entries.push({ filename, label, aliases });
  }
  return entries;
}

/** 一次声明匹配中的一个命中文件。 */
export type GalleryReferenceMatch = {
  /** 命中的图鉴条目。 */
  entry: GalleryAliasEntry;
  /** 该文件命中的声明别名（按声明位置排序）；首个即最早位置别名，供预演与编号标签使用。 */
  matchedAliases: string[];
  /** 命中别名在声明清单中的最早下标（排序键）。 */
  position: number;
};

export type GalleryMatchResult = {
  /** 全部命中文件，按声明序（最早命中下标升序）排列，不设数量上限。 */
  matches: GalleryReferenceMatch[];
  /** 声明了但没有任何图鉴文件命中的别名（声明序），供预演提示"缺失角色"。 */
  unmatchedAliases: string[];
};

/**
 * 声明序匹配（简报 §0.4/§3.3）：声明清单中每个归一化别名命中含该别名的文件；
 * 文件位置 = 其命中别名在声明中的最早下标；按位置升序全部返回，不设上限；
 * 一个文件命中多个别名只返回一次（取最早位置）。同一别名命中多个文件时保持索引中的文件顺序。
 * `declared` 允许传未归一化文本，入口会按同一规则归一化（幂等）。
 */
export function matchGalleryReferences(declared: string[], index: GalleryAliasEntry[]): GalleryMatchResult {
  const positionOfAlias = new Map<string, number>();
  (Array.isArray(declared) ? declared : []).forEach(rawAlias => {
    const alias = normalizeAlias(rawAlias);
    if (!alias || positionOfAlias.has(alias)) return;
    positionOfAlias.set(alias, positionOfAlias.size);
  });

  const orderedMatches: Array<GalleryReferenceMatch & { order: number }> = [];
  const declaredHitAliases = new Set<string>();
  (Array.isArray(index) ? index : []).forEach((entry, order) => {
    if (!entry || typeof entry.filename !== 'string' || !Array.isArray(entry.aliases)) return;
    const hits: Array<{ alias: string; position: number }> = [];
    for (const rawAlias of entry.aliases) {
      const alias = normalizeAlias(rawAlias);
      const position = positionOfAlias.get(alias);
      if (position !== undefined) hits.push({ alias, position });
    }
    if (hits.length === 0) return;
    hits.sort((a, b) => a.position - b.position);
    for (const hit of hits) declaredHitAliases.add(hit.alias);
    orderedMatches.push({ entry, matchedAliases: hits.map(hit => hit.alias), position: hits[0].position, order });
  });

  orderedMatches.sort((a, b) => a.position - b.position || a.order - b.order);
  const matches = orderedMatches.map(({ entry, matchedAliases, position }) => ({ entry, matchedAliases, position }));
  const unmatchedAliases = [...positionOfAlias.keys()].filter(alias => !declaredHitAliases.has(alias));
  return { matches, unmatchedAliases };
}

/**
 * 兜底检测扫描（简报 §0.7）：声明缺失时扫描提示词文本中是否出现任一图鉴别名。
 * 只检测、不产生附图决定（附图与否只由声明匹配决定）；返回按文本中首次出现位置
 * 排序、去重后的命中别名（归一化后）。
 */
export function scanPromptForAliases(promptText: string, index: GalleryAliasEntry[]): string[] {
  if (typeof promptText !== 'string' || promptText === '') return [];
  const haystack = normalizeAlias(promptText);
  if (!haystack) return [];
  const found: Array<{ alias: string; at: number }> = [];
  (Array.isArray(index) ? index : []).forEach(entry => {
    if (!entry || !Array.isArray(entry.aliases)) return;
    for (const rawAlias of entry.aliases) {
      const alias = normalizeAlias(rawAlias);
      if (!alias) continue;
      const at = haystack.indexOf(alias);
      if (at >= 0) found.push({ alias, at });
    }
  });
  found.sort((a, b) => a.at - b.at || a.alias.localeCompare(b.alias));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { alias } of found) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    result.push(alias);
  }
  return result;
}

const STYLE_LABEL = normalizeAlias('风格');

/**
 * 风格段精确查找（简报 §0.10/§3.4）：标签 = `风格` 且别名 = 出图预设名
 * （两侧归一化后完全相等，非子串）。找不到返回 null，由调用方决定仅在预演中警告、
 * 不弹 toast、不阻塞。
 */
export function findStyleReference(index: GalleryAliasEntry[], presetName: string): GalleryAliasEntry | null {
  const wanted = normalizeAlias(presetName);
  if (!wanted) return null;
  const entry = (Array.isArray(index) ? index : []).find(
    candidate =>
      !!candidate &&
      Array.isArray(candidate.aliases) &&
      normalizeAlias(candidate.label) === STYLE_LABEL &&
      candidate.aliases.some(alias => normalizeAlias(alias) === wanted),
  );
  return entry ?? null;
}

export type GalleryFetchOptions = {
  /** 测试注入端点；生产默认 SillyTavern 的 `/api/images/list`。 */
  endpoint?: string;
  /** 测试注入 fetch；生产默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入请求头；生产默认 SillyTavern 的请求头（与 shot-storage 同一注入习惯）。 */
  getRequestHeaders?: () => Record<string, string>;
};

function defaultRequestHeaders(): Record<string, string> {
  try {
    return { ...SillyTavern.getRequestHeaders() };
  } catch {
    throw new Error('未找到 SillyTavern 请求上下文');
  }
}

/**
 * 拉取图鉴文件夹的文件名列表（简报 §3.2）：POST `/api/images/list`。
 * 2026-10-05 存储地基探针确认：请求体 `{ folder }`，响应为纯文件名数组。
 * 任何失败（文件夹名为空、HTTP 非 2xx、响应不是数组、网络异常）都只警告并返回 null，
 * 由调用方处置（索引置空、不阻塞生成）；不重试。只返回文件名文本，不含任何图片数据。
 */
export async function fetchGalleryFileNames(
  folder: string = CONFIRMED_SHOT_FOLDER_NAME,
  options: GalleryFetchOptions = {},
): Promise<string[] | null> {
  const targetFolder = typeof folder === 'string' ? folder.trim() : '';
  if (!targetFolder) {
    console.warn('<杠杠の生图机> 图鉴文件夹名为空，跳过图鉴列表请求');
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? '/api/images/list';
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ...(options.getRequestHeaders ?? defaultRequestHeaders)(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folder: targetFolder }),
    });
    if (!response.ok) {
      console.warn('<杠杠の生图机> 图鉴列表请求失败', { status: response.status });
      return null;
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      console.warn('<杠杠の生图机> 图鉴列表响应格式不符合预期');
      return null;
    }
    return payload.filter((item): item is string => typeof item === 'string');
  } catch {
    console.warn('<杠杠の生图机> 图鉴列表请求失败');
    return null;
  }
}
