# Changelog

本文件采用 Keep a Changelog 风格。

## [Unreleased]

## [0.2.0] - 2026-10-08

### Added

- Fish Audio 引擎接入：动态拉取音色市场（公开接口，浏览器直连）、FAS2 情绪标签随台词透传；合成经酒馆自带的 `/proxy` 转发（上游 `POST /v1/tts` 的 CORS 预检 404，浏览器直连不可行）。
- 试音台标签页：任选引擎与音色（可手填 voiceId），按引擎变形的原生情绪控制（小米导演台本、豆包 context_texts、MiniMax 情绪档位、Fish FAS2 标签）；逐家"测试连接"状态灯；样本进入最近 10 条。
- probe 升级为真实合成"你好"验证凭据与额度，失败原因按 凭据/额度/审核/网络/服务 分类展示（沿用凭据脱敏纪律）。
- 一键 AI 配音表输入扩充：用户 persona 设定，以及用户与角色卡绑定世界书中当前启用的条目（按生成时刻状态原样发送，不设长度上限；单一来源读取失败只跳过该来源）。
- 配音表支持手动增删改：新增/删除角色条目、编辑名称与别名、一键互设旁白；修改前按同款不变式校验（恰好一个旁白、名称/别名唯一），失败不落盘。

### Changed

- **传输层迁移：全部引擎零服务端安装。** 豆包改用浏览器直连（`X-Api-*` 请求头 + 客户端解析 NDJSON 分片流）；Fish 合成改走酒馆自带 `/proxy`；小米与 MiniMax 维持原有直连。浏览器侧不再请求 `ganggang-tts-bridge`。
- `ganggang-tts-bridge` 整体退出 v0.2.0 运行时依赖（降级为"语音插座"阶段资产）：桥接代码与其 44 个用例保留在仓库，但不再随配音室装配。
- Fish 请求把模型放在**请求头** `model`（缺省 `s2.1-pro-free`）：漏该头会默认走付费模型并返回 402，与免费档额度无关。
- `/proxy` 会丢掉上游 `Content-Type`，因此音频 MIME 改为"文件魔数优先、响应头兜底"识别（ID3/MP3 帧同步/RIFF-WAVE/OggS/fLaC）；`/proxy` 音频另设 25MB 上限与 120 秒硬超时。
- provider 失败文案本地化：404 → 提示打开 `enableCorsProxy` 并重启酒馆；402 → 提示确认请求头 `model` 是免费档；403 / 45000000 / 55000000 → 统一点明"音色与资源 ID 不配套"（拿非配套音色去配 `seed-tts-2.0` 即此族）。
- `provider_ready.mode` 增加 `proxy`（浏览器直连 = `direct`，经酒馆 `/proxy` = `proxy`，经 server 插件 = `plugin`）。

### Fixed

- `CASTING_JSON_SCHEMA` 不再携带 `minItems`/`maxItems`/`minimum`/`maximum`/`enum` 约束关键字，避免被严格校验 JSON Schema 的 OpenAI 兼容网关以 400 Bad Request 拒绝；生成结果仍由代码侧 `parseCastingResult` 完整校验。

### Distribution

- 版本：`0.2.0`
- Tag：`杠杠の配音室-v0.2.0`
- 正式制品：`dist/杠杠の配音室/index.js`（纯自定义音效版）。
- 前置要求：只有 Fish Audio 需要酒馆 `config.yaml` 的 `enableCorsProxy: true`（且 `basicAuthMode: false`），改完必须重启酒馆；豆包/小米/MiniMax/Edge 零额外安装。

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
