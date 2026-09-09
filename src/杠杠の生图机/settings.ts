import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { z } from 'zod';
import {
  DEFAULT_DRAWING_PRESET,
  DEFAULT_DRAWING_PRESET_ID,
  DrawingPresetSchema,
  LEGACY_GIFT_DRAWING_PRESET_ID,
  LEGACY_GIFT_DRAWING_PRESET_NAME,
  getCurrentDrawingPreset as getCurrentDrawingPresetFromList,
  normalizeDrawingPresets,
  type DrawingPreset,
} from './drawing-preset';
import {
  DEFAULT_OUTPUT_PRESET,
  DEFAULT_OUTPUT_PRESET_ID,
  ImageOutputPresetSchema,
  getCurrentOutputPreset as getCurrentOutputPresetFromList,
  normalizeOutputPresets,
  type ImageOutputPreset,
} from './output-preset';

export {
  DEFAULT_DRAWING_PRESET,
  DEFAULT_DRAWING_PRESET_ID,
  DrawingPresetSchema,
  LEGACY_GIFT_DRAWING_PRESET_ID,
  LEGACY_GIFT_DRAWING_PRESET_NAME,
  createDrawingPreset,
  deleteDrawingPreset,
  normalizeDrawingPreset,
  normalizeDrawingPresets,
  updateDrawingPreset,
} from './drawing-preset';
export type { DrawingPreset } from './drawing-preset';
export {
  DEFAULT_IMAGE_OUTPUT_PRESET,
  DEFAULT_IMAGE_OUTPUT_PRESET_ID,
  DEFAULT_OUTPUT_PRESET,
  DEFAULT_OUTPUT_PRESET_ID,
  ImageOutputPresetSchema,
  createImageOutputPreset,
  createOutputPreset,
  deleteImageOutputPreset,
  deleteOutputPreset,
  getCurrentImageOutputPreset,
  normalizeImageOutputPreset,
  normalizeImageOutputPresets,
  normalizeOutputPreset,
  normalizeOutputPresets,
  updateImageOutputPreset,
  updateOutputPreset,
} from './output-preset';
export type { ImageOutputPreset } from './output-preset';

const LEGACY_INLINE_PROMPT_DEFAULT =
  '当回复中确实需要一张或两张随文插图时，在对应正文段落中输出最多两个 <pic prompt="英文绘图提示词"> 标记；没有需要时不要输出标记。不要输出分析过程。';

export const DEFAULT_PROMPT_SECTIONS = {
  base: [
    '你正在正常生成角色回复正文。根据正文内容和叙事需要，最多生成两条 <pic prompt="..."> 标记。没有适合随文插图的位置时不要生成标记。',
    '两条标记分别对应正文中的两个位置；每一条有效标记对应一张图片，有几条有效标记就生成几张，最多两张。',
    '标记必须位于 <content> 内，并插入对应的正文段落位置，不要放在 <content> 外。',
    '标记格式必须是：<pic prompt="这里填写一条中文绘图提示词">。内部只使用英文半角双引号，不要在 prompt 内再次使用英文半角双引号。',
    '不要输出分析过程、额外说明、备选方案或对提示词生成过程的解释。',
  ],
  scene: [
    '整体审美采用日系 Ins 生活美学、私人社交账号记录感、干净现代城市生活和轻松自然的生活方式摄影。色彩自然明亮、低饱和但不灰暗，常用奶油色、浅灰、米白、淡蓝和柔和暖光。',
    '综合正文中的环境、物件、时间、光线和情绪，画面要精致但不刻意，有生活痕迹但不杂乱。',
    '场景一致性：如果两条图片属于同一场景和同一时间段，正文已经出现的家具、道具和环境物品必须保持一致；只有正文明确写出地点变化或时间跳跃时才改变场景。',
    '场景常识补全：根据时间和地点补充现实中通常存在的背景，例如教室中的其他同学、便利店货架、公交车厢结构、餐厅中的其他桌椅和顾客；这些背景只能作为陪衬，不能喧宾夺主。',
    '画面丰富度：加入生活痕迹、个人物品、时间感、空间细节、材质细节、小型装饰和环境线索，避免空白背景、单调背景和没有故事的普通照片。',
    '人物不能成为主要主体。优先使用第一人称视角或生活场景旁观视角，人物只作为远景、背影、环境元素，或通过发丝、肩颈线条、手部动作和衣物细节间接出现。',
  ],
  style: [
    '每次从下面的视觉风格库中随机选择两种不同的视觉类型。每条 prompt 都必须保留所选类型的强制开头句式，一字不改，只在句末补充当前正文对应的场景内容。',
    '',
    '**1. 拍立得照片**',
    '强制开头句式："这张照片是抓拍的，略微倾斜（荷兰角），模拟了业余智能手机摄影的效果。这张照片展现了原始的真实感，并刻意保留了一些缺陷：可见的数字噪点/颗粒、平淡的人工照明，以及左下角的复古橙色日期戳记（比如“26 04 29”日期戳根据正文剧情生成），散发出一种亲密、怀旧的胶片遗留氛围。画面内容是："',
    '适合：回忆、纪念、关系节点。',
    '',
    '**2. 胶片照片**',
    `强制开头句式：
"CG 渲染风格的景观画面。
画面风格与质量要求：
- 呈现虚幻引擎 5 级别的高端游戏视觉质量，整体效果逼真、清晰、干净、清新，具有 HDR 质感。
- 使用电影级照明：清晰的定向阳光、强烈但自然的明暗对比、明显的长阴影、可见的体积光。
- 保持明亮通透的氛围，高曝光但高光不过曝，半透明高光保留细节。
- 暗部保持干净、有层次，不发灰、不脏乱。
- 色彩使用自然且生动的饱和度，避免过度艳丽或失真。- 强化空间深度与景深层次，远景使用清晰的空气透视效果。- 不添加文字、水印、边框、UI 元素、标识、虚构角色、额外建筑、额外车辆或其他无关的物体。画面内容是："`,
    '适合：青春、旅行、过去。',
    '',
    '**3. 手账页面**',
    `强制开头句式：
"这是一页私人手账本体的平面呈现，版面带有轻微手绘小插图装饰，使用最大的色块、涂鸦感更重，尽可能弄得惨兮兮的。用白底，做得像是在老式电脑画图程序里拿鼠标画出来的。要隐约有点像，但又不太像，像是对上了又哪哪都不对，别扭得让人迷惑，呈现那种低清、一像素一像素蹭出来的感觉，突出它到底有多离谱地烂。越乱越好，但是还是要保持可爱的感觉。算了，随便吧，你想怎么画就怎么画 整张图像即为这页手账本身，而非拍摄手账的照片。画面内容是："`,
    '',
    '**4. 人生四格漫画**',
    `强制开头句式：
"这是一页完整的四格漫画本体，采用简单干净的线条和自然的分镜排版，画风轻松可爱，整张图像即为这页漫画本身。重画附图，使用最大的色块、涂鸦感更重，尽可能弄得惨兮兮的。用白底，做得像是在老式电脑画图程序里拿鼠标画出来的。要隐约有点像，但又不太像，像是对上了又哪哪都不对，别扭得让人迷惑，呈现那种低清、一像素一像素蹭出来的感觉，突出它到底有多离谱地烂。算了，随便吧，你想怎么画就怎么画。四格内容分别是："`,
    '适合：日常互动、小事件。',
    '',
    '**5. 简笔画 / 涂鸦**',
    `强制开头句式：
"这是角色随手留下的一幅简笔涂鸦本体，极简线条插画，不要复刻外形，不描写细节，不追求完整，从提炼核心神态、气质与轮廓。用不超过六笔完成传达。每一笔都是审美判断的必要表达，简而传神。毛笔或速写线条，流畅，带有轻重停顿、呼吸与节奏感。允许断线、留白和弧度起伏，画面自由生长。不要机械描边、碎裂轮廓。不刻画五官细纹、毛发、叶脉、褶皱，不写实、不阴影、不纹理。构图集中醒目，有留白。在小尺寸下仍能辨认主体。背景顺应原图气质或指定颜色，深色调，突出白色或浅色线条。可有极少量轻巧点缀，但必须克制、自然、不喧宾夺主，贴合主体节奏和神韵。最终效果应极简、少而有力、有神，每一笔都传递对象的神态和生命感，呈现 大师级的抽象表达 与审美画面内容是："`,
    '',
    '**6. 动漫风格截图**',
    `强制开头句式：
"这是一帧原创动漫风格插画的截图本体，画风为日系动漫渲染风格，构图带有截图特有的宽高比和轻微的画面颗粒感，角色设计为原创虚构形象，不致敬任何现实存在的动漫作品的角色或画面构图，整张图像即为这帧动漫截图本身。画面内容是："`,
    '适合：想象片段、内心戏、二次元自比场景。',
  ],
  safety: [
    '所有画面必须保持纯 SFW：不生成色情、裸露、性暗示、露骨身体描写、性行为、血腥重伤或创伤画面。',
    '人物限制：不要生成正面肖像、自拍头像、脸部特写或商业写真；不要使用“少女、少年、幼女、萝莉、正太、未成年”等措辞，改用“角色、人物、女子、男子、女性角色、男性角色”等中性说法。',
    '敏感措辞替换：不要写裸露身体、足部特写、色情内容或创伤画面；不要使用“赤足、裸足、光脚、脚面、足尖、脚趾、受伤、伤口、流血、血迹、鲜血、痛苦”等词，可改写为“穿着完整、鞋袜整洁、气氛紧张、光影冷清”等安全表达。',
    '生成前自检：检查人物是否占据主要篇幅，是否保留场景中的既有物品，是否补全了合理的环境背景，是否符合角色已知的年龄/学段/职业，是否选择了两种不同视觉类型并保留了各自的强制开头句式。',
    '如果有文字，图里的文字必须是中文，绝不能出现人脸。prompt 使用中文完整句子，不使用关键词堆砌；最终 prompt 只写正向画面内容，不把安全限制原样写进图片后端请求。',
    '只输出最终正文和有效的 <pic prompt="..."> 标记，不输出思考过程、自检过程、额外说明或备选结果。',
  ],
} as const;

export type PromptSectionKey = 'basePrompt' | 'scenePrompt' | 'stylePrompt' | 'safetyPrompt';

export const DEFAULT_GIFT_PROMPT_SECTIONS = {
  identity: [
    '角色 1 和角色 2 的身份特征来自各自参考图。',
    '参考图决定脸型、发型、发色、瞳色、身材比例和整体气质。',
    '不要让模板图改变角色身份。',
  ],
  template: [
    '模板图只用于确定镜头、动作、姿势、构图、人物关系和肢体位置。',
    '不要照搬模板图中的人物外貌、发型或服装。',
  ],
  scene: [
    '服装、场景、道具、表情、光线和氛围必须根据当前正文剧情决定。',
    '只读取正文旁白、环境、动作、心理和剧情信息。',
  ],
  style: [
    '默认使用 2.5D 精致数字绘画风，带有细腻的 BJD 质感。',
    '也可以使用乙女游戏角色精致渲染风。',
    '如果模板图是二次元，跟随模板图画风；如果模板图是真人照片，必须重绘成二次元，不保留真人照片质感。',
  ],
  output: [
    '只输出一条适合图生图的中文提示词。',
    '不要输出分析过程、角色参考图分析过程、模板图分析过程或备选方案。',
    '所有画面保持纯 SFW，不生成色情、裸露、性暗示、血腥重伤或未成年人相关敏感内容。',
  ],
} as const;

export type GiftReferenceSlot = 'character-1' | 'character-2' | 'template';
export type GiftRequestMode = 'auto' | 'multipart-edit' | 'chat-multimodal' | 'json-reference';
export type MultipartImageField = 'auto' | 'image' | 'image[]';

export const GiftImageSettings = z.object({
  enabled: z.boolean().default(false),
  triggerInterval: z.enum(['manual', '3', '5']).default('manual'),
  requestMode: z.enum(['auto', 'multipart-edit', 'chat-multimodal', 'json-reference']).default('auto'),
  multipartImageField: z.enum(['auto', 'image', 'image[]']).default('auto'),
  jsonReferenceField: z.enum(['images', 'reference_images', 'image']).default('images'),
  identityPrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.identity.join('\n')),
  templatePrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.template.join('\n')),
  scenePrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.scene.join('\n')),
  stylePrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.style.join('\n')),
  outputPrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.output.join('\n')),
});

export type GiftSettings = z.infer<typeof GiftImageSettings>;

type LegacyInlinePromptSettings = Partial<Record<PromptSectionKey, string>> & {
  drawingPresets?: DrawingPreset[];
  currentDrawingPresetId?: string;
};

export function composeInlinePrompt(settings: LegacyInlinePromptSettings): string {
  const sections = [settings.basePrompt, settings.scenePrompt, settings.stylePrompt, settings.safetyPrompt]
    .filter((section): section is string => typeof section === 'string' && section.trim().length > 0)
    .map(section => section.trim());
  if (sections.length === 0 && settings.drawingPresets) {
    const current = getCurrentDrawingPresetFromList(settings.drawingPresets, settings.currentDrawingPresetId ?? '');
    if (current.instructionText.trim()) sections.push(current.instructionText.trim());
  }
  return `<杠杠の生图机>\n${sections.join('\n\n')}\n</杠杠の生图机>`;
}

export const DEFAULT_IMAGE_API_PROFILE_ID = 'default-profile';

const DEFAULT_IMAGE_API_PROFILE = {
  id: DEFAULT_IMAGE_API_PROFILE_ID,
  name: '默认配置',
  serviceUrl: 'https://api.openai.com/v1/images/generations',
  modelListUrl: '',
  apiKey: '',
  model: 'gpt-image-1',
  imageSize: '1024x1024',
  quality: 'auto',
  imageCount: 1,
  timeoutMs: 120_000,
  retryAttempts: 0,
  retryDelayMs: 1_500,
  requestMode: 'auto',
  multipartImageField: 'auto',
  jsonReferenceField: 'images',
  extraBody: {},
} as const;

export const ImageApiProfile = z.object({
  id: z.string().min(1),
  name: z.string().default('默认配置'),
  serviceUrl: z.string().default('https://api.openai.com/v1/images/generations'),
  modelListUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-image-1'),
  imageSize: z.string().default('1024x1024'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('auto'),
  imageCount: z.coerce.number().int().min(1).max(4).default(1),
  timeoutMs: z.number().int().min(1000).max(900_000).default(120_000),
  retryAttempts: z.number().int().min(0).max(5).default(0),
  retryDelayMs: z.number().int().min(0).max(60_000).default(1_500),
  requestMode: z.enum(['auto', 'multipart-edit', 'chat-multimodal', 'json-reference']).default('auto'),
  multipartImageField: z.enum(['auto', 'image', 'image[]']).default('auto'),
  jsonReferenceField: z.enum(['images', 'reference_images', 'image']).default('images'),
  extraBody: z.record(z.string(), z.unknown()).default({}),
});

export type ImageApiProfile = z.infer<typeof ImageApiProfile>;

export const MAX_SKIP_FLOORS = 1000;

function normalizeApiProfileTimeout(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_IMAGE_API_PROFILE.timeoutMs;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(numeric) && numeric >= 1_000 && numeric <= 900_000
    ? numeric
    : DEFAULT_IMAGE_API_PROFILE.timeoutMs;
}

function parseApiProfile(value: unknown): ImageApiProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const parsed = ImageApiProfile.safeParse({
    ...candidate,
    timeoutMs: normalizeApiProfileTimeout(candidate.timeoutMs),
  });
  return parsed.success ? parsed.data : null;
}

export const DisplaySettingsSchema = z.object({
  displayMode: z.enum(['inline', 'gift']).default('inline'),
  // The UI accepts a number input, while old or hand-edited script variables
  // can contain strings. Coercion is kept at the persistence boundary.
  skipFloors: z.coerce.number().int().min(0).max(MAX_SKIP_FLOORS).default(0),
  generateOnSwipe: z.boolean().default(true),
});

export type DisplaySettings = z.infer<typeof DisplaySettingsSchema>;
export type DisplayMode = DisplaySettings['displayMode'];
export type StoryImageDisplaySettings = DisplaySettings;

export const DEFAULT_RECENT_IMAGE_LIMIT = 10;
export const MIN_RECENT_IMAGE_LIMIT = 1;
export const MAX_RECENT_IMAGE_LIMIT = 50;

export const RecentImageLimitSchema = z.coerce
  .number()
  .int()
  .min(MIN_RECENT_IMAGE_LIMIT)
  .max(MAX_RECENT_IMAGE_LIMIT)
  .default(DEFAULT_RECENT_IMAGE_LIMIT);

const DEFAULT_DRAWING_INSTRUCTION = [
  DEFAULT_PROMPT_SECTIONS.base.join('\n'),
  DEFAULT_PROMPT_SECTIONS.scene.join('\n'),
  DEFAULT_PROMPT_SECTIONS.style.join('\n'),
  DEFAULT_PROMPT_SECTIONS.safety.join('\n'),
]
  .map(section => section.trim())
  .filter(Boolean)
  .join('\n\n');

const DEFAULT_DRAWING_PRESETS: DrawingPreset[] = [
  { ...DEFAULT_DRAWING_PRESET, instructionText: DEFAULT_DRAWING_INSTRUCTION },
];

const DEFAULT_OUTPUT_PRESETS: ImageOutputPreset[] = [{ ...DEFAULT_OUTPUT_PRESET }];

export function normalizeRecentImageLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RECENT_IMAGE_LIMIT;
  return Math.min(MAX_RECENT_IMAGE_LIMIT, Math.max(MIN_RECENT_IMAGE_LIMIT, Math.trunc(numeric)));
}

function parseApiProfiles(raw: Record<string, unknown>): ImageApiProfile[] {
  if (Array.isArray(raw.apiProfiles)) {
    const profiles = raw.apiProfiles
      .map(parseApiProfile)
      .filter((profile): profile is ImageApiProfile => profile !== null);
    if (profiles.length > 0) return profiles;
  }

  const legacyProfile = parseApiProfile({
    id: DEFAULT_IMAGE_API_PROFILE_ID,
    name: '默认配置',
    serviceUrl: raw.serviceUrl,
    modelListUrl: '',
    apiKey: raw.apiKey,
    model: raw.model,
    imageSize: raw.imageSize,
    quality: raw.quality,
    imageCount: raw.imageCount,
    timeoutMs: raw.timeoutMs,
    retryAttempts: raw.retryAttempts,
    retryDelayMs: raw.retryDelayMs,
    requestMode: raw.requestMode,
    multipartImageField: raw.multipartImageField,
    jsonReferenceField: raw.jsonReferenceField,
    extraBody: raw.extraBody,
  });
  return legacyProfile ? [legacyProfile] : [ImageApiProfile.parse(DEFAULT_IMAGE_API_PROFILE)];
}

function profileRouteId(raw: Record<string, unknown>, key: string, fallback: string): string {
  return typeof raw[key] === 'string' && raw[key].trim() ? raw[key].trim() : fallback;
}

function composeLegacyGiftPrompt(raw: Record<string, unknown>): string {
  const gift = raw.gift && typeof raw.gift === 'object' ? (raw.gift as Record<string, unknown>) : {};
  const sanitize = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value
      .split(/\r?\n/)
      .filter(line => !/(模板图|模板|只输出一条|输出一条|图生图)/.test(line))
      .join('\n')
      .trim();
  };
  const values = [
    ['身份约束', sanitize(gift.identityPrompt)],
    ['正文场景约束', sanitize(gift.scenePrompt)],
    ['画风约束', sanitize(gift.stylePrompt)],
  ]
    .filter((entry): entry is [string, string] => entry[1].length > 0)
    .map(([label, text]) => `【${label}】\n${text}`);
  return values.join('\n\n');
}

function legacyInlineInstruction(raw: Record<string, unknown>): string {
  const sections = [raw.basePrompt, raw.scenePrompt, raw.stylePrompt, raw.safetyPrompt]
    .filter((section): section is string => typeof section === 'string' && section.trim().length > 0)
    .map(section => section.trim());
  if (sections.length > 0) return sections.join('\n\n');
  if (
    typeof raw.inlinePrompt === 'string' &&
    raw.inlinePrompt.trim() &&
    raw.inlinePrompt.trim() !== LEGACY_INLINE_PROMPT_DEFAULT
  ) {
    return raw.inlinePrompt.trim();
  }
  return DEFAULT_DRAWING_INSTRUCTION;
}

function parseDrawingPresets(raw: Record<string, unknown>): DrawingPreset[] {
  if (Array.isArray(raw.drawingPresets)) {
    const presets = normalizeDrawingPresets(raw.drawingPresets);
    // If only malformed values were supplied, normalizeDrawingPresets returns
    // one safe default. Existing valid presets are otherwise preserved byte for
    // byte apart from whitespace-normalized IDs/names.
    return presets;
  }

  const inlinePreset: DrawingPreset = {
    ...DEFAULT_DRAWING_PRESET,
    instructionText: legacyInlineInstruction(raw),
  };
  const giftPrompt = composeLegacyGiftPrompt(raw);
  if (!giftPrompt) return [inlinePreset];
  return [
    inlinePreset,
    {
      id: LEGACY_GIFT_DRAWING_PRESET_ID,
      name: LEGACY_GIFT_DRAWING_PRESET_NAME,
      // Keep the marker contract in front of the migrated gift rules so this
      // compatibility preset remains usable when selected in v0.3.
      instructionText: `${DEFAULT_DRAWING_PRESET.instructionText}\n\n${giftPrompt}`,
    },
  ];
}

function legacyCurrentDrawingPresetNeedsProcessing(raw: Record<string, unknown>): boolean {
  const source = Array.isArray(raw.drawingPresets) ? raw.drawingPresets : [];
  if (source.length === 0) return raw.needsProcessing === true;

  const currentId = typeof raw.currentDrawingPresetId === 'string' ? raw.currentDrawingPresetId.trim() : '';
  const current =
    (currentId
      ? source.find(
          item =>
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof (item as Record<string, unknown>).id === 'string' &&
            ((item as Record<string, unknown>).id as string).trim() === currentId,
        )
      : undefined) ?? source[0];
  return Boolean(
    current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    (current as Record<string, unknown>).needsProcessing === true,
  );
}

function parseOutputPresets(raw: Record<string, unknown>, inheritedUseAvatarReferences: boolean): ImageOutputPreset[] {
  if (Array.isArray(raw.outputPresets) && raw.outputPresets.length > 0) {
    return normalizeOutputPresets(raw.outputPresets);
  }
  return [{ ...DEFAULT_OUTPUT_PRESET, useAvatarReferences: inheritedUseAvatarReferences }];
}

type LegacyGiftTriggerInterval = 'manual' | '3' | '5';

type LegacyDisplayMigration = {
  displaySettings: StoryImageDisplaySettings;
  disableAutomaticGeneration: boolean;
};

function hasExplicitDisplaySettings(raw: Record<string, unknown>): boolean {
  return raw.displaySettings !== null && typeof raw.displaySettings === 'object' && !Array.isArray(raw.displaySettings);
}

function parseLegacyGiftTrigger(value: unknown): LegacyGiftTriggerInterval | null {
  return value === 'manual' || value === '3' || value === '5' ? value : null;
}

function getLegacyDisplayMode(raw: Record<string, unknown>, legacyGift: Record<string, unknown>): 'inline' | 'gift' {
  const trigger = parseLegacyGiftTrigger(legacyGift.triggerInterval);
  if (legacyGift.enabled === true) {
    // The old schema persisted mode:inline even when the independent gift
    // route was enabled. Scheduled gift intervals are the stronger signal and
    // must migrate to unified gift display rather than stale inline mode.
    if (trigger === '3' || trigger === '5') return 'gift';

    // A legacy manual gift route did not schedule anything. When inline is
    // enabled and gift mode was not explicitly selected, preserve inline;
    // otherwise keep gift mode so the migration can disable it safely.
    if (trigger === 'manual' || trigger === null) {
      if (raw.mode === 'gift') return 'gift';
      if (raw.enabled === true) return 'inline';
      return 'gift';
    }

    // Unknown/old gift intervals retain the historical gift preference.
    return 'gift';
  }

  // If the legacy gift route was disabled, the old mode is the only remaining
  // display hint. This is intentionally a fallback, not an override for an
  // enabled gift route above.
  if (raw.mode === 'gift' || raw.mode === 'inline') return raw.mode;
  return 'inline';
}

function parseDisplaySettings(
  raw: Record<string, unknown>,
  legacyGift: Record<string, unknown> = {},
): StoryImageDisplaySettings {
  const nested = hasExplicitDisplaySettings(raw) ? (raw.displaySettings as Record<string, unknown>) : {};
  const legacyMode = getLegacyDisplayMode(raw, legacyGift);
  const displayMode =
    nested.displayMode === 'gift' || nested.displayMode === 'inline'
      ? nested.displayMode
      : hasExplicitDisplaySettings(raw)
        ? 'inline'
        : legacyMode;
  const numericSkipFloors = Number(nested.skipFloors);
  const skipFloors = Number.isFinite(numericSkipFloors)
    ? Math.min(MAX_SKIP_FLOORS, Math.max(0, Math.trunc(numericSkipFloors)))
    : 0;
  const generateOnSwipe = typeof nested.generateOnSwipe === 'boolean' ? nested.generateOnSwipe : true;
  const parsed = DisplaySettingsSchema.safeParse({
    displayMode,
    skipFloors,
    generateOnSwipe,
  });
  return parsed.success
    ? parsed.data
    : DisplaySettingsSchema.parse({ displayMode, skipFloors: 0, generateOnSwipe: true });
}

function migrateLegacyGiftTrigger(
  raw: Record<string, unknown>,
  legacyGift: Record<string, unknown>,
  displaySettings: StoryImageDisplaySettings,
): LegacyDisplayMigration {
  // A v3 displaySettings object is authoritative. Do not reinterpret a stale
  // v0.2 gift block after a successful migration has already been written.
  if (hasExplicitDisplaySettings(raw)) {
    return { displaySettings, disableAutomaticGeneration: false };
  }

  // A disabled legacy gift block is not an automatic route to migrate. Keep
  // it inert unless the old configuration explicitly selected gift mode.
  if (legacyGift.enabled !== true && raw.mode !== 'gift') {
    return { displaySettings, disableAutomaticGeneration: false };
  }

  const trigger = parseLegacyGiftTrigger(legacyGift.triggerInterval);
  if (!trigger) {
    const explicitGiftMode = raw.mode === 'gift';
    const hasRetainableInlineAutomaticRoute = raw.mode !== 'gift' && raw.enabled === true;
    if (!explicitGiftMode && hasRetainableInlineAutomaticRoute) {
      // Missing or invalid v0.2 trigger values are treated like manual: keep
      // the usable inline route, but never infer an automatic gift schedule.
      return { displaySettings, disableAutomaticGeneration: false };
    }

    // A gift route with no trustworthy schedule must not fall back to v3's
    // skipFloors=0 (every-floor) behavior. Disable it conservatively.
    return {
      displaySettings: { ...displaySettings, skipFloors: MAX_SKIP_FLOORS },
      disableAutomaticGeneration: true,
    };
  }

  if (trigger === 'manual') {
    const explicitGiftMode = raw.mode === 'gift';
    const hasRetainableInlineAutomaticRoute = raw.mode !== 'gift' && raw.enabled === true;
    if (!explicitGiftMode && hasRetainableInlineAutomaticRoute) {
      // With no explicit gift mode, v0.2 could have inline generation enabled
      // alongside a manual-only gift route. Keep inline mode and its enabled
      // state; the manual gift route must not disable the whole plugin.
      return { displaySettings, disableAutomaticGeneration: false };
    }

    // v0.2 manual meant “never schedule automatically”. v0.3 has no disabled
    // value inside DisplaySettings, so disable the top-level switch as the
    // only unambiguous migration. The large interval is a second guard for
    // code that inspects this object directly; it is not relied on for safety.
    return {
      displaySettings: { ...displaySettings, skipFloors: MAX_SKIP_FLOORS },
      disableAutomaticGeneration: true,
    };
  }

  // v0.2 scheduled on the 3rd/5th reply. v0.3 always considers the first
  // counted floor eligible, so exact phase preservation is impossible. Map
  // 3→skip 2 and 5→skip 4 (the documented v3 interval) and keep the choice
  // explicit rather than silently turning either value into every-floor mode.
  const interval = Number(trigger);
  return {
    displaySettings: { ...displaySettings, skipFloors: interval - 1 },
    disableAutomaticGeneration: false,
  };
}

const StoryImageSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    drawingPresets: z.array(DrawingPresetSchema).min(1).default(DEFAULT_DRAWING_PRESETS),
    currentDrawingPresetId: z.string().default(DEFAULT_DRAWING_PRESET_ID),
    outputPresets: z.array(ImageOutputPresetSchema).min(1).prefault(DEFAULT_OUTPUT_PRESETS),
    currentOutputPresetId: z.string().default(DEFAULT_OUTPUT_PRESET_ID),
    recentImageLimit: RecentImageLimitSchema,
    displaySettings: DisplaySettingsSchema.prefault({}),
    activeApiProfileId: z.string().default(DEFAULT_IMAGE_API_PROFILE_ID),
    apiProfiles: z.array(ImageApiProfile).min(1).default([DEFAULT_IMAGE_API_PROFILE]),

    // Kept as non-UI compatibility routes while v0.2 callers are removed.
    // They contain no image data and are repaired to an existing profile.
    storyApiProfileId: z.string().default(DEFAULT_IMAGE_API_PROFILE_ID),
    giftApiProfileId: z.string().default(DEFAULT_IMAGE_API_PROFILE_ID),
  })
  .prefault({});

export const ImageSettings = StoryImageSettingsSchema;
export type StoryImageSettings = z.infer<typeof StoryImageSettingsSchema>;

export function getActiveApiProfile(settings: StoryImageSettings): ImageApiProfile {
  return settings.apiProfiles.find(profile => profile.id === settings.activeApiProfileId) ?? settings.apiProfiles[0];
}

export function repairApiProfileRouteIds(settings: StoryImageSettings, fallbackProfileId?: string): void {
  const hasProfile = (id: string) => settings.apiProfiles.some(profile => profile.id === id);
  const fallback = fallbackProfileId && hasProfile(fallbackProfileId) ? fallbackProfileId : settings.apiProfiles[0].id;
  if (!hasProfile(settings.activeApiProfileId)) settings.activeApiProfileId = fallback;
  if (!hasProfile(settings.storyApiProfileId)) settings.storyApiProfileId = settings.activeApiProfileId;
  if (!hasProfile(settings.giftApiProfileId)) settings.giftApiProfileId = settings.activeApiProfileId;
}

export function getStoryApiProfile(settings: StoryImageSettings): ImageApiProfile {
  return (
    settings.apiProfiles.find(profile => profile.id === settings.storyApiProfileId) ?? getActiveApiProfile(settings)
  );
}

export function getGiftApiProfile(settings: StoryImageSettings): ImageApiProfile {
  return (
    settings.apiProfiles.find(profile => profile.id === settings.giftApiProfileId) ?? getActiveApiProfile(settings)
  );
}

export function getCurrentDrawingPreset(settings: StoryImageSettings): DrawingPreset {
  return getCurrentDrawingPresetFromList(settings.drawingPresets, settings.currentDrawingPresetId);
}

export function getCurrentOutputPreset(settings: StoryImageSettings): ImageOutputPreset {
  return getCurrentOutputPresetFromList(settings.outputPresets, settings.currentOutputPresetId);
}

// Explicitly named alias for callers that prefer to distinguish the settings
// lookup from the pure list helper exported by drawing-preset.ts.
export const getCurrentDrawingPresetForSettings = getCurrentDrawingPreset;
export const getCurrentImageOutputPresetForSettings = getCurrentOutputPreset;

export function parseStoryImageSettings(raw: unknown): StoryImageSettings {
  const rawRecord = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const legacyGift =
    rawRecord.gift && typeof rawRecord.gift === 'object' ? (rawRecord.gift as Record<string, unknown>) : {};
  const parsedProfiles = parseApiProfiles(rawRecord);
  const legacyGiftProfileId = profileRouteId(rawRecord, 'giftApiProfileId', parsedProfiles[0].id);
  const profiles = parsedProfiles.map(profile => {
    if (profile.id !== legacyGiftProfileId) return profile;
    const requestMode = GiftImageSettings.shape.requestMode.safeParse(legacyGift.requestMode);
    const multipartImageField = GiftImageSettings.shape.multipartImageField.safeParse(legacyGift.multipartImageField);
    const jsonReferenceField = GiftImageSettings.shape.jsonReferenceField.safeParse(legacyGift.jsonReferenceField);
    return {
      ...profile,
      requestMode: requestMode.success ? requestMode.data : profile.requestMode,
      multipartImageField: multipartImageField.success ? multipartImageField.data : profile.multipartImageField,
      jsonReferenceField: jsonReferenceField.success ? jsonReferenceField.data : profile.jsonReferenceField,
    };
  });
  const activeApiProfileId = profileRouteId(rawRecord, 'activeApiProfileId', profiles[0].id);
  const drawingPresets = parseDrawingPresets(rawRecord);
  const currentDrawingPresetId = profileRouteId(rawRecord, 'currentDrawingPresetId', drawingPresets[0].id);
  const outputPresets = parseOutputPresets(rawRecord, legacyCurrentDrawingPresetNeedsProcessing(rawRecord));
  const currentOutputPresetId = profileRouteId(rawRecord, 'currentOutputPresetId', outputPresets[0].id);
  const recentImageLimit = normalizeRecentImageLimit(rawRecord.recentImageLimit);
  const legacyDisplayMigration = migrateLegacyGiftTrigger(
    rawRecord,
    legacyGift,
    parseDisplaySettings(rawRecord, legacyGift),
  );
  const displaySettings = legacyDisplayMigration.displaySettings;
  const enabled = hasExplicitDisplaySettings(rawRecord)
    ? typeof rawRecord.enabled === 'boolean'
      ? rawRecord.enabled
      : false
    : legacyDisplayMigration.disableAutomaticGeneration
      ? false
      : typeof rawRecord.enabled === 'boolean'
        ? rawRecord.enabled || (displaySettings.displayMode === 'gift' && legacyGift.enabled === true)
        : displaySettings.displayMode === 'gift' && legacyGift.enabled === true;

  const parsed = StoryImageSettingsSchema.safeParse({
    enabled,
    drawingPresets,
    currentDrawingPresetId,
    outputPresets,
    currentOutputPresetId,
    recentImageLimit,
    displaySettings,
    activeApiProfileId,
    apiProfiles: profiles,
    storyApiProfileId: profileRouteId(rawRecord, 'storyApiProfileId', activeApiProfileId),
    giftApiProfileId: profileRouteId(rawRecord, 'giftApiProfileId', activeApiProfileId),
  });
  const settings = parsed.success ? parsed.data : StoryImageSettingsSchema.parse({});
  repairApiProfileRouteIds(settings, activeApiProfileId);
  if (!settings.drawingPresets.some(preset => preset.id === settings.currentDrawingPresetId)) {
    settings.currentDrawingPresetId = settings.drawingPresets[0].id;
  }
  if (!settings.outputPresets.some(preset => preset.id === settings.currentOutputPresetId)) {
    settings.currentOutputPresetId = settings.outputPresets[0].id;
  }
  return settings;
}

export const useStoryImageSettingsStore = defineStore('story-image-settings', () => {
  const scriptVariableOption = { type: 'script' as const, script_id: getScriptId() };
  const raw = getVariables(scriptVariableOption);
  const settings = ref<StoryImageSettings>(parseStoryImageSettings(raw));

  watch(
    settings,
    nextSettings => {
      updateVariablesWith(variables => {
        const {
          inlinePrompt: _legacyInlinePrompt,
          mode: _legacyMode,
          basePrompt: _legacyBasePrompt,
          scenePrompt: _legacyScenePrompt,
          stylePrompt: _legacyStylePrompt,
          safetyPrompt: _legacySafetyPrompt,
          gift: _legacyGift,
          serviceUrl: _legacyServiceUrl,
          apiKey: _legacyApiKey,
          model: _legacyModel,
          imageSize: _legacyImageSize,
          timeoutMs: _legacyTimeoutMs,
          retryAttempts: _legacyRetryAttempts,
          retryDelayMs: _legacyRetryDelayMs,
          extraBody: _legacyExtraBody,
          ...rest
        } = variables;
        return { ...rest, ...klona(nextSettings) };
      }, scriptVariableOption);
    },
    { deep: true, immediate: true },
  );

  return { settings };
});
