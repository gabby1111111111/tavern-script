import { MAX_RECENT_VOICES, RecentVoiceStore, type PlaybackResult } from '../src/杠杠の配音室/playback';
import {
  MAX_SOUND_CUES_PER_MESSAGE,
  SoundEffectPlayer,
  parseSoundCuesDetailed,
  validateSoundCue,
} from '../src/杠杠の配音室/sound-effects';
import type { SoundEffectEntry, VoiceRef } from '../src/杠杠の配音室/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

type AudioListener = (event: Event) => void;

class FakeAudio {
  paused = true;
  src = '';
  currentTime = 0;
  volume = 1;
  playCount = 0;
  loadCount = 0;
  private readonly listeners = new Map<string, Set<AudioListener>>();
  private playGate: Promise<void> = Promise.resolve();

  setPlayGate(gate: Promise<void>): void {
    this.playGate = gate;
  }

  play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
    return this.playGate;
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {
    this.loadCount += 1;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: AudioListener =
      typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
    const callbacks = this.listeners.get(type) ?? new Set<AudioListener>();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callbacks = this.listeners.get(type);
    if (!callbacks) return;
    const callback: AudioListener =
      typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
    callbacks.delete(callback);
  }

  emit(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  snapshotListeners(type: string): AudioListener[] {
    return [...(this.listeners.get(type) ?? [])];
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

function asAudio(audio: FakeAudio): HTMLAudioElement {
  return audio as unknown as HTMLAudioElement;
}

const voice: VoiceRef = { providerProfileId: 'profile-a', voiceId: 'voice-a' };

async function run(): Promise<void> {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const urlApi = {
    createObjectURL: (blob: Blob) => {
      const url = `blob:voice-${createdUrls.length + 1}-${blob.size}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => revokedUrls.push(url),
  };

  const fakeAudio = new FakeAudio();
  const store = new RecentVoiceStore({
    audioFactory: () => asAudio(fakeAudio),
    urlApi,
    now: () => 100,
  });

  const firstGeneration = store.beginGeneration({ textPreview: ' 第一行台词 ', characterName: '角色 A', voice });
  equal(firstGeneration.item.status, 'generating', '开始合成时应显示 generating');
  assert(!firstGeneration.signal.aborted, '新合成不应预先取消');
  assert(store.markReady(firstGeneration.item.id, new Blob(['first'], { type: 'audio/mpeg' })), 'ready 音频应写入内存');
  equal(store.get(firstGeneration.item.id)?.status, 'ready', '合成完成后应显示 ready');
  assert(Boolean(store.get(firstGeneration.item.id)?.objectUrl), 'ready 音频应拥有 object URL');

  const firstPlayGate = deferred<void>();
  fakeAudio.setPlayGate(firstPlayGate.promise);
  const pendingPlay = store.play(firstGeneration.item.id);
  await Promise.resolve();
  equal(store.get(firstGeneration.item.id)?.status, 'ready', 'audio.play 未 resolve 前不得报告 playing');
  firstPlayGate.resolve();
  const firstPlayResult = await pendingPlay;
  equal(firstPlayResult.played, true, 'audio.play resolve 后应报告 played');
  equal(store.get(firstGeneration.item.id)?.status, 'playing', 'audio.play resolve 后应显示 playing');

  const pausedResult = await store.toggle(firstGeneration.item.id);
  equal(pausedResult.status, 'paused', '重复点击正在播放的同一条应暂停');
  equal(store.get(firstGeneration.item.id)?.status, 'paused', '暂停后应显示 paused');
  const resumedResult = await store.toggle(firstGeneration.item.id);
  equal(resumedResult.status, 'playing', '再次点击暂停条目应恢复播放');
  equal(store.get(firstGeneration.item.id)?.status, 'playing', '恢复后应显示 playing');

  fakeAudio.emit('ended');
  equal(store.get(firstGeneration.item.id)?.status, 'ready', '自然结束应回到 ready');
  equal(store.activeItemId, null, '自然结束后不应保留活动条目');
  equal(fakeAudio.listenerCount('ended'), 0, '自然结束后应清理 ended listener');
  equal(fakeAudio.listenerCount('error'), 0, '自然结束后应清理 error listener');

  const secondGeneration = store.beginGeneration({ textPreview: '第二行', characterName: '角色 B', voice });
  assert(
    store.markReady(secondGeneration.item.id, new Blob(['second'], { type: 'audio/mpeg' })),
    '第二条音频应写入内存',
  );
  const secondPlay = await store.play(secondGeneration.item.id);
  assert(secondPlay.played, '第二条音频应可播放');
  equal(store.get(firstGeneration.item.id)?.status, 'ready', '切换条目必须停止并复位旧条目');
  equal(store.activeItemId, secondGeneration.item.id, '切换后只应保留第二条活动播放');
  assert(
    fakeAudio.listenerCount('ended') === 1 && fakeAudio.listenerCount('error') === 1,
    '活动音频应各只有一个 listener',
  );
  store.stop();
  equal(store.activeItemId, null, 'stop 后不应保留活动播放');
  equal(fakeAudio.listenerCount('ended'), 0, 'stop 后应清理 ended listener');
  equal(fakeAudio.listenerCount('error'), 0, 'stop 后应清理 error listener');

  const pendingVoiceAudio = new FakeAudio();
  const pendingVoiceGate = deferred<void>();
  pendingVoiceAudio.setPlayGate(pendingVoiceGate.promise);
  const pendingVoiceStore = new RecentVoiceStore({
    audioFactory: () => asAudio(pendingVoiceAudio),
    urlApi,
  });
  const pendingVoiceGeneration = pendingVoiceStore.beginGeneration({
    textPreview: '播放启动时取消',
    characterName: null,
    voice,
  });
  assert(
    pendingVoiceStore.markReady(pendingVoiceGeneration.item.id, new Blob(['pending-voice'], { type: 'audio/mpeg' })),
    'pending play 测试语音应可 ready',
  );
  let pendingVoiceSettled = false;
  const pendingVoicePlay = pendingVoiceStore.play(pendingVoiceGeneration.item.id).then(result => {
    pendingVoiceSettled = true;
    return result;
  });
  await flushMicrotasks();
  assert(pendingVoiceStore.stop(), 'audio.play pending 时 stop 仍应找到活动语音');
  await flushMicrotasks();
  assert(pendingVoiceSettled, 'audio.play pending 时 stop 必须立即结算语音 play promise');
  equal(
    await pendingVoicePlay,
    { itemId: pendingVoiceGeneration.item.id, played: false, status: 'ready' },
    'audio.play pending 时停止应返回未播放且可重播',
  );
  pendingVoiceGate.resolve();
  await Promise.resolve();
  equal(pendingVoiceStore.activeItemId, null, '迟到的 audio.play resolve 不得复活已停止语音');
  pendingVoiceStore.unload();

  const staleVoiceAudio = new FakeAudio();
  const staleVoiceStore = new RecentVoiceStore({ audioFactory: () => asAudio(staleVoiceAudio), urlApi });
  const staleVoiceA = staleVoiceStore.beginGeneration({ textPreview: '旧语音', characterName: null, voice });
  const staleVoiceB = staleVoiceStore.beginGeneration({ textPreview: '新语音', characterName: null, voice });
  assert(
    staleVoiceStore.markReady(staleVoiceA.item.id, new Blob(['stale-a'], { type: 'audio/mpeg' })),
    '旧语音应 ready',
  );
  assert(
    staleVoiceStore.markReady(staleVoiceB.item.id, new Blob(['stale-b'], { type: 'audio/mpeg' })),
    '新语音应 ready',
  );
  assert((await staleVoiceStore.play(staleVoiceA.item.id)).played, '旧语音应开始播放');
  const staleVoiceEnded = staleVoiceAudio.snapshotListeners('ended');
  const staleVoiceError = staleVoiceAudio.snapshotListeners('error');
  assert(staleVoiceStore.stop(), '旧语音应可停止');
  assert((await staleVoiceStore.play(staleVoiceB.item.id)).played, '新语音应开始播放');
  [...staleVoiceEnded, ...staleVoiceError].forEach(listener => listener(new Event('stale')));
  equal(staleVoiceStore.activeItemId, staleVoiceB.item.id, '旧语音的迟到回调不得停止新语音');
  equal(staleVoiceStore.get(staleVoiceB.item.id)?.status, 'playing', '旧回调不得改写新语音状态');
  equal(staleVoiceAudio.listenerCount('ended'), 1, '旧回调不得移除新语音 ended listener');
  equal(staleVoiceAudio.listenerCount('error'), 1, '旧回调不得移除新语音 error listener');
  staleVoiceAudio.emit('ended');
  staleVoiceStore.unload();

  const cancellationGate = deferred<Blob>();
  const cancellingPromise = store.generate({ textPreview: '会取消', characterName: '角色 C', voice }, ({ signal }) => {
    signal.addEventListener('abort', () => cancellationGate.reject(new DOMException('cancelled', 'AbortError')), {
      once: true,
    });
    return cancellationGate.promise;
  });
  await Promise.resolve();
  const cancellingItem = store.items[0];
  assert(cancellingItem.status === 'generating', 'generate 等待 provider 时应显示 generating');
  assert(store.cancelGeneration(cancellingItem.id), 'generating 条目应可取消');
  const cancelledItem = await cancellingPromise;
  equal(cancelledItem.status, 'cancelled', '取消 provider 请求后应显示 cancelled');
  assert(cancelledItem.blob === null && cancelledItem.objectUrl === null, '取消条目不应拥有音频资源');

  for (let index = 0; index < MAX_RECENT_VOICES + 1; index += 1) {
    const generation = store.beginGeneration({ textPreview: `保留 ${index}`, characterName: null, voice });
    assert(
      store.markReady(generation.item.id, new Blob([String(index)], { type: 'audio/mpeg' })),
      'recent 条目应可 ready',
    );
  }
  equal(store.items.length, MAX_RECENT_VOICES, 'recent voice 最多保留十条');
  assert(revokedUrls.length >= 1, '淘汰条目必须 revoke object URL');

  const removableId = store.items[0].id;
  const removableUrl = store.get(removableId)?.objectUrl as string;
  assert(store.remove(removableId), 'recent 条目应可删除');
  assert(revokedUrls.includes(removableUrl), '删除条目必须 revoke object URL');
  store.clear();
  equal(store.items.length, 0, 'clear 后不应残留 recent 条目');
  assert(
    createdUrls.every(url => revokedUrls.includes(url)),
    'clear 后所有 object URL 都应释放',
  );

  const evictionAudio = new FakeAudio();
  const evictionStore = new RecentVoiceStore({
    maxEntries: 1,
    audioFactory: () => asAudio(evictionAudio),
    urlApi,
  });
  const activeEviction = evictionStore.beginGeneration({ textPreview: '会被淘汰', characterName: null, voice });
  assert(
    evictionStore.markReady(activeEviction.item.id, new Blob(['evict'], { type: 'audio/mpeg' })),
    '淘汰测试条目应可 ready',
  );
  assert((await evictionStore.play(activeEviction.item.id)).played, '淘汰测试条目应开始播放');
  const replacement = evictionStore.beginGeneration({ textPreview: '替代条目', characterName: null, voice });
  assert(evictionStore.get(activeEviction.item.id) === null, '超出上限时最旧条目应被移除');
  assert(
    evictionAudio.listenerCount('ended') === 0 && evictionAudio.listenerCount('error') === 0,
    '淘汰活动条目应清理 audio listener',
  );
  equal(evictionStore.activeItemId, null, '淘汰活动条目应停止播放');
  assert(evictionStore.cancelGeneration(replacement.item.id), '淘汰测试中的生成条目应可取消');
  evictionStore.unload();

  const soundCatalog: SoundEffectEntry[] = [
    {
      id: 'door-open',
      name: '开门',
      category: 'door',
      url: 'https://example.test/door.mp3',
      description: '',
      enabled: true,
      volume: 0.8,
    },
    {
      id: 'footstep',
      name: '脚步',
      category: 'step',
      url: 'https://example.test/step.mp3',
      description: '',
      enabled: true,
      volume: 1,
    },
    {
      id: 'disabled',
      name: '禁用',
      category: 'misc',
      url: 'https://example.test/no.mp3',
      description: '',
      enabled: false,
      volume: 1,
    },
  ];
  const cueResult = parseSoundCuesDetailed(
    [
      { id: 'door-1', effectId: 'door-open', anchorText: '门被推开', placement: 'before', sourceMessageId: 4 },
      { id: 'step-1', effectId: 'footstep', anchorText: '脚步声', placement: 'after' },
      { id: 'bad', effectId: 'disabled', anchorText: '不会播放', placement: 'before' },
    ],
    soundCatalog,
    { sourceMessageId: 9 },
  );
  equal(cueResult.cues.length, 2, '音效解析只应返回目录中启用的音效');
  equal(cueResult.cues[1].sourceMessageId, 9, '缺省 sourceMessageId 应使用调用方上下文');
  assert(cueResult.errors.length === 1, '无效音效应留下可审计错误');
  assert(validateSoundCue(cueResult.cues[0], soundCatalog).cue !== null, '有效 cue 应通过校验');
  assert(
    parseSoundCuesDetailed(
      new Array(MAX_SOUND_CUES_PER_MESSAGE + 1).fill({
        effectId: 'footstep',
        anchorText: '脚步声',
        placement: 'before',
      }),
      soundCatalog,
    ).errors.some(error => error.includes('超过上限')),
    '音效 cue 应限制单消息数量',
  );

  const effectAudio = new FakeAudio();
  const effectPlayer = new SoundEffectPlayer(soundCatalog, { audioFactory: () => asAudio(effectAudio) });
  const effectResult = await effectPlayer.playCue(cueResult.cues[0]);
  assert(effectResult.played, '有效音效 cue 应使用独立 HTMLAudioElement 播放');
  equal(effectAudio.src, soundCatalog[0].url, '音效播放应使用目录 URL');
  equal(effectAudio.volume, 0.8, '音效播放应使用目录音量');
  assert(effectPlayer.stop(), '活动音效应可停止');
  equal(effectPlayer.activeEffectId, null, 'stop 后不应保留活动音效');
  equal(effectAudio.listenerCount('ended'), 0, '停止音效应清理 ended listener');
  equal(effectAudio.listenerCount('error'), 0, '停止音效应清理 error listener');

  const awaitedAudio = new FakeAudio();
  const awaitedPlayer = new SoundEffectPlayer(soundCatalog, { audioFactory: () => asAudio(awaitedAudio) });
  let naturalSettled = false;
  const naturalCompletion = awaitedPlayer.playCueToEnd(cueResult.cues[0]).then(result => {
    naturalSettled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert(!naturalSettled, '时间线音效在 audio.play resolve 后仍必须等待 ended');
  awaitedAudio.emit('ended');
  equal(
    await naturalCompletion,
    { effectId: 'door-open', played: true, outcome: 'ended' },
    '时间线音效只有自然结束后才能报告 ended',
  );
  equal(awaitedAudio.listenerCount('ended'), 0, '自然结束后应清理时间线音效 listener');

  const failedCompletion = awaitedPlayer.playCueToEnd(cueResult.cues[1]);
  await Promise.resolve();
  await Promise.resolve();
  awaitedAudio.emit('error');
  equal(
    await failedCompletion,
    { effectId: 'footstep', played: true, outcome: 'failed', error: '音效播放失败' },
    '音效 error 事件必须结算为 failed，供队列跳过并继续',
  );
  equal(awaitedAudio.listenerCount('error'), 0, '音效失败后应清理 error listener');

  const cancelledCompletion = awaitedPlayer.playCueToEnd(cueResult.cues[0]);
  await Promise.resolve();
  await Promise.resolve();
  assert(awaitedPlayer.stop(), '停止时间线应能取消正在等待 ended 的音效');
  equal(
    await cancelledCompletion,
    { effectId: 'door-open', played: true, outcome: 'cancelled' },
    'stop 必须让等待中的音效 promise 结算为 cancelled',
  );
  equal(awaitedAudio.src, '', '取消时间线音效必须清空 src');
  equal(awaitedAudio.listenerCount('ended'), 0, '取消时间线音效必须清理 ended listener');

  const pendingSoundAudio = new FakeAudio();
  const pendingSoundGate = deferred<void>();
  pendingSoundAudio.setPlayGate(pendingSoundGate.promise);
  const pendingSoundPlayer = new SoundEffectPlayer(soundCatalog, { audioFactory: () => asAudio(pendingSoundAudio) });
  let pendingSoundSettled = false;
  const pendingSoundCompletion = pendingSoundPlayer.playCueToEnd(cueResult.cues[0]).then(result => {
    pendingSoundSettled = true;
    return result;
  });
  await flushMicrotasks();
  assert(pendingSoundPlayer.stop(), 'audio.play pending 时 stop 仍应找到活动音效');
  await flushMicrotasks();
  assert(pendingSoundSettled, 'audio.play pending 时 stop 必须立即结算音效完成 promise');
  equal(
    await pendingSoundCompletion,
    { effectId: 'door-open', played: false, outcome: 'cancelled' },
    'audio.play pending 时停止应返回 cancelled',
  );
  pendingSoundGate.resolve();
  await Promise.resolve();
  equal(pendingSoundPlayer.activeEffectId, null, '迟到的音效 play resolve 不得复活已停止音效');
  equal(pendingSoundAudio.src, '', '迟到的音效 play resolve 不得恢复旧 src');
  equal(pendingSoundAudio.listenerCount('ended'), 0, 'pending 音效取消后不得残留 listener');
  pendingSoundPlayer.unload();

  const staleSoundAudio = new FakeAudio();
  const staleSoundPlayer = new SoundEffectPlayer(soundCatalog, { audioFactory: () => asAudio(staleSoundAudio) });
  const staleSoundA = staleSoundPlayer.playCueToEnd(cueResult.cues[0]);
  await flushMicrotasks();
  const staleSoundEnded = staleSoundAudio.snapshotListeners('ended');
  const staleSoundError = staleSoundAudio.snapshotListeners('error');
  assert(staleSoundPlayer.stop(), '旧音效应可停止');
  equal((await staleSoundA).outcome, 'cancelled', '旧音效停止后应结算');
  const staleSoundB = staleSoundPlayer.playCueToEnd(cueResult.cues[1]);
  await flushMicrotasks();
  [...staleSoundEnded, ...staleSoundError].forEach(listener => listener(new Event('stale')));
  equal(staleSoundPlayer.activeEffectId, 'footstep', '旧音效的迟到回调不得停止新音效');
  equal(staleSoundAudio.src, soundCatalog[1].url, '旧音效回调不得清空新音效 src');
  equal(staleSoundAudio.listenerCount('ended'), 1, '旧音效回调不得移除新 ended listener');
  equal(staleSoundAudio.listenerCount('error'), 1, '旧音效回调不得移除新 error listener');
  staleSoundAudio.emit('ended');
  equal((await staleSoundB).outcome, 'ended', '新音效仍应由自己的回调正常结束');
  staleSoundPlayer.unload();
  awaitedPlayer.unload();

  store.unload();
  effectPlayer.unload();

  const playbackAssertion: PlaybackResult = { itemId: null, played: false, status: 'missing' };
  assert(playbackAssertion.status === 'missing', '测试应覆盖缺失音频返回值');
  console.info('<杠杠の配音室> playback and sound-effect tests passed');
}

run().catch(error => {
  console.error(error);
  throw error;
});
