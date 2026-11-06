import { planSoundCues } from '../src/杠杠の配音台/sound-casting';
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

  // 配音台是纯自定义音效版：没有内置远程目录，音效目录就是用户自己配置的元数据。
  const catalogRun = beginSoundCatalogAudit();
  markSoundCatalog(catalogRun, 'success', catalog.length, catalog.length, 0);
  assert(voiceAudit.action === 'sound-catalog-load', '音效目录读取必须有独立 Audit action');
  assert(voiceAudit.sound_catalog.status === 'success', '音效目录成功状态必须可观察');
  assert(voiceAudit.sound_catalog.count === 1, 'Audit 只记录音效目录小型计数');
  const effectRun = beginSoundEffectAudit();
  markSoundEffect(effectRun, 'success');
  assert(voiceAudit.sound_effect.status === 'success', '行内音效开始播放后必须可观察');
}

void main();
