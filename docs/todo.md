# TODO / 待办清单

> 记录尚未排期或跨里程碑的功能想法。设计与取舍的唯一事实来源是 [`plan.md`](../plan.md)，当前状态、命令与实现细节在 [`handoff.md`](handoff.md)；本文件只收"以后要做的事"，已完成项不在此追踪。
> 最后更新：2026-10-26（清理已完成项，仅保留未排期事项）

## 按需（不承诺）

- 收敛快速导入/导出对话框与配置抽屉：两者有意并存，收敛会改变 M1 的 e2e 契约，收益不足以抵消回归风险（见 `handoff.md` §7）。
- 改 `tools/lib/rst.mjs`，让 RST 表格单元格里的代码块有 `<pre>` 语义（渲染层归一化已兼容，不阻塞）。
- 加"重置安装提示"入口；给 SW 更新横幅、>2 MB 输入、worker 崩溃横幅补 e2e（现有单测覆盖，见 `handoff.md` §7）。
- 仓库是否长期 public、是否要 per-PR 预览（GitHub Pages 不支持，需 Cloudflare Pages）。
- 界面字号：连续比例（85%–120%）代替 90%/100%/115% 三档；提供显式的"恢复默认"入口。
- 若上游修了 16/17/18.1.0–18.1.7/22/23 的 wasm `dump_config`，可去掉 `versions.json` 里的 `"dump": "native"` 与 native 构建步骤（其余版本不受影响）。

## 已知上游缺陷（非本项目可修）

- 19.1.1 的 npm wasm `version()` 报 19.1.0（上游标签错）；格式化行为与 native 19.1.1 一致，`core.build` 保留上游值，UI 状态栏显示选中版本。
- 22.x / 23.x 的 wasm `dump_config` 值域错位（CLI 构建同样错）：schema 默认值已改由同版本 native dump 生成，运行期格式化仍用 wasm。
