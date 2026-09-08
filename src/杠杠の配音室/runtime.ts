import { ref, watch } from 'vue';
import {
  beginAiCastingAudit,
  beginSoundCatalogAudit,
  beginSoundEffectAudit,
  beginVoiceAudit,
  beginVoiceCleanupAudit,
  markAudioPlayed,
  markAiCasting,
  markContentExtracted,
  markPlaybackTimelineBuilt,
  markPlaybackTimelineComplete,
  markPlaybackTimelineStep,
  markProviderFailed,
  markProviderReady,
  markRecentCount,
  markRouteBuilt,
  markSoundCatalog,
  markSoundEffect,
  markVoiceCleanup,
  markVoiceAuditError,
  setVoiceAuditBuild,
} from './audit';
import { createCastingGenerationId, generateCastingTable, isStaleCastingInputError, stopCasting } from './casting';
import { createCastingInputSignature, readCurrentCastingContext } from './context';
import {
  CUSTOM_ONLY_VOICE_EDITION,
  getBuiltinSoundCatalog,
  loadEditionSoundCatalog,
  type VoiceEdition,
} from './edition';
import { bindVoiceLifecycleEvents } from './lifecycle-events';
import { MessageControlManager } from './message-controls';
import { createRecentVoiceStore } from './playback';
import { mapSelectionToSegments, routeSpokenSegments, voiceRouteKey } from './reading';
import { buildReadingTimeline } from './reading-timeline';
import { loadVoiceSettings, normalizeProviderProfile, updateVoiceSettings } from './settings';
import { planSoundCues } from './sound-casting';
import { SoundEffectPlayer } from './sound-effects';
import { createProviderRegistry } from './tts/providers';
import { parseSpokenSegments } from './tts/text';
import { getStaticVoiceCatalog } from './tts/voice-catalog';
import type {
  RecentVoiceItem,
  RoutedSegment,
  SoundCue,
  SoundEffectEntry,
  SpokenSegment,
  TtsProviderKind,
  TtsProviderProfile,
  VoiceCleanupReason,
  VoiceOption,
  VoiceRef,
  VoiceSettingsData,
} from './types';

type RecentRequest = {
  text: string;
  characterName: string | null;
  voice: VoiceRef;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredVoice(profile: TtsProviderProfile): VoiceOption[] {
  if (!profile.defaultVoiceId.trim()) return [];
  return [
    {
      providerProfileId: profile.id,
      voiceId: profile.defaultVoiceId,
      name: profile.defaultVoiceId,
      description: `${profile.name} 当前配置的默认音色`,
    },
  ];
}

function uniqueVoices(voices: VoiceOption[]): VoiceOption[] {
  const seen = new Set<string>();
  return voices.filter(voice => {
    const key = `${voice.providerProfileId}\u0000${voice.voiceId}`;
    if (!voice.providerProfileId || !voice.voiceId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentMessage(messageId: number) {
  return getChatMessages(messageId, { include_swipes: false })[0] ?? null;
}

function defaultVoice(settings: VoiceSettingsData): VoiceRef | null {
  const profile = settings.profiles.find(item => item.enabled && item.defaultVoiceId.trim());
  return profile ? { providerProfileId: profile.id, voiceId: profile.defaultVoiceId } : null;
}

export function createVoiceRuntime(edition: VoiceEdition = CUSTOM_ONLY_VOICE_EDITION) {
  const builtinSoundCatalog = getBuiltinSoundCatalog(edition);
  const builtinSoundCatalogPresentation = builtinSoundCatalog?.presentation ?? null;
  setVoiceAuditBuild(edition.id, edition.version);
  const settings = ref(loadVoiceSettings());
  const voices = ref<VoiceOption[]>([]);
  const recentVoices = ref<RecentVoiceItem[]>([]);
  const status = ref('等待朗读');
  const error = ref('');
  const providerBusy = ref(false);
  const castingBusy = ref(false);
  const soundCatalogBusy = ref(false);
  const soundCatalogCount = ref(0);
  const soundCatalogSfxCount = ref(0);
  const soundCatalogAmbienceCount = ref(0);
  const soundCatalogRevision = ref('');
  const currentCharacterKey = ref('character:unknown');
  const currentCharacterName = ref('');
  const registry = createProviderRegistry({ getSillyTavernHeaders: () => SillyTavern.getRequestHeaders() });
  const recentStore = createRecentVoiceStore();
  const soundPlayer = new SoundEffectPlayer(settings.value.soundEffects);
  const soundCues = new Map<number, SoundCue[]>();
  const plannedSoundMessages = new Set<number>();
  const recentRequests = new Map<string, RecentRequest>();
  const inlineRecentItems = new Map<string, string>();
  const discoveredVoices = new Map<string, { type: TtsProviderKind; voices: VoiceOption[] }>();
  const listeners: EventOnReturn[] = [];
  let settingsTimer: number | null = null;
  let providerController: AbortController | null = null;
  let soundCatalogController: AbortController | null = null;
  let activeCastingGenerationId: string | null = null;
  let activeSoundGenerationId: string | null = null;
  let readingSequence = 0;
  let lifecycleEpoch = 0;
  let soundPlanSequence = 0;
  let stopped = false;
  let soundCatalogSignature = JSON.stringify(settings.value.soundEffects);
  let builtinSoundEffects: SoundEffectEntry[] = [];

  function currentSoundCatalog(): SoundEffectEntry[] {
    const entries = new Map(builtinSoundEffects.map(effect => [effect.id, effect]));
    settings.value.soundEffects.forEach(effect => entries.set(effect.id, effect));
    return [...entries.values()];
  }

  const stopRecentSubscription = recentStore.subscribe(items => {
    recentVoices.value = [...items];
    const retained = new Set(items.map(item => item.id));
    recentRequests.forEach((_request, id) => {
      if (!retained.has(id)) recentRequests.delete(id);
    });
    inlineRecentItems.forEach((id, key) => {
      if (!retained.has(id)) inlineRecentItems.delete(key);
    });
    markRecentCount(items.length);
    messageControls.renderAll();
  });

  function refreshCharacter(): void {
    if (stopped) return;
    try {
      const context = readCurrentCastingContext(1);
      currentCharacterKey.value = context.characterKey;
      currentCharacterName.value = context.characterName;
    } catch (caught) {
      currentCharacterKey.value = 'character:unknown';
      currentCharacterName.value = getCurrentCharacterName() ?? '';
      error.value = errorMessage(caught);
    }
  }

  function refreshKnownVoices(): void {
    voices.value = uniqueVoices(
      settings.value.profiles.flatMap(profile => {
        const discovered = discoveredVoices.get(profile.id);
        return [
          ...getStaticVoiceCatalog(profile),
          ...(discovered?.type === profile.type ? discovered.voices : []),
          ...configuredVoice(profile),
        ];
      }),
    );
  }

  function persistSettings(): void {
    if (settingsTimer !== null) {
      window.clearTimeout(settingsTimer);
      settingsTimer = null;
    }
    updateVoiceSettings(() => settings.value);
    soundPlayer.setCatalog(currentSoundCatalog());
  }

  function scheduleSettingsSave(): void {
    if (stopped) return;
    if (settingsTimer !== null) window.clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(persistSettings, 350);
  }

  const stopSettingsWatch = watch(
    settings,
    () => {
      refreshKnownVoices();
      soundPlayer.setCatalog(currentSoundCatalog());
      const nextSoundCatalogSignature = JSON.stringify(settings.value.soundEffects);
      if (nextSoundCatalogSignature !== soundCatalogSignature) {
        soundCatalogSignature = nextSoundCatalogSignature;
        soundCues.clear();
        plannedSoundMessages.clear();
        messageControls.renderAll();
      }
      scheduleSettingsSave();
    },
    { deep: true },
  );

  async function probeAndLoadVoices(profileId: string): Promise<void> {
    stopReadingSequence();
    providerController?.abort();
    const profile = settings.value.profiles.find(item => item.id === profileId);
    if (!profile) return;
    const runId = beginVoiceAudit('provider-probe');
    markContentExtracted(runId, 0);
    markRouteBuilt(runId, 0);
    providerBusy.value = true;
    error.value = '';
    status.value = `正在检查 ${profile.name}…`;
    const controller = new AbortController();
    providerController = controller;
    try {
      const probeResult = await registry.probe(profile, controller.signal);
      const discovered = await registry.listVoices(profile, controller.signal);
      if (controller.signal.aborted || providerController !== controller) return;
      discoveredVoices.set(profile.id, { type: profile.type, voices: discovered });
      refreshKnownVoices();
      const networkVerified = probeResult.unverified !== true;
      markProviderReady(runId, profile.id, networkVerified);
      status.value = networkVerified
        ? `${profile.name} 连接检查通过，读取到 ${discovered.length} 个音色`
        : `${profile.name} 配置检查通过（未联网验证），读取到 ${discovered.length} 个音色`;
    } catch (caught) {
      if (controller.signal.aborted) return;
      markProviderFailed(runId, profile.id);
      error.value = errorMessage(caught);
      status.value = 'TTS 来源检查失败';
      markVoiceAuditError(runId, caught);
    } finally {
      if (providerController === controller) {
        providerController = null;
        providerBusy.value = false;
      }
    }
  }

  function addProfile(type: TtsProviderKind): void {
    const id = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name: Record<TtsProviderKind, string> = {
      edge: 'Edge TTS',
      'openai-compatible': 'OpenAI 兼容 TTS',
      doubao: '豆包 TTS',
      minimax: 'MiniMax TTS',
      'xiaomi-mimo': '小米 MiMo TTS',
    };
    settings.value.profiles.push(normalizeProviderProfile({ id, name: name[type], type, enabled: true }, id));
  }

  function removeProfile(profileId: string): void {
    if (settings.value.profiles.length <= 1) {
      error.value = '至少保留一个 TTS 来源。';
      return;
    }
    settings.value.profiles = settings.value.profiles.filter(profile => profile.id !== profileId);
    discoveredVoices.delete(profileId);
    refreshKnownVoices();
  }

  async function generateCasting(): Promise<void> {
    if (castingBusy.value) return;
    stopReadingSequence();
    castingBusy.value = true;
    error.value = '';
    status.value = 'AI 正在阅读角色与音色目录…';
    const generationId = createCastingGenerationId();
    const auditRunId = beginAiCastingAudit(generationId);
    activeCastingGenerationId = generationId;
    try {
      const captureInput = () => {
        const recentMessageCount = settings.value.readingDefaults.recentMessageCount;
        const context = readCurrentCastingContext(recentMessageCount);
        const enabledProfiles = settings.value.profiles
          .filter(profile => profile.enabled)
          .map(profile => ({ id: profile.id, type: profile.type }));
        const enabledIds = new Set(enabledProfiles.map(profile => profile.id));
        const castingVoices = voices.value.filter(voice => enabledIds.has(voice.providerProfileId));
        return {
          context,
          castingVoices,
          signature: createCastingInputSignature(context, castingVoices, recentMessageCount, enabledProfiles),
        };
      };
      const input = captureInput();
      currentCharacterKey.value = input.context.characterKey;
      currentCharacterName.value = input.context.characterName;
      const table = await generateCastingTable({
        context: input.context,
        voices: input.castingVoices,
        generationId,
        isInputCurrent: () => captureInput().signature === input.signature,
      });
      if (activeCastingGenerationId !== generationId) return;
      settings.value.castingByCharacter = { ...settings.value.castingByCharacter, [table.characterKey]: table };
      persistSettings();
      markAiCasting(auditRunId, 'success', table.entries.length);
      status.value = `已为 ${table.entries.length} 个主要角色分配音色`;
    } catch (caught) {
      if (activeCastingGenerationId !== generationId) return;
      if (isStaleCastingInputError(caught)) {
        markAiCasting(auditRunId, 'cancelled');
        error.value = '';
        status.value = '生成期间角色或音色输入已变化，本次配音表已丢弃，请重新生成';
        return;
      }
      markAiCasting(auditRunId, 'fail');
      error.value = errorMessage(caught);
      status.value = 'AI 配音表生成失败';
    } finally {
      if (activeCastingGenerationId === generationId) {
        activeCastingGenerationId = null;
        castingBusy.value = false;
      }
    }
  }

  function routeSegments(segments: SpokenSegment[], mode = settings.value.readingDefaults.mode): RoutedSegment[] {
    return routeSpokenSegments(segments, {
      mode,
      casting: settings.value.castingByCharacter[currentCharacterKey.value] ?? null,
      singleVoice: settings.value.readingDefaults.singleVoice,
      fallbackVoice: defaultVoice(settings.value),
      characterName: settings.value.readingDefaults.characterName,
    });
  }

  function inlineSegmentKey(segment: RoutedSegment): string {
    const profile = settings.value.profiles.find(item => item.id === segment.voice.providerProfileId);
    const profileSignature = profile
      ? JSON.stringify({
          type: profile.type,
          endpoint: profile.endpoint,
          model: profile.model,
          resourceId: profile.resourceId,
          responseFormat: profile.responseFormat,
          platform: profile.platform,
          style: profile.style,
          edgeRate: profile.edgeRate,
          extraBody: profile.extraBody,
        })
      : 'missing-profile';
    return [segment.sourceMessageId ?? 'none', segment.id, voiceRouteKey(segment), profileSignature].join('::');
  }

  function clearInlineMessage(messageId: number): void {
    const prefix = `${messageId}::`;
    inlineRecentItems.forEach((_itemId, key) => {
      if (key.startsWith(prefix)) inlineRecentItems.delete(key);
    });
  }

  async function prepareSegment(segment: RoutedSegment, runId: number, sequence: number): Promise<RecentVoiceItem> {
    const profile = settings.value.profiles.find(item => item.id === segment.voice.providerProfileId && item.enabled);
    if (!profile) throw new Error('配音表引用的 TTS 来源不存在或已禁用');
    const generation = recentStore.beginGeneration({
      textPreview: segment.text,
      characterName: segment.characterName,
      voice: segment.voice,
    });
    recentRequests.set(generation.item.id, {
      text: segment.text,
      characterName: segment.characterName,
      voice: { ...segment.voice },
    });
    inlineRecentItems.set(inlineSegmentKey(segment), generation.item.id);
    try {
      const audio = await registry.synthesize(profile, {
        text: segment.text,
        voice: segment.voice,
        signal: generation.signal,
        contextText: segment.voice.emotion
          ? `${segment.characterName ?? '旁白'}，情绪：${segment.voice.emotion}`
          : (segment.characterName ?? undefined),
      });
      if (sequence !== readingSequence || generation.signal.aborted) {
        recentStore.markCancelled(generation.item.id);
      } else {
        markProviderReady(runId, profile.id, true);
        recentStore.markReady(generation.item.id, audio);
      }
    } catch (caught) {
      if (generation.signal.aborted || sequence !== readingSequence) recentStore.markCancelled(generation.item.id);
      else {
        markProviderFailed(runId, profile.id);
        recentStore.markFailed(generation.item.id, caught);
      }
    }
    return recentStore.get(generation.item.id) ?? generation.item;
  }

  function waitForPlaybackEnd(itemId: string, sequence: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const current = recentStore.get(itemId);
      if (sequence !== readingSequence || !current || !['playing', 'paused'].includes(current.status)) {
        if (current?.status === 'failed') reject(new Error(current.error ?? '音频播放失败'));
        else resolve();
        return;
      }
      const stop = recentStore.subscribe(items => {
        const item = items.find(candidate => candidate.id === itemId);
        if (item?.status === 'failed') {
          stop();
          reject(new Error(item.error ?? '音频播放失败'));
          return;
        }
        if (sequence !== readingSequence || !item || !['playing', 'paused'].includes(item.status)) {
          stop();
          resolve();
        }
      });
    });
  }

  function stopReadingSequence(): void {
    readingSequence += 1;
    recentStore.stop();
    soundPlayer.stop();
    recentStore
      .snapshot()
      .filter(item => item.status === 'generating')
      .forEach(item => recentStore.cancelGeneration(item.id));
  }

  async function playRoutedSegments(
    segments: RoutedSegment[],
    action: string,
    soundOptions: { cues?: readonly SoundCue[]; catalog?: readonly SoundEffectEntry[] } = {},
  ): Promise<void> {
    stopReadingSequence();
    const sequence = readingSequence;
    const runId = beginVoiceAudit(action);
    markContentExtracted(runId, segments.length);
    if (segments.length === 0) {
      const caught = new Error('没有符合当前朗读方式的文本');
      markVoiceAuditError(runId, caught);
      error.value = caught.message;
      return;
    }

    const catalog = [...(soundOptions.catalog ?? [])];
    const eligibleEffectIds = new Set(catalog.filter(effect => effect.kind !== 'ambience').map(effect => effect.id));
    const timeline = buildReadingTimeline(segments, soundOptions.cues ?? [], { eligibleEffectIds });
    markRouteBuilt(runId, timeline.speechCount);
    const timelineEffects = timeline.items.flatMap(item => {
      if (item.kind !== 'sound') return [];
      const effect = catalog.find(candidate => candidate.id === item.cue.effectId);
      return effect ? [effect] : [];
    });
    const remoteSoundCount = builtinSoundCatalog
      ? timelineEffects.filter(effect => builtinSoundCatalog.isRemote(effect)).length
      : 0;
    markPlaybackTimelineBuilt(runId, {
      speechCount: timeline.speechCount,
      soundCount: timeline.soundCount,
      ignoredSoundCount: timeline.ignoredCueCount,
      remoteSoundCount,
      pinnedRemoteSoundCount: builtinSoundCatalog
        ? timelineEffects.filter(effect => builtinSoundCatalog.isPinned(effect)).length
        : 0,
    });

    error.value = '';
    status.value =
      timeline.soundCount > 0
        ? `准备 ${timeline.speechCount} 段语音和 ${timeline.soundCount} 个音效…`
        : `准备 ${timeline.speechCount} 段语音…`;
    try {
      const speechSegments = timeline.items.flatMap(item => (item.kind === 'speech' ? [item.segment] : []));
      let speechIndex = 0;
      let prepared = speechSegments[0] ? prepareSegment(speechSegments[0], runId, sequence) : null;
      for (let index = 0; index < timeline.items.length && sequence === readingSequence; index += 1) {
        const timelineItem = timeline.items[index];
        markPlaybackTimelineStep(runId, timelineItem.kind, 'start');
        if (timelineItem.kind === 'sound') {
          const played = await soundPlayer.playCueToEnd(timelineItem.cue, catalog);
          if (sequence !== readingSequence) return;
          markPlaybackTimelineStep(runId, 'sound', played.outcome === 'ended' ? 'end' : 'skip');
          status.value =
            played.outcome === 'ended'
              ? `音效已完成，继续播放 ${index + 1}/${timeline.items.length}`
              : `音效未能完成，已跳过并继续 ${index + 1}/${timeline.items.length}`;
          continue;
        }

        if (!prepared) throw new Error('语音准备队列丢失');
        const item = await prepared;
        if (sequence !== readingSequence) return;
        if (item.status !== 'ready') throw new Error(item.error ?? '语音生成失败');
        speechIndex += 1;
        const nextSpeech = speechSegments[speechIndex];
        prepared = nextSpeech ? prepareSegment(nextSpeech, runId, sequence) : null;
        const played = await recentStore.play(item.id);
        if (!played.played) throw new Error(played.error ?? '浏览器没有开始播放音频');
        markAudioPlayed(runId, item.id);
        status.value = `正在播放 ${index + 1}/${timeline.items.length}`;
        await waitForPlaybackEnd(item.id, sequence);
        if (sequence !== readingSequence) return;
        markPlaybackTimelineStep(runId, 'speech', 'end');
      }
      if (sequence === readingSequence) {
        markPlaybackTimelineComplete(runId);
        status.value = '朗读完成';
      }
    } catch (caught) {
      if (sequence !== readingSequence) return;
      stopReadingSequence();
      error.value = errorMessage(caught);
      status.value = '朗读失败';
      markVoiceAuditError(runId, caught);
    }
  }

  async function routeAndPlay(
    segments: SpokenSegment[],
    mode: VoiceSettingsData['readingDefaults']['mode'],
    action: string,
    soundOptions: { cues?: readonly SoundCue[]; catalog?: readonly SoundEffectEntry[] } = {},
  ): Promise<void> {
    stopReadingSequence();
    try {
      await playRoutedSegments(routeSegments(segments, mode), action, soundOptions);
    } catch (caught) {
      const runId = beginVoiceAudit(action);
      markContentExtracted(runId, segments.length);
      markVoiceAuditError(runId, caught);
      error.value = errorMessage(caught);
      status.value = '朗读失败';
    }
  }

  function reportPlaybackInputError(action: string, caught: unknown): void {
    stopReadingSequence();
    const runId = beginVoiceAudit(action);
    markVoiceAuditError(runId, caught);
    error.value = errorMessage(caught);
    status.value = '朗读失败';
  }

  async function loadSoundCatalog(): Promise<boolean> {
    if (!builtinSoundCatalog) return false;
    if (soundCatalogBusy.value) return false;
    stopReadingSequence();
    soundCatalogController?.abort();
    const controller = new AbortController();
    soundCatalogController = controller;
    soundCatalogBusy.value = true;
    error.value = '';
    status.value = `正在读取 ${builtinSoundCatalog.presentation.title}…`;
    const runId = beginSoundCatalogAudit();
    try {
      const snapshot = await loadEditionSoundCatalog(edition, { signal: controller.signal });
      if (!snapshot) return false;
      if (controller.signal.aborted || soundCatalogController !== controller) return false;
      builtinSoundEffects = snapshot.effects;
      soundCatalogCount.value = snapshot.effects.length;
      soundCatalogSfxCount.value = snapshot.sfxCount;
      soundCatalogAmbienceCount.value = snapshot.ambienceCount;
      soundCatalogRevision.value = snapshot.revision;
      soundPlayer.setCatalog(currentSoundCatalog());
      soundCues.clear();
      plannedSoundMessages.clear();
      messageControls.renderAll();
      markSoundCatalog(runId, 'success', snapshot.effects.length, snapshot.sfxCount, snapshot.ambienceCount);
      status.value = `已读取 ${snapshot.effects.length} 条音效（短音效 ${snapshot.sfxCount} / 环境音 ${snapshot.ambienceCount}）`;
      return true;
    } catch (caught) {
      if (controller.signal.aborted) return false;
      markSoundCatalog(runId, 'fail');
      error.value = errorMessage(caught);
      status.value = '音效目录读取失败';
      return false;
    } finally {
      if (soundCatalogController === controller) {
        soundCatalogController = null;
        soundCatalogBusy.value = false;
      }
    }
  }

  async function ensureSoundCues(messageId: number, message: string, force = false): Promise<boolean> {
    const catalog = currentSoundCatalog();
    if (!settings.value.readingDefaults.includeSoundEffects || catalog.length === 0) return false;
    if (!force && plannedSoundMessages.has(messageId)) return true;
    if (activeSoundGenerationId) stopGenerationById(activeSoundGenerationId);
    const generationId = `ganggang-sfx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeSoundGenerationId = generationId;
    try {
      const cues = await planSoundCues({
        messageId,
        message,
        segments: parseSpokenSegments(message, {
          sourceMessageId: messageId,
          defaultCharacterName: currentMessage(messageId)?.name ?? null,
        }),
        catalog,
        generationId,
      });
      if (activeSoundGenerationId !== generationId) return false;
      soundCues.set(messageId, cues);
      plannedSoundMessages.add(messageId);
      messageControls.renderMessage(messageId);
      return true;
    } catch (caught) {
      if (activeSoundGenerationId === generationId) {
        console.warn('<杠杠の配音室> AI 音效标注失败', errorMessage(caught).slice(0, 300));
      }
      return false;
    } finally {
      if (activeSoundGenerationId === generationId) activeSoundGenerationId = null;
    }
  }

  async function readMessage(messageId: number, suppliedSegments?: SpokenSegment[]): Promise<void> {
    const message = currentMessage(messageId);
    if (!message) {
      reportPlaybackInputError('message-playback', new Error('消息不存在'));
      return;
    }
    const segments =
      suppliedSegments ??
      parseSpokenSegments(message.message, { sourceMessageId: messageId, defaultCharacterName: message.name });
    const mode = settings.value.readingDefaults.mode === 'selected-text' ? 'full' : settings.value.readingDefaults.mode;
    await routeAndPlay(segments, mode, 'message-playback', {
      cues: settings.value.readingDefaults.includeSoundEffects ? (soundCues.get(messageId) ?? []) : [],
      catalog: currentSoundCatalog(),
    });
  }

  async function readOneSegment(segment: SpokenSegment): Promise<void> {
    const mode = settings.value.readingDefaults.mode === 'single-voice' ? 'single-voice' : 'full';
    try {
      const routed = routeSegments([segment], mode);
      const key = inlineSegmentKey(routed[0]);
      const existingId = inlineRecentItems.get(key);
      const existing = existingId ? recentStore.get(existingId) : null;
      if (existing?.status === 'generating') {
        status.value = '这句语音还在生成中…';
        return;
      }
      if (existing && ['ready', 'playing', 'paused'].includes(existing.status)) {
        await toggleRecentItem(existing.id, 'inline-playback');
        return;
      }
      await playRoutedSegments(routed, 'inline-playback');
    } catch (caught) {
      reportPlaybackInputError('inline-playback', caught);
    }
  }

  async function readSelectionFromMessage(messageId: number, text: string, segments: SpokenSegment[]): Promise<void> {
    const selected = mapSelectionToSegments(text, segments, messageId);
    const mode = settings.value.readingDefaults.mode === 'single-voice' ? 'single-voice' : 'selected-text';
    await routeAndPlay(selected, mode, 'selection-playback');
  }

  async function readLatest(): Promise<void> {
    if (settings.value.readingDefaults.mode === 'selected-text') return readSelection();
    await readMessage(getLastMessageId());
  }

  async function readSelection(): Promise<void> {
    const selection = window.parent.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!text) {
      reportPlaybackInputError('selection-playback', new Error('请先在聊天正文里选中要朗读的文字。'));
      return;
    }
    const node = selection?.anchorNode;
    const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
    const floor = element?.closest<HTMLElement>('#chat .mes[mesid]');
    if (!floor) {
      reportPlaybackInputError('selection-playback', new Error('请在聊天正文中选择要朗读的文字。'));
      return;
    }
    const messageId = Number(floor.getAttribute('mesid'));
    const message = currentMessage(messageId);
    if (!message) {
      reportPlaybackInputError('selection-playback', new Error('选中文本所在的消息不存在。'));
      return;
    }
    const segments = parseSpokenSegments(message.message, {
      sourceMessageId: messageId,
      defaultCharacterName: message.name,
    });
    await readSelectionFromMessage(messageId, text, segments);
  }

  async function toggleRecentItem(id: string, action: string): Promise<void> {
    const isCurrent = recentStore.activeItemId === id;
    if (!isCurrent) stopReadingSequence();
    const item = recentStore.get(id);
    if (!item) return;
    if (isCurrent && item.status === 'playing') {
      await recentStore.toggle(id);
      status.value = '已暂停';
      return;
    }
    const runId = beginVoiceAudit(action);
    markContentExtracted(runId, 1);
    markRouteBuilt(runId, 1);
    markProviderReady(runId, item.voice.providerProfileId);
    const result = await recentStore.toggle(id);
    if (result.played) markAudioPlayed(runId, id);
    else if (result.error) markVoiceAuditError(runId, result.error);
  }

  async function playRecent(id: string): Promise<void> {
    await toggleRecentItem(id, 'recent-playback');
  }

  async function regenerateRecent(id: string): Promise<void> {
    const request = recentRequests.get(id);
    if (!request) {
      error.value = '这条语音的原始请求已经不在当前页面内存中。';
      return;
    }
    const segment: RoutedSegment = {
      id: `regenerate-${id}`,
      kind: 'dialogue',
      text: request.text,
      characterName: request.characterName,
      sourceMessageId: null,
      voice: { ...request.voice },
    };
    await playRoutedSegments([segment], 'regenerate-playback');
  }

  function downloadRecent(id: string): void {
    recentStore.download(id);
  }

  function removeRecent(id: string): void {
    recentRequests.delete(id);
    recentStore.remove(id);
  }

  function clearRecent(): void {
    stopReadingSequence();
    recentRequests.clear();
    recentStore.clear();
  }

  function addSoundEffect(): void {
    settings.value.soundEffects.push({
      id: `effect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: '新音效',
      kind: 'sfx',
      category: '',
      url: '',
      description: '',
      enabled: true,
      volume: 0.8,
    });
  }

  function removeSoundEffect(effectId: string): void {
    settings.value.soundEffects = settings.value.soundEffects.filter(effect => effect.id !== effectId);
    soundCues.forEach((cues, messageId) => {
      soundCues.set(
        messageId,
        cues.filter(cue => cue.effectId !== effectId),
      );
    });
    messageControls.renderAll();
  }

  async function playSoundEffect(effectId: string): Promise<void> {
    stopReadingSequence();
    const sequence = readingSequence;
    const epoch = lifecycleEpoch;
    const runId = beginSoundEffectAudit();
    error.value = '';
    const result = await soundPlayer.play(effectId, currentSoundCatalog());
    if (stopped || sequence !== readingSequence || epoch !== lifecycleEpoch) return;
    markSoundEffect(runId, result.played ? 'success' : 'fail');
    if (result.played) status.value = '正在播放场景音效';
    else error.value = result.error ?? '音效播放失败';
  }

  async function planLatestSoundEffects(): Promise<void> {
    stopReadingSequence();
    const planSequence = ++soundPlanSequence;
    const epoch = lifecycleEpoch;
    const messageId = getLastMessageId();
    const message = currentMessage(messageId);
    if (!message) return;
    if (builtinSoundCatalog && builtinSoundEffects.length === 0) {
      const loaded = await loadSoundCatalog();
      if (!loaded || stopped || planSequence !== soundPlanSequence || epoch !== lifecycleEpoch) return;
    }
    if (!currentSoundCatalog().some(effect => effect.enabled && effect.url.trim())) {
      error.value ||= edition.id === 'custom-only' ? '请先添加并启用自定义音效。' : '请先读取或添加音效库。';
      return;
    }
    status.value = 'AI 正在给原文安放音效按钮…';
    const committed = await ensureSoundCues(messageId, message.message, true);
    if (!committed || stopped || planSequence !== soundPlanSequence || epoch !== lifecycleEpoch) return;
    status.value = `已放置 ${soundCues.get(messageId)?.length ?? 0} 个音效按钮`;
  }

  const messageControls = new MessageControlManager({
    resolveMessage: (messageId, message) => ({
      segments: parseSpokenSegments(message, {
        sourceMessageId: messageId,
        defaultCharacterName: currentMessage(messageId)?.name ?? null,
      }),
      soundCues: settings.value.readingDefaults.includeSoundEffects ? (soundCues.get(messageId) ?? []) : [],
    }),
    onPlayMessage: readMessage,
    onPlaySegment: readOneSegment,
    onPlaySelection: readSelectionFromMessage,
    onPlaySoundEffect: cue => playSoundEffect(cue.effectId),
    getSegmentStatus: segment => {
      try {
        const mode = settings.value.readingDefaults.mode === 'single-voice' ? 'single-voice' : 'full';
        const routed = routeSegments([segment], mode)[0];
        const itemId = inlineRecentItems.get(inlineSegmentKey(routed));
        return itemId ? (recentStore.get(itemId)?.status ?? null) : null;
      } catch {
        return null;
      }
    },
  });

  function refreshInlineControls(): void {
    messageControls.renderAll();
  }

  function stopAllWithReason(reason: VoiceCleanupReason): void {
    lifecycleEpoch += 1;
    soundPlanSequence += 1;
    const castingGenerationId = activeCastingGenerationId;
    const runId = beginVoiceCleanupAudit(reason, castingGenerationId);
    let requestCancelled = true;
    stopReadingSequence();
    providerController?.abort();
    providerController = null;
    providerBusy.value = false;
    soundCatalogController?.abort();
    soundCatalogController = null;
    soundCatalogBusy.value = false;
    if (castingGenerationId) {
      let stoppedCasting: boolean;
      try {
        stoppedCasting = stopCasting(castingGenerationId);
      } catch {
        stoppedCasting = false;
      }
      requestCancelled = stoppedCasting;
    }
    activeCastingGenerationId = null;
    castingBusy.value = false;
    if (activeSoundGenerationId) stopGenerationById(activeSoundGenerationId);
    activeSoundGenerationId = null;
    soundPlayer.stop();
    if (castingGenerationId) markAiCasting(runId, requestCancelled ? 'cancelled' : 'fail');
    markVoiceCleanup(runId, requestCancelled);
    status.value = '已停止';
  }

  function stopAll(): void {
    stopAllWithReason('user-stop');
  }

  function start(): void {
    stopped = false;
    refreshCharacter();
    refreshKnownVoices();
    listeners.push(
      ...bindVoiceLifecycleEvents(
        {
          onChatChanged: listener => eventOn(tavern_events.CHAT_CHANGED, listener),
          onMessageSwiped: listener => eventOn(tavern_events.MESSAGE_SWIPED, listener),
          onMessageEdited: listener => eventOn(tavern_events.MESSAGE_EDITED, listener),
          onMessageDeleted: listener => eventOn(tavern_events.MESSAGE_DELETED, listener),
        },
        {
          stopAll: stopAllWithReason,
          clearAllMessageState: () => {
            soundCues.clear();
            plannedSoundMessages.clear();
            inlineRecentItems.clear();
          },
          clearMessageState: messageId => {
            soundCues.delete(messageId);
            plannedSoundMessages.delete(messageId);
            clearInlineMessage(messageId);
          },
          scheduleCharacterRefresh: () => {
            const epoch = lifecycleEpoch;
            window.setTimeout(() => {
              if (!stopped && epoch === lifecycleEpoch) refreshCharacter();
            }, 0);
          },
          renderMessage: messageId => messageControls.renderMessage(messageId),
        },
      ),
    );
    messageControls.start();
  }

  function stop(reason: Extract<VoiceCleanupReason, 'pagehide' | 'unmount'> = 'unmount'): void {
    if (stopped) return;
    stopAllWithReason(reason);
    stopped = true;
    if (settingsTimer !== null) persistSettings();
    stopSettingsWatch();
    stopRecentSubscription();
    listeners.splice(0).forEach(listener => listener.stop());
    messageControls.destroy();
    soundPlayer.dispose();
    recentStore.dispose();
  }

  return {
    edition,
    builtinSoundCatalogPresentation,
    settings,
    voices,
    recentVoices,
    status,
    error,
    providerBusy,
    castingBusy,
    soundCatalogBusy,
    soundCatalogCount,
    soundCatalogSfxCount,
    soundCatalogAmbienceCount,
    soundCatalogRevision,
    currentCharacterKey,
    currentCharacterName,
    start,
    stop,
    stopAll,
    addProfile,
    removeProfile,
    probeAndLoadVoices,
    generateCasting,
    readLatest,
    readSelection,
    playRecent,
    regenerateRecent,
    downloadRecent,
    removeRecent,
    clearRecent,
    loadSoundCatalog,
    addSoundEffect,
    removeSoundEffect,
    playSoundEffect,
    planLatestSoundEffects,
    refreshInlineControls,
  };
}

export type VoiceRuntime = ReturnType<typeof createVoiceRuntime>;
