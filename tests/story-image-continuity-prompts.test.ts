import assert from 'node:assert/strict';
import {
  applyDrawingPromptTemplate,
  applyOutputPromptTemplate,
  describeReferenceSources,
  processDrawingPrompt,
} from '../src/杠杠の生图机/prompt-processor';
import {
  createOutputPreset,
  normalizeOutputPreset,
  CONTINUOUS_STORY_OUTPUT_EXAMPLE,
} from '../src/杠杠の生图机/output-preset';
import {
  buildPromptEditorFinalPrompt,
  buildPromptEditorReferenceCandidates,
  canConfirmPromptEditorFinalPrompt,
  describePromptEditorReferenceSelection,
  getPromptEditorFocusableElements,
  selectPromptEditorReferenceSources,
} from '../src/杠杠の生图机/prompt-editor';

async function run(): Promise<void> {
  const referenceSources = [
    { kind: 'user-avatar' as const, label: 'User 头像', value: 'user' },
    { kind: 'character-avatar' as const, label: '角色头像', value: 'character' },
    { kind: 'previous-story-image' as const, label: '上一镜头参考图', value: 'previous' },
  ];
  assert.deepEqual(
    selectPromptEditorReferenceSources(referenceSources, {
      known: true,
      useAvatarReferences: false,
      usePreviousStoryImage: true,
    }).map(source => source.kind),
    ['previous-story-image'],
    '编辑器关闭头像后只保留上一镜头图参考',
  );
  assert(
    describePromptEditorReferenceSelection([], {
      known: false,
      useAvatarReferences: false,
      usePreviousStoryImage: false,
    }).includes('原参考记录不可用'),
    '没有实际参考记录时必须明确提示用户选择',
  );
  assert(canConfirmPromptEditorFinalPrompt('expanded prompt'), '非空最终提示词允许确认');
  assert(!canConfirmPromptEditorFinalPrompt('  '), '清空最终提示词后禁止确认');
  assert.deepEqual(
    buildPromptEditorReferenceCandidates(['previous-story-image'], {
      avatarReferences: true,
      previousStoryImage: true,
    }).map(source => [source.kind, source.value]),
    [
      ['user-avatar', ''],
      ['character-avatar', ''],
      ['previous-story-image', ''],
    ],
    '编辑器打开前只创建参考来源标签，不读取图片内容',
  );
  const focusable = getPromptEditorFocusableElements([
    { hidden: false, getAttribute: () => null, closest: () => null } as unknown as HTMLElement,
    { hidden: false, disabled: true, getAttribute: () => null, closest: () => null } as unknown as HTMLElement,
    { hidden: true, getAttribute: () => null, closest: () => null } as unknown as HTMLElement,
  ]);
  assert.equal(focusable.length, 1, '焦点循环应跳过 disabled 与 hidden 控件');
  assert.equal(applyOutputPromptTemplate('{{xx}}|{{xx_pic}}', '{{xx_pic}}$&', '{{xx}}$&'), '{{xx_pic}}$&|{{xx}}$&');
  assert.equal(applyDrawingPromptTemplate('{{xx_pic}}|{{xx}}', '{{xx_pic}}'), '{{xx_pic}}|{{xx}}');
  assert.equal(applyOutputPromptTemplate('fixed', 'shot', 'old'), 'fixed');
  assert.equal(applyOutputPromptTemplate('{{xx_pic}}', 'shot'), 'null');
  assert.equal(
    applyOutputPromptTemplate('{{xx}}|{{xx_pic}}|{{reference_sources}}', ' \n', '\t', []),
    'null|null|null',
  );
  assert.equal(
    applyOutputPromptTemplate(
      '{{xx}}|{{xx_pic}}|{{reference_sources}}',
      '  shot  ',
      '  previous  ',
      [{ kind: 'user-avatar', label: 'User 头像', value: 'user' }],
    ),
    '  shot  |  previous  |图1：User 头像',
  );
  assert.equal(applyOutputPromptTemplate('{{xx}}', 'nested {{xx_pic}}'), 'nested {{xx_pic}}');
  assert.equal(applyDrawingPromptTemplate('{{xx_pic}}|{{xx}}', ''), 'null|{{xx}}');
  assert.equal(applyDrawingPromptTemplate('{{xx_pic}}', '  previous  '), '  previous  ');
  assert.equal(describeReferenceSources([]), '', '空来源的描述仍保持 UI 原语义');
  assert.equal(normalizeOutputPreset({ id: 'old' })?.usePreviousStoryImage, false);
  for (const avatars of [false, true])
    for (const previous of [false, true]) {
      let reads = 0;
      const result = await processDrawingPrompt(
        createOutputPreset({
          ...CONTINUOUS_STORY_OUTPUT_EXAMPLE,
          useAvatarReferences: avatars,
          usePreviousStoryImage: previous,
        }),
        'current',
        {
          previousShotPrompt: 'old',
          previousStoryImage: 'previous',
          readReferences: async () => {
            reads++;
            return {
              references: [
                { source: 'character', value: 'character' },
                { source: 'persona', value: 'user' },
              ],
              failedSources: [],
            };
          },
        },
      );
      const expected = [...(avatars ? ['user', 'character'] : []), ...(previous ? ['previous'] : [])];
      assert.deepEqual(result.referenceImages, expected.length ? expected : undefined);
      assert.equal(reads, avatars ? 1 : 0);
      assert.equal(
        buildPromptEditorFinalPrompt(
          CONTINUOUS_STORY_OUTPUT_EXAMPLE.templateText,
          'current',
          'old',
          result.referenceSources,
        ),
        result.prompt,
      );
    }
  const missing = await processDrawingPrompt(createOutputPreset({ ...CONTINUOUS_STORY_OUTPUT_EXAMPLE }), 'current', {
    previousStoryImage: 'previous',
    readReferences: async () => ({
      references: [{ source: 'character', value: 'character' }],
      failedSources: ['persona'],
    }),
  });
  assert.deepEqual(missing.referenceImages, ['character', 'previous']);
  assert.ok(missing.prompt.includes('图1：角色头像\n图2：上一镜头参考图'));
  const failed = await processDrawingPrompt(createOutputPreset(CONTINUOUS_STORY_OUTPUT_EXAMPLE), 'current', {
    previousStoryImage: 'previous',
    readReferences: async () => {
      throw new Error('unavailable');
    },
  });
  assert.deepEqual(failed.referenceImages, ['previous']);
  assert.ok(failed.prompt.includes('图1：上一镜头参考图'));
  const empty = await processDrawingPrompt(createOutputPreset(CONTINUOUS_STORY_OUTPUT_EXAMPLE), 'current', {
    readReferences: async () => ({ references: [], failedSources: [] }),
  });
  assert.equal(empty.referenceImages, undefined);
  assert.equal(empty.referenceSources, undefined);
  console.info('story-image continuity prompt tests passed');
}
void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
