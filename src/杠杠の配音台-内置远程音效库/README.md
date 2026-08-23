# 杠杠の配音台 · 内置远程音效库版

这是“杠杠の配音台”`0.1.0`
的可选 Edition：保留同一套 TTS、AI 配音表、朗读路线、最近十条和播放生命周期，并额外提供一套可直接读取的远程 SFX/Ambience 目录。

> 发布级别：预览附件。本 fork 在公开来源的目录上加入了维护者自己的内容；维护者已明确同意本次 `0.1.0`
> 与纯自定义版一起上传，但本 Edition 不是默认推荐版，也不作素材授权承诺。

## 版本与制品

- 功能版本：`0.1.0`
- 与纯自定义音效版共用 Tag：`杠杠の配音台-v0.1.0`
- 预览 dist：`dist/杠杠の配音台-内置远程音效库/index.js`
- 固定素材 revision：`f800e5e4f23508b3336d63a7274f4108b84e30c1`

Edition 跟随共享核心版本，不单独制造另一套 SemVer 或 Tag。本次作为同一 GitHub
Release 的第二个、明确标注为预览的附件上传。

## 安装与切换

1. 确认没有同时启用 `dist/杠杠の配音台/index.js`。两个 Edition 会挂载同一个面板和全局清理入口，只能选择一个。
2. 在 Tavern Helper 中加载固定 Tag 下的 `dist/杠杠の配音台-内置远程音效库/index.js`，不要依赖持续变化的 `main` 分支。
3. 配置 TTS Profile，检查音色并生成 AI 配音表。
4. 在音效页读取内置目录，再试听、请求 AI 放置音效按钮或进行整段朗读。

两个 Edition 的设置结构兼容，但 Tavern
Helper 的脚本变量按脚本实例隔离。如果把本 Edition 导入成一个新的脚本实例，原脚本中的 Profile、API
Key、配音表和自定义音效不会自动出现。需要保留设置时，优先备份设置并在同一个 Tavern Helper 脚本中替换 `import`
URL；不要同时保留两条已启用的 loader。

## 远程目录如何工作

- 目录来源为 [gabby1111111111/ST-Audio-Assets](https://github.com/gabby1111111111/ST-Audio-Assets)，其上游为
  [Ellinav/ST-Audio-Assets](https://github.com/Ellinav/ST-Audio-Assets)。
- 本版只读取固定 revision `f800e5e4f23508b3336d63a7274f4108b84e30c1`，不得在运行时跟随分支最新提交。
- JavaScript 制品不打包 OGG 音频。运行时只请求该固定 revision 的目录元数据，并在实际试听或播放时请求所选 OGG。
- 目录只保留在当前页面内存，刷新后重新读取；音频文件不会写入 Tavern Helper 设置。
- 短 SFX 可以插入整段朗读；Ambience 独立试听，不阻塞台词队列。
- 进一步的来源与授权说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 隐私与存储

- AI 配音表仍只在明确点击后接收当前角色卡、设置范围内最近聊天和音色目录。
- AI 音效计划只接收当前消息、可朗读片段以及音效 ID、名称、分类和说明；音频 URL 不发送给酒馆 AI。
- API Key 不发送给酒馆 AI，也不得进入 Audit、缓存描述、第三方声明或日志。
- Profile、凭据、配音表和用户自定义音效元数据保存在当前 Tavern Helper 脚本实例变量中。
- 最近十条只在页面内存；TTS 合成缓存使用当前浏览器 origin 的内存与 IndexedDB。

## 授权边界

上游数据库公开可访问不等于自动获得任意再分发许可；同时，本 fork 还包含维护者自行补充的内容。本次可以作为预览版上传，但：

- 不得把“运行时远程请求”描述成已获得音频复制或使用许可。
- 不得写“免费商用”“自由分发”或类似结论。
- 不得把本次上传解释为对其中音效的再授权，也不得替维护者承诺后续版本继续公开。
- 后续 Release 是否继续附带本 Edition，必须由维护者再次明确决定。

## 开发与验收

- 共享业务规则见 [`../杠杠の配音台/AGENTS.md`](../杠杠の配音台/AGENTS.md)；本 wrapper 的额外规则见
  [AGENTS.md](./AGENTS.md)。
- 本 Edition 的用户可见变更见 [CHANGELOG.md](./CHANGELOG.md)。
- 发布前必须使用生产 bundle，并在真实 8000 环境确认加载的是本 dist，而不是纯自定义制品。
- Audit 应能证明 Edition、目录条数、串行 speech/sound 和取消路径；固定 revision 由制品常量、界面版本与 Network 请求共同核对。任何验收证据都不得包含正文、音频 URL、Key 或完整设置。
- 浏览器 Network 只应看到声明的目录请求和按需 OGG 请求；不得请求分支最新 revision。
- 人工验收只保留远程音效是否合适、音量是否自然以及移动端体验。
- 本次 `0.1.0` 进入公开发布清单并标为预览；这一决定不自动延续到后续版本。
