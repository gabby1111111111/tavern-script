# 杠杠の生图机 v0.4.0 代码线路图

## 主数据流

```text
GENERATION_STARTED(normal)
  -> runtime-policy.ts 排除不应触发配图的生成类型
  -> display-policy.ts 判断本楼是否符合频率
  -> runtime.ts 锁定当前画图预设、出图预设、连续线与参考快照
  -> drawing-preset.ts 注入画图指令；{{xx_pic}} 展开上一镜头文字

MESSAGE_RECEIVED(normal assistant)
  -> marker.ts 解析有效的 <pic>
  -> prompt-processor.ts 展开 {{xx}}、{{xx_pic}} 与 {{reference_sources}}
  -> runtime.ts 按快照准备已选择的头像和上一镜头图片
  -> image-api.ts requestImages(profile, { prompt, referenceImages? }, signal)
  -> image-presenter.ts 放置 inline 图片或写入 gift 最近生成列表

修改图片提示词
  -> prompt-editor.ts 编辑最终 API 提示词与本次参考开关
  -> 复用页面内已准备的参考结果
  -> image-api.ts 请求一张新图并追加到当前版本历史

区域重绘
  -> region-redraw-editor.ts 可选生成洋红标记图
  -> runtime.ts 默认只发送原图和修改提示词；关闭“无需画笔”后再发送标记图
  -> image-api.ts 请求一张新图并追加到当前版本历史
```

## 连续线与快照

- 连续线由“画图预设 ID＋出图预设 ID”组成，并在当前聊天内独立维护。
- 参考源只从当前聊天、目标楼层之前、当前有效 Swipe 的正文插图中选择；礼物图不参与连续线。
- 同一位置的当前显示候选或重绘版本作为下一次参考。没有有效来源时按首图处理。
- 生成开始时锁定预设组合、镜头文字和参考图片资源；切换预设、候选或 Swipe 不会改写已启动请求。
- 源图片被删除、清理或所属消息失效时，依赖它的任务会失效并释放资源，不静默替换另一张图。

## 参考图请求

头像参考和上一镜头图参考是两个独立选项。实际来源按可用结果重新编号：User 头像、角色头像、上一镜头图。某个来源读取失败时跳过该来源，正文和其他可用来源继续请求。

`{{xx_pic}}` 只展开上一镜头的有界镜头文字，不展开图片地址或二进制；`{{reference_sources}}` 只展示本次实际来源标签。提示词中由替换产生的文本不会再次递归展开。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `pipeline-types.ts` | 预设、参考来源、任务身份和 API 输入契约 |
| `drawing-preset.ts`、`settings.ts` | 画图/出图预设和用户配置 |
| `prompt-processor.ts` | 提示词占位符替换和来源编号 |
| `story-continuity.ts` | 连续线选择、快照和来源生命周期 |
| `reference-resolution.ts`、`avatar-references.ts` | 参考来源读取与失败降级 |
| `image-api.ts` | 不同 API 模式、超时、取消和响应资源解析 |
| `prompt-editor.ts`、`region-redraw-editor.ts` | 图片修改和区域重绘交互 |
| `image-placement.ts`、`image-presenter.ts`、`message-renderer.ts` | 页面内图片展示、候选和版本切换 |
| `task-cache.ts`、`recent-image-cache.ts`、`image-system.ts` | 页面内任务、资源和最近图片缓存 |
| `runtime.ts`、`runtime-policy.ts` | 事件编排、生命周期和 `window.__storyImageAudit` |

## 存储与失败边界

生成图片、参考图、提示词编辑、候选、版本、任务和 placement 只保存在当前页面 JavaScript 内存。只有用户明确保存到角色图库时才上传图片；不会把 Base64、图片地址、完整响应或大段提示词写入设置、聊天正文、变量、日志或审计。

单个图片任务只请求一次。请求失败、取消或来源失效时清理对应占位并继续聊天；不自动重试、不后台补跑，也不把失败结果当成成功。

## 验收边界

目标测试、ESLint 和生产构建用于验证纯代码、请求构造和打包完整性。真实 SillyTavern 仍需按实际 API 模式验证正文事件、头像和上一镜头图参考、inline/gift 展现、区域重绘与角色图库保存；静态结果不能替代真实接口或视觉验收。
