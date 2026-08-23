export const VOICE_SETTINGS_SCHEMA_VERSION = 1;

export type VoiceEditionId = 'custom-only' | 'remote-catalog';

export type TtsProviderKind = 'edge' | 'openai-compatible' | 'doubao' | 'minimax' | 'xiaomi-mimo';

export type TtsProviderProfile = {
  id: string;
  name: string;
  type: TtsProviderKind;
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  defaultVoiceId: string;
  appId: string;
  accessKey: string;
  resourceId: string;
  groupId: string;
  responseFormat: string;
  platform: string;
  style: string;
  edgeRate: number;
  extraBody: Record<string, unknown>;
};

export type VoiceOption = {
  providerProfileId: string;
  voiceId: string;
  name: string;
  locale?: string;
  gender?: string;
  description?: string;
  tags?: string[];
};

export type VoiceRef = {
  providerProfileId: string;
  voiceId: string;
  speed?: number;
  emotion?: string;
};

export type CastRole = 'narrator' | 'character' | 'fallback';

export type CastEntry = {
  id: string;
  role: CastRole;
  displayName: string;
  aliases: string[];
  voice: VoiceRef;
  reason?: string;
};

export type CastingTable = {
  characterKey: string;
  characterName: string;
  generatedAt: number;
  entries: CastEntry[];
};

export type ReadingMode = 'full' | 'dialogue-only' | 'single-voice' | 'selected-text' | 'character-only';

export type ReadingDefaults = {
  mode: ReadingMode;
  singleVoice: VoiceRef | null;
  characterName: string;
  includeSoundEffects: boolean;
  recentMessageCount: number;
};

export type SoundEffectEntry = {
  id: string;
  name: string;
  kind?: 'sfx' | 'ambience';
  category: string;
  url: string;
  description: string;
  enabled: boolean;
  volume: number;
};

export type VoiceSettingsData = {
  schemaVersion: typeof VOICE_SETTINGS_SCHEMA_VERSION;
  profiles: TtsProviderProfile[];
  castingByCharacter: Record<string, CastingTable>;
  readingDefaults: ReadingDefaults;
  soundEffects: SoundEffectEntry[];
};

export type ContextMessage = {
  messageId: number;
  role: 'system' | 'assistant' | 'user';
  name: string;
  message: string;
};

export type CastingContext = {
  characterKey: string;
  characterName: string;
  characterDescription: string;
  characterPersonality: string;
  scenario: string;
  recentMessages: ContextMessage[];
};

export type CastingRequest = {
  context: CastingContext;
  voices: VoiceOption[];
};

export type SpokenSegment = {
  id: string;
  kind: 'narration' | 'dialogue';
  text: string;
  characterName: string | null;
  sourceMessageId: number | null;
};

export type RoutedSegment = SpokenSegment & {
  voice: VoiceRef;
};

export type SoundCue = {
  id: string;
  effectId: string;
  sourceMessageId: number | null;
  sourceSegmentId: string | null;
  anchorText: string;
  anchorOccurrence: number;
  placement: 'before' | 'after';
};

export type SynthesisRequest = {
  text: string;
  voice: VoiceRef;
  signal: AbortSignal;
  contextText?: string;
};

export type SynthesizedAudio = {
  blob: Blob;
  mimeType: string;
};

export type RecentVoiceStatus = 'generating' | 'ready' | 'playing' | 'paused' | 'failed' | 'cancelled';

export type RecentVoiceItem = {
  id: string;
  textPreview: string;
  characterName: string | null;
  voice: VoiceRef;
  createdAt: number;
  status: RecentVoiceStatus;
  blob: Blob | null;
  objectUrl: string | null;
  error: string | null;
};

export type VoiceAuditStatus = 'idle' | 'pending' | 'success' | 'fail' | 'cancelled';

export type VoiceCleanupReason =
  | 'user-stop'
  | 'replacement'
  | 'chat-change'
  | 'message-swipe'
  | 'message-edit'
  | 'message-delete'
  | 'pagehide'
  | 'unmount'
  | 'unknown';

export type VoiceAudit = {
  version: string;
  edition: VoiceEditionId;
  run_id: number;
  action: string;
  content_extracted: { status: VoiceAuditStatus; count: number };
  route_built: { status: VoiceAuditStatus; count: number };
  provider_ready: {
    status: VoiceAuditStatus;
    profile_id: string | null;
    network_verified: boolean | null;
  };
  ai_casting: { status: VoiceAuditStatus; count: number; generation_id: string | null };
  sound_catalog: {
    status: VoiceAuditStatus;
    count: number;
    sfx_count: number;
    ambience_count: number;
  };
  sound_effect: { status: VoiceAuditStatus };
  playback_timeline: {
    status: VoiceAuditStatus;
    total_count: number;
    speech_count: number;
    sound_count: number;
    completed_count: number;
    skipped_sound_count: number;
    active_kind: 'speech' | 'sound' | null;
    max_active: number;
    remote_sound_count: number;
    pinned_remote_sound_count: number;
    trace: Array<'speech-start' | 'speech-end' | 'sound-start' | 'sound-end' | 'sound-skip' | 'cancelled'>;
  };
  cleanup: {
    status: VoiceAuditStatus;
    reason: VoiceCleanupReason | null;
    had_active_timeline: boolean;
  };
  request_cancelled: { status: VoiceAuditStatus };
  audio_played: { status: VoiceAuditStatus; item_id: string | null };
  recent_count: number;
  last_error: string | null;
};
