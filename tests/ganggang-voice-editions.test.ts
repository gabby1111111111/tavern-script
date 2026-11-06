import { beginVoiceAudit, setVoiceAuditBuild, voiceAudit } from '../src/杠杠の配音台/audit';
import {
  CUSTOM_ONLY_VOICE_EDITION,
  VOICE_CONSOLE_VERSION,
  createRemoteCatalogVoiceEdition,
  getBuiltinSoundCatalog,
  loadEditionSoundCatalog,
  type BuiltinSoundCatalogCapability,
  type VoiceEdition,
} from '../src/杠杠の配音台/edition';
import { normalizeVoiceSettings } from '../src/杠杠の配音台/settings';
import { planSoundCues } from '../src/杠杠の配音台/sound-casting';
import type { SoundEffectEntry, SpokenSegment } from '../src/杠杠の配音台/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const customEffect: SoundEffectEntry = {
  id: 'custom-door',
  name: '自定义开门声',
  kind: 'sfx',
  category: '门',
  url: 'https://audio.example/custom-door.ogg',
  description: '木门缓慢推开',
  enabled: true,
  volume: 0.8,
};

async function main(): Promise<void> {
  let loadCalls = 0;
  const capability: BuiltinSoundCatalogCapability = {
    presentation: {
      title: '测试内置目录',
      loadLabel: '读取测试目录',
      loadingLabel: '读取中…',
      hints: ['仅用于版本隔离测试'],
    },
    load: async () => {
      loadCalls += 1;
      return {
        revision: 'a'.repeat(40),
        effects: [{ ...customEffect, id: 'remote-door' }],
        sfxCount: 1,
        ambienceCount: 0,
      };
    },
    isRemote: entry => entry.id === 'remote-door',
    isPinned: entry => entry.id === 'remote-door' && entry.url.includes('/custom-door.ogg'),
  };

  const forgedCustom = {
    ...CUSTOM_ONLY_VOICE_EDITION,
    builtinSoundCatalog: capability,
  } as unknown as VoiceEdition;
  assert(getBuiltinSoundCatalog(forgedCustom) === null, 'custom-only 必须忽略意外注入的内置目录 capability');
  const customSnapshot = await loadEditionSoundCatalog(forgedCustom);
  assert(customSnapshot === null, 'custom-only 读取目录应直接返回 null');
  assert(loadCalls === 0, 'custom-only 绝不能调用远程目录 loader');

  const remoteEdition = createRemoteCatalogVoiceEdition(capability);
  assert(remoteEdition.id === 'remote-catalog', '远程目录入口应得到 remote-catalog edition');
  assert(remoteEdition.version === VOICE_CONSOLE_VERSION, '两个 edition 必须共享同一个产品版本');
  const remoteSnapshot = await loadEditionSoundCatalog(remoteEdition);
  assert(remoteSnapshot?.effects.length === 1, 'remote-catalog 应调用注入的目录 loader');
  assert(Number(loadCalls) === 1, 'remote-catalog 每次显式读取只调用一次 loader');

  const normalized = normalizeVoiceSettings({
    edition: 'remote-catalog',
    version: '999.0.0',
    readingDefaults: { mode: 'full', includeSoundEffects: true, recentMessageCount: 10 },
    soundEffects: [customEffect],
  });
  assert(normalized.soundEffects.length === 1, '切换 edition 不得删除自定义音效设置');
  assert(!('edition' in normalized), 'edition 是构建能力，不得写入设置 schema');
  assert(!('version' in normalized), '产品版本不得写入设置 schema');

  setVoiceAuditBuild(remoteEdition.id, remoteEdition.version);
  beginVoiceAudit('edition-test');
  assert(voiceAudit.edition === 'remote-catalog', 'Audit 应暴露当前 edition');
  assert(voiceAudit.version === VOICE_CONSOLE_VERSION, '普通 Audit run 不得重置产品版本');
  setVoiceAuditBuild('custom-only', 'not-a-semver');
  assert(String(voiceAudit.version) === 'unknown', 'Audit 必须拒绝非版本格式，避免任意字符串进入验收对象');
  setVoiceAuditBuild(remoteEdition.id, remoteEdition.version);

  const segments: SpokenSegment[] = [
    {
      id: 'voice-1-0',
      kind: 'narration',
      text: '她推开木门。',
      characterName: null,
      sourceMessageId: 1,
    },
  ];
  let aiPayload = '';
  await planSoundCues({
    messageId: 1,
    message: '她推开木门。',
    segments,
    catalog: [customEffect],
    generate: async config => {
      aiPayload = JSON.stringify(config);
      return { cues: [] };
    },
  });
  assert(aiPayload.includes('custom-door'), 'custom-only 的 AI 目录应包含自定义音效元数据');
  assert(!aiPayload.includes(customEffect.url), '任何 edition 都不得把音频 URL 发给 AI');

  setVoiceAuditBuild(CUSTOM_ONLY_VOICE_EDITION.id, CUSTOM_ONLY_VOICE_EDITION.version);
}

void main();
