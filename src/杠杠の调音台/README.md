# 杠杠の调音台 v0.3.0

一个运行在 SillyTavern / Tavern Helper 中的 BGM 与环境音后台脚本。它根据正文 AI 输出的控制标记自动搜索、播放并维护音频。

当前稳定版本为 v0.3.0，公开安装请使用固定标签 `杠杠の调音台-v0.3.0`。

## 安装

前置条件是已安装 SillyTavern 与 Tavern Helper，并允许 Tavern Helper 加载后台脚本。

新建一个 Tavern Helper 后台脚本，填入固定版本导入语句：

```ts
import 'https://testingcf.jsdelivr.net/gh/gabby1111111111/tavern-script@杠杠の调音台-v0.3.0/dist/杠杠の调音台/index.js';
```

加载后，在扩展设置中应看到标题为“杠杠の调音台 v0.3.0”的设置抽屉。

## 功能

- BGM 可使用完全随机模式，或从指定网易云歌单中抽取候选歌曲。
- 环境音根据正文地点从 Bilibili 搜索白噪音，并支持备用 BV 号。
- 提示词支持新建、选择、保存和删除多套方案；修改从下一轮 AI 回复开始生效。
- 可设置“隔几楼出歌”：`0` 表示每个新正常 AI 回复都发送出歌提示，`1` 表示第 1、3、5 楼发送，依此类推。
- 可选“Swipe 新回答也出歌”；Swipe 不推进正常正文楼层计数。
- 播放列表缓存数量和网易云候选抽取数量均可设为 1–20。

## 使用

1. 在“BGM”中开启模块并选择歌曲来源。
2. 在“环境音”中按需开启环境音，并填写备用 BV 号。
3. 在“提示词”中选择现有方案，或新建、编辑并保存自己的方案。
4. 在“更多”中调整播放列表、候选数量、出歌间隔和 Swipe 行为。

## 已知限制

- 不同 SillyTavern / Tavern Helper 运行时的 Swipe 事件顺序可能不同，“Swipe 新回答也出歌”仍可能偶发不触发。追求稳定时建议关闭该选项，让新正常正文楼按“隔几楼出歌”规则换歌。
- 远程音乐接口、跨域代理或浏览器自动播放策略不可用时，本轮音频可能无法播放；正文生成不会因此中断。

## 数据与安全

- 设置保存在 Tavern Helper 的脚本变量中。
- 脚本不会把播放结果写进聊天正文。
- 发布包不包含 API Key、Cookie、聊天内容或本机路径。

## 开发与验收

- 专项测试：`pnpm exec ts-node --transpile-only --compiler-options '{"module":"CommonJS","moduleResolution":"Node","ignoreDeprecations":"6.0"}' tests/ganggang-bgm-settings.test.ts`
- ESLint：`pnpm exec eslint "src/杠杠の调音台" "tests/ganggang-bgm-settings.test.ts"`
- 生产构建：`pnpm build`
- 真实运行时可通过 `window.__ganggangConsoleAudit` 核对提示注入、标记解析、音乐查询、播放列表、环境音和播放结果。

进一步阅读：[变更记录](CHANGELOG.md) · [v0.3.0 发布说明](docs/releases/v0.3.0.md)
