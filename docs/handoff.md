# 交接文档（M3 完成 → v3 交付，M4 可选）

> 新会话先读本文件，再读 [`plan.md`](../plan.md)。plan.md 是设计与取舍的唯一事实来源；本文只记状态、命令、坑和待办。
> 最后更新：2026-10-24 10:45。M3 的代码范围：`src/App.tsx`、`src/App.module.css`、`src/styles.css`、`index.html`、`src/components/{SettingsMenu,OptionPanel,OptionRow,controls,ConfigDialog,ConfigDrawer,DiffPane,ErrorPanel}.*`、`src/lib/{persisted-state,theme,service-worker}.*`、`public/sw.js`、`tools/{gen-golden,check-size}.mjs`、`tests/golden/golden-21.1.8.json`、`tests/e2e/{m3,golden,perf}.spec.ts`、`.github/workflows/{ci,deploy}.yml`、`NOTICE`；具体提交以 `git log` 为准。

## 1. 一句话现状

**M3 已完成，v3 视为交付**：会话持久化、系统/浅色/深色主题、<768 px 的「Options / Code」选项卡、Service Worker 离线、a11y 收尾、首屏 gzip 预算与 native↔wasm 黄金对拍闸门全部落地。
`npm run verify` 全绿（typecheck + **197 单测 / 12 文件** + build）；Playwright **47 条**（4 smoke + 17 M1 + 12 M2 + 11 M3 + 1 golden + 2 perf）在 base `/` 与 `/<repo>/` 子路径下各全绿（约 26–35 s）；`npm run check:size` 10 项全过（首屏 JS 219.4 KB gzip）；黄金对拍 29/29 与 native 21.1.8 逐字节相同；格式化 p95 19.3–21.7 ms（预算 80 ms）。
**M4 是可选项**（分享链接、PWA、示例、补齐全部 52 个版本），不阻塞交付。

## 2. 链接

| 项 | 地址 |
|---|---|
| 仓库（public） | <https://github.com/lzh0394/clang-format-configurator-v3> |
| Actions | <https://github.com/lzh0394/clang-format-configurator-v3/actions> |
| 线上 | <https://lzh0394.github.io/clang-format-configurator-v3/> |
| 待办清单 | [`docs/todo.md`](todo.md) |
| 本地路径 | `C:\workspaces\clang-format-configurator-v3` |

## 3. 本地怎么跑 / 怎么验

```powershell
npm install
npm run prepare:assets   # 仅首次：下载 wasm + 生成 schema（需联网；之后 public/schema 已在仓库里）
npm run dev              # http://127.0.0.1:5173
```

验证（提交前跑，不需要外网）：

```powershell
npm run verify           # typecheck + vitest + build（197 单测）
npm run check:size       # 需先 build；按 plan §1 检查 gzip 预算（10 项）
npx playwright test      # 本地用 Edge（channel=msedge），47 条，约 26–35 s
```

子路径构建（模拟 Pages）：

```powershell
$env:VITE_BASE='/clang-format-configurator-v3/'
npm run build
npx playwright test      # 自动在 http://127.0.0.1:4173/clang-format-configurator-v3/ 起 preview
Remove-Item Env:VITE_BASE
```

验线上（发布后）：

```powershell
$env:PW_BASE_URL='https://lzh0394.github.io/clang-format-configurator-v3/'
npx playwright test
```

黄金标准输出（需要 native clang-format 21.1.8；本机没有时脚本会用仓库缓存 `.cache/cf-pkg/...` 的 21.1.8）：

```powershell
npm run golden:gen                 # 重新生成 tests/golden/golden-21.1.8.json
npm run golden:gen -- --check      # 只校验是否与 native 漂移（CI 用，退出码非 0 即失败）
```

离线手工验：

1. `npm run build` + `npm run preview -- --port 4173 --host 127.0.0.1`，打开页面等首次格式化（SW 会缓存 shell + 当前版本 wasm/schema）。
2. 刷新一次（让页面处于 SW 控制下），DevTools → Network 勾 Offline，再刷新：应能加载并从缓存格式化，顶部出现离线横幅。
3. 更新提示只在 `sw.js` 字节变化时出现（普通发版改了 assets hash 但 sw.js 没变时不会提示；这是刻意的，避免无意义提示）。

只跑某个里程碑：`npx playwright test tests/e2e/m3.spec.ts` / `golden.spec.ts` / `perf.spec.ts`。

## 4. 环境事实与坑（踩过的）

- 本机 **Windows + PowerShell**；Node **v26.12.0**、npm **11.20.0**。CI 用 Node **22** + Python 3.12（只为 native clang-format）。
- 本地 npm 配了腾讯镜像；`tools/fetch-wasm.mjs` 默认直连 `registry.npmjs.org`，可用 `NPM_REGISTRY` 覆盖。pip 走清华镜像。
- 本地 Playwright 用 **Edge**（`channel: "msedge"`）；CI 用 `PW_CHANNEL=chromium`。
- **`vite preview` 必须 `--host 127.0.0.1`**（runner 上 `localhost` 可能解析到 `::1`）；**e2e 里 `page.goto("./")`** 以保留子路径前缀。
- 端口冲突会挂住 Playwright（4173/5173 先清残留）。
- **CM6 与 Playwright**（M2 起）：`data-testid="source"/"output"/"config-yaml"` 在 `.cm-content`（contenteditable）上，`fill()` 不可靠，用 `click → ControlOrMeta+A → keyboard.insertText`；DOM `textContent` 没有换行，读逻辑文本要拼 `.cm-line`（**不要用 innerText**，空行会多插 `\n`）。
- **Settings 菜单（M3）**：`editor-font-size` 现在在弹出层里，先点 `settings-toggle`；主题 radio 的 testid 是 `theme-system/light/dark`；菜单非模态，Escape/外部点击关闭并把焦点还给 toggle。
- **本地存储与主题（M3）**：key `clang-format-configurator:v3`，`stateVersion` 当前为 1；`index.html` 有一段预置脚本读 `parsed.theme` 提前设 `data-theme` 防闪白——**改 storage key/shape 时必须同步改这段内联脚本**（它在 `index.html` 里，只有 5 行、不计入 JS 预算）。e2e 里用 `page.addInitScript` 预置/破坏 localStorage。
- **Service Worker（M3）**：
  - 只在 production（`import.meta.env.PROD`）注册，dev 下完全惰性；e2e 用 `vite preview` 才有 SW。
  - 首次加载虽然会被 claim，但已加载资源未经 SW；**测离线要先 reload 一次**再断网。
  - SW 里所有 URL 从 `self.registration.scope` 推导，子路径安全；改缓存策略要 bump `CACHE_VERSION`（`cfc-v1`）。
  - 导航 network-first：正常发版刷新即可看到新版本；更新横幅只有在 `sw.js` 变化时才出现。
- **黄金对拍（M3）**：`tests/golden/golden-21.1.8.json` 是 **native 21.1.8 生成的提交物**；CI 用 `actions/setup-python@v7` + `pip install clang-format==21.1.8` 后跑 `node tools/gen-golden.mjs --check`（Linux 上重新生成 Windows 生成的 JSON，按 stdin/stdout 字节比较，理论上平台无关；如首跑出现漂移，按提示的 fixture 名排查，不要盲目重生成）。e2e 的 `golden.spec.ts` 在浏览器里用 wasm 跑同一组 fixture 并逐字节比较（29/29）。
- **gzip 预算（M3）**：`tools/check-size.mjs` 口径是 zlib level 9，1 MB = 1024 KB；初 JS 只算 `dist/index.html` 里的入口 script + modulepreload，**不含**懒加载的 clike chunk（上屏实际约 +7.5 KB）也不含 wasm glue（plan §1 明确不含 wasm/schema）。CI 在 build 后跑。
- **性能用例（M3）**：`tests/e2e/perf.spec.ts` 用 `retries: 1` 抵消并行 worker 噪声，但预算不放宽（p95 ≤80 ms、版本切换 ≤1.2 s / 200 ms）；在页面里直接 import wasm 测 `format()`，不走 UI 防抖。
- **Windows 剪贴板**把换行归一成 CRLF：比较复制出来的 YAML 要 `replace(/\r\n/g,"\n")`；Edge 下载 `.clang-format` 的建议文件名是 `clang-format`（前导点被去掉）。
- **CI 时长**：保留 Playwright 浏览器缓存、`npx playwright install chromium`（**不带 `--with-deps`**）、并发取消；M3 新增 setup-python + pip + `golden:gen --check` 约 +8–10 s，`check:size` 可忽略。
- **网络**：`github.com`/`api.github.com` 偶发 DNS/TLS 抖动，**不要写重试循环**；API 还可能匿名限流（本次实测 403 rate limit），优先看 Actions 网页。

## 5. 代码地图

```
tools/
  versions.json        版本清单（唯一事实来源，当前 3 个）
  fetch-wasm.mjs       拉 npm tarball → 校验 sha512 → public/wasm/<ver>/ + 生成 entry.js
  gen-schema.mjs       dump_config + LLVM RST → public/schema/<ver>/{core,docs}.json（含校验闸门）
  prepare-assets.mjs   依次跑上面两个；--only=<ver> / --refresh-rst 可传
  gen-golden.mjs       native 21.1.8 → tests/golden/golden-21.1.8.json；--check 防漂移
  check-size.mjs       dist 的 gzip 预算闸门（plan §1）
  lib/rst.mjs          ClangFormatStyleOptions.rst 解析 + 子集 reST→HTML
  lib/tar.mjs          最小 ustar 读取（不引 tar 依赖）
  wasm.lock.json       已提交：每版本 integrity + 每个文件 sha256
src/
  App.tsx              版本/风格/文件名 + 选项面板 + 编辑器/diff + 持久化/主题/移动端 tabs/离线横幅
  App.module.css       布局（桌面双栏；<768px 单栏+tabs）+ skip link/横幅样式
  main.tsx / styles.css  design tokens（浅/深两套、--font-size-editor、--syntax-*、--border-control）
  editor/
    CodeEditor.tsx      受控 CM6 编辑器：value/onChange/language/readOnly/testId/onSubmit
    languages.ts        文件名→语言映射 + lazy 语言包（clike/protobuf/lang-yaml），带缓存
    theme.ts            共享 CM6 主题 + 语法高亮（全部走 CSS 变量）
  components/
    OptionPanel/OptionRow/controls   选项面板五种控件（M1，M3 补 a11y 语义）
    ConfigDialog.tsx    快速导入/导出对话框（M1/M2，M3 补 aria-labelledby/tabs ids）
    ConfigDrawer.tsx    配置页抽屉（M2，M3 补 aria-labelledby/警告播报）
    DiffPane.tsx        真实 split diff（M2，M3 加 region 语义）
    ErrorPanel.tsx      结构化错误面板（M2，M3 让诊断可聚焦）
    SettingsMenu.tsx    主题三档 + 编辑器字号（M3，Settings 弹出层）
    useDocs.ts          docs 懒加载 hook（M1）
  lib/
    schema.ts / schema-store.ts / config.ts / config-state.ts / config-io.ts / config-diff.ts / diagnostics.ts
    formatter-client.ts worker 封装：串行化、latest-wins、supersede、20s 超时、onFatal
    persisted-state.ts  localStorage 持久化（stateVersion、损坏/不兼容/配额降级，纯逻辑可测）
    theme.ts            ThemePreference、resolveTheme、applyTheme（data-theme + color-scheme）
    service-worker.ts   SW 注册/更新/在线离线事件（prod-only，可注入环境测试）
  worker/              formatter.worker.ts（唯一 wasm 实例、串行化、console 诊断捕获）+ protocol
tests/
  golden/              29 组 native clang-format 21.1.8 黄金输出（提交入库）
  e2e/                 helpers + smoke + m1 + m2 + m3 + golden + perf
public/
  schema/<ver>/        已提交（core.json + docs.json），index.json 驱动版本下拉
  sw.js               手写 Service Worker（Vite 原样拷进 dist）
  wasm/<ver>/          不提交（.gitignore），由 prepare:assets 生成
.github/workflows/
  ci.yml               verify（typecheck/unit/golden check/size/build/e2e）+ Playwright 缓存
  deploy.yml           build（含 e2e）→ deploy → 对线上 URL 跑整套 e2e
docs/screenshot.png    线上截图（README 引用）
NOTICE                 第三方材料与授权说明（LLVM 文档、wasm-fmt、v2 参考）
```

## 6. M3 已实现的行为与实现细节（读代码前必须知道）

1. **持久化（`persisted-state.ts` + `App.tsx`）**：状态文档 `{stateVersion, version, style, modified, code, theme, editorFontSize}`，`STORAGE_KEY="clang-format-configurator:v3"`，`STATE_VERSION=1`。`loadPersistedState` 同步、不抛异常：`empty/unavailable` 静默，`corrupt/version-mismatch` → 丢弃 + 一次性 notice（"Saved session was discarded"），单字段非法只降级为默认。`savePersistedState` 自身 stamp 版本号，quota/unavailable 返回状态码，App 只提示一次（`persist-banner`）。保存 400 ms 防抖；`pagehide`/卸载用 ref 稳定回调 flush（**不要让 flush effect 依赖每次编辑都变的函数**，否则每敲一个键都会同步写 localStorage）。
2. **版本恢复**：版本列表加载后优先用存档里的 version（仍在 `schema/index.json` 里才用），否则用默认版本；`reconcileModified` 丢弃目标 schema 不认识/已废弃的键，丢弃时把键名收进 notice（最多列 12 个）。
3. **主题（`theme.ts` + `SettingsMenu` + `styles.css`）**：三档 system/light/dark；显式档设 `html[data-theme=...]` + 内联 `color-scheme`，system 移除两者交给 `prefers-color-scheme`。CSS 词令顺序：`:root` 浅色基色 → `@media dark { :root:not([data-theme=light]) }` → `:root[data-theme=dark]`。`index.html` 预置脚本读 storage 的 `theme` 提前应用（防闪白）。**没有 matchMedia 监听**：system 档完全交给 CSS，切系统主题即时生效。
4. **响应式（`App.tsx` + `App.module.css`）**：`matchMedia("(max-width: 768px)")` 控制 `isMobile`；移动端渲染 `role="tablist"` 的两个 tab（`tab-options`/`tab-code`，默认 Code），main 上加 `mainOptions`/`mainCode` 类隐藏另一面板；←/→ 切换并转移焦点。CSS 断点：1100px/900px 是布局细化，768px 才是选项卡。
5. **可访问性**：跳过链接（`#main`）；`live-status` 是 visually-hidden 的 polite 播报（busy/error/formatted，避免每 250 ms 抖动）；OptionPanel 的 "N of M options shown" 是 debounced 的 polite 状态；对话框用 `aria-labelledby` 指可见标题；错误 `role="alert"`；chips `aria-pressed`；docs 展开 `aria-expanded + aria-controls`；可滚动 `<pre>`/warnings 加了 tabIndex；`--border-control` 专用于控件边框（1.4.11），`--border` 保持装饰用途。
6. **离线（`public/sw.js` + `service-worker.ts`）**：SW 是**普通 JS**（不是 TS、不参与打包），Vite 从 `public/` 原样复制到 `dist/sw.js`。缓存名 `cfc-v1`（改策略务必 bump）。install 预缓存 scope root + favicon、**不自动 skipWaiting**；activate 删旧 `cfc-*` 后 `clients.claim()`；fetch：导航 network-first → 缓存 shell → 合成离线页；同源 GET 静态资源 stale-while-revalidate（opaque/206/no-store 不缓存），离线 miss 返回 504；消息 `{type:"SKIP_WAITING"}` 才激活。注册模块 prod + 安全上下文才注册（`${BASE_URL}sw.js`, scope `BASE_URL`），`onUpdateReady` 每页最多一次，`applyUpdate()` 发 SKIP_WAITING 并在 `controllerchange` 时 reload 一次，`onOfflineChange` 初次即回调。
7. **质量闸门**：`check-size.mjs` 读 `dist/index.html` 找入口 script + modulepreload 算初 JS gzip，逐版本检查 wasm/core/docs；缺资源直接失败。`gen-golden.mjs` 的二进制解析顺序 `--clang-format` > `CLANG_FORMAT_BIN` > PATH > 仓库缓存（仅本机兜底），版本必须 21.1.8；`--check` 忽略 `generatedAt` 逐 fixture 比较。e2e 的 `golden.spec.ts` 在浏览器里 import `wasm/21.1.8/entry.js`，用 `JSON.stringify(style)` 调 `format(code, filename, style)`，**原始字节**比较（允许尾随空格/CRLF）。
8. **性能**：`perf.spec.ts` 在页面里直接 import wasm（绕过 UI 防抖）测 20 KB C++ 代码的 `format()` p95，并测版本切换冷/缓存时间（select → status ready + 输出出现，10 ms 轮询）。本机实测 p95 **18.6–22.7 ms**、冷切换 **130–166 ms**、缓存 **104–108 ms**。
9. **M0–M2 不变量仍然成立**：只发改动项；16 个 map 是稀疏 patch；导出按 schema 顺序、枚举 canonical、单结尾换行、导出→导入→导出**字节幂等**；版本切换剔除未知键；错误面板 `err.kind === "format"` 才进 ErrorPanel，fatal 走崩溃横幅；>2 MB 需确认；语言随文件名；diff 打开时普通双栏卸载（`source`/`output` 全局唯一）。

## 7. 已知缺陷 / 有意的取舍

- **16.0.6 / 17.0.6 不可用**：wasm 包只导出 `format`/`version`，没有 `dump_config`。
- **22.x / 23.x 不可用**：`dump_config` 值域错位，被 schema 校验闸门拦下，等上游修。
- **SW 更新横幅没有 e2e**：只有 `sw.js` 字节变化才会出现等待中的 worker；本地要确定性复现得在两次加载之间换一份 sw.js，成本高。更新生命周期由 `src/lib/service-worker.test.ts` 的 20 条单测覆盖（含 waiting→applyUpdate→reload 流程）。
- **持久化失败横幅（quota/unavailable）没有 e2e**：需要 stub localStorage 抛错；`persisted-state.test.ts` 19 条单测覆盖返回码。
- **M2 遗留**：>2 MB 输入与 worker 崩溃横幅没有 e2e（键盘输入 2 MB 太慢、崩溃无自然触发）；配置抽屉的"从文件加载"只由 M1 对话框同类用例覆盖。
- **虚拟列表键盘模型**：Tab 只能到已渲染行，滚到更远的选项需要先滚动；没有 roving tabindex/listbox 语义（M4）。
- **ConfigDialog 没有焦点陷阱**（`aria-modal` 但 Tab 可离开），ConfigDrawer 有；两者理论上可同时打开（两个 aria-modal）——M4 收敛。
- **docs HTML 里 code-block 渲染仍粗糙**（"Meaning" 列出现字面 `code-block:: c++`），是 `tools/lib/rst.mjs` 子集渲染的局限；docs `<pre>` 横向滚动区域不可聚焦（要改生成器）。
- **界面字号整体缩放未做**（只有编辑器字号 + 主题）；见 `docs/todo.md`。
- **两个入口并存**：快速 Import/Export 模态框与配置抽屉（有意，见 M2 交接）；M4 可考虑收敛。
- 没有 ESLint/Prettier、没有 Dependabot、没有 per-PR 预览。

## 8. e2e 覆盖清单（47 条）

- **smoke（4，M0）**：首屏格式化 / 换风格 / 换版本 / 改源码。
- **m1（17，M1）**：纯 UI 生成配置、reset、Minimal/Full roundtrip、导入 warning/legacy、稀疏 map、struct list、list<string>、过滤 chips、对话框焦点、非法 YAML、文件加载、下载、复制、docs 懒加载、enum/bool 控件、override 警告。
- **m2（12，M2）**：编辑器语义、Auto 关闭时 Ctrl/Cmd+Enter、语言徽标、字号、Diff 开关/真实高亮/在 diff 里编辑、抽屉实时校验/preview/apply/mode/下载/关闭、结构化错误面板。
- **m3（11，M3）**：会话持久化恢复（option+code+theme+font）、版本持久化、损坏存档、stateVersion 不兼容、主题三档 + 系统深色、Settings 弹层行为/焦点、移动端 tabs、桌面↔移动 resize、跳过链接、离线 SW（controller→reload→caches→offline→reload→banner）、a11y 语义 smoke。
- **golden（1）**：29 组 fixture 与 native 21.1.8 逐字节相同（wasm 在浏览器里跑）。
- **perf（2）**：format p95 ≤80 ms；版本切换冷 ≤1.2 s / 缓存 ≤200 ms。

## 9. 下一步：M4（可选，plan §9）

M3 完成即 v3 交付；M4 按需，不阻塞上线：

1. **分享链接**：状态编码进 URL hash（`version/style/modified`，`code` 可选），复制链接按钮；与 localStorage 恢复的优先级要明确（hash > storage）。
2. **PWA**：manifest + 图标 + 安装提示（SW 已有，补 manifest 与离线页文案即可）。
3. **示例与语言**：C#/proto 代码示例、更多语言文件后缀（`.kt`、`.ts` 等仅影响高亮时用 clike 映射）。
4. **补齐版本**：按 minor 补齐全部 52 个 wasm 版本（16/17 走 native dump 兜底、22/23 等上游或 native）；`tools/versions.json` 加行 → `prepare:assets` → 提交 schema。
5. **界面字号缩放**（`docs/todo.md`）、虚拟列表 roving 键盘模型、ConfigDialog 焦点陷阱、docs HTML 渲染修整、把快速导入/导出与配置抽屉收敛成一个入口。
6. **nightly 上游漂移检查**（plan §8.1.3）：重新生成 schema 到临时目录 + `git diff --exit-code`，失败只开 issue 不阻塞发布。

## 10. 待决策

- **16/17/22/23 怎么办**：(a) PyPI native binary 做构建期 dump（schema 仍提交，运行时不变）；(b) 支持范围改成 18+；(c) 等上游修 22/23。
- 仓库是否长期 public（Pages 免费额度）；是否要 per-PR 预览（Pages 不支持，需 Cloudflare Pages）。
- 是否删掉快速导入/导出模态框、只留配置抽屉。
- 界面字号缩放做到什么粒度（三档 vs 85–120% 连续）。

## 11. 约定

- `plan.md` 是设计与取舍的唯一事实来源；实现偏离时先改 plan 再改代码。
- 提交信息用 `area: summary`（`feat:` / `test:` / `docs:` / `ci:`），一次提交一件事。
- 加版本：`tools/versions.json` 加一行 → `npm run prepare:assets -- --only=<ver>` → 提交 `public/schema/<ver>` 与 lock → push。CI 不重跑 schema 生成（只 `prepare:wasm`）。
- **改持久化**：storage key / 文档 shape 变化必须 bump `STATE_VERSION`，并同步 `index.html` 的预置主题脚本（只依赖 `parsed.theme`）与 `persisted-state.test.ts`。
- **改 SW**：bump `public/sw.js` 里的 `CACHE_VERSION`；保持 scope 从 `registration.scope` 推导、不要写死 `/`；改更新流程跑 `src/lib/service-worker.test.ts`。
- **改导出/导入**：必须跑 `config-io` 的 roundtrip 与 e2e 的 roundtrip；字节幂等是最容易漏的回归。
- **改 UI/主题**：跑 m2/m3 的 e2e；对比度用 `--border-control`（控件）与 `--border`（装饰）区分，别把装饰线调成高对比噪点。
- **改 golden**：`npm run golden:gen` 后用 native 21.1.8 重新生成，并跑 `npx playwright test tests/e2e/golden.spec.ts`；CI 的 `--check` 会拦 Windows/Linux 漂移。
- 提交前至少 `npm run verify`；动 UI/base/离线路径时跑 `npx playwright test`（base `/` 与子路径各一遍），再跑 `npm run check:size`。
- 改 workflow：保持 Playwright 浏览器缓存、`npx playwright install chromium`（无 `--with-deps`）、并发取消；golden 的 setup-python/pip 步骤不要挪到 build 之后（现在放在 npm ci 前，漂移 8 秒内失败）。
- 网络抖动时不写重试循环；GitHub API 匿名限流时直接看 Actions 网页。

## 12. 最近验证记录

### 本地（2026-10-24，M3 完成后）

| 项 | 结果 |
|---|---|
| `npm run verify` | ✅ typecheck 0 错 + **197 unit（12 文件）** + build |
| `npx playwright test`（base `/`，production build） | ✅ **47 passed**（34.9 s 首次/冷缓存，Edge） |
| `npx playwright test`（`VITE_BASE=/clang-format-configurator-v3/`） | ✅ **47 passed**（26.5 s） |
| `npm run check:size` | ✅ 10 项全过：初 JS **219.42 KB**（限 250）；wasm 941.88 / 984.62 / 990.26 KB（限 1.0 MB）；core 6.76–7.72 KB（限 25）；docs 21.51–23.23 KB（限 45） |
| `node tools/gen-golden.mjs --check` | ✅ 29 组与 native 21.1.8 一致 |
| 黄金对拍（wasm vs native） | ✅ 29/29 逐字节相同 |
| 性能 | ✅ format p95 **18.6–22.7 ms**（限 80）；版本切换冷 **99–116 ms**（偶发 214 ms，限 1.2 s）、缓存 **86–144 ms**（限 200 ms） |
| 离线 | ✅ 断网刷新后 app shell + 格式化结果可用，离线横幅显示 |
| 单测覆盖 | config / config-state / config-io / schema-store / schema / config-diff / diagnostics / formatter-client / languages / persisted-state / theme / service-worker |

### CI / 部署（GitHub Actions）

| 项 | 结果 |
|---|---|
| ci（M3 提交 `92f665e`） | ✅ [40056377277](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40056377277)：setup-python + native 21.1.8 + `golden:gen --check` + typecheck/197 单测 + build + check:size + 47 条 e2e，全绿；**Linux 上重新生成的 fixture 与 Windows 提交物一致**（资源漂移闸门成立） |
| deploy（M3 线上） | ✅ [40056377297](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40056377297)：build（含 47 条 e2e）→ deploy → 对线上 URL 再跑整套 e2e，全绿 |
| 线上复跑（本地执行，M3/golden/perf 组） | ✅ `PW_BASE_URL=https://lzh0394.github.io/clang-format-configurator-v3/ npx playwright test tests/e2e/m3.spec.ts tests/e2e/golden.spec.ts tests/e2e/perf.spec.ts` → 13 passed + 1 flaky（perf 版本切换在公网抖动下首跑超时、retry 通过；非产品问题） |
| 线上资源 | ✅ 首页 200 且含主题预置脚本；入口 JS/CSS 200；`sw.js` 200（7152 B，与仓库一致）；m3 的离线用例在线上通过 |
