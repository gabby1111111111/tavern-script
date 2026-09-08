import type { SoundEffectEntry, VoiceEditionId } from './types';

export const VOICE_CONSOLE_VERSION = '0.1.0';

export type SoundCatalogSnapshot = {
  revision: string;
  effects: SoundEffectEntry[];
  sfxCount: number;
  ambienceCount: number;
};

export type BuiltinSoundCatalogPresentation = {
  title: string;
  loadLabel: string;
  loadingLabel: string;
  hints: readonly string[];
};

export type BuiltinSoundCatalogCapability = {
  presentation: BuiltinSoundCatalogPresentation;
  load: (options?: { signal?: AbortSignal }) => Promise<SoundCatalogSnapshot>;
  isRemote: (entry: SoundEffectEntry) => boolean;
  isPinned: (entry: SoundEffectEntry) => boolean;
};

export type VoiceEdition =
  | {
      id: 'custom-only';
      version: string;
      builtinSoundCatalog: null;
    }
  | {
      id: 'remote-catalog';
      version: string;
      builtinSoundCatalog: BuiltinSoundCatalogCapability;
    };

export const CUSTOM_ONLY_VOICE_EDITION: VoiceEdition = {
  id: 'custom-only',
  version: VOICE_CONSOLE_VERSION,
  builtinSoundCatalog: null,
};

export function createRemoteCatalogVoiceEdition(builtinSoundCatalog: BuiltinSoundCatalogCapability): VoiceEdition {
  return {
    id: 'remote-catalog',
    version: VOICE_CONSOLE_VERSION,
    builtinSoundCatalog,
  };
}

/** The id check keeps a custom build inert even if an invalid object carries a loader. */
export function getBuiltinSoundCatalog(edition: VoiceEdition): BuiltinSoundCatalogCapability | null {
  return edition.id === 'remote-catalog' ? edition.builtinSoundCatalog : null;
}

export async function loadEditionSoundCatalog(
  edition: VoiceEdition,
  options: { signal?: AbortSignal } = {},
): Promise<SoundCatalogSnapshot | null> {
  return (await getBuiltinSoundCatalog(edition)?.load(options)) ?? null;
}

export type { VoiceEditionId };
