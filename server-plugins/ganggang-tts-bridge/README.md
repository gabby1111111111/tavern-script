# Ganggang TTS Bridge

“杠杠の配音室”的 SillyTavern server companion：只提供豆包 TTS 与 Fish Audio 的同源窄桥接，不是通用网络代理。

> **不属于 v0.2.0 运行时的组成部分。** 配音室 v0.2.0 的浏览器侧已完全脱离本插件（豆包/小米/MiniMax 直连，
> Fish 走酒馆自带 `/proxy`），因为它存在的唯一理由是"非浏览器消费者"（桌宠、后台服务等）——也就是**语音插座阶段**。
> 因此本目录连同 `tests/` 的 44 个用例被保留为插座阶段资产，不随 v0.2.0 装配。

## 路由

- `GET /api/plugins/ganggang-tts-bridge/capabilities`
- `POST /api/plugins/ganggang-tts-bridge/probe`
- `POST /api/plugins/ganggang-tts-bridge/doubao/synthesize`
- `POST /api/plugins/ganggang-tts-bridge/fish/synthesize`

## 安全边界

- 上游固定为豆包 v3 单向 TTS。
- 凭据只转发当前请求，不持久化。
- 错误使用固定错误码，不回显正文、Key 或上游响应原文。
- 有正文、上下文、音频大小和超时上限。
- 不接受任意目标 URL，不能用作 SSRF 代理。

## 安装与验证

把整个目录放入目标 SillyTavern 支持的 server plugin 位置，按目标版本说明启用并重启正确实例。看到
`[ganggang-tts-bridge] Plugin loaded.` 后，再在配音室中检查豆包 Profile。

```powershell
node --check server-plugins/ganggang-tts-bridge/index.mjs
node --check server-plugins/ganggang-tts-bridge/doubao.mjs
node --check server-plugins/ganggang-tts-bridge/fish.mjs
node --test server-plugins/ganggang-tts-bridge/tests/doubao.test.mjs server-plugins/ganggang-tts-bridge/tests/fish.test.mjs
```

当前 bridge package 独立版本为 `1.1.0`（与 `index.mjs` 的 `version` / `capabilities.version` 一致），配音室产品版本为 `0.2.0`；两者分别版本化。
