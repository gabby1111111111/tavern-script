# 杠杠の生图机 V0.3.0

一个运行在 SillyTavern / Tavern Helper 中的轻量异步生图脚本。正文 AI 按当前画图预设输出
`<pic prompt="...">`，脚本在正文完成后异步生图；失败只跳过图片，不阻塞聊天。

当前稳定版本为 v0.3.0，公开安装请使用固定标签 `杠杠の生图机-v0.3.0`。

## 安装

前置条件是已安装 SillyTavern 与 Tavern Helper，并且 Tavern Helper 可以加载后台脚本。

新建一个 Tavern Helper 后台脚本，填入下面的固定版本导入语句：

```ts
import 'https://testingcf.jsdelivr.net/gh/gabby1111111111/tavern-script@杠杠の生图机-v0.3.0/dist/杠杠の生图机/index.js';
```

加载后，在扩展设置中应看到标题为“杠杠の生图机 V0.3.0”的设置抽屉。也可以从对应 GitHub Release 下载
`index.js` 后，按 Tavern Helper 的脚本导入方式加载。

## 用户怎么使用

1. 在“画图预设”中选择或新建预设，填写要发给正文 AI 的指令。
2. 在“出图预设”中用 `{{xx}}` 接入正文 AI 解析出的图片提示词；需要角色一致性时，可开启当前 User 与角色头像参考，固定顺序为 User 图 1、角色图 2。
3. 在“最近生成”中设置本页保留数量（默认 10 张，可设 1–50 张），并按需删除图片或保存到角色图库。
4. 选择展现方式：
   - `插入正文`：图片生成后放在 `<pic>` 对应段落附近。
   - `礼物异步`：不插入正文，只进入“最近生成”列表，同一楼最多提示一次已送达。
5. 设置“隔几楼”：`0` 表示每个新正常 AI 回复都尝试；`1` 表示第 1 楼尝试、跳过 1 楼、再尝试；依此类推。
6. 在“API 设置”中配置服务地址、模型、API Key、尺寸、超时和额外 JSON。

脚本只统计本次页面运行期间的新 `normal`
AI 回复。重新生成、swipe、quiet、impersonate、加载历史等不会增加计数；切换聊天后从头计数。v0.3.0 暂不在群聊中生图。

## 图片与保存

- 每个符合频率的楼层最多处理两条有效 `<pic>`。
- 生成图片默认只保存在当前页面 JavaScript 内存中，默认最多保留 10 张；用户可在“最近生成”中调整为 1–50 张。
- 刷新、脚本重载、卸载或切换聊天后，内存图片会消失，不回扫历史。
- 只有用户明确点击“保存到角色图库”时才调用 SillyTavern `/api/images/upload`；图片列表不承担其他持久化操作。
- 图库保存失败时，页面内存中的原图仍保留，可以再次点击。
- 图片、Base64 和图片地址不会写入 Tavern Helper 脚本变量、聊天变量、消息变量、`localStorage` 或 IndexedDB。

API Key 会以明文保存在 Tavern Helper 脚本变量中。请使用权限受限、可撤销的 Key，不要分享含设置的导出内容。

## v0.2 升级

- 多 API 档案、Key、模型、尺寸、超时和额外 JSON 会保留。
- 旧随文提示词会合并为默认画图预设。
- 旧礼物提示词会合并为“v0.2 礼物 CG 兼容预设”，不会静默丢失文字配置。
- 旧的三张手工参考图只存在于页面内存，不迁移；v0.3 改为读取当前 User 与角色头像。
- 旧手动礼物任务、3/5 楼调度和预测槽已移除。

## API 请求

运行时统一调用：

```ts
requestImage(profile, { prompt, referenceImages? }, signal)
```

无参考图时发送普通 generation 请求；有参考图时按端点/档案兼容 multipart
edit、Chat 多模态或 JSON 参考图。每个任务只请求一次，不自动重试。

## 开发与验收

- ESLint：`pnpm exec eslint "src/杠杠の生图机"`
- 相关回归脚本位于仓库根 `tests/`。
- 生产构建：`pnpm build`
- 真实运行时需检查 `window.__storyImageAudit` 的
  `run_id`、`lifecycle`、`injection`、`generation`、`markers`、`tasks`、`gift`、`cache` 和 `last_error`。
- 头像参考、不同 API 请求模式、inline、gift、图库保存都必须在真实 SillyTavern 中单独验收；静态构建不能替代。

进一步阅读：[代码线路图](docs/ARCHITECTURE.md) · [变更记录](CHANGELOG.md) · [Agent 协作规则](AGENTS.md)
