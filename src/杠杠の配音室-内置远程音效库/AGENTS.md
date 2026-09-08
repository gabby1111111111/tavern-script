# Repository Guidelines

## 本目录的职责

`src/杠杠の配音室-内置远程音效库` 是“杠杠の配音室”的薄 Edition
wrapper，只负责注入固定 revision 的远程音效目录能力并生成独立 dist。

先遵守仓库根 `AGENTS.md` 和
[`../杠杠の配音室/AGENTS.md`](../杠杠の配音室/AGENTS.md)。共享 TTS、AI 配音表、朗读、缓存、Audit、播放生命周期和设置逻辑均以
`src/杠杠の配音室` 为唯一来源，不得在本目录复制一套实现。

## 不得破坏的 Edition 合同

- 功能版本与纯自定义音效版保持一致；首版为 `0.1.0`，共用 Tag `杠杠の配音室-v0.1.0`，本 Edition 作为预览附件上传。
- 本 dist 固定为 `dist/杠杠の配音室-内置远程音效库/index.js`，不得覆盖默认 `dist/杠杠の配音室/index.js`。
- 素材 revision 固定为 `f800e5e4f23508b3336d63a7274f4108b84e30c1`；禁止运行时读取 `main` 或无版本 URL。
- 远程 Edition 专属名称、仓库地址、目录按钮和请求逻辑不得进入纯自定义生产 bundle。
- 两个 Edition 不得同时启用。共享设置 schema 不代表共享持久化实例；`{ type: 'script' }` 变量随 Tavern
  Helper 脚本实例隔离。
- 仅传音效 ID、名称、分类和说明给 AI；不得发送 OGG URL、完整目录响应或素材内容。
- 目录只驻留页面内存，OGG 按需请求；不得把远程目录、音频 Blob 或 Base64 写入脚本变量、聊天变量、localStorage 或 IndexedDB。

## 预览与素材边界

- 上游数据库公开可访问，本 fork 还含维护者自己补充的内容；维护者已明确批准本次 `0.1.0` 与纯自定义版一起上传。
- 发布声明必须链接 `THIRD_PARTY_NOTICES.md`，保留 fork、上游和精确 revision。
- 当前没有可识别 LICENSE 或逐文件来源；本 Edition 必须标为预览，不得把上传行为描述成音效授权。
- 本次批准不自动延续到后续版本；未来再次附带本 Edition 前必须重新询问 Gabby。
- 不得宣称已授权、免费商用、自由分发，也不得把“音频未打包”推导成使用许可。
- 仓库根 `LICENSE` 是指向 Ghostscript subject matter 的 AFPL
  v9 文本，是否清晰适用于本项目尚未由维护者确认。Agent 不得擅自更换许可证或作确定性法律结论。

## 验证路线

1. 命令验收：运行两个源码目录的 scoped ESLint、全部配音室测试、豆包 bridge 测试和生产构建。
2. 制品隔离：纯自定义 bundle 对本 Edition 的展示名称、素材仓库、请求域名和目录按钮文案负向扫描为零；远程 bundle 能识别固定 revision。
3. 运行时验收：只启用本 Edition，在 8000 检查目录加载、AI
   Cue、原文按钮、speech/sound 串行、失败跳过和 Stop/宿主事件取消。
4. 网络验收：目录请求必须绑定固定 revision；OGG 只在实际试听或播放时请求。
5. 隐私验收：Audit、console、AI Prompt 和错误信息均不含音频 URL、正文、Key、cookie 或完整设置。
6. 人工验收：只判断音效质量、音量、停顿和移动端舒适度。

watch 产物不能用于本次上传。必须生成生产包并对 exact artifact 验收；共享核心测试也不能替代本 wrapper 的真实加载证据。

## Git 与协作

- 本仓库为共享脏工作区；本次 `0.1.0` 已获准显式暂存本目录和 `dist/杠杠の配音室-内置远程音效库`，但仍禁止 `git add -A`。
- 不得从本次批准或“远程仓库可访问”推断为后续版本也能自动公开插件或维护者新增的内容。
- 不撤销其他 Agent 的改动，不自行 commit、Tag、push、pull、rebase 或发布。
- 修改共享核心前先确认当前写入者；同一个文件同一时刻只能有一个 Agent 写入。
