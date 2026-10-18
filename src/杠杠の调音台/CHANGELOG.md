# Changelog

本文件记录“杠杠の调音台”的用户可感知变化。版本以脚本专属 Git 标签为准，不跟随多脚本仓库根版本。

## [0.3.1] - 2026-10-18

### Fixed

- 修复 v0.3.0 已知限制"Swipe 新回答也出歌"在部分运行时事件顺序下偶发不触发。
  - Swipe 资格管理改为按生图机相同帧设计的 floor ledger（`src/杠杠の调音台/bgm-eligibility.ts`）。
  - Swipe 资格读取不再依赖 `MESSAGE_SWIPED` 事件，全局 `pendingSwipeTarget` 退化为仅 audit 用途。
  - Ledger `prepare({type:'swipe', targetMessageId, chat})` 通过聊天数组直接定位原楼层对象，
    抗宿主运行时事件顺序差异；同时支持 strict tail truncation 的 replacement slot 继承。
- normal 提交走 ledger `commit` 路径，stale / duplicate settlement 会被显式拒绝（v0.3.0 旧 `set` 路径无防护）。
- 移除死代码 `BgmMessageIdentityStore` import。

### Changed

- 新增 `src/杠杠の调音台/bgm-eligibility.ts`：floor ledger 帧设计参考 `src/杠杠の生图机/generation-eligibility.ts`，
  不引入生图机的 displayPolicy / regenerate 等业务字段。
- 新增 `tests/ganggang-mixer-swipe-eligibility.test.ts`，7 个场景 47 个断言全过：cadence 一致、happy path、
  MESSAGE_SWIPED 丢失命中、stale commit、replacement slot、reset。

### Tests

- `tests/ganggang-bgm-settings.test.ts` 维持通过。
- `tests/ganggang-mixer-vs-image-cadence.test.ts`（调研产物）维持通过。

## [0.3.0] - 2026-09-09

### Added

- 提示词支持新建、选择、保存和删除多套方案，当前方案修改从下一轮 AI 回复开始生效。
- 新增“隔几楼出歌”，`0` 为每楼发送；其他数值按第 1 楼开始、间隔 N 楼再次发送。
- 新增“Swipe 新回答也出歌”选项；Swipe 复用原楼出歌资格且不推进正常正文楼计数。
- 新增楼层、Swipe、提示注入和播放状态的运行时审计字段。

### Changed

- 扩展设置标题显示“杠杠の调音台”和当前版本号。
- 播放列表缓存与网易云候选抽取数量均限制为 1–20。
- “更多”页面精简为可操作设置，不再展示内部重试和生效时机说明。

### Fixed

- 提示词方案迁移会保留旧版自定义内容，并始终维持一个可用方案。
- 正常正文楼、重生成、Swipe、停止生成和重复结束事件使用独立门控，避免楼层重复计数。
- 环境音和歌单请求支持取消与超时，过期请求不会覆盖当前生成。
- 修复提示重建时覆盖已跳过 Swipe 审计的问题。

## [0.1.2] - 2026-08-23

### Fixed

- 稳定 BGM 与环境音的搜索、取消、超时、播放确认及播放列表维护。
