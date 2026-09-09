import {
  buildRegionRedrawInput,
  buildRegionRedrawRevision,
  buildWholeImageRedrawInput,
  commitManualRevisionFailure,
  createEmptyAudit,
  forceSingleImageCount,
} from '../src/杠杠の生图机/runtime';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const region = { x: -0.1, y: 0.23456, width: 1.2, height: 0.5 };
const input = buildRegionRedrawInput('source-image', 'marked-image', 'change detail', region);
assert(input.referenceImages?.length === 2, '区域重绘必须恰好发送两张参考图');
assert(input.referenceImages[0] === 'source-image', '图1必须是当前原图');
assert(input.referenceImages[1] === 'marked-image', '图2必须是用户标记图');
assert(!input.referenceImages.includes('user-avatar'), '区域重绘不得追加 User 头像');
assert(!input.referenceImages.includes('character-avatar'), '区域重绘不得追加角色头像');
assert(input.prompt.includes('x=0, y=0.2346, width=1, height=0.5'), '提示词应包含钳制后的归一化坐标');
assert(input.prompt.includes('change detail'), '提示词应包含本次临时修改描述');
assert(input.prompt.includes('洋红高亮仅用于指示修改位置'), '提示词必须说明洋红标记不是输出内容');
assert(input.prompt.includes('重新生成一张完整新图'), '提示词必须诚实说明这是整图重新生成');
assert(!input.prompt.includes('仅重绘') && !input.prompt.includes('必须保持'), '不得伪装为像素锁定的真实 inpainting');

const wholeImageInput = buildWholeImageRedrawInput('source-image', '  change the whole image  ');
assert(wholeImageInput.prompt === 'change the whole image', '无需画笔模式应只提交当前修改提示词');
assert(wholeImageInput.referenceImages?.length === 1, '无需画笔模式必须只发送当前生成图');
assert(wholeImageInput.referenceImages[0] === 'source-image', '无需画笔模式的唯一参考图必须是当前生成图');

const revision = buildRegionRedrawRevision(
  'source-image',
  'marked-image',
  'original prompt',
  'temporary detail',
  region,
);
assert(revision.storedPrompt === 'original prompt', '区域重绘新版本应保留来源提示词');
assert(!revision.storedPrompt.includes('temporary detail'), '临时描述不得写入正文 placement 提示词');

const audit = createEmptyAudit();
audit.generation = { id: 'new-region-request', status: 'running' };
let committed = false;
assert(
  !commitManualRevisionFailure(audit, 'old-region-request', () => {
    committed = true;
  }),
  '旧区域重绘失败不得污染新的 generation 状态',
);
assert(!committed && audit.generation.status === 'running', '旧请求不得提交全局错误');

const regionProfile = { imageCount: 4 };
const requestProfile = forceSingleImageCount(regionProfile);
assert(requestProfile.imageCount === 1, '区域重绘必须固定只请求一张图');

console.info('<杠杠の生图机> region redraw runtime tests passed');
