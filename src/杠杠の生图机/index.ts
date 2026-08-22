import { klona } from 'klona';
import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import ImageSettings from './ImageSettings.vue';
import { createStoryImageRuntime } from './runtime';
import { useStoryImageSettingsStore } from './settings';
import './index.scss';

function mountStoryImageScript() {
  const pinia = createPinia();
  const settingsStore = useStoryImageSettingsStore(pinia);
  const runtime = createStoryImageRuntime();
  const stopSettingsWatch = watch(settingsStore.settings, nextSettings => runtime.updateSettings(klona(nextSettings)), {
    deep: true,
    immediate: true,
  });

  const app = createApp(ImageSettings, { runtime }).use(pinia);
  const $target = $('#extensions_settings2').length > 0 ? $('#extensions_settings2') : $('#extensions_settings');
  const $app = createScriptIdDiv().appendTo($target);
  const { destroy: destroyStyle } = teleportStyle();
  app.mount($app[0]);
  runtime.start();

  $(window).on('pagehide.story-image', () => {
    runtime.stop();
    stopSettingsWatch();
    app.unmount();
    $app.remove();
    destroyStyle();
  });
}

$(() => {
  errorCatched(mountStoryImageScript)();
});
