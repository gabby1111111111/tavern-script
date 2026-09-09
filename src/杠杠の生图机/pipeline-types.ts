export type DrawingPreset = {
  id: string;
  name: string;
  instructionText: string;
};

export type ImageOutputPreset = {
  id: string;
  name: string;
  templateText: string;
  useAvatarReferences: boolean;
  usePreviousStoryImage?: boolean;
};

export type DisplayMode = 'inline' | 'gift';

export type DisplaySettings = {
  displayMode: DisplayMode;
  skipFloors: number;
  generateOnSwipe: boolean;
};

export type PictureDirective = {
  imageIndex: number;
  prompt: string;
  markerText: string;
};

export type ImageRequestInput = {
  prompt: string;
  referenceImages?: string[];
};

export type ResolvedReferenceSource = {
  kind: 'user-avatar' | 'character-avatar' | 'previous-story-image';
  label: string;
  value: string;
};

/**
 * Lightweight page-memory provenance for a generated placement.  It carries
 * only the kind of reference that was attached, never the image bytes or URL.
 */
export type ImageReferenceKind = ResolvedReferenceSource['kind'];

export type PromptProcessingResult = {
  referenceSources?: ResolvedReferenceSource[];
  prompt: string;
  referenceImages?: string[];
  processing: 'bypassed' | 'processed';
};

export type FloorTriggerDecision = {
  shouldTrigger: boolean;
  normalAssistantFloorCount: number;
  interval: number;
  reason: 'eligible' | 'disabled' | 'non-normal-generation' | 'group-chat' | 'skipped-by-frequency';
};

export type ImageMemoryKey = {
  chatId: string;
  messageId: number;
  swipeId: number;
  imageIndex: number;
};

export type GallerySaveInput = {
  dataUrl: string;
  characterName: string;
  filename: string;
};

export type GallerySaveResult = {
  path: string;
};
