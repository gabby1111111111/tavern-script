import { materializeReferenceSources } from './reference-resolution';
import type { ImageApiProfile } from './settings';
import {
  findStyleReference,
  matchGalleryReferences,
  parseDeclaredCharacters,
  scanPromptForAliases,
  type GalleryAliasEntry,
  type GalleryReferenceMatch,
} from './gallery-reference';
import { CONFIRMED_SHOT_FOLDER_NAME } from './shot-storage';
import type {
  GalleryReferenceMatchStatus,
  ImageOutputPreset,
  PromptGalleryMatchSummary,
  PromptProcessingResult,
  ResolvedReferenceSource,
} from './pipeline-types';
import { readCurrentAvatarReferences, type AvatarReferenceReadResult } from './avatar-references';

export type PromptProcessorOptions = {
  readReferences?: () => Promise<AvatarReferenceReadResult>;
  previousShotPrompt?: string;
  previousStoryImage?: string;
  referenceContext?: { profile: ImageApiProfile; signal: AbortSignal };
  resolvedReferenceSources?: readonly ResolvedReferenceSource[];
  /**
   * v0.5.2 图鉴参考上下文:声明制匹配所需的别名索引。省略时完全不启用图鉴
   * 逻辑(旧调用方行为不变);列表失败由 runtime 置空索引,这里拿到空索引
   * 等价于图鉴无匹配,不阻塞生成。
   */
  gallery?: {
    aliasIndex?: GalleryAliasEntry[];
    /** 测试注入 origin;省略时按当前文档 `location.origin`(srcdoc 基准)解析。 */
    baseOrigin?: string | null;
  };
};

export function describeReferenceSources(sources: readonly ResolvedReferenceSource[]): string {
  return sources.map((source, index) => `图${index + 1}：${source.label}`).join('\n');
}

function asPromptTemplateValue(value: string): string {
  return value.trim() ? value : 'null';
}

// ---------------------------------------------------------------------------
// v0.5.2 图鉴参考:固定段序组装与物化基准
// ---------------------------------------------------------------------------

/** SillyTavern 用户图片服务的 URL 根(2026-10-05 存储地基探针,与 restore.ts 同依据)。 */
const USER_IMAGES_URL_ROOT = '/user/images/';

export type OutputReferenceAssemblyInput = {
  preset: ImageOutputPreset;
  avatarReferences: AvatarReferenceReadResult;
  /** 镜头提示词原文(`{{xx}}` 的内容);声明行 `当前出场角色：…` 从这里解析。 */
  promptText: string;
  /** 上一镜头图地址;仅当开关开启且非空白时成为收尾段。 */
  previousStoryImage?: string;
  /** 当前别名索引;省略或空数组等价于图鉴为空。 */
  galleryAliasIndex?: GalleryAliasEntry[];
};

export type OutputReferenceAssembly = {
  /**
   * 固定段序组装出的全部来源:①身份 → ②服装(预留)→ ③场景(预留)→
   * ④画风 → ⑤上一镜头图。物化与编号在调用方;`{{reference_sources}}` 永远
   * 按物化剔除后的最终实际发送列表重新编号。
   */
  sources: ResolvedReferenceSource[];
  /** 是否读到了非空的出场角色声明清单。 */
  declarationFound: boolean;
  /** 归一化声明清单(首次声明、去重、剔除空项)。 */
  declaredAliases: string[];
  /** 声明序命中的图鉴文件(不设上限)。 */
  galleryMatches: GalleryReferenceMatch[];
  /** 声明了但图鉴中无匹配的别名(声明序)。 */
  unmatchedAliases: string[];
  /** 声明缺失时兜底扫描命中的别名(仅检测,不附图)。 */
  scannedAliases: string[];
  /** 风格段开关是否开启。 */
  styleRequested: boolean;
  /** 风格段是否在图鉴中找到同名风格图。 */
  styleFound: boolean;
  /** 图鉴匹配审计状态(开关关闭即 'off')。 */
  status: GalleryReferenceMatchStatus;
};

/** 图鉴命中文件的服务器相对路径(专用文件夹,shot-storage 常量单一来源)。 */
export function galleryReferenceServerPath(filename: string): string {
  const name = filename.trim();
  if (!name) return '';
  return `${USER_IMAGES_URL_ROOT}${CONFIRMED_SHOT_FOLDER_NAME}/${name}`;
}

function normalizedHttpOrigin(baseOrigin?: string | null): string | null {
  const candidate =
    baseOrigin !== undefined
      ? typeof baseOrigin === 'string'
        ? baseOrigin.trim()
        : ''
      : readDocumentOrigin();
  return /^https?:\/\//i.test(candidate) ? candidate.replace(/\/+$/, '') : null;
}

function readDocumentOrigin(): string {
  try {
    // srcdoc iframe 的 location.origin 是字符串 "null",并不继承宿主页;
    // document.baseURI 才继承宿主页基准(执行简报 §3.3)。先取 location.origin,
    // 非 http(s) 时回退 baseURI;取不到时返回空,由调用方按物化失败剔除。
    const globalLocation = (globalThis as { location?: { origin?: unknown } }).location?.origin;
    const origin = typeof globalLocation === 'string' ? globalLocation.trim() : '';
    if (/^https?:\/\//i.test(origin)) return origin;
    if (typeof document !== 'undefined') {
      const baseOrigin = new URL(document.baseURI).origin;
      if (/^https?:\/\//i.test(baseOrigin)) return baseOrigin;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 图鉴/风格来源的物化基准(执行简报 §3.3):srcdoc iframe 里相对路径的隐式
 * 基准不可靠,必须显式相对 `location.origin` 解析成绝对 URL 后再交给现行物化
 * 管线。data:/http(s):/blob: 等绝对引用原样放行;解析失败返回空字符串,来源
 * 在物化阶段按现行可选来源规则被剔除,不占编号。
 */
export function resolveMaterializableReferenceUrl(value: string, baseOrigin?: string | null): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  const origin = normalizedHttpOrigin(baseOrigin);
  if (!origin) return '';
  try {
    return new URL(trimmed, `${origin}/`).toString();
  } catch {
    return '';
  }
}

/**
 * 固定段序组装(执行简报 §0.3/§3.4):段序是代码常量,未来新类型只增加段、
 * 不重排既有段——①人物身份(头像模式 = User 头像→角色头像;图鉴模式 = 匹配
 * 图按声明序)→ ②服装/造型(预留)→ ③场景(预留)→ ④画风(预设绑定的同名
 * 风格参考图)→ ⑤上一镜头图(如开,永远收尾)。
 *
 * 编号标签:`User 头像`、`角色头像`、`图鉴·<标签>(<最早命中别名>)`、
 * `风格·<预设名>`、`上一镜头图`;物化剔除后由 describeReferenceSources 按
 * 最终实际发送列表重新编号,编号永远与真实发送一致。
 */
export function assembleOutputReferenceSources(input: OutputReferenceAssemblyInput): OutputReferenceAssembly {
  const { preset } = input;
  const sources: ResolvedReferenceSource[] = [];
  const aliasIndex = Array.isArray(input.galleryAliasIndex) ? input.galleryAliasIndex : [];

  // ① 身份段:头像模式与图鉴模式互斥(设置层已保证单真,这里以头像优先防御双真数据)。
  let declaredAliases: string[] = [];
  let galleryMatches: GalleryReferenceMatch[] = [];
  let unmatchedAliases: string[] = [];
  let scannedAliases: string[] = [];
  if (preset.useAvatarReferences === true) {
    for (const source of ['persona', 'character'] as const) {
      const reference = input.avatarReferences.references.find(item => item.source === source && item.value.trim());
      if (reference)
        sources.push({
          kind: source === 'persona' ? 'user-avatar' : 'character-avatar',
          label: source === 'persona' ? 'User 头像' : '角色头像',
          value: reference.value,
        });
    }
  } else if (preset.useGalleryReferences === true) {
    declaredAliases = parseDeclaredCharacters(input.promptText);
    const matchResult = matchGalleryReferences(declaredAliases, aliasIndex);
    galleryMatches = matchResult.matches;
    unmatchedAliases = matchResult.unmatchedAliases;
    if (declaredAliases.length === 0) scannedAliases = scanPromptForAliases(input.promptText, aliasIndex);
    for (const match of galleryMatches) {
      const alias = match.matchedAliases[0];
      sources.push({
        kind: 'gallery-reference',
        label: `图鉴·${match.entry.label}(${alias})`,
        value: galleryReferenceServerPath(match.entry.filename),
      });
    }
  }

  // ② 服装/造型段、③ 场景段:本版预留;文件名的标签位已留,未来按标签细化
  // 触发规则时只增加段,不重排既有段。
  // ④ 画风段:预设绑定的同名风格参考图(独立开关,不参与头像/图鉴互斥)。
  const styleRequested = preset.useStyleReference === true;
  let styleFound = false;
  if (styleRequested) {
    const styleEntry = findStyleReference(aliasIndex, preset.name);
    if (styleEntry) {
      styleFound = true;
      sources.push({
        kind: 'style-reference',
        label: `风格·${preset.name.trim()}`,
        value: galleryReferenceServerPath(styleEntry.filename),
      });
    }
  }

  // ⑤ 上一镜头图:如开,永远收尾。
  const previousStoryImage = input.previousStoryImage?.trim();
  if (preset.usePreviousStoryImage === true && previousStoryImage)
    sources.push({ kind: 'previous-story-image', label: '上一镜头图', value: previousStoryImage });

  const status: GalleryReferenceMatchStatus =
    preset.useAvatarReferences === true || preset.useGalleryReferences !== true
      ? // 头像模式优先(双真数据被设置层修复,这里同口径防御),开关关闭即 'off'。
        'off'
      : declaredAliases.length === 0
        ? 'no_declaration'
        : galleryMatches.length === 0
          ? 'no_match'
          : unmatchedAliases.length > 0
            ? 'partial'
            : 'matched';

  return {
    sources,
    declarationFound: declaredAliases.length > 0,
    declaredAliases,
    galleryMatches,
    unmatchedAliases,
    scannedAliases,
    styleRequested,
    styleFound,
    status,
  };
}

/** 组装判定 → 随 PromptProcessingResult 带出的摘要(供 runtime 接审计与 toast)。 */
export function summarizeGalleryMatch(assembly: OutputReferenceAssembly): PromptGalleryMatchSummary {
  return {
    status: assembly.status,
    scannedAliasCount: assembly.scannedAliases.length,
    matchedCount: assembly.galleryMatches.length,
    unmatchedCount: assembly.unmatchedAliases.length,
    style: assembly.styleRequested ? (assembly.styleFound ? 'found' : 'missing') : 'off',
  };
}

/**
 * 物化前的基准修正:只有图鉴/风格来源携带服务器相对路径,其余来源(data URL、
 * 头像路径、上一镜头图 URL)保持原样交给现行物化管线。
 */
function withMaterializableReferenceValues(
  sources: readonly ResolvedReferenceSource[],
  baseOrigin?: string | null,
): ResolvedReferenceSource[] {
  return sources.map(source => {
    if (source.kind !== 'gallery-reference' && source.kind !== 'style-reference') return source;
    return { ...source, value: resolveMaterializableReferenceUrl(source.value, baseOrigin) };
  });
}

/** Literal one-pass substitution: inserted shot text is never evaluated as a template. */
export function applyOutputPromptTemplate(
  templateText: string,
  prompt: string,
  previousShotPrompt = '',
  referenceSources: readonly ResolvedReferenceSource[] = [],
): string {
  const values = {
    xx: asPromptTemplateValue(prompt),
    xx_pic: asPromptTemplateValue(previousShotPrompt),
    reference_sources: asPromptTemplateValue(describeReferenceSources(referenceSources)),
  };
  return templateText.replace(/\{\{(xx|xx_pic|reference_sources)\}\}/g, (_match, key: string) => {
    return values[key as keyof typeof values];
  });
}

export function applyDrawingPromptTemplate(templateText: string, previousShotPrompt = ''): string {
  return templateText.replace(/\{\{xx_pic\}\}/g, () => asPromptTemplateValue(previousShotPrompt));
}

/** Sources are resolved in request order; absent images never reserve an image number. */
export async function processDrawingPrompt(
  preset: ImageOutputPreset,
  prompt: string,
  options: PromptProcessorOptions = {},
): Promise<PromptProcessingResult> {
  let references: AvatarReferenceReadResult = { references: [], failedSources: [] };
  if (preset.useAvatarReferences && !options.resolvedReferenceSources) {
    try {
      references = await (options.readReferences ?? readCurrentAvatarReferences)();
    } catch {
      // Missing avatar inputs do not block text or previous-story references.
    }
  }
  let assembly: OutputReferenceAssembly | null = null;
  let sources: ResolvedReferenceSource[];
  if (options.resolvedReferenceSources) {
    sources = options.resolvedReferenceSources
      .filter(source => preset.usePreviousStoryImage || source.kind !== 'previous-story-image')
      .map(source => ({ ...source }));
  } else {
    const built = assembleOutputReferenceSources({
      preset,
      avatarReferences: references,
      promptText: prompt,
      previousStoryImage: preset.usePreviousStoryImage ? options.previousStoryImage : undefined,
      ...(options.gallery ? { galleryAliasIndex: options.gallery.aliasIndex } : {}),
    });
    assembly = built;
    sources = built.sources;
  }
  if (options.referenceContext) {
    if (options.referenceContext.signal.aborted) throw new DOMException('图片请求已取消', 'AbortError');
    if (!options.resolvedReferenceSources)
      sources = await materializeReferenceSources(
        withMaterializableReferenceValues(sources, options.gallery?.baseOrigin),
        options.referenceContext.profile,
        options.referenceContext.signal,
      );
  }
  const result: PromptProcessingResult = {
    prompt: applyOutputPromptTemplate(
      preset.templateText,
      prompt,
      preset.usePreviousStoryImage ? options.previousShotPrompt : undefined,
      sources,
    ),
    processing: 'processed',
  };
  if (sources.length > 0) {
    result.referenceImages = sources.map(source => source.value);
    result.referenceSources = sources;
  }
  // 仅在调用方提供图鉴上下文时带出匹配摘要;省略 gallery 的旧调用方行为不变
  // (结果不含新字段,既有的结构断言不受影响)。
  if (assembly && options.gallery) result.galleryMatch = summarizeGalleryMatch(assembly);
  return result;
}

/**
 * 兼容两种自然调用顺序：`(preset, prompt)` 是主接口，`(prompt, preset)`
 * 便于旧运行时迁移；两者共享同一套模板和头像引用语义。
 */
export async function processPrompt(
  first: ImageOutputPreset | string,
  second: string | ImageOutputPreset,
  options: PromptProcessorOptions = {},
): Promise<PromptProcessingResult> {
  if (typeof first === 'string') return processDrawingPrompt(second as ImageOutputPreset, first, options);
  return processDrawingPrompt(first, second as string, options);
}

/**
 * 头像模式下的参考来源(保留给直接需要 avatar+previous 列表的调用方);
 * 完整的固定段序组装见 assembleOutputReferenceSources。
 */
export function resolveReferenceSources(
  references: AvatarReferenceReadResult,
  previousStoryImage?: string,
): ResolvedReferenceSource[] {
  return assembleOutputReferenceSources({
    preset: {
      id: '',
      name: '',
      templateText: '',
      useAvatarReferences: true,
      usePreviousStoryImage: true,
    },
    avatarReferences: references,
    promptText: '',
    previousStoryImage,
  }).sources;
}
