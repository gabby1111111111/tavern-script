import { registerVoiceConsole } from '../杠杠の配音台/bootstrap';
import { createRemoteCatalogVoiceEdition } from '../杠杠の配音台/edition';
import { ST_AUDIO_ASSETS_CATALOG_CAPABILITY } from './sound-catalog';

registerVoiceConsole(createRemoteCatalogVoiceEdition(ST_AUDIO_ASSETS_CATALOG_CAPABILITY));
