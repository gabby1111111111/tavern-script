# Changelog

本文件采用 Keep a Changelog 风格。

## [Unreleased]

## [0.1.0] - 2026-09-09

### Added

- 多 TTS Provider Profile、音色发现与 AI 自动配音表。
- 五种朗读方式、最近十条、重新生成、下载和行内对白按钮。
- 自定义音效、AI Cue、行内音效按钮和 speech/sound 时间线。
- `window.__ganggangVoiceAudit` 小型运行时验收对象。
- CHAT_CHANGED、重抽、编辑和删除的可测试宿主事件边界。
- 可选豆包同源窄桥接。

### Changed

- 产品公开名称确定为“杠杠の配音室”。
- 默认 `dist/杠杠の配音室/index.js` 只提供用户自定义音效，不包含内置目录入口。
- AI 音效 Cue 绑定真实可朗读片段和重复锚点序号。
- Ambience 与短 SFX 分流；只有短 SFX 进入串行朗读。
- 新的前台动作废止旧朗读，避免手动音效与旧时间线重叠。
- Stop 与宿主清理动作会记录脱敏 reason，并保留被取消时间线的小型证据。

### Fixed

- 修复 `audio.play()` pending 时 Stop 无法立即结算语音/音效 Promise。
- 覆盖旧 ended/error 回调不得干扰替换播放。
- 修复切聊天期间等待音效来源后误给新消息规划音效。
- 修复旧 AI 配音表 finally 可能清除新任务 busy 状态。
- Audit 使用固定错误码，不回显异常中的正文、URL 或凭据形状。

### Distribution

- 版本：`0.1.0`
- Tag：`杠杠の配音室-v0.1.0`
- 正式制品：`dist/杠杠の配音室/index.js`（纯自定义音效版）。
