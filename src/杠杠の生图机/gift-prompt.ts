import type { GiftContextSnapshot } from './gift-context';
import { formatGiftContext } from './gift-context';
import type { GiftSettings } from './settings';

export function composeGiftImagePrompt(settings: GiftSettings, context: GiftContextSnapshot): string {
  return [
    settings.identityPrompt.trim(),
    settings.templatePrompt.trim(),
    settings.scenePrompt.trim(),
    `当前上下文：\n${formatGiftContext(context)}`,
    settings.stylePrompt.trim(),
    settings.outputPrompt.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}
