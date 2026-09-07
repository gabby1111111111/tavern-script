# v0.3 代码线路图

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

| 模块      | 文件                                                                                         | 职责                                                |
| --------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 公共契约  | `pipeline-types.ts`                                                                          | 预设、展现、API 输入、内存键和图库输入              |
| 画图预设  | `drawing-preset.ts`、`settings.ts`                                                           | 正文 AI 指令 CRUD、当前预设、v0.2 文本迁移          |
| 出图预设  | `output-preset.ts`、`prompt-processor.ts`、`avatar-references.ts`                            | `{{xx}}` 模板 CRUD、头像硬门控与 User→角色引用顺序  |
| 图片 API  | `image-api.ts`                                                                               | 统一请求输入、一次请求、响应资源解析                |
| 展现策略  | `display-policy.ts`                                                                          | `skipFloors + 1` 频率纯函数                         |
| 页面展现  | `image-presenter.ts`、`image-placement.ts`、`message-renderer.ts`、`region-redraw-editor.ts` | inline placement、区域标记编辑器或 gift recent-only |
| 内存缓存  | `task-cache.ts`、`recent-image-cache.ts`、`image-system.ts`                                  | 任务隔离、1–50 张可调最近池与资源释放               |
| 主动保存  | `gallery-storage.ts`                                                                         | 用户点击后 POST `/api/images/upload`                |
| 编排/审计 | `runtime.ts`、`runtime-policy.ts`                                                            | 事件门控、任务生命周期、`window.__storyImageAudit`  |

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
