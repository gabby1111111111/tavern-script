export type DrawingPreset = {
  id: string;
  name: string;
  instructionText: string;
};

export type ImageOutputPreset = {
  id: string;
  name: string;
  templateText: string;
  useAvatarReferences: boolean;
  /** v0.5.2 图鉴参考匹配开关(与头像参考互斥,设置层 schema 已提供)。 */
  useGalleryReferences?: boolean;
  /**
   * v0.5.2 风格段开关(预设绑定的同名风格参考图;独立开关,不参与头像/图鉴互斥)。
   * 组装层与设置层 schema 均已提供(output-preset.ts,默认 false),缺省视为关闭。
   */
  useStyleReference?: boolean;
  usePreviousStoryImage?: boolean;
};

export type DisplayMode = 'inline' | 'gift';

export type DisplaySettings = {
  displayMode: DisplayMode;
  skipFloors: number;
  generateOnSwipe: boolean;
};

export type PictureDirective = {
  imageIndex: number;
  prompt: string;
  markerText: string;
};

export type ImageRequestInput = {
  prompt: string;
  referenceImages?: string[];
};

export type ResolvedReferenceSource = {
  kind: 'user-avatar' | 'character-avatar' | 'gallery-reference' | 'style-reference' | 'previous-story-image';
  label: string;
  value: string;
};

/**
 * Lightweight page-memory provenance for a generated placement.  It carries
 * only the kind of reference that was attached, never the image bytes or URL.
 */
export type ImageReferenceKind = ResolvedReferenceSource['kind'];

/**
 * v0.5.2 图鉴参考匹配的审计状态(执行简报 §3.6):`matched` 全部声明命中,
 * `partial` 部分命中,`no_declaration` 声明缺失,`no_match` 有声明零匹配,
 * `off` 图鉴模式关闭。
 */
export type GalleryReferenceMatchStatus = 'matched' | 'partial' | 'no_declaration' | 'no_match' | 'off';

/** 一次镜头生成的图鉴匹配摘要(组装判定,随 PromptProcessingResult 带出)。 */
export type PromptGalleryMatchSummary = {
  status: GalleryReferenceMatchStatus;
  /** 声明缺失时兜底扫描命中的别名数(仅检测,不附图;toast 分支依据)。 */
  scannedAliasCount: number;
  /** 组装时命中的图鉴文件数(物化剔除前;审计 matched_count 以最终发送列表为准)。 */
  matchedCount: number;
  /** 声明了但图鉴中无匹配的别名数。 */
  unmatchedCount: number;
  /** 风格段状态:'off' 开关关;'found' 命中;'missing' 开着但图鉴中无同名风格图。 */
  style: 'off' | 'found' | 'missing';
};

export type PromptProcessingResult = {
  referenceSources?: ResolvedReferenceSource[];
  prompt: string;
  referenceImages?: string[];
  processing: 'bypassed' | 'processed';
  /** v0.5.2 图鉴匹配摘要;仅在走组装路径(非调用方预解析来源)时带出。 */
  galleryMatch?: PromptGalleryMatchSummary;
};

export type FloorTriggerDecision = {
  shouldTrigger: boolean;
  normalAssistantFloorCount: number;
  interval: number;
  reason: 'eligible' | 'disabled' | 'non-normal-generation' | 'group-chat' | 'skipped-by-frequency';
};

export type ImageMemoryKey = {
  chatId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
};

export type GallerySaveInput = {
  dataUrl: string;
  characterName: string;
  filename: string;
};

export type GallerySaveResult = {
  path: string;
};
