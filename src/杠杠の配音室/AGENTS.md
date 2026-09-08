# Repository Guidelines

## 先读：这是怎样的项目

“杠杠の配音室”是 Tavern
Helper 前端脚本。它把 TTS 配置、AI 自动配音表、五种朗读路线、最近十条语音和原文旁音效按钮放进一个轻量面板。

维护者不需要记住每个函数和变量，但必须能回答：用户动作从哪里进来、经过哪条管线、状态写到哪里、出错时先查哪一段。

## 默认制品边界

- `src/杠杠の配音室` 是纯自定义音效正式版的共享核心和默认入口。
- 用户 README、UI、运行时请求和 `dist/杠杠の配音室/index.js` 只能呈现用户自行配置的音效；不得隐式加载任何内置目录。
- `edition.ts` 只定义小型能力注入边界。默认入口必须始终传入
  `CUSTOM_ONLY_VOICE_EDITION`，共享核心不得反向导入任何可选 wrapper。
- 设置结构不保存 Edition 或产品版本。若用户新建另一个 Tavern Helper loader 脚本，`{ type: 'script' }`
  变量按脚本实例隔离，不会自动继承 Profile、Key、配音表或自定义音效。

## 与 Gabby 协作

- 默认用中文，先说结论，再说证据和下一步。
- 能用离线测试、Audit 或真实 8000 环境证明的，Agent 自己完成；不要反复把测试交还给 Gabby。
- 人工验收只保留声音是否好听、音量/停顿是否自然、移动端是否舒服等主观判断。
- 汇报问题时必须指出“事件 → 函数 → 模块”的具体位置，不要只报抽象术语。
- 非琐碎改动先给 `Step N` 计划，明确命令验收、运行时 Audit 验收和剩余人工验收。
- 本仓库是多脚本仓库，只操作本项目的显式路径并保留其他 Agent 的改动。
- 不要擅自重启 8000；必须先告诉 Gabby。未经明确授权绝不操作 8001。
- 不提交、Tag、推送、发布或清理其他项目改动，除非 Gabby 明确授权目标和动作。

## 一眼看懂总路线

```text
宿主事件 / Vue 按钮 / 消息旁按钮
  → runtime.ts（唯一业务编排中心）
  → tts/text.ts（文本解析）
  → reading.ts（朗读路由）
  → reading-timeline.ts（speech/sound 时间线）
  → tts/providers.ts 或 SoundEffectPlayer
  → RecentVoiceStore / 浏览器音频
  → audit.ts + Vue 状态 + 消息旁图标
```

Provider、TTS 缓存、最近语音、AI 配音表和音效计划是不同责任，不要揉成一个巨型 Manager。

## 事件到函数路线图

| 用户或宿主事件              | 第一入口                                          | 主要管线                                                             | 最终副作用                               |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| 脚本加载 / 热重载           | `index.ts` → `bootstrap.ts: registerVoiceConsole` | 创建 runtime → `runtime.start`                                       | 挂载面板与 `window.__ganggangVoiceAudit` |
| 检查 TTS / 读取音色         | `probeAndLoadVoices`                              | Provider Registry → adapter `probe/listVoices`                       | 更新页内音色与 Provider Audit            |
| 一键 AI 配音表              | `generateCasting`                                 | `readCurrentCastingContext` → `generateCastingTable` → `generateRaw` | 写当前角色卡的 `castingByCharacter`      |
| 朗读最新消息 / 楼层         | `readLatest/readMessage`                          | `parseSpokenSegments` → `routeSegments` → `playRoutedSegments`       | 严格串行播放并写最近语音                 |
| 朗读选中文字                | `readSelection`                                   | 定位楼层 → `mapSelectionToSegments` → `routeAndPlay`                 | 朗读映射到的片段                         |
| 原文旁对白喇叭              | `MessageControlManager.onPlaySegment`             | `readOneSegment` → 路由 → `playRoutedSegments`                       | 生成/复用该行语音                        |
| 最近十条播放/暂停/重生/下载 | runtime 对应方法                                  | `RecentVoiceStore`                                                   | 页内列表、播放器、下载                   |
| AI 配最新音效               | `planLatestSoundEffects`                          | 捕获当前消息 → `ensureSoundCues` → `planSoundCues`                   | 只提交当前代次 Cue                       |
| 原文旁音效喇叭              | `onPlaySoundEffect`                               | `playSoundEffect` → `SoundEffectPlayer.play`                         | 独立试听音效                             |
| 整段朗读插入短 SFX          | `playRoutedSegments`                              | `buildReadingTimeline` → speech/sound 串行                           | 台词 → SFX → 台词                        |
| Stop                        | `stopAll`                                         | `stopAllWithReason` → 废止代次 → abort Provider/AI → 停 speech/sound | 旧 Promise 结算，Audit 留下 `user-stop`  |
| 换聊天/重抽/编辑/删除       | `runtime.start` → `bindVoiceLifecycleEvents`      | 带 reason 的 Stop → 按事件清 Cue/inline map                          | 旧状态不污染新楼层，事件链可离线测试     |
| pagehide / 热重载           | `bootstrap.ts cleanup` → `runtime.stop`           | 解绑事件、停止媒体、释放 URL                                         | 不留活动媒体                             |
| 设置变化                    | Vue watch → `scheduleSettingsSave`                | `updateVoiceSettings`                                                | 写 Tavern Helper 脚本变量                |

## 文件责任

- `index.ts`：正式版薄入口，只注册 `CUSTOM_ONLY_VOICE_EDITION`。
- `bootstrap.ts`：挂载、Audit 暴露、pagehide/热重载清理。
- `edition.ts`：产品版本、默认 Edition 和可选目录能力边界。
- `VoiceSettings.vue` / `index.scss`：面板与交互。
- `runtime.ts`：编排和生命周期代次；这里决定动作走哪条路。
- `lifecycle-events.ts`：CHAT_CHANGED / SWIPE / EDIT / DELETE 的可测试宿主事件边界。
- `types.ts`：公共数据合同。
- `settings.ts`：默认值、规范化和脚本变量持久化。
- `context.ts` / `casting.ts`：AI 配音表上下文、提示、校验和取消。
- `tts/text.ts`：`<content>` 提取与旁白/对白切分。
- `reading.ts`：五种朗读方式和角色覆盖优先级。
- `reading-timeline.ts`：把已路由语音与已规划短 SFX 合成时间线。
- `playback.ts`：最近十条、speech 播放、生成取消、Object URL 所有权。
- `sound-casting.ts`：把消息、片段和无 URL 的目录元数据交给 AI。
- `sound-effects.ts`：Cue 校验和 ended/error/cancelled 结算。
- `message-controls.ts`：楼层按钮 DOM 与图标生命周期。
- `audit.ts`：无正文、无 URL、无 Key 的验收对象。
- `tts/providers.ts` 与 `tts` 下 request 模块：Provider adapter 和协议。
- `server-plugins/ganggang-tts-bridge`：豆包同源窄桥接，不属于浏览器 bundle。

## 出问题先去哪条路找

| 症状                | 第一检查点                                            | 然后检查                                              |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| 面板没出现          | 角色脚本 loader 的 `localhost:5500` 是否在线并带 CORS | `bootstrap.ts` 挂载、watch bundle、Tavern Helper 监听 |
| 正文漏读/对白识别错 | `tts/text.ts` fixtures                                | `reading.ts` 模式过滤                                 |
| 角色声音分错        | `runtime.routeSegments`                               | 配音表、角色 override、默认路由                       |
| Provider 失败       | `tts/providers.ts` adapter                            | request builder；豆包再查 bridge                      |
| 一直 generating     | `prepareSegment` 与 AbortSignal                       | Provider、IndexedDB、代次是否过期                     |
| Stop 后旧声音回来   | `playback.ts` pending-play race                       | `readingSequence/lifecycleEpoch`                      |
| 两个声音重叠        | `playRoutedSegments`                                  | `playSoundEffect` 是否先废止旧朗读                    |
| 音效位置错          | `sound-casting.ts` segment/occurrence                 | `reading-timeline.ts` 拆段                            |
| 音效失败后不继续    | `playCueToEnd`                                        | runtime 的 sound-skip 分支                            |
| 行内图标不更新      | `message-controls.ts`                                 | `inlineRecentItems` 与缓存扫描                        |
| 刷新后设置丢失      | `settings.ts`                                         | Tavern Helper script 变量作用域                       |
| 最近十条异常        | `playback.ts`                                         | recent 历史与音频缓存是两层                           |
| Audit 看不到运行    | `bootstrap.ts` 顶层 window 暴露                       | `audit.ts` run_id                                     |

## 不得破坏的合同

- Provider 可替换，新功能不能硬编码到单一 TTS。
- 凭据绝不进入 AI Prompt、cache key、Audit、console 或错误正文。
- AI 配音表和 AI 音效计划都只能由明确点击触发。
- 新朗读、手动音效、Stop、换聊天、重抽、编辑、删除或卸载必须废止旧播放。
- `audio.play()` pending 时 Stop 也必须立即结算外层 Promise。
- speech 和短 SFX 严格串行，`max_active` 必须为 1；SFX 失败跳过，TTS 失败终止。
- Ambience 是独立试听/未来背景 lane，不能阻塞串行朗读。
- 最近十条是页内历史；合成缓存是 `memory → IndexedDB`，Blob/base64 不写设置。
- Object URL、listener、AbortController 必须在结束、失败、取消、替换和卸载路径清理。

## 验证与发布

- 本地实时链是 `pnpm watch` → `dist/杠杠の配音室/index.js` → 带 CORS 的 `http://localhost:5500` 静态服务 →
  8000 角色脚本 loader；只开 watch 不会自动提供 5500。
- 八组测试：`tests/ganggang-voice-{tts,playback,reading,casting,sound-casting,audit,runtime-lifecycle,editions}.test.ts`。
- Lint 限定本源码目录和配音室测试，不把其他脚本纳入本项目修复。
- 真实验收读取 `window.__ganggangVoiceAudit`，不回传正文、URL、Key、cookie 或完整设置。
- 第一版 Tag：`杠杠の配音室-v0.1.0`；不要复用仓库全局自动 bundle Tag。
- 显式暂存本源码目录、配音室测试、豆包 bridge、目标 dist 和目标文档；禁止 `git add -A`。
- 本次 `0.1.0` 已明确批准同时上传纯自定义版和内置目录预览版；后续 Release 是否继续附带预览版，必须再次询问 Gabby。
- watch 产物是开发 bundle，不能公开发布；生产构建后必须用 exact artifact 完成 8000 实机验收。
- 纯自定义生产 bundle 必须对所有内置目录标识、请求域名和按钮文案做负向扫描，结果应为零匹配；浏览器 Network 也不得访问相应目录或音频域名。
- 仓库根 `LICENSE` 当前是指向 Ghostscript subject matter 的 AFPL
  v9 文本，是否清晰适用于本项目尚未确认。发布前必须由维护者选择并确认代码许可证；Agent 不得擅自替换、解释为已授权或在 README 中作确定性承诺。
- Edge 是外部可选依赖；豆包需要可选 server bridge。
