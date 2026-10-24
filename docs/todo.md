# TODO / 待办清单

> 记录尚未排期或跨里程碑的功能想法。设计与取舍的唯一事实来源是 [`plan.md`](../plan.md)，当前状态与交接信息在 [`handoff.md`](handoff.md)；本文件只收"以后要做的事"。
> 最后更新：2026-10-24（M4 完成后）

## 1. 字体大小调节（已完成，保留设计记录）

- **状态**：M2 完成编辑器字号（12–20 px，`--font-size-editor`），M4 完成**界面字号**（Settings 菜单里的 Interface size：Compact 90% / Standard 100% / Large 115%，`--ui-scale`，随会话持久化；编辑器与界面字号互不影响）。三项验收（即时变化/刷新保持/三种字号下列表行高正确）都有 e2e 覆盖（`tests/e2e/m4.spec.ts` 的 "interface size scales the UI (not the editor) and persists"）。
- **实现要点（改字号前必读）**：
  - 根字号 `:root { font-size: calc(100% * var(--ui-scale, 1)) }`，组件字号全部 rem；`transform/zoom` 会破坏虚拟列表行高计算，不要用。
  - 改字号后虚拟列表要对已渲染行调 `virtualizer.measureElement(el)` 重测；**不要调 `virtualizer.measure()`**（清 cache 但保留旧 measurementsCache，delta 会算成 0，行按估算高度重叠）。
  - 持久化字段 `uiFontScale` 是向后兼容的增字段，`STATE_VERSION` 仍为 1；旧存档按 1.0 加载。
- **未做**：连续比例（85%–120%）而不是三档；"恢复默认"目前通过选回 Standard 实现。

## 2. M4 已完成项（保留追踪）

- 分享链接（URL hash）、PWA manifest/安装提示、C#/Proto 等示例与更多语言后缀、全部 52 个 wasm 版本、界面字号缩放、虚拟列表 roving 键盘模型、ConfigDialog 焦点陷阱、docs `<pre>` 可聚焦、nightly schema 漂移检查 → 见 `plan.md` 的 M4 状态与 `handoff.md` §6/§12。
- M4 遗留（按需）：收敛快速导入/导出与配置抽屉（有意保留两个入口）、RST 表格单元格代码块的 `<pre>` 语义（需改 `tools/lib/rst.mjs`）、安装提示 dismiss 的重置入口、SW 更新横幅/>2 MB/崩溃横幅的 e2e 缺口（见 `handoff.md` §7）。
- 已知缺陷（上游）：19.1.1 的 npm wasm `version()` 报 19.1.0；16/17/18.1.0–18.1.7/22/23 的 wasm 没有可用 `dump_config`（schema 走同版本 native dump，已解决）。
