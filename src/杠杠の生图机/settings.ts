import { klona } from 'klona';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { z } from 'zod';

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

export const GiftImageSettings = z.object({
  enabled: z.boolean().default(false),
  triggerInterval: z.enum(['manual', '3', '5']).default('manual'),
  requestMode: z.enum(['auto', 'multipart-edit', 'chat-multimodal', 'json-reference']).default('auto'),
  jsonReferenceField: z.enum(['images', 'reference_images', 'image']).default('images'),
  identityPrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.identity.join('\n')),
  templatePrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.template.join('\n')),
  scenePrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.scene.join('\n')),
  stylePrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.style.join('\n')),
  outputPrompt: z.string().default(DEFAULT_GIFT_PROMPT_SECTIONS.output.join('\n')),
});

export type GiftSettings = z.infer<typeof GiftImageSettings>;

export function composeInlinePrompt(settings: Pick<StoryImageSettings, PromptSectionKey>): string {
  const sections = [settings.basePrompt, settings.scenePrompt, settings.stylePrompt, settings.safetyPrompt]
    .map(section => section.trim())
    .filter(Boolean);
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
  timeoutMs: 120_000,
  retryAttempts: 1,
  retryDelayMs: 1_500,
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
  timeoutMs: z.number().int().min(1000).max(900_000).default(120_000),
  retryAttempts: z.number().int().min(0).max(5).default(1),
  retryDelayMs: z.number().int().min(0).max(60_000).default(1_500),
  extraBody: z.record(z.string(), z.unknown()).default({}),
});

export type ImageApiProfile = z.infer<typeof ImageApiProfile>;

export const ImageSettings = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['inline', 'gift']).default('inline'),
    basePrompt: z.string().default(DEFAULT_PROMPT_SECTIONS.base.join('\n')),
    scenePrompt: z.string().default(DEFAULT_PROMPT_SECTIONS.scene.join('\n')),
    stylePrompt: z.string().default(DEFAULT_PROMPT_SECTIONS.style.join('\n')),
    safetyPrompt: z.string().default(DEFAULT_PROMPT_SECTIONS.safety.join('\n')),
    gift: GiftImageSettings.prefault({}),
    activeApiProfileId: z.string().default(DEFAULT_IMAGE_API_PROFILE_ID),
    apiProfiles: z.array(ImageApiProfile).min(1).default([DEFAULT_IMAGE_API_PROFILE]),
  })
  .prefault({});

export type StoryImageSettings = z.infer<typeof ImageSettings>;

export function getActiveApiProfile(settings: StoryImageSettings): ImageApiProfile {
  return settings.apiProfiles.find(profile => profile.id === settings.activeApiProfileId) ?? settings.apiProfiles[0];
}

const scriptVariableOption = { type: 'script' as const, script_id: getScriptId() };

export const useStoryImageSettingsStore = defineStore('story-image-settings', () => {
  const raw = getVariables(scriptVariableOption);
  const rawRecord = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const migratedRaw = Array.isArray(rawRecord.apiProfiles)
    ? rawRecord
    : {
        ...rawRecord,
        activeApiProfileId: DEFAULT_IMAGE_API_PROFILE_ID,
        apiProfiles: [
          {
            id: DEFAULT_IMAGE_API_PROFILE_ID,
            name: '默认配置',
            serviceUrl: rawRecord.serviceUrl,
            modelListUrl: '',
            apiKey: rawRecord.apiKey,
            model: rawRecord.model,
            imageSize: rawRecord.imageSize,
            timeoutMs: rawRecord.timeoutMs,
            retryAttempts: rawRecord.retryAttempts,
            retryDelayMs: rawRecord.retryDelayMs,
            extraBody: rawRecord.extraBody,
          },
        ],
      };
  const parsed = ImageSettings.safeParse(migratedRaw);
  const parsedSettings = parsed.success ? parsed.data : ImageSettings.parse({});
  if (!parsedSettings.apiProfiles.some(profile => profile.id === parsedSettings.activeApiProfileId)) {
    parsedSettings.activeApiProfileId = parsedSettings.apiProfiles[0].id;
  }
  const settings = ref<StoryImageSettings>(parsedSettings);

  if (
    typeof rawRecord.inlinePrompt === 'string' &&
    !('basePrompt' in rawRecord) &&
    rawRecord.inlinePrompt.trim() !== LEGACY_INLINE_PROMPT_DEFAULT
  ) {
    settings.value.basePrompt = rawRecord.inlinePrompt;
  }

  watch(
    settings,
    nextSettings => {
      updateVariablesWith(variables => {
        const {
          inlinePrompt: _legacyInlinePrompt,
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
