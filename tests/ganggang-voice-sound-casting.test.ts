import { planSoundCues } from '../src/杠杠の配音台/sound-casting';
import {
  isStAudioAssetsPinnedSound,
  isStAudioAssetsRemoteSound,
  loadDefaultSoundCatalog,
  ST_AUDIO_ASSETS_REVISION,
} from '../src/杠杠の配音台-内置远程音效库/sound-catalog';
import {
  beginSoundCatalogAudit,
  beginSoundEffectAudit,
  markSoundCatalog,
  markSoundEffect,
  voiceAudit,
} from '../src/杠杠の配音台/audit';
import type { SoundEffectEntry, SpokenSegment } from '../src/杠杠の配音台/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const catalog: SoundEffectEntry[] = [
  {
    id: 'door-open',
    name: '开门声',
    category: '门',
    url: 'https://audio.example/door.mp3',
    description: '木门被推开',
    enabled: true,
    volume: 0.8,
  },
];

async function main(): Promise<void> {
  const spokenSegments: SpokenSegment[] = [
    {
      id: 'voice-7-0',
      kind: 'narration',
      text: '她推开木门，朝屋里看了一眼。',
      characterName: null,
      sourceMessageId: 7,
    },
  ];
  const capturedConfigs: Array<Record<string, unknown>> = [];
  const cues = await planSoundCues({
    messageId: 7,
    message: '她推开木门，朝屋里看了一眼。',
    segments: spokenSegments,
    catalog,
    generate: async config => {
      capturedConfigs.push(config);
      return JSON.stringify({
        cues: [
          {
            effectId: 'door-open',
            sourceSegmentId: 'voice-7-0',
            anchorText: '推开木门',
            anchorOccurrence: 0,
            placement: 'after',
          },
        ],
      });
    },
  });

  assert(capturedConfigs[0]?.should_silence === true, '音效标注应使用静默生成');
  assert(!JSON.stringify(capturedConfigs[0]).includes('https://audio.example'), '发给 AI 的音效目录不得包含音频 URL');
  assert(cues.length === 1, '合法音效标记应被接受');
  assert(cues[0].sourceMessageId === 7, '音效标记应绑定来源楼层');
  assert(cues[0].sourceSegmentId === 'voice-7-0', '音效标记应绑定解析后的语音段');
  assert(cues[0].anchorOccurrence === 0, '音效标记应保留段内锚点序号');

  const invalidAnchor = await planSoundCues({
    messageId: 8,
    message: '房间里很安静。',
    segments: [
      {
        id: 'voice-8-0',
        kind: 'narration',
        text: '房间里很安静。',
        characterName: null,
        sourceMessageId: 8,
      },
    ],
    catalog,
    generate: async () =>
      JSON.stringify({
        cues: [
          {
            effectId: 'door-open',
            sourceSegmentId: 'voice-8-0',
            anchorText: '推开木门',
            anchorOccurrence: 0,
            placement: 'after',
          },
        ],
      }),
  });
  assert(invalidAnchor.length === 0, '不在原文中的 anchorText 必须被拒绝');

  const requestedUrls: string[] = [];
  const snapshot = await loadDefaultSoundCatalog({
    fetchImpl: async input => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            { type: 'blob', path: 'SFX/门/敲门-1.ogg' },
            { type: 'blob', path: 'Ambience/风声/风_正常.ogg' },
            { type: 'blob', path: 'SFX/../越界.ogg' },
            { type: 'blob', path: 'README.md' },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert(requestedUrls.length === 1, '内置远程目录只能请求发行时固定的 tree');
  assert(!requestedUrls[0].includes('/branches/'), '内置远程目录不得追踪可变分支');
  assert(requestedUrls[0].includes(ST_AUDIO_ASSETS_REVISION), '目录请求必须锁定发行时固定的 commit');
  assert(snapshot.revision === ST_AUDIO_ASSETS_REVISION, '目录快照必须报告发行时固定的 commit');
  assert(snapshot.effects.length === 2, '目录只应接纳 SFX/Ambience 下的 OGG 文件');
  assert(snapshot.sfxCount === 1 && snapshot.ambienceCount === 1, '目录应分别统计短音效和环境音');
  assert(
    snapshot.effects.some(effect => effect.kind === 'sfx') &&
      snapshot.effects.some(effect => effect.kind === 'ambience'),
    '远程目录必须显式标记短音效与环境音，不能靠显示分类猜测',
  );
  assert(
    snapshot.effects.every(effect => effect.url.includes(ST_AUDIO_ASSETS_REVISION)),
    '播放 URL 必须使用不可变 commit',
  );
  assert(snapshot.effects.every(isStAudioAssetsRemoteSound), '远程目录条目必须能被 Edition 识别为远程音效');
  assert(snapshot.effects.every(isStAudioAssetsPinnedSound), '远程目录条目必须全部锁定到 Edition 的固定 commit');
  assert(
    snapshot.effects.every(effect => effect.id.length <= 40),
    '远程音效应使用短且稳定的 id',
  );
  assert(!JSON.stringify(snapshot.effects).includes('..'), '目录必须拒绝路径穿越条目');

  const catalogRun = beginSoundCatalogAudit();
  markSoundCatalog(catalogRun, 'success', snapshot.effects.length, snapshot.sfxCount, snapshot.ambienceCount);
  assert(voiceAudit.action === 'sound-catalog-load', '音效目录读取必须有独立 Audit action');
  assert(voiceAudit.sound_catalog.status === 'success', '音效目录成功状态必须可观察');
  assert(voiceAudit.sound_catalog.count === 2, 'Audit 只记录音效目录小型计数');
  const effectRun = beginSoundEffectAudit();
  markSoundEffect(effectRun, 'success');
  assert(voiceAudit.sound_effect.status === 'success', '行内音效开始播放后必须可观察');
}

void main();
