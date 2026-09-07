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

export type PromptProcessingResult = {
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
