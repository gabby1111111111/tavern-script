/**
 * st测试-BGM
 * 使用 Tavern Helper API 常驻注入 BGM 指示，并流式识别回复正文中的 BGM 标记。
 * 不依赖 MVU；标记解析成功后会走已验证过的
 * JOOX 搜歌 -> 获取歌曲 URL -> Tavern Helper BGM 播放路径。
 *
 * ============================================================
 * 整体原理(先看这一段,再看代码,会容易懂很多):
 * ============================================================
 *
 * 目标:AI 回复的文字"一边往外蹦",我们就要"一边"从里面找出一个
 * 约定好的标记(比如 <st测试/BGM=Sparks-Coldplay>),找到了就立刻触发放歌,
 * 不用等 AI 把这一整条回复说完。
 *
 * 分三个阶段,对应三种事件:
 *
 * 1) AI 开始要说话了 —— tavern_events.GENERATION_STARTED
 *    这时候我们要做的事:准备一个"干净的扫描器"(scanner),
 *    专门负责"看"这一轮 AI 要说的话。
 *
 * 2) AI 正在说话,文字一点点往外蹦 —— tavern_events.STREAM_TOKEN_RECEIVED
 *    这个事件会被触发很多很多次(AI 每吐一点新字就触发一次),
 *    每次都会把"目前为止 AI 已经说的全部文字"给你(不是新增的那一小段,
 *    是从头到目前为止的完整文字)。
 *    我们让 scanner 每次都检查一下完整快照中是不是已经出现了
 *    完整的 <st测试/BGM=歌曲-歌手> 标记?
 *      - 还没出现 / 还没写完(比如只写了 "<st测试/BGM=Sparks-") → 先不管,继续等
 *      - 出现了完整的标记 → 立刻触发一次"播放"回调,并且记一个"已完成"
 *        的标志,防止后面文字继续蹦出来的时候,同一个标记被重复触发。
 *
 * 3) 这一轮 AI 说完了 —— tavern_events.MESSAGE_RECEIVED
 *    如果从头到尾都没等到标记(比如 AI 这次没按格式说话,或者标记
 *    没有出现),就在这里"收尾"，判定这一轮
 *    是 "none"(没有标记),避免 scanner 一直悬空等着。
 *
 * ============================================================
 * 这次改了什么(相比上一版):
 * ============================================================
 *
 * 【重要修复】GENERATION_STARTED 和 MESSAGE_RECEIVED 这两个事件,
 * 不是只有"用户在聊天界面看到的对话"会触发它们 —— 酒馆还会在很多
 * 你看不见的场合偷偷发起生成请求,比如自动摘要、世界书触发的隐藏
 * 请求等等,这些都属于 type: 'quiet'。
 *
 * 上一版代码完全没检查 type,所以只要酒馆背景里跑一次隐藏请求,
 * 就会误判成"新的一轮 AI 回复开始了",把正在追踪的真实对话 scanner
 * 提前重置或结束掉 —— 导致你正在看的这条真实回复,BGM 检测悄悄失效。
 *
 * 这一版加了 shouldTrack() 这个判断函数,只有真正会显示给你看的
 * 那种生成(不是 quiet、也不是 dry_run 试跑)才会被追踪。
 *
 * 标记允许出现在正文任意位置；命中一次后，本轮不再重复触发。
 */
export {};

type BgmAction = { type: 'play' | 'stop' | 'none'; song?: string; singer?: string };
type MarkerScanner = {
  pushSnapshot: (fullText: string) => BgmAction | null;
  finish: () => BgmAction;
  getState: () => { generationId: number; resolved: boolean; action: BgmAction | null };
};

// 标记格式: <st测试/BGM=歌曲名-歌手>，歌曲名允许包含连字符，最后一个连字符作为分隔符。
const markerPattern = /<st测试\/BGM=([^<>\r\n]+)\s*-\s*([^<>\r\n]+)>/i;

function createMarkerScanner(generationId: number, onAction: (action: BgmAction) => void): MarkerScanner {
  let latestText = '';
  let resolved = false; // 这一轮是不是已经出结果了(播/停/都不是),出了结果就不用再看后面的文字
  let action: BgmAction | null = null;

  const resolve = (next: BgmAction) => {
    resolved = true;
    action = next;
    if (next.type !== 'none') onAction(next); // 只有真的要播/停的时候才回调,'none' 不用通知外面
    return next;
  };

  return {
    pushSnapshot(fullText) {
      // 已经出过结果了,或者传进来的东西不是文字,直接跳过不处理
      if (resolved || typeof fullText !== 'string') return null;
      latestText = fullText;

      const prefix = latestText.slice(0, 96);
      // 开头看着像新格式标记但还没等到 ">" 出现 —— 说明标记还没写完,先耐心等,
      // 不要在这里就误判成"没有标记"
      if (/^\s*<st测试\/BGM=/i.test(prefix) && !prefix.includes('>')) return null;

      const match = latestText.match(markerPattern);
      // 流式阶段可能先收到正文/推理片段，不能因此提前锁定 none；
      // 只有 MESSAGE_RECEIVED -> finish() 时才确认本轮没有标记。
      if (!match) return null;

      const song = match[1].trim();
      const singer = match[2].trim();
      if (song.toLowerCase() === 'none') return resolve({ type: 'none' });
      if (song.toLowerCase() === 'stop') return resolve({ type: 'stop' });
      return resolve({ type: 'play', song, singer });
    },
    finish() {
      // 流式过程中一直没等到匹配结果,这里兜底判定成 'none'
      return action ?? resolve({ type: 'none' });
    },
    getState() {
      void latestText;
      return { generationId, resolved, action };
    },
  };
}

// JOOX 搜索使用“歌手 歌名”的顺序；标记本身是“歌名-歌手”，所以这里专门转换一次。
function createMusicSearchQuery(song: string, singer: string) {
  return `${singer} ${song}`.trim();
}

// ============================================================
// 下面是一组很小的"单元测试",跟 BGM 功能本身无关,只是用来验证
// createMarkerScanner() 这一段逻辑写得对不对。可以先不用管这部分。
// ============================================================

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

function runUnitTests() {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  const test = (name: string, body: () => void) => {
    try {
      body();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  test('完整文本快照跨 chunk 后只触发一次', () => {
    const actions: BgmAction[] = [];
    const scanner = createMarkerScanner(1, action => actions.push(action));
    scanner.pushSnapshot('<st测试/BGM=夜行-');
    scanner.pushSnapshot('<st测试/BGM=夜行-椎名林檎>\n正文');
    scanner.pushSnapshot('<st测试/BGM=夜行-椎名林檎>\n正文更多');
    equal(actions, [{ type: 'play', song: '夜行', singer: '椎名林檎' }], 'actions');
  });

  test('none 不播放，stop 只触发停止', () => {
    const actions: BgmAction[] = [];
    const none = createMarkerScanner(2, action => actions.push(action));
    const stop = createMarkerScanner(3, action => actions.push(action));
    equal(none.pushSnapshot('<st测试/BGM=none-x>'), { type: 'none' }, 'none');
    equal(stop.pushSnapshot('<st测试/BGM=stop-x>'), { type: 'stop' }, 'stop');
    equal(actions, [{ type: 'stop' }], 'actions');
  });

  test('正文中出现的标记也会触发', () => {
    const actions: BgmAction[] = [];
    const scanner = createMarkerScanner(4, action => actions.push(action));
    scanner.pushSnapshot('正文先到达\n<st测试/BGM=late-singer>');
    equal(actions, [{ type: 'play', song: 'late', singer: 'singer' }], 'actions');
    equal(scanner.getState().action, { type: 'play', song: 'late', singer: 'singer' }, 'final action');
  });

  test('歌曲名包含连字符时，最后一个连字符分隔歌手', () => {
    const actions: BgmAction[] = [];
    const scanner = createMarkerScanner(5, action => actions.push(action));
    scanner.pushSnapshot('<st测试/BGM=Spider-Man-Into the Spider-Verse-Blackway>');
    equal(actions, [{ type: 'play', song: 'Spider-Man-Into the Spider-Verse', singer: 'Blackway' }], 'actions');
  });

  test('新 generation 拥有独立的一次性闸门', () => {
    const actions: BgmAction[] = [];
    const first = createMarkerScanner(6, action => actions.push(action));
    const second = createMarkerScanner(7, action => actions.push(action));
    first.pushSnapshot('<st测试/BGM=雨-rain>');
    first.pushSnapshot('<st测试/BGM=雨-rain>');
    second.pushSnapshot('<st测试/BGM=雨-rain>');
    equal(
      actions,
      [
        { type: 'play', song: '雨', singer: 'rain' },
        { type: 'play', song: '雨', singer: 'rain' },
      ],
      'actions',
    );
    assert(first.getState().generationId !== second.getState().generationId, 'generation ids must differ');
  });

  test('未闭合标记在流结束时不播放', () => {
    const actions: BgmAction[] = [];
    const scanner = createMarkerScanner(8, action => actions.push(action));
    scanner.pushSnapshot('<st测试/BGM=未完成-');
    equal(scanner.finish(), { type: 'none' }, 'finish action');
    equal(actions, [], 'actions');
  });

  test('JOOX 查询使用歌手在前、歌名在后', () => {
    equal(createMusicSearchQuery('夜曲', '周杰伦'), '周杰伦 夜曲', 'search query');
  });

  const passed = results.filter(result => result.passed).length;
  const report = { passed, failed: results.length - passed, total: results.length, results };
  (globalThis as typeof globalThis & { __stBgmStreamTests?: unknown }).__stBgmStreamTests = report;
  // console.info('<st测试/BGM> unit tests', report);
  if (report.failed > 0) console.error('<st测试/BGM> failures', report.results);
  return report;
}

// ============================================================
// 下面是真正接到酒馆事件上的部分
// ============================================================

const bgmPromptId = 'st-bgm-marker-persistent';
const legacyBgmPromptId = 'st-bgm-marker-test';
const legacyTestButtonNames = new Set(['<st测试/BGM>注入 BGM 标记测试指示', '<st测试/BGM>测试 JOOX 搜歌播放']);
const bgmPromptContent =
  '你正在正常生成角色回复正文。除非用户明确要求不要配 BGM，否则每次正常回复必须按当前正文氛围追加一条歌曲 BGM。保持正常的角色回复和剧情正文，不要输出候选列表、分析过程或选曲理由。【选曲流程（仅在内部完成）】1. 分析当前场景的情绪基调、人物心理状态、剧情节奏，重点看情绪、氛围和节奏的契合度，而不是只看歌词字面意思。2. 在心中列出 3-5 首不同歌手或乐队的候选曲目。3. 排除本次对话历史中已经在 BGM 标记出现过的歌曲，不能重复同一首。4. 优先选择该歌手的非代表作、专辑曲目、B 面曲或冷门单曲，不要每次都选最热门歌曲。5. 剧情出现明显转折时必须重新选曲。 【硬性规则】更像电视剧、电影或 Galgame 的 BGM 选曲逻辑；可以使用中文、日文、韩文、英文歌曲，但不能使用纯音乐或器乐曲；歌名与歌手必须真实准确，不可编造。 【标记输出】需要 BGM 时，必须在 <content> 标签内部、正文第一段的结尾另起一行，仅输出这一条标记：<st测试/BGM=歌曲名-歌手>。不要把标记拖到整条回复的最后；标记后可以继续正常正文。';
let generationId = 0;
let activeScanner: MarkerScanner | null = null;
let activeMusicGenerationId = 0;

type RuntimeAudit = {
  run_id: number;
  generation: { status: 'pending' | 'success' | 'fail'; id: number };
  marker: {
    status: 'pending' | 'success' | 'fail';
    matched: boolean;
    song: string | null;
    singer: string | null;
    error: string | null;
  };
  stream_finished: { status: 'pending' | 'success' | 'fail'; message_id: number | null; error: string | null };
  music_lookup: {
    status: 'pending' | 'success' | 'fail';
    query: string | null;
    track_id: string | null;
    error: string | null;
  };
  audio_played: { status: 'pending' | 'success' | 'fail'; error: string | null };
  prompt_injection: {
    status: 'pending' | 'success' | 'fail';
    id: string;
    scope: 'current_chat';
    reason: 'script_loaded' | 'chat_changed' | null;
    error: string | null;
  };
  legacy_test_controls: { status: 'pending' | 'success' | 'fail'; removed_count: number; error: string | null };
  last_error: string | null;
};

const runtimeAudit: RuntimeAudit = {
  run_id: 0,
  generation: { status: 'pending', id: 0 },
  marker: { status: 'pending', matched: false, song: null, singer: null, error: null },
  stream_finished: { status: 'pending', message_id: null, error: null },
  music_lookup: { status: 'pending', query: null, track_id: null, error: null },
  audio_played: { status: 'pending', error: null },
  prompt_injection: { status: 'pending', id: bgmPromptId, scope: 'current_chat', reason: null, error: null },
  legacy_test_controls: { status: 'pending', removed_count: 0, error: null },
  last_error: null,
};
(globalThis as typeof globalThis & { __stBgmStreamAudit?: RuntimeAudit }).__stBgmStreamAudit = runtimeAudit;

type BgmPromptRuntimeState = { uninject?: () => void };
const bgmPromptRuntime = ((
  globalThis as typeof globalThis & { __stBgmPromptRuntime?: BgmPromptRuntimeState }
).__stBgmPromptRuntime ??= {});

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 默认不传 once，即让提示在当前聊天文件中持续有效。
 * CHAT_CHANGED 后会重新注册；同 ID 覆盖旧条目，先调用旧 disposer 以避免同一 iframe 重执行时留下旧注入。
 */
function installPersistentBgmPrompt(reason: 'script_loaded' | 'chat_changed') {
  try {
    bgmPromptRuntime.uninject?.();
    uninjectPrompts([legacyBgmPromptId, bgmPromptId]);
    bgmPromptRuntime.uninject = injectPrompts([
      {
        id: bgmPromptId,
        position: 'in_chat',
        depth: 0,
        role: 'system',
        should_scan: false,
        content: bgmPromptContent,
      },
    ]).uninject;
    runtimeAudit.prompt_injection = {
      status: 'success',
      id: bgmPromptId,
      scope: 'current_chat',
      reason,
      error: null,
    };
    // console.info('<st测试/BGM> 常驻 BGM 指示已注册', { reason, id: bgmPromptId });
  } catch (error) {
    const message = errorText(error);
    runtimeAudit.prompt_injection = {
      status: 'fail',
      id: bgmPromptId,
      scope: 'current_chat',
      reason,
      error: message,
    };
    runtimeAudit.last_error = message;
    console.warn('<st测试/BGM> 常驻 BGM 指示注册失败', { reason, message });
  }
}

function removeLegacyTestControls() {
  try {
    const buttons = getScriptButtons();
    const retainedButtons = buttons.filter(button => !legacyTestButtonNames.has(button.name));
    if (retainedButtons.length !== buttons.length) replaceScriptButtons(retainedButtons);
    runtimeAudit.legacy_test_controls = {
      status: 'success',
      removed_count: buttons.length - retainedButtons.length,
      error: null,
    };
  } catch (error) {
    const message = errorText(error);
    runtimeAudit.legacy_test_controls = { status: 'fail', removed_count: 0, error: message };
    runtimeAudit.last_error = message;
    console.warn('<st测试/BGM> 清理旧测试按钮失败', { message });
  }
}

function isCurrentMusicGeneration(runId: number) {
  return runId === activeMusicGenerationId;
}

/**
 * 这是从 index.before-mvu-stream-test.ts 搬来的已验证播放路径：
 * 1. JOOX 搜索，取第一个结果的 id；2. 用 id 请求可播放 URL；3. 交给 Tavern Helper 播放 BGM。
 * 每一个 await 后都检查 runId，旧 generation 即使晚返回也不会覆盖新一轮的 BGM。
 */
async function searchAndPlayBgm(runId: number, song: string, singer: string) {
  const query = createMusicSearchQuery(song, singer);
  if (isCurrentMusicGeneration(runId)) {
    runtimeAudit.music_lookup = { status: 'pending', query, track_id: null, error: null };
    runtimeAudit.audio_played = { status: 'pending', error: null };
  }

  let trackId: string | null = null;
  let urlResolved = false;

  try {
    const searchRes = await fetch(
      'https://music-api.gdstudio.xyz/api.php?types=search&source=joox&name=' + encodeURIComponent(query) + '&count=5',
    );
    if (!searchRes.ok) throw new Error(`JOOX 搜歌请求失败 (${searchRes.status})`);

    const searchData: unknown = await searchRes.json();
    const firstTrack = Array.isArray(searchData) ? searchData[0] : undefined;
    const rawTrackId = firstTrack && typeof firstTrack === 'object' ? (firstTrack as { id?: unknown }).id : undefined;
    if (typeof rawTrackId !== 'string' && typeof rawTrackId !== 'number') {
      throw new Error('没有搜到可播放的歌曲');
    }
    trackId = String(rawTrackId);

    if (!isCurrentMusicGeneration(runId)) return;

    const urlRes = await fetch(
      `https://music-api.gdstudio.xyz/api.php?types=url&source=joox&id=${encodeURIComponent(trackId)}&br=320`,
    );
    if (!urlRes.ok) throw new Error(`JOOX 歌曲 URL 请求失败 (${urlRes.status})`);

    const urlData: unknown = await urlRes.json();
    const audioUrl =
      urlData && typeof urlData === 'object' && typeof (urlData as { url?: unknown }).url === 'string'
        ? (urlData as { url: string }).url
        : '';
    if (!audioUrl) throw new Error('歌曲没有可用 URL');
    urlResolved = true;

    if (!isCurrentMusicGeneration(runId)) return;

    runtimeAudit.music_lookup = { status: 'success', query, track_id: trackId, error: null };
    // playAudio 是 Tavern Helper 的同步公共 API；调用成功返回就代表已把曲目交给其 BGM 播放器。
    playAudio('bgm', { title: `${song} - ${singer}`, url: audioUrl });
    runtimeAudit.audio_played = { status: 'success', error: null };
    // console.info('<st测试/BGM> 搜歌并开始播放', { generationId: runId, song, singer, trackId });
  } catch (error) {
    if (!isCurrentMusicGeneration(runId)) return;

    const message = errorText(error);
    if (!urlResolved) {
      runtimeAudit.music_lookup = { status: 'fail', query, track_id: trackId, error: message };
    }
    runtimeAudit.audio_played = { status: 'fail', error: message };
    runtimeAudit.last_error = message;
    console.warn('<st测试/BGM> 搜歌或播放失败，跳过本轮 BGM', { generationId: runId, message });
  }
}

/**
 * 【新增】判断这一次生成事件,是不是"真正会显示给你看的对话"。
 *
 * - type === 'quiet'  → 酒馆背景里的隐藏请求(比如自动摘要),跳过不追踪
 * - dry_run === true  → 只是"试跑一下看看prompt长什么样",不是真的要生成给你看,跳过
 * - 其他情况(normal / swipe / regenerate / continue / impersonate ...)
 *   → 都是会真实显示在聊天界面的内容,要追踪
 */
function shouldTrack(type: string, dryRun: boolean): boolean {
  if (dryRun) return false;
  if (type === 'quiet') return false;
  return true;
}

function startGeneration() {
  generationId += 1;
  const currentGenerationId = generationId;
  // 新 generation 出现后，旧的网络请求即使晚到，也不允许再开始播放。
  activeMusicGenerationId = currentGenerationId;
  runtimeAudit.run_id = currentGenerationId;
  runtimeAudit.generation = { status: 'success', id: currentGenerationId };
  runtimeAudit.marker = { status: 'pending', matched: false, song: null, singer: null, error: null };
  runtimeAudit.stream_finished = { status: 'pending', message_id: null, error: null };
  runtimeAudit.music_lookup = { status: 'pending', query: null, track_id: null, error: null };
  runtimeAudit.audio_played = { status: 'pending', error: null };
  runtimeAudit.last_error = null;
  activeScanner = createMarkerScanner(currentGenerationId, action => {
    //   console.info('<st测试/BGM> marker resolved', { generationId: currentGenerationId, action });
    runtimeAudit.marker = {
      status: 'success',
      matched: action.type !== 'none',
      song: action.song ?? null,
      singer: action.singer ?? null,
      error: null,
    };
    if (action.type === 'play' && action.song && action.singer) {
      // 不 await：播放准备和 AI 继续流式输出并行进行，标记出现后即可开始搜歌。
      void searchAndPlayBgm(currentGenerationId, action.song, action.singer);
    }
    if (action.type === 'stop') {
      activeMusicGenerationId = 0;
      pauseAudio('bgm');
    }
  });
  // // console.info(`<st测试/BGM> generation started #${currentGenerationId}`);
}

removeLegacyTestControls();
installPersistentBgmPrompt('script_loaded');
eventOn(tavern_events.CHAT_CHANGED, () => installPersistentBgmPrompt('chat_changed'));

// 【已修复】这里以前直接把 startGeneration 挂上去,完全没看 type/dry_run,
// 现在先判断 shouldTrack(),不是"真实对话"就直接跳过,不动 scanner。
eventOn(tavern_events.GENERATION_STARTED, (type: string, _option: unknown, dry_run: boolean) => {
  if (!shouldTrack(type, dry_run)) {
    // console.info('<st测试/BGM> 跳过非真实对话的生成', { type, dry_run });
    return;
  }
  startGeneration();
});

eventOn(tavern_events.STREAM_TOKEN_RECEIVED, (fullText: string) => {
  //  console.log('<st测试/BGM>收到流式文本:', fullText); // 临时调试用,这一行是新加的
  if (!activeScanner) startGeneration();
  activeScanner?.pushSnapshot(fullText);
});

// 【已修复】同样加上 type 判断,quiet 类型的"消息接收"不应该去 finish 真正的 scanner。
eventOn(tavern_events.MESSAGE_RECEIVED, (messageId: number, type: string) => {
  if (type === 'quiet') {
    // console.info('<st测试/BGM> 跳过 quiet 消息,不结束 scanner', { messageId });
    return;
  }
  let action = activeScanner?.getState().action ?? null;
  if (activeScanner && !action) {
    const finalMessage = getChatMessages(messageId)[0]?.message ?? '';
    activeScanner.pushSnapshot(finalMessage);
    action = activeScanner.finish();
  } else if (activeScanner) {
    action = activeScanner.finish();
  }
  runtimeAudit.stream_finished = { status: 'success', message_id: messageId, error: null };
  if (action?.type === 'none' && runtimeAudit.marker.status === 'pending') {
    runtimeAudit.marker = { status: 'success', matched: false, song: null, singer: null, error: null };
  }
  // console.info('<st测试/BGM> stream finished', { generationId, messageId, type, action });
  activeScanner = null;
});

eventOn(tavern_events.GENERATION_STOPPED, () => {
  activeMusicGenerationId = 0;
  activeScanner = null;
  // console.info('<st测试/BGM> scanner reset after generation stopped');
});

eventOn(tavern_events.MESSAGE_SWIPED, (messageId: number) => {
  activeMusicGenerationId = 0;
  activeScanner = null;
  // console.info('<st测试/BGM> scanner reset after swipe', { messageId });
});

runUnitTests();
