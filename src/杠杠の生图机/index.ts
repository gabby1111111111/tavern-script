/* eslint-disable vue/one-component-per-file -- Settings and workbench mount into separate host containers. */
import { klona } from 'klona';
import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import ImageSettings from './ImageSettings.vue';
import StoryImageWorkbench from './StoryImageWorkbench.vue';
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
  const workbenchApp = createApp(StoryImageWorkbench, { runtime }).use(pinia);
  const $workbench = $('<div>').attr('data-story-image-workbench-root', getScriptId()).appendTo('body');
  workbenchApp.mount($workbench[0]);
  runtime.start();

  $(window).on('pagehide.story-image', () => {
    runtime.stop();
    stopSettingsWatch();
    app.unmount();
    workbenchApp.unmount();
    $app.remove();
    $workbench.remove();
    destroyStyle();
  });
}

$(() => {
  errorCatched(mountStoryImageScript)();
});
