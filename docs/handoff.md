# 交接文档（M0–M4 完成，v3 完整交付）

> 新会话先读本文件，再读 [`plan.md`](../plan.md)。plan.md 是设计与取舍的唯一事实来源；本文只记状态、命令、坑和待办。
> 最后更新：2026-10-24 12:10。M4 的代码范围：`src/lib/share-link.ts`、`src/pwa/**`、`src/editor/{languages,examples}.ts`、`src/components/{OptionPanel,OptionRow,ConfigDialog,ConfigDrawer,useDocs,roving,focus-trap}.*`、`src/lib/persisted-state.ts`、`src/(App|main).tsx`、`src/styles.css` 与全站 CSS 的 px→rem、`public/manifest.json`、`public/icons/**`、`public/sw.js`、`public/schema/**`（52 版本）、`tools/{versions.json,wasm.lock.json,gen-schema,fetch-wasm,check-size,prepare-assets}.mjs`、`tests/e2e/{m4,m4-pwa,m4-a11y}.spec.ts`、`.github/workflows/nightly.yml`、`plan.md`/`README.md`/本文件；具体提交以 `git log` 为准。

## 1. 一句话现状

**M0–M4 全部完成，v3 完整交付**：骨架/资源流水线、选项引擎、编辑器与 diff、持久化/主题/响应式/离线、a11y 闸门，以及 M4 的分享链接、PWA（manifest + 安装提示）、C#/Proto 等示例与语言扩展、全部 **52** 个 wasm 版本、界面字号缩放、虚拟列表 roving、ConfigDialog 焦点陷阱、docs `<pre>` 可聚焦、nightly schema 漂移检查。
`npm run verify` 全绿（typecheck + **298 单测 / 18 文件** + build）；Playwright **64 条**（4 smoke + 17 M1 + 12 M2 + 11 M3 + 1 golden + 2 perf + 7 M4 + 5 M4-PWA + 5 M4-a11y）在 base `/` 与 `/<repo>/` 子路径下各 63 passed + 1 flaky（perf 的 cached 版本切换在并行 worker 下偶发 >200 ms，单独跑 76 ms）；`npm run check:size` **157 项全过**（首屏 JS **224.5 KB gzip** / 250 KB；52 个 wasm 902.4–1071.5 KB / 1.1 MB；core 6.4–8.5 KB、docs 19.3–24.6 KB）；黄金对拍 29/29 与 native 21.1.8 逐字节相同；52/52 版本运行期自检 + 312/312 native vs wasm 对拍；格式化 p95 9–23 ms（预算 80 ms）；dist ≈130 MB。
**nightly**：`schema:check --allow-missing-native` 每日跑，漂移只开 issue，不阻塞发布。

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
npm run verify           # typecheck + vitest + build（298 单测 / 18 文件）
npm run check:size       # 需先 build；按 plan §1 检查 gzip 预算（157 项 / 52 版本）
npx playwright test      # 本地用 Edge（channel=msedge），64 条，约 30 s
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
  - SW 里所有 URL 从 `self.registration.scope` 推导，子路径安全；改缓存策略要 bump `CACHE_VERSION`（M4 起 `cfc-v2`，预缓存 manifest + 图标）。
  - 导航 network-first：正常发版刷新即可看到新版本；更新横幅只有在 `sw.js` 变化时才出现。
- **黄金对拍（M3）**：`tests/golden/golden-21.1.8.json` 是 **native 21.1.8 生成的提交物**；CI 用 `actions/setup-python@v7` + `pip install clang-format==21.1.8` 后跑 `node tools/gen-golden.mjs --check`（Linux 上重新生成 Windows 生成的 JSON，按 stdin/stdout 字节比较，理论上平台无关；如首跑出现漂移，按提示的 fixture 名排查，不要盲目重生成）。e2e 的 `golden.spec.ts` 在浏览器里用 wasm 跑同一组 fixture 并逐字节比较（29/29）。
- **gzip 预算（M3）**：`tools/check-size.mjs` 口径是 zlib level 9，1 MB = 1024 KB；初 JS 只算 `dist/index.html` 里的入口 script + modulepreload，**不含**懒加载的 clike chunk（上屏实际约 +7.5 KB）也不含 wasm glue（plan §1 明确不含 wasm/schema）。CI 在 build 后跑。
- **性能用例（M3/M4）**：`tests/e2e/perf.spec.ts` 在 `playwright.config.ts` 里是**独立的 `perf` project**，`dependencies: [channel]` 让它排在主套件全部结束之后串行跑——52 个版本后并行套件会抢占 CPU，缓存版本切换偶发 200–204 ms 而同类操作单独跑只要 64–95 ms，CI 因此红过一次；预算本身不放宽（p95 ≤80 ms、版本切换 ≤1.2 s / 200 ms），仍保留 `retries: 1`。在页面里直接 import wasm 测 `format()`，不走 UI 防抖。
- **Windows 剪贴板**把换行归一成 CRLF：比较复制出来的 YAML 要 `replace(/\r\n/g,"\n")`；Edge 下载 `.clang-format` 的建议文件名是 `clang-format`（前导点被去掉）。
- **CI 时长**：保留 Playwright 浏览器缓存、`npx playwright install chromium`（**不带 `--with-deps`**）、并发取消；M3 新增 setup-python + pip + `golden:gen --check` 约 +8–10 s，`check:size` 可忽略。
- **网络**：`github.com`/`api.github.com` 偶发 DNS/TLS 抖动，**不要写重试循环**；API 还可能匿名限流（本次实测 403 rate limit），优先看 Actions 网页。
- **界面字号（M4）**：`App.tsx` 把持久化的 `uiFontScale`（0.9/1/1.15）写到 `<html>` 的 `--ui-scale`，`styles.css` 用 `:root { font-size: calc(100% * var(--ui-scale)) }`，**组件 CSS 字号全部 rem**（`--font-size-editor` 仍是 px，不受影响）。改字号后虚拟列表必须重测行高：`OptionPanel` 收到 `remeasureKey` 后在 rAF 里对已渲染 `[data-index]` 行逐个 `virtualizer.measureElement(el)`；**不要改成 `virtualizer.measure()`**（它清 itemSizeCache 但保留旧 measurementsCache，delta 会算成 0，行按 44px 估算重叠）。改任何组件字号时记得也检查 px→rem。
- **PWA（M4）**：manifest 用 `public/manifest.json`（曾用 `.webmanifest`，担心 GitHub Pages MIME 不是 `application/manifest+json`；`.json` 一定是 `application/json`，Chrome/Edge 都接受）。manifest 里 `start_url:"."`、`scope:"./"`、图标 `src` 全相对，子路径部署安全。`src/pwa/install.ts` 的浏览器单例在 `main.tsx` render 前创建，避免漏掉 `beforeinstallprompt`。
- **52 个版本（M4）**：`public/schema/` 提交（105 文件 / 11.6 MB raw）；`public/wasm/` 仍不提交，CI 的 actions/cache key 是 `hashFiles('tools/versions.json')`，冷跑要下 118 MB / 约 2–4 分钟（ci/deploy 的 timeout 已提到 30 分钟）；dist ≈130 MB。26 个版本的 schema 默认值来自同版本 native（`versions.json` 里 `"dump": "native"`）：16.0.6、17.0.x、18.1.0–18.1.7、22.x、23.x；22.1.6/7 不在 PyPI，用 LLVM 官方 release 的 `clang-format.exe`（.cache，862 MB tarball 用完即删）。新增版本时按 `versions.json` 加行 → `npm run prepare:assets -- --only=<ver>` 或全量 → 提交 schema + lock。
- **分享链接（M4）**：纯逻辑在 `src/lib/share-link.ts`（11 条单测）；`App.tsx` 在 `useState` 初始化器里读 `location.hash`，应用后 `history.replaceState` 清掉 fragment；优先级 hash > storage。新增字段必须 bump payload 的 `k`。
- **CI**：nightly 只在 `schema:check --allow-missing-native` 下跳过 26 个 native-dump 版本的默认值（docs/结构仍比对）；本地/发布前要跑严格 `npm run schema:check`（需要 native 二进制）。

## 5. 代码地图

```
tools/
  versions.json        版本清单（唯一事实来源，52 行；native-dump 版本带 "dump": "native"）
  fetch-wasm.mjs       拉 npm tarball → 校验 sha512 → public/wasm/<ver>/ + 生成 entry.js
  gen-schema.mjs       wasm dump_config / native dump + LLVM RST → public/schema/<ver>/{core,docs}.json（含校验闸门、--check、--allow-missing-native）
  prepare-assets.mjs   依次跑上面两个；--only=<ver> / --refresh-rst 可传
  gen-golden.mjs       native 21.1.8 → tests/golden/golden-21.1.8.json；--check 防漂移
  check-size.mjs       dist 的 gzip 预算闸门（plan §1；52 版本、wasm ≤1.1MB）
  lib/rst.mjs          ClangFormatStyleOptions.rst 解析 + 子集 reST→HTML
  lib/tar.mjs          最小 ustar 读取（不引 tar 依赖）
  wasm.lock.json       已提交：52 条 integrity + 178 个文件 sha256
src/
  App.tsx              版本/风格/文件名 + 选项面板 + 编辑器/diff + 持久化/分享链接/PWA/字号/移动端 tabs/离线横幅
  App.module.css       布局（桌面双栏；<768px 单栏+tabs）+ skip link/横幅样式
  main.tsx / styles.css  design tokens（浅/深两套、--ui-scale、--font-size-editor、--syntax-*、--border-control）
  editor/
    CodeEditor.tsx      受控 CM6 编辑器：value/onChange/language/readOnly/testId/onSubmit
    languages.ts        文件名→语言映射（含 kotlin/objc/js/ts）+ lazy 语言包，带缓存
    examples.ts         各语言示例代码 + getSampleCode/isKnownSample（M4）
    theme.ts            共享 CM6 主题 + 语法高亮（全部走 CSS 变量）
  pwa/
    install.ts          beforeinstallprompt 生命周期（可注入环境、无 React）
    InstallBanner.tsx   可安装横幅（可关闭/安装后隐藏）
  components/
    OptionPanel/OptionRow/controls   选项面板五种控件 + roving 键盘模型（M1/M4）
    roving.ts / focus-trap.ts        键盘索引纯逻辑 / 焦点陷阱纯逻辑（M4，均有单测）
    ConfigDialog.tsx    快速导入/导出对话框（焦点陷阱、两 modal 只有顶层响应）
    ConfigDrawer.tsx    配置页抽屉（与 ConfigDialog 共用焦点陷阱）
    DiffPane.tsx        真实 split diff（M2）
    ErrorPanel.tsx      结构化错误面板（M2）
    SettingsMenu.tsx    主题三档 + 编辑器字号 + 界面字号（M3/M4，Settings 弹出层）
    useDocs.ts          docs 懒加载 hook + prepareDocsHtml（M4 修 docs pre/标记）
  lib/
    schema.ts / schema-store.ts / config.ts / config-state.ts / config-io.ts / config-diff.ts / diagnostics.ts
    share-link.ts       URL hash 分享链接编解码（纯逻辑，M4）
    formatter-client.ts worker 封装：串行化、latest-wins、supersede、20s 超时、onFatal
    persisted-state.ts  localStorage 持久化（stateVersion=1；uiFontScale 为兼容增字段）
    theme.ts            ThemePreference、resolveTheme、applyTheme（data-theme + color-scheme）
    service-worker.ts   SW 注册/更新/在线离线事件（prod-only，可注入环境测试）
  worker/              formatter.worker.ts（唯一 wasm 实例、串行化、console 诊断捕获）+ protocol
tests/
  golden/              29 组 native clang-format 21.1.8 黄金输出（提交入库）
  e2e/                 helpers + smoke + m1 + m2 + m3 + m4 + m4-pwa + m4-a11y + golden + perf
public/
  schema/<ver>/        已提交（core.json + docs.json），52 个版本；index.json 驱动版本下拉
  manifest.json        PWA manifest（相对 start_url/scope）
  icons/               PWA 图标（192/512/maskable/apple-touch）
  sw.js                手写 Service Worker（Vite 原样拷进 dist）
  wasm/<ver>/          不提交（.gitignore），由 prepare:assets 生成
.github/workflows/
  ci.yml               verify（typecheck/unit/golden check/size/build/e2e）+ Playwright/wasm 缓存
  deploy.yml           build（含 e2e）→ deploy → 对线上 URL 跑整套 e2e
  nightly.yml          schema 漂移检查（只开 issue）
docs/screenshot.png    线上截图（README 引用）
NOTICE                 第三方材料与授权说明（LLVM 文档、wasm-fmt、v2 参考）
```

## 6. 已实现的行为与实现细节（读代码前必须知道）

1. **持久化（`persisted-state.ts` + `App.tsx`）**：状态文档 `{stateVersion, version, style, modified, code, theme, editorFontSize}`，`STORAGE_KEY="clang-format-configurator:v3"`，`STATE_VERSION=1`。`loadPersistedState` 同步、不抛异常：`empty/unavailable` 静默，`corrupt/version-mismatch` → 丢弃 + 一次性 notice（"Saved session was discarded"），单字段非法只降级为默认。`savePersistedState` 自身 stamp 版本号，quota/unavailable 返回状态码，App 只提示一次（`persist-banner`）。保存 400 ms 防抖；`pagehide`/卸载用 ref 稳定回调 flush（**不要让 flush effect 依赖每次编辑都变的函数**，否则每敲一个键都会同步写 localStorage）。
2. **版本恢复**：版本列表加载后优先用存档里的 version（仍在 `schema/index.json` 里才用），否则用默认版本；`reconcileModified` 丢弃目标 schema 不认识/已废弃的键，丢弃时把键名收进 notice（最多列 12 个）。
3. **主题（`theme.ts` + `SettingsMenu` + `styles.css`）**：三档 system/light/dark；显式档设 `html[data-theme=...]` + 内联 `color-scheme`，system 移除两者交给 `prefers-color-scheme`。CSS 词令顺序：`:root` 浅色基色 → `@media dark { :root:not([data-theme=light]) }` → `:root[data-theme=dark]`。`index.html` 预置脚本读 storage 的 `theme` 提前应用（防闪白）。**没有 matchMedia 监听**：system 档完全交给 CSS，切系统主题即时生效。
4. **响应式（`App.tsx` + `App.module.css`）**：`matchMedia("(max-width: 768px)")` 控制 `isMobile`；移动端渲染 `role="tablist"` 的两个 tab（`tab-options`/`tab-code`，默认 Code），main 上加 `mainOptions`/`mainCode` 类隐藏另一面板；←/→ 切换并转移焦点。CSS 断点：1100px/900px 是布局细化，768px 才是选项卡。
5. **可访问性**：跳过链接（`#main`）；`live-status` 是 visually-hidden 的 polite 播报（busy/error/formatted，避免每 250 ms 抖动）；OptionPanel 的 "N of M options shown" 是 debounced 的 polite 状态；对话框用 `aria-labelledby` 指可见标题；错误 `role="alert"`；chips `aria-pressed`；docs 展开 `aria-expanded + aria-controls`；可滚动 `<pre>`/warnings 加了 tabIndex；`--border-control` 专用于控件边框（1.4.11），`--border` 保持装饰用途。
6. **离线（`public/sw.js` + `service-worker.ts`）**：SW 是**普通 JS**（不是 TS、不参与打包），Vite 从 `public/` 原样复制到 `dist/sw.js`。缓存名 `cfc-v1`（改策略务必 bump）。install 预缓存 scope root + favicon、**不自动 skipWaiting**；activate 删旧 `cfc-*` 后 `clients.claim()`；fetch：导航 network-first → 缓存 shell → 合成离线页；同源 GET 静态资源 stale-while-revalidate（opaque/206/no-store 不缓存），离线 miss 返回 504；消息 `{type:"SKIP_WAITING"}` 才激活。注册模块 prod + 安全上下文才注册（`${BASE_URL}sw.js`, scope `BASE_URL`），`onUpdateReady` 每页最多一次，`applyUpdate()` 发 SKIP_WAITING 并在 `controllerchange` 时 reload 一次，`onOfflineChange` 初次即回调。
7. **质量闸门**：`check-size.mjs` 读 `dist/index.html` 找入口 script + modulepreload 算初 JS gzip，逐版本检查 wasm/core/docs；缺资源直接失败。`gen-golden.mjs` 的二进制解析顺序 `--clang-format` > `CLANG_FORMAT_BIN` > PATH > 仓库缓存（仅本机兜底），版本必须 21.1.8；`--check` 忽略 `generatedAt` 逐 fixture 比较。e2e 的 `golden.spec.ts` 在浏览器里 import `wasm/21.1.8/entry.js`，用 `JSON.stringify(style)` 调 `format(code, filename, style)`，**原始字节**比较（允许尾随空格/CRLF）。
8. **性能**：`perf.spec.ts` 在页面里直接 import wasm（绕过 UI 防抖）测 20 KB C++ 代码的 `format()` p95，并测版本切换冷/缓存时间（select → status ready + 输出出现，10 ms 轮询）。本机实测 p95 **18.6–22.7 ms**、冷切换 **130–166 ms**、缓存 **104–108 ms**。
9. **M0–M2 不变量仍然成立**：只发改动项；16 个 map 是稀疏 patch；导出按 schema 顺序、枚举 canonical、单结尾换行、导出→导入→导出**字节幂等**；版本切换剔除未知键；错误面板 `err.kind === "format"` 才进 ErrorPanel，fatal 走崩溃横幅；>2 MB 需确认；语言随文件名；diff 打开时普通双栏卸载（`source`/`output` 全局唯一）。
10. **分享链接（M4，`share-link.ts` + `App.tsx`）**：载荷 `{k:1, v, s, m, c?}` → base64url(UTF-8 JSON) → `#s=...`；编码上限 48 KB、code 上限 8 KB（超过只分享配置）；解码对 base64/JSON/k/v/s/m/c 逐项校验，任何异常返回 null。`App` 的 `useState` 初始化器里读 hash（**首帧就是分享状态**），storage 的 theme/editorFontSize 仍用；hydrate 后一次性 notice + `history.replaceState` 清 fragment。Copy link 从当前会话重新编码，clipboard 失败时把 URL 放进 notice。
11. **PWA（M4，`public/manifest.json` + `src/pwa/*`）**：manifest 全相对 URL；SW install 预缓存 shell/manifest/4 图标/favicon（逐项 catch，不因单个 404 失败），离线导航回退页有可操作文案。安装横幅自订阅 `install.ts` 单例（`main.tsx` 提前创建），`beforeinstallprompt` → canInstall，`promptInstall()` 用一次即丢弃事件，dismiss 写 `clang-format-configurator:install-dismissed`。
12. **界面字号（M4）**：`uiFontScale` 0.9/1/1.15；根字号 `calc(100% * var(--ui-scale))`，组件字号全 rem；编辑器走独立 `--font-size-editor`。虚拟列表 `remeasureKey` 变化后在 rAF 中对已渲染行 `measureElement`（**不可用 `measure()`**，见 §4 的坑）。
13. **键盘/焦点（M4）**：`roving.ts` 纯逻辑（isRovingNavigationKey/nextRovingIndex/pageStep/clampIndex/resolveActiveIndex/rovingTabIndex），OptionPanel 用一个 `activeKey` + `rangeExtractor` 强制把 active 行渲染进窗口；`focus-trap.ts` 提供 collectTabStops/resolveTabTarget + modal 栈（drawer z-index 110 > dialog 100），顶层 modal 消费 Escape/Tab 时 `stopImmediatePropagation()`，否则一次 Escape 会关两个。`useDocs.prepareDocsHtml` 在渲染层给 `<pre>` 加 `tabindex=0` 并清理 RST 泄漏标记（幂等，不改生成器）。
14. **52 版本 schema（M4）**：`versions.json` 行可带 `"dump": "native"`；`gen-schema.mjs` 对 native 版本逐个 `--style=<Style> --dump-config`（二进制从 `.cache/cf-native/<ver>` 或 `.cache/llvm/<ver>` 找），仍用 RST 做类型/枚举/文档与校验闸门；`--check` 把结果写到 `.cache/schema-check` 并与 `public/schema` 逐文件比较；`--allow-missing-native` 跳过默认值、照验 docs/结构。`check-size.mjs` 读 `versions.json` 逐版本校验 wasm/core/docs，缺版本直接失败；wasm 预算 1.1 MB（23.x 上游变大）。

## 7. 已知缺陷 / 有意的取舍

- **SW 更新横幅没有 e2e**：只有 `sw.js` 字节变化才会出现等待中的 worker；本地要确定性复现得在两次加载之间换一份 sw.js，成本高。更新生命周期由 `src/lib/service-worker.test.ts` 的 20 条单测覆盖（含 waiting→applyUpdate→reload 流程）。
- **持久化失败横幅（quota/unavailable）没有 e2e**：需要 stub localStorage 抛错；`persisted-state.test.ts` 21 条单测覆盖返回码。
- **M2 遗留**：>2 MB 输入与 worker 崩溃横幅没有 e2e（键盘输入 2 MB 太慢、崩溃无自然触发）；配置抽屉的"从文件加载"只由 M1 对话框同类用例覆盖。
- **两个入口并存**：快速 Import/Export 模态框与配置抽屉（有意，见 M2 交接）；M4 评估后仍保留——收敛会改变 M1 的 e2e 契约，收益不足以抵消回归风险。
- **docs 表格里的代码块仍无 `<pre>` 语义**：生成器把 RST 表格单元格压平成一行文本，渲染层的 `prepareDocsHtml` 只能清理泄漏的 directive/标记；要真正还原代码块得改 `tools/lib/rst.mjs`（已记录，不阻塞）。
- **安装横幅 dismiss 永久持久化**：key `clang-format-configurator:install-dismissed`，没有设置项重置（PWA 惯例；如需要可加"重置提示"）。
- **19.1.1 的 `core.build` 是上游标签错**（npm 包 `version()` 报 19.1.0）；format 行为与 native 19.1.1 一致，UI 状态栏显示选中版本，不影响功能。
- **nightly 不验 26 个 native-dump 版本的默认值**（需要 1.9 GB native；跳过时仍验 RST docs 与选项结构）。严格模式在本地/发布前跑 `npm run schema:check`。
- 没有 ESLint/Prettier、没有 Dependabot、没有 per-PR 预览。

## 8. e2e 覆盖清单（64 条）

- **smoke（4，M0）**：首屏格式化 / 换风格 / 换版本 / 改源码。
- **m1（17，M1）**：纯 UI 生成配置、reset、Minimal/Full roundtrip、导入 warning/legacy、稀疏 map、struct list、list<string>、过滤 chips、对话框焦点、非法 YAML、文件加载、下载、复制、docs 懒加载、enum/bool 控件、override 警告。
- **m2（12，M2）**：编辑器语义、Auto 关闭时 Ctrl/Cmd+Enter、语言徽标、字号、Diff 开关/真实高亮/在 diff 里编辑、抽屉实时校验/preview/apply/mode/下载/关闭、结构化错误面板。
- **m3（11，M3）**：会话持久化恢复（option+code+theme+font）、版本持久化、损坏存档、stateVersion 不兼容、主题三档 + 系统深色、Settings 弹层行为/焦点、移动端 tabs、桌面↔移动 resize、跳过链接、离线 SW（controller→reload→caches→offline→reload→banner）、a11y 语义 smoke。
- **m4（7，M4）**：分享链接复制→新标签恢复、hash 压过 storage、坏 hash 回退、首帧解码、界面字号缩放/持久化/行不重叠、文件名跟随示例（C#/Proto）、52 版本下拉 + 用 16.0.6/23.1.1 实际格式化。
- **m4-pwa（5，M4）**：manifest 字段/scope/图标、SW 预缓存 manifest+图标、安装横幅出现→安装、dismiss 持久化、语言徽标。
- **m4-a11y（5，M4）**：跨虚拟窗口方向键/Home/End/PageUp/PageDown、单一 Tab 停靠点与 Tab 进控件、ConfigDialog 焦点陷阱/Escape/焦点归还、docs `<pre>` 可聚焦 + RST 标记清理、两个 modal 只有顶层响应。
- **golden（1）**：29 组 fixture 与 native 21.1.8 逐字节相同（wasm 在浏览器里跑）。
- **perf（2）**：format p95 ≤80 ms；版本切换冷 ≤1.2 s / 缓存 ≤200 ms。

## 9. 下一步（M4 已完成）

v3 的 M0–M4 已全部交付；没有阻塞项。留作以后（按需，不承诺）：

1. 收敛快速导入/导出与配置抽屉（有意保留现状，见 §7）。
2. 改 `tools/lib/rst.mjs`，让 RST 表格单元格里的代码块有 `<pre>` 语义。
3. 加"重置安装提示"入口；给 SW 更新横幅、>2 MB、崩溃横幅补 e2e。
4. 仓库是否长期 public / 是否要 per-PR 预览（Pages 不支持，需 Cloudflare Pages）。
5. 若上游修了 16/17/22/23 的 wasm `dump_config`，可去掉 `"dump": "native"` 与 native 构建步骤（其余版本不受影响）。

## 11. 约定

- `plan.md` 是设计与取舍的唯一事实来源；实现偏离时先改 plan 再改代码。
- 提交信息用 `area: summary`（`feat:` / `test:` / `docs:` / `ci:`），一次提交一件事。
- 加版本：`tools/versions.json` 加一行（wasm 没有 `dump_config` 就加 `"dump": "native"`，并把同版本 native 二进制放到 `.cache/cf-native/<ver>` 或 `.cache/llvm/<ver>`）→ `npm run prepare:assets -- --only=<ver>` → 提交 `public/schema/<ver>` 与 lock → push。CI 不重跑 schema 生成（只 `prepare:wasm`）。
- **改持久化**：storage key / 不兼容 shape 变化必须 bump `STATE_VERSION`，并同步 `index.html` 的预置主题脚本（只依赖 `parsed.theme`）与 `persisted-state.test.ts`；**新增带默认值的字段**（如 `uiFontScale`）是向后兼容的，不 bump，但仍要更新 normalize/测试。
- **改分享链接**：`share-link.ts` 的载荷 `k` 是格式版本；字段语义变化要 bump `k` 并保留旧格式解码，同时更新 `share-link.test.ts` 与 m4 e2e。
- **改界面字号/字体**：组件 CSS 字号一律 rem（`--font-size-editor` 例外），改后跑 m4 的 "interface size" 用例；虚拟列表 remeasure 只能用 `measureElement`（见 §4）。
- **改 PWA**：manifest 保持相对 URL（子路径安全）；改 SW 预缓存列表要同步 `public/sw.js` 与 `service-worker.test.ts`，并 bump `CACHE_VERSION`。
- **改 SW**：bump `public/sw.js` 里的 `CACHE_VERSION`；保持 scope 从 `registration.scope` 推导、不要写死 `/`；改更新流程跑 `src/lib/service-worker.test.ts`。
- **改导出/导入**：必须跑 `config-io` 的 roundtrip 与 e2e 的 roundtrip；字节幂等是最容易漏的回归。
- **改 UI/主题**：跑 m2/m3 的 e2e；对比度用 `--border-control`（控件）与 `--border`（装饰）区分，别把装饰线调成高对比噪点。
- **改 golden**：`npm run golden:gen` 后用 native 21.1.8 重新生成，并跑 `npx playwright test tests/e2e/golden.spec.ts`；CI 的 `--check` 会拦 Windows/Linux 漂移。
- 提交前至少 `npm run verify`；动 UI/base/离线路径时跑 `npx playwright test`（base `/` 与子路径各一遍），再跑 `npm run check:size`。
- 改 workflow：保持 Playwright 浏览器缓存、`npx playwright install chromium`（无 `--with-deps`）、并发取消；golden 的 setup-python/pip 步骤不要挪到 build 之后（现在放在 npm ci 前，漂移 8 秒内失败）；52 版本后 ci/deploy 的 timeout 是 30 分钟，wasm 缓存 key 用 `hashFiles('tools/versions.json')`。
- 网络抖动时不写重试循环；GitHub API 匿名限流时直接看 Actions 网页。

## 12. 最近验证记录

### 本地（2026-10-24，M4 完成后）

| 项 | 结果 |
|---|---|
| `npm run verify` | ✅ typecheck 0 错 + **298 unit（18 文件）** + build |
| `npx playwright test`（base `/`，production build） | ✅ **64 passed**（31.4 s；perf 在独立 project 里串行跑，cached 切换 64 ms） |
| `npx playwright test`（`VITE_BASE=/clang-format-configurator-v3/`） | ✅ **64 passed**（31.5 s；cached 切换 75 ms） |
| `npm run check:size` | ✅ 157 项全过：初 JS **224.5 KB**（限 250）；52 个 wasm **902.4–1071.5 KB**（限 1.1 MB）；core 6.4–8.5 KB（限 25）；docs 19.3–24.6 KB（限 45） |
| `node tools/gen-golden.mjs --check` | ✅ 29 组与 native 21.1.8 一致（M3 记录，未改 fixture） |
| 黄金对拍（wasm vs native） | ✅ 29/29 逐字节相同 |
| 52 版本自检 | ✅ 52/52 entry.js 可加载并格式化；26 个 native-dump 版本 **312/312** 次 CLI vs wasm 逐字节相同 |
| `npm run schema:check` | ✅ 严格模式 52 版本 OK；`--allow-missing-native` 干净 checkout（清 `.cache/rst`）可跑；篡改 index → exit 1 |
| 性能 | ✅ format p95 **9–23 ms**（限 80，单独跑 11.3 ms）；版本切换冷 **79–116 ms**、缓存 **76–144 ms**；并行偶尔 >200 ms（flaky） |
| 离线/PWA | ✅ 断网刷新后 shell + 格式化可用；manifest/图标/SW 预缓存 e2e 通过 |
| 单测覆盖 | 18 文件：config / config-state / config-io / schema-store / schema / config-diff / diagnostics / formatter-client / languages / examples / persisted-state / share-link / theme / service-worker / roving / focus-trap / useDocs / install |

### CI / 部署（GitHub Actions，M4）

| 项 | 结果 |
|---|---|
| ci（M4 代码最终提交 `1b0cdcf`） | ✅ [40062550829](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40062550829)：setup-python + native 21.1.8 + `golden:gen --check` + typecheck/**298 单测** + build + **157 项** `check:size` + **64 条** e2e（chromium，perf 独立 project 串行），1m28s 全绿 |
| deploy（M4 最终线上） | ✅ [40062550843](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40062550843)：build（含 64 条 e2e，1m07s）→ deploy（18s）→ smoke 对线上 URL 再跑整套 64 条（1m07s），全绿 |
| nightly（手动触发验证） | ✅ [40062227600](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40062227600)：`prepare:wasm` + `schema:check --allow-missing-native` 16s 通过（干净 checkout，无 native 二进制，RST 走网络），无 drift issue |
| 线上复跑（本地 Edge，全套） | ✅ `PW_BASE_URL=... npx playwright test` → **63 passed + 1 flaky**（perf 冷切换在公网抖动、retry 通过；与 M3 记录同类）。另一次并行全量跑中 m4-a11y 的"方向键跨虚拟列表"因公网资源加载抖动失败一次，单跑通过——CI 的 deploy smoke 对线上整套 64 条全绿 |
| 线上资源（M4） | ✅ 首页、`manifest.json`（`application/json`）、`icons/*.png`（`image/png`，192=7915 B）、`sw.js`（**v2**，8714 B）、`schema/index.json`（**52 版本**，default 21.1.8）、`wasm/16.0.6/entry.js`、`wasm/23.1.1/clang-format.wasm`（`application/wasm`）均 200；线上 manifest/安装横幅/SW 预缓存/分享链接/字号/52 版本 e2e 全部通过 |

### 历史（2026-10-24，M3 完成后）

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
