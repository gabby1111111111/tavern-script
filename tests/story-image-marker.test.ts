import {
  cleanInlineImageMessage,
  cleanInlineImageMarkers,
  extractInlineImagePrompts,
  scanInlineImagePrompts,
} from '../src/杠杠の生图机/marker';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const two = extractInlineImagePrompts('第一段\n\n<pic prompt="one &amp; moon">\n\n第二段 <pic prompt="two">结束');
equal(
  two.map(marker => marker.prompt),
  ['one & moon', 'two'],
  '两个标记按顺序解析',
);
equal(
  two.map(marker => marker.index),
  [0, 1],
  '标记 index 稳定',
);
assert(two[1].paragraphIndex === 2, '第二个标记应落在第二个正文段落之后');

const truncated = scanInlineImagePrompts('<pic prompt="one"><pic prompt="two"><pic prompt="three"><pic prompt="four">');
equal(truncated.markers.length, 2, '最多处理两个标记');
assert(truncated.truncated, '第三个及之后的有效标记应触发截断标记');
equal(truncated.totalValid, 4, '截断前有效标记数量应可审计');

const codeExample = scanInlineImagePrompts(
  '正文 `<pic prompt="fake">`\n\n```html\n<pic prompt="also fake">\n```\n\n<pic prompt="real">',
);
equal(
  codeExample.markers.map(marker => marker.prompt),
  ['real'],
  '代码块中的伪标记必须忽略',
);

const empty = scanInlineImagePrompts('<pic prompt=""> <pic prompt="  "> <pic prompt="valid">');
equal(
  empty.markers.map(marker => marker.prompt),
  ['valid'],
  '空提示词不能创建任务',
);

const cleaned = cleanInlineImageMarkers('前文 <pic prompt="one"> 后文 `<pic prompt="fake">`');
assert(cleaned.includes('前文  后文'), '显示层清理应移除有效标记');
assert(cleaned.includes('<pic prompt="fake">'), '代码中的伪标记不应被清理');

const cleanedMessage = cleanInlineImageMessage('<content>\n第一段剧情\n\n<pic prompt="one">\n第二段剧情\n</content>');
equal(cleanedMessage, '\n第一段剧情\n\n\n第二段剧情\n', '源数据清理应保留正文和原始换行');
assert(!/<\/?content\b|<pic\b/i.test(cleanedMessage), '源数据中不应残留控制标签');

console.info('<杠杠の生图机> marker tests passed');
