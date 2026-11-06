import { createApp } from 'vue';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import VoiceSettings from './VoiceSettings.vue';
import { voiceAudit } from './audit';
import type { VoiceEdition } from './edition';
import { createVoiceRuntime } from './runtime';
import './index.scss';

declare global {
  interface Window {
    __ganggangVoiceCleanup?: () => void;
  }
}

function mountVoiceConsole(edition: VoiceEdition): void {
  window.__ganggangVoiceCleanup?.();
  const $target = $('#extensions_settings2').length > 0 ? $('#extensions_settings2') : $('#extensions_settings');
  if ($target.length === 0) throw new Error('未找到酒馆助手设置面板挂载点');

  const runtime = createVoiceRuntime(edition);
  let auditWindow: Window = window;
  try {
    if (window.parent && window.parent !== window) auditWindow = window.parent;
  } catch {
    // Tavern Helper normally runs same-origin; keep the iframe-local Audit as fallback.
  }
  auditWindow.__ganggangVoiceAudit = voiceAudit;
  const app = createApp(VoiceSettings, { runtime });
  const $host = createScriptIdDiv().attr('id', 'ganggang-voice-settings-panel').appendTo($target);
  const { destroy: destroyStyle } = teleportStyle();
  app.mount($host[0]);
  runtime.start();

  let cleanedUp = false;
  function cleanupWithReason(reason: 'pagehide' | 'unmount'): void {
    if (cleanedUp) return;
    cleanedUp = true;
    runtime.stop(reason);
    app.unmount();
    $host.remove();
    destroyStyle();
    if (auditWindow.__ganggangVoiceAudit === voiceAudit) delete auditWindow.__ganggangVoiceAudit;
    $(window).off('pagehide.ganggangVoice', cleanupFromPagehide);
    if (window.__ganggangVoiceCleanup === cleanup) delete window.__ganggangVoiceCleanup;
  }
  function cleanup(): void {
    cleanupWithReason('unmount');
  }
  function cleanupFromPagehide(): void {
    cleanupWithReason('pagehide');
  }
  window.__ganggangVoiceCleanup = cleanup;
  $(window).off('pagehide.ganggangVoice').on('pagehide.ganggangVoice', cleanupFromPagehide);
}

export function registerVoiceConsole(edition: VoiceEdition): void {
  $(() => errorCatched(() => mountVoiceConsole(edition))());
}
