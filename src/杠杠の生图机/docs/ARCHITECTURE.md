# 生图机代码线路图

## v0.4.3 当前线路

v0.4.2 已发布（标签 `杠杠の生图机-v0.4.2`，验收状态见 [V0.4.2-DEVELOPMENT.md](V0.4.2-DEVELOPMENT.md)）；v0.4.3 只收尾悬浮面板与正文图片操作界面，不改动以下线路。以下线路替代历史说明中的自动取显示图和只计 normal 的门控。

- `GENERATION_STARTED` → `generation-eligibility.ts` 按消息身份决定新推进或复用位置资格 → `runtime-policy.ts` 保留总开关和 Swipe 开关 → 锁定本轮预设及最近已确认来源。
- `shot-workflow.ts` 分开记录底图、确认及首次聊天推进；runtime 只将已确认 placement 交给 `story-continuity.ts` 按组合和剧情位置选源。未确认镜头回退只用非阻塞提醒。
- 关闭 `usePreviousStoryImage` 时不捕获上一图；正文注入和 `prompt-processor.ts` 同时使上一镜头文字为空，再由模板空值规则写成字面 `null`。
- 具体回答通过消息身份校验后才提交资格并处理标记；删除后的同编号新回答不会继承图片。资格 ledger 与图片生命周期分开，刷新均不恢复。
- `StoryImageWorkbench.vue` 经 `index.ts` 独立挂载到宿主页；它和正文共用 runtime facade。面板候选选择仅为本地预览，确认/放弃才修改镜头状态。
- 面板位置、主题与浏览方式只存在组件内 ref；窗口 resize 时 `clampFloatingPositions()` 把入口和面板拉回视口内，不写入脚本设置。入口与正文图片按钮同为一套图标语义。
- `workbench-types.ts` 向面板传递镜头、候选、任务数及来源楼层；图片内容、镜头文字和关联只留内存，audit 仅记录有界身份和计数。
- 确认清理本镜头并保留其他已锁定请求的资源副本；显式删除来源消息或放弃来源镜头仍按生命周期使相关快照失效。不自动重跑请求。

## 历史：v0.4 开发增量

基线为 v0.3.1，验收状态见 [V0.4-DEVELOPMENT.md](V0.4-DEVELOPMENT.md)。下方 v0.3 线路仍说明既有功能；v0.4 在其上增加以下连接：

- `GENERATION_STARTED` → runtime 读取 renderer 已选图片 → `story-continuity.ts` 按预设组合、前楼和有效 Swipe 选源 → 锁定来源及单镜头文字 → 展开画图预设 `{{xx_pic}}` 后注入。
- 同轮 `MESSAGE_RECEIVED` 的所有 `<pic>` 共用该快照与头像读取结果；`prompt-processor.ts` 展开 `{{xx}}`、`{{xx_pic}}`、`{{reference_sources}}`，将实际来源压缩为有序 `referenceImages`。
- `image-presenter.ts` → `image-placement.ts` 保存仅在页面内存中的原始预设组合与本镜头文字；区域重绘沿用镜头文字，提示词修改更新本镜头文字。
- 快照独立持有图片资源；任务结束、生成未产生回复、取消、关闭和切聊天会释放。源图片被显式删除或自动清理时，关联任务失效；不会偷偷换图。
- v0.3.1 新楼清理仍优先手动固定。若保留的是非有效 Swipe 的固定图，后续选源会跳过它；若直接续写触发的新楼清理删除了已经锁定的源，本轮图片任务失效，不额外保留图来绕过清理规则。
- 审计新增 `continuity`：活动快照数量、状态、来源身份、预设 ID、实际引用数量与类型；不保存图片内容、地址或镜头文字。

## 主数据流

```text
GENERATION_STARTED(normal)
  -> runtime-policy.ts 排除 dry-run / quiet / regenerate / swipe / group
  -> display-policy.ts 依据运行期新 AI 楼层计数决定本楼是否触发
  -> settings.ts 读取当前 drawing preset
  -> injectPrompts() 把 instructionText 发给正文 AI

MESSAGE_RECEIVED(normal assistant)
  -> marker.ts 解析最多两个 <pic>
  -> output-preset.ts 读取当前出图预设快照
  -> prompt-processor.ts 用 templateText 的 {{xx}} 替换解析结果
       useAvatarReferences=false: 不读取头像
       useAvatarReferences=true: avatar-references.ts 按 User 图1、角色图2读取
  -> image-api.ts requestImages(profile, { prompt, referenceImages? }, signal)
  -> image-presenter.ts
       inline: recent cache + placement + message renderer
         同次请求结果按 variantIndex 左右排列
         重绘结果按同 variant 的 revisionIndex 上下追加
       gift: recent cache only + runtime 单次 toast

正文区域重绘
  -> region-redraw-editor.ts 在原图上生成洋红标记图与归一化区域
  -> runtime.ts 仅构造 { prompt: 临时描述与区域说明, referenceImages: [原图, 标记图] }
  -> image-api.ts 发起一次单图请求（不读取头像，不经过出图预设）
  -> 成功结果追加到当前 variant 的纵向 revision；临时描述与标记图不持久化
```

## 模块边界

| 模块      | 文件                                                              | 职责                                                       |
| --------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| 公共契约  | `pipeline-types.ts`                                               | 预设、展现、API 输入、内存键和图库输入                     |
| 画图预设  | `drawing-preset.ts`、`settings.ts`                                | 正文 AI 指令 CRUD、当前预设、v0.2 文本迁移                 |
| 出图预设  | `output-preset.ts`、`prompt-processor.ts`、`avatar-references.ts`  | `{{xx}}` 模板 CRUD、头像硬门控与 User→角色引用顺序         |
| 图片 API  | `image-api.ts`                                                    | 统一请求输入、一次请求、响应资源解析                       |
| 展现策略  | `display-policy.ts`                                               | `skipFloors + 1` 频率纯函数                                |
| 页面展现  | `image-presenter.ts`、`image-placement.ts`、`message-renderer.ts`、`region-redraw-editor.ts` | inline placement、区域标记编辑器或 gift recent-only       |
| 内存缓存  | `task-cache.ts`、`recent-image-cache.ts`、`image-system.ts`       | 任务隔离、1–50 张可调最近池与资源释放                       |
| 主动保存  | `gallery-storage.ts`                                              | 用户点击后 POST `/api/images/upload`                       |
| 编排/审计 | `runtime.ts`、`runtime-policy.ts`                                 | 事件门控、任务生命周期、`window.__storyImageAudit`         |

## 频率语义

运行时只统计脚本加载后的新 `normal` assistant 回复。`skipFloors=N` 的间隔为 `N+1`，第一个正常回复先触发：

| skipFloors | 触发计数       |
| ---------- | -------------- |
| 0          | 1, 2, 3, 4...  |
| 1          | 1, 3, 5, 7...  |
| 2          | 1, 4, 7, 10... |

取消的生成不计数；regenerate、swipe、quiet、impersonate、continue、append、历史加载不计数。开启“Swipe 新回答也生图”后，只有原本符合楼层频率的新 Swipe 回答会额外生图，但不会推进楼层计数；切换已有 Swipe 不请求 API。切换聊天会重置运行期计数与图片内存；删除消息按原始消息对象校正楼层号，清除失效的正文任务、placement 及其 current 图片；其他楼层和礼物图片保持独立。

## 候选与版本清理

- `message-advance.ts` 依据新尾消息身份、楼层增长及生成类型识别真正的新楼，Swipe 和重复渲染不会触发清理。
- `image-retention.ts` 记录内存中的固定选择、任务失效状态与未完成首图的一次性保留状态。
- 手动固定仅清理当前 Swipe 的同一插图位置；新楼自动清理跨上一楼全部 Swipe，每个位置优先保留最近手动固定版，否则保留当前显示版。
- 清理同时移除被淘汰的 placement 与对应 recent artifact，并处理在途请求，避免迟到结果重新出现。

## 存储边界

`settings.ts`
只持久化画图预设、出图预设、展现设置、最近图片数量和 API 配置（含质量与单次生成数量）。生成图片、重绘提示词、横向候选、纵向版本、参考图、任务、placement、最近生成均为页面内存。图库保存时才把当前图片转换为 Base64 请求体；请求完成后临时 clone 会释放，Base64 不写设置或审计。

## 失败语义

- 正文已完成后才启动图片任务；inline 请求期间在对应位置显示“正在生图…”，结束、失败或失效时清理占位。
- 单个图片任务只有一次 API 尝试。
- 修改提示词或区域重绘只发起一次单图请求；原版本保留，失败不伪装成功。区域重绘是整图重新生成，不承诺选区外像素完全不变。
- 失效聊天、消息或 swipe 的迟到结果会丢弃。
- 图库保存失败不会移除最近生成。
- 日志和审计只记录有界状态，不记录 Key、Base64、图片 URL、完整响应、完整聊天或大段 prompt。

## 运行时验收缺口

静态测试只能证明纯逻辑、请求构造与构建。以下必须在用户开启的真实 SillyTavern 页面中完成：

1. `GENERATION_STARTED` 时动态 prompt 注入是否进入实际请求。
2. normal 与 regenerate/swipe/quiet 的真实事件序列是否符合门控。
3. 当前 persona/角色头像在所选 API 模式下是否可读取。
4. inline 锚点、gift recent-only、同楼单 toast 的真实 DOM 行为。
5. `/api/images/upload` 的实际保存路径与角色图库刷新表现。
