import { processDrawingPrompt, processPrompt } from '../src/杠杠の生图机/prompt-processor';
import type { ImageOutputPreset } from '../src/杠杠の生图机/pipeline-types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

const defaultPreset: ImageOutputPreset = {
  id: 'default',
  name: '默认模板',
  templateText: '{{xx}}',
  useAvatarReferences: false,
};

const templatePreset: ImageOutputPreset = {
  id: 'template',
  name: '固定模板',
  templateText: '固定前缀：{{xx}}\n再次引用：{{xx}}\n固定后缀',
  useAvatarReferences: false,
};

const referencePreset: ImageOutputPreset = {
  id: 'references',
  name: '角色一致性',
  templateText: '角色约束：{{xx}}',
  useAvatarReferences: true,
};

const testDefaultTemplateWithoutReferences = async (): Promise<void> => {
  let readCount = 0;
  const originalPersonaReader = (globalThis as Record<string, unknown>).getPersonaAvatarPath;
  const originalCharacterReader = (globalThis as Record<string, unknown>).getCharacter;
  (globalThis as Record<string, unknown>).getPersonaAvatarPath = () => {
    readCount += 1;
    throw new Error('default template must not read persona');
  };
  (globalThis as Record<string, unknown>).getCharacter = async () => {
    readCount += 1;
    throw new Error('default template must not read character');
  };

  try {
    const prompt = '  原样 prompt\n\n';
    const result = await processDrawingPrompt(defaultPreset, prompt);
    equal(result, { prompt, processing: 'processed' }, '默认 {{xx}} 模板应保留 prompt 原文，但仍标记为已套用出图预设');
    equal(readCount, 0, 'useAvatarReferences=false 不得读取任何头像');

    const injectedResult = await processDrawingPrompt(defaultPreset, prompt, {
      readReferences: async () => {
        readCount += 1;
        throw new Error('injected reader must not run');
      },
    });
    equal(injectedResult, { prompt, processing: 'processed' }, '关闭头像引用时必须跳过注入的头像读取器');
    equal(readCount, 0, '关闭头像引用时跳过注入读取器');
  } finally {
    if (typeof originalPersonaReader === 'undefined')
      delete (globalThis as Record<string, unknown>).getPersonaAvatarPath;
    else (globalThis as Record<string, unknown>).getPersonaAvatarPath = originalPersonaReader;
    if (typeof originalCharacterReader === 'undefined') delete (globalThis as Record<string, unknown>).getCharacter;
    else (globalThis as Record<string, unknown>).getCharacter = originalCharacterReader;
  }
};

const testTemplateReplacement = async (): Promise<void> => {
  const result = await processDrawingPrompt(templatePreset, '场景 prompt');
  equal(
    result,
    {
      prompt: '固定前缀：场景 prompt\n再次引用：场景 prompt\n固定后缀',
      processing: 'processed',
    },
    '模板中的所有字面量 {{xx}} 都应替换为同一条解析 prompt',
  );

  const noPlaceholderPreset: ImageOutputPreset = {
    ...templatePreset,
    id: 'without-placeholder',
    templateText: '用户明确写下的完整模板',
  };
  const noPlaceholder = await processDrawingPrompt(noPlaceholderPreset, '不会被追加');
  equal(
    noPlaceholder,
    { prompt: '用户明确写下的完整模板', processing: 'processed' },
    '无占位符时必须按用户模板原样输出，不追加 prompt 或隐藏内容',
  );
};

const testProcessingWithReferences = async (): Promise<void> => {
  let readCount = 0;
  const result = await processDrawingPrompt(referencePreset, '场景 prompt', {
    readReferences: async () => {
      readCount += 1;
      return {
        references: [
          { source: 'persona', value: '/user/images/persona.png' },
          { source: 'character', value: '/characters/character.png' },
        ],
        failedSources: [],
      };
    },
  });
  equal(
    result,
    {
      prompt: '角色约束：场景 prompt',
      processing: 'processed',
      referenceImages: ['/user/images/persona.png', '/characters/character.png'],
    },
    '启用头像引用时应按 persona(User)=图1、character=图2 的顺序传递',
  );
  equal(readCount, 1, '一次加工只应读取一次头像');

  const reversed = await processPrompt('反向调用', defaultPreset, {
    readReferences: async () => {
      throw new Error('default preset should not read references');
    },
  });
  equal(reversed, { prompt: '反向调用', processing: 'processed' }, '兼容 prompt-first 调用顺序');
  assert(!('referenceImages' in reversed), '关闭头像引用时应省略 referenceImages 字段');
};

const testCurrentAvatarAdapter = async (): Promise<void> => {
  let personaArgument = '';
  let characterArgument = '';
  const originalPersonaReader = (globalThis as Record<string, unknown>).getPersonaAvatarPath;
  const originalCharacterReader = (globalThis as Record<string, unknown>).getCharacter;
  (globalThis as Record<string, unknown>).getPersonaAvatarPath = (id: string) => {
    personaArgument = id;
    return '/user/images/current-persona.png';
  };
  (globalThis as Record<string, unknown>).getCharacter = async (id: string) => {
    characterArgument = id;
    return { avatar: 'current-character.png' };
  };

  try {
    const { readCurrentAvatarReferences } = await import('../src/杠杠の生图机/avatar-references');
    const result = await readCurrentAvatarReferences();
    equal(personaArgument, 'current', 'persona 头像必须读取 current');
    equal(characterArgument, 'current', '角色卡必须读取 current');
    equal(
      result.references,
      [
        { source: 'persona', value: '/user/images/current-persona.png' },
        { source: 'character', value: '/characters/current-character.png' },
      ],
      '当前头像适配器应返回 persona 与角色卡头像路径',
    );
    equal(result.failedSources, [], '可用头像不应产生失败来源');
  } finally {
    if (typeof originalPersonaReader === 'undefined')
      delete (globalThis as Record<string, unknown>).getPersonaAvatarPath;
    else (globalThis as Record<string, unknown>).getPersonaAvatarPath = originalPersonaReader;
    if (typeof originalCharacterReader === 'undefined') delete (globalThis as Record<string, unknown>).getCharacter;
    else (globalThis as Record<string, unknown>).getCharacter = originalCharacterReader;
  }
};

testDefaultTemplateWithoutReferences()
  .then(testTemplateReplacement)
  .then(testProcessingWithReferences)
  .then(testCurrentAvatarAdapter)
  .then(() => console.info('<杠杠の生图机> story image processor tests passed'))
  .catch(error => {
    console.error(error);
    (globalThis as typeof globalThis & { process?: { exitCode?: number } }).process!.exitCode = 1;
  });
