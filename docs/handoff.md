# 交接文档（M2 完成 → 准备 M3）

> 新会话先读本文件，再读 [`plan.md`](../plan.md)。plan.md 是设计与取舍的唯一事实来源；本文只记状态、命令、坑和待办。
> 最后更新：2026-10-24 09:45。M2 落地的代码范围：`src/editor/`、`src/components/{ConfigDrawer,DiffPane,ErrorPanel}.*`、`src/lib/{diagnostics,config-diff,formatter-client}.*`、`src/worker/*`、`src/App.tsx`、`src/App.module.css`、`src/styles.css`、`package.json`；测试：`tests/e2e/{helpers,m2.spec}.ts` + `smoke/m1` 适配；具体提交以 `git log` 为准。

## 1. 一句话现状

**M2 已完成**：CodeMirror 6 双栏编辑器（语言随文件名、字号可调、Ctrl/Cmd+Enter、250 ms 防抖）、`@codemirror/merge` 的真实 split diff（懒加载）、worker 请求串行化 + latest-wins + LLVM 诊断捕获 + 超时/fatal 重建、结构化错误面板、配置页抽屉（CM6 YAML + 实时校验 + 增删改键预览 + 上传/下载/Apply），以及 >2 MB 输入确认。
`npm run verify` 全绿（typecheck + **146 单测** + build），Playwright **33 条**（4 smoke + 17 M1 + 12 M2）在 base `/` 与 `/<repo>/` 子路径下各全绿；首屏 JS **222.9 KB gzip**（预算 250）。
**M3（持久化 / 主题 / 响应式 / a11y / 离线 / 性能预算脚本 / 黄金对拍 / NOTICE）尚未开始。** M0/M1 的功能与 CI/Pages 发布保持可用。

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

验证三件套（提交前跑，不需要外网）：

```powershell
npm run verify           # typecheck + vitest + build（146 单测）
npx playwright test      # 本地用 Edge（channel=msedge），33 条
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

只跑 M2 / 有头观察：

```powershell
npx playwright test tests/e2e/m2.spec.ts
npx playwright test --headed
npx playwright test -g "diff"
```

首屏体积（M2 之后不再有 `check:size` 脚本，M3 才做；当前手动口径）：

```powershell
npm run build
# 看 vite 输出的 index-*.js gzip = 223.54 KB；实际首屏还要加 lazy 之前就会加载的 clike chunk 7.50 KB
# = 222.9 KB gzip（不含 wasm glue；含 21.1.8 glue 13.6 KB 也仍 < 250）
```

**最终验收必须对 production build 跑**（`npm run build` + `npx playwright test` 自动起 `vite preview`），dev server 只用于日常迭代。

## 4. 环境事实与坑（踩过的）

- 本机 **Windows + PowerShell**；Node **v26.12.0**、npm **11.20.0**。CI 用 Node **22**。
- 本地 npm 配了腾讯镜像，但 `tools/fetch-wasm.mjs` 默认直接访问 `registry.npmjs.org`；可用 `NPM_REGISTRY` 覆盖。
- 本地 Playwright 用 **Edge**（`channel: "msedge"`，无需下载浏览器）；CI 用 `PW_CHANNEL=chromium`。
- **`vite preview` 必须 `--host 127.0.0.1`**：runner 上 `localhost` 解析到 `::1`，Playwright 连 `127.0.0.1` 会 60s 超时。
- **e2e 里必须 `page.goto("./")`，不能 `page.goto("/")`**：`/` 会丢掉 baseURL 的 `/<repo>/` 前缀。
- **端口冲突会挂住 Playwright**：若 4173 上已有 preview，再起 webServer 会卡到超时。跑 e2e 前确认 4173/5173 没有残留进程（`Get-NetTCPConnection -LocalPort 4173`），或先清掉后台任务。
- **CM6 与 Playwright（M2 新增，必读）**：
  - `data-testid="source"/"output"/"config-yaml"` 挂在 **`.cm-content`**（contenteditable）上，不是 textarea：`fill()` 不可靠，用 `click → ControlOrMeta+A → keyboard.insertText`（`tests/e2e/helpers.ts` 的 `setEditorText`）。
  - **DOM `textContent` 没有换行**（每行一个 `.cm-line` div）；用 `.cm-line` 拼接还原逻辑文本（`readEditorText`）。不要用 `innerText`：空行会额外插入一个 `\n`，已实测踩坑。
  - diff 模式与普通双栏**不会同时存在**（`source`/`output` 永远各只有一个），strict locator 安全；切 diff 时普通编辑器会 unmount，所以 `Auto`/光标状态会丢（预期）。
  - 语言高亮是 lazy chunk：首屏只加载 clike（默认 C/C++），切到 YAML/Proto 等按需再拉；`@codemirror/merge` 也是 lazy（Diff 开关才拉）。
  - CM6 里 `Mod-Enter` 被 `defaultKeymap` 绑定为 `insertBlankLine`；自定义提交键必须 `Prec.highest`（`CodeEditor` 用扩展顺序、`DiffPane` 显式 `Prec.highest`），否则 Ctrl/Cmd+Enter 会失效。
- **Windows 剪贴板会把换行归一成 CRLF**：e2e 里复制 `.clang-format` 后比较文本要 `replace(/\r\n/g,"\n")`；下载文件名在 Edge 下是 `clang-format`（前导点被去掉），M1/M2 用例都按这个断言。
- TypeScript **7.0.2**：对重复的索引访问不做持续窄化，会报 TS2698；先取局部变量再窄化。
- **CI 时长 / Playwright 缓存（2026-10-23 优化，仍有效）**：
  - `npx playwright install chromium`（**不要带 `--with-deps`**）；ci/deploy 都缓存 `~/.cache/ms-playwright`，key = `hashFiles('package-lock.json')`。warm 缓存 ci ≈ 41s，冷缓存 ≈ 1m2s。
  - ci 有 `concurrency.cancel-in-progress` 与各 job 的 `timeout-minutes`。
  - 改 `package-lock.json`（M2 加了 CM6 依赖）会让浏览器缓存 key 失效 → 下一次运行多 ~10s 冷安装，属正常。
- **网络**：`github.com` / `api.github.com` 偶发 DNS/TLS 抖动，**不要写重试循环**；等几分钟或看 Actions 网页。
- gh 已登录账号 **lzh0394**，仓库 public；Pages 已设为 `build_type: workflow`。

## 5. 代码地图

```
tools/
  versions.json        版本清单（唯一事实来源，当前 3 个）
  fetch-wasm.mjs       拉 npm tarball → 校验 sha512 → public/wasm/<ver>/ + 生成 entry.js
  gen-schema.mjs       dump_config + LLVM RST → public/schema/<ver>/{core,docs}.json（含校验闸门）
  prepare-assets.mjs   依次跑上面两个；--only=<ver> / --refresh-rst 可传
  lib/rst.mjs          ClangFormatStyleOptions.rst 解析 + 子集 reST→HTML
  lib/tar.mjs          最小 ustar 读取（不引 tar 依赖）
  wasm.lock.json       已提交：每版本 integrity + 每个文件 sha256
src/
  App.tsx              版本/风格/文件名 + 选项面板 + 编辑器/diff 切换 + 错误/崩溃横幅 + 抽屉/对话框 + 状态栏
  App.module.css       布局（≥1100px: 面板 | 编辑区；<900px 上下堆叠）+ 大输入/崩溃横幅样式
  main.tsx / styles.css  design tokens（含 --font-size-editor、--syntax-*）
  editor/
    CodeEditor.tsx      受控 CM6 编辑器：value/onChange/language/readOnly/testId/onSubmit，compartments 同步
    languages.ts        文件名→语言映射 + lazy 语言包（clike/protobuf/lang-yaml），带缓存
    theme.ts            共享 CM6 主题 + 语法高亮（全部走 CSS 变量）
    CodeEditor.module.css
  components/
    OptionPanel.tsx     虚拟列表 + 搜索 + 过滤 chips + 面板头（M1）
    OptionRow.tsx       单行：key/徽标/控件/docs/reset/override 警告（M1）
    controls.tsx        五种控件（M1）
    ConfigDialog.tsx    快速导入/导出对话框（M1，保留）
    ConfigDrawer.tsx    配置页抽屉（M2）：CM6 YAML + 实时校验 + 预览 + 上传/下载/Apply
    DiffPane.tsx        真实 split diff（@codemirror/merge，M2，lazy）
    ErrorPanel.tsx      结构化错误面板（M2）
    useDocs.ts          docs 懒加载 hook（M1）
  lib/
    schema.ts           schema 类型、资源加载、buildStylePayload
    schema-store.ts     版本 schema/docs LRU(3)，in-flight 去重，失败不缓存
    config.ts           modified 模型：effectiveValue、稀疏 map、formatValue
    config-state.ts     ConfigState + reducer + 版本切换 reconcileModified
    config-io.ts        serializeConfig（minimal/full）+ parseConfigText（校验/warning/legacy）
    config-diff.ts      diffModified / deepEqual（配置抽屉预览）
    diagnostics.ts      splitErrorText / describeError / mergeDiagnostics（LLVM 诊断）
    formatter-client.ts worker 封装：单飞 + latest-wins + supersede + 20s 超时 + onFatal
  worker/
    protocol.ts         init/format；ready/ok/err(kind: format|fatal)
    formatter.worker.ts 唯一 wasm 实例；请求串行化 + 队列最新优先；console 诊断捕获
tests/e2e/
  helpers.ts            CM6 逻辑文本/输入、打开应用等待首屏（M2 新增）
  smoke.spec.ts         M0 冒烟 4 条（已适配 CM6）
  m1.spec.ts            M1 17 条（已适配 CM6）
  m2.spec.ts            M2 12 条（编辑器 / diff / 抽屉 / 错误面板）
public/
  schema/<ver>/        已提交（core.json + docs.json），index.json 驱动版本下拉
  wasm/<ver>/          不提交（.gitignore），由 prepare:assets 生成
.github/workflows/
  ci.yml               verify：typecheck + unit + build + e2e；Playwright 浏览器缓存 + 并发取消
  deploy.yml           build（含 e2e）→ deploy → 对线上 URL 跑整套 e2e（smoke）
docs/screenshot.png    线上截图（README 引用，M2 更新为 diff 模式）
```

## 6. M2 已实现的行为与实现细节（读代码前必须知道）

1. **`CodeEditor`（`src/editor/CodeEditor.tsx`）是唯一受控 CM6 封装**：React 拥有文本；用户编辑才触发 `onChange`，props 变化时用 `dispatch({changes})` 同步文档并跳过回显。挂载只做一次，语言/只读/contentAttributes 全走 Compartment。`testId` 由 `EditorView.contentAttributes` 落在 `.cm-content`。**不要**在别处再造一个 CM6 实例；YAML 抽屉也复用它。
2. **语言由文件名决定**（plan §6：`Language` 不是 UI 选项）：`languageForFilename` 映射 c/h/cc/cpp/cxx/hpp→cpp、java、cs、proto、`.clang-format`/yaml→yaml；未知扩展 → plain。代码语言用 **legacy stream modes**（clike 的 cpp/java/csharp、protobuf），只有 YAML 用 `@codemirror/lang-yaml`；全部 lazy + 进程内缓存。**这是首屏预算决策**：改用 `@codemirror/lang-cpp`/`lang-java` 会让首屏多 ~35 KB gzip（实测 257 KB，超 250 预算），所以不引这两个包。
3. **diff 是真实 MergeView**（`DiffPane.tsx`）：懒加载 chunk；两侧共用一个滚动容器（滚动同步）、`collapseUnchanged {margin:3,minSize:4}`、无 accept/reject 按钮；左可编辑 → `onChange` → App → 重新格式化 → 右文档更新。**diff 打开时普通双栏 unmount**，不要同时渲染两套 `source`/`output`。
4. **worker 协议**（`protocol.ts` / `formatter.worker.ts`）：`err` 带 `kind: "format" | "fatal"`；worker 内请求串行化，格式化排队时**新请求替换旧排队**（旧的回一条 `superseded` err）；格式化期间临时接管 `console.error/warn` 收集 LLVM stderr 并并入 `detail`（finally 还原）。wasm `entry.js` 按版本懒 import，一个 worker 一个实例（换版本 terminate）。
5. **`FormatterClient`**：单飞 + 队列只保留最新（被替换的排队请求 reject `FormatterSupersededError`，调用方必须静默忽略）；格式化 20s 超时 / `onerror` / `onmessageerror` / fatal err → 清空 pending、teardown、调 `onFatal`，之后 `init(version)` 可重建。`dispose()` 不触发 `onFatal`。App 里 fatal 由崩溃横幅接管（自动重试一次，之后 `worker-retry` 手动），`kind === "format"` 的错误才进 `ErrorPanel`。
6. **结构化错误面板**：`ErrorPanel` 默认折叠诊断（`<details>`）；e2e 断言 `<pre>` 前必须先点 `summary`，否则 `innerText` 只看得到 summary。**可复现的真实触发**：配置抽屉里写 `ColumnLimit: 1e21`（schema 的 int 校验通过，clang-format 报 `invalid number`）→ 摘要 `Error parsing -style: Invalid argument` + 展开的 LLVM 原文。
7. **配置页抽屉**（`ConfigDrawer.tsx`）：每次打开用当前配置重新序列化（minimal 默认，mode 跨打开保留）；改 mode 会丢弃未 Apply 的编辑（有意，测试已据此写）；150 ms 防抖校验（致命 YAML 错误带行列号，未知键/非法值 → warning 列表）；底部预览用 `config-diff.ts` 对比"当前 modified vs 解析结果"，按 schema 选项顺序列出 added/removed/changed + BasedOnStyle 变化；Apply 成功才关闭。M1 的 `ConfigDialog`（Import/Export 模态框）保留为快速入口，两者共用 `config-io.ts`。
8. **快捷键 / 字号 / 大输入**：Ctrl/Cmd+Enter 在编辑器内由 CM6 keymap（`Prec.highest` 语义）触发、页面其他地方由 App 的 document keydown 兜底（依赖 `defaultPrevented`）；`Auto` 开关保留（关闭后只有按钮/快捷键触发）。编辑器字号选择器写 CSS 变量 `--font-size-editor`（12–20 px，仅编辑器；界面字号归 M3）。源码 >2 MB 时不自动格式化，显示 `large-input` 横幅，点 `format-anyway` 才发请求。
9. **M1 不变量仍然成立**（改导出/导入相关代码前必须遵守）：只发改动项；16 个 map 是稀疏 patch；导出按 `schema.options` 顺序、枚举 canonical、单结尾换行、导出→导入→导出**字节幂等**（`config-io.test.ts` 78 条 + e2e roundtrip 兜底）；版本切换 `reconcileModified` 剔除未知键；`SpacesInLineCommentPrefix.Maximum` 的 `-1` 是老 schema 瑕疵，Full roundtrip 仍字节相同。
10. **`SpacesInLineCommentPrefix.Maximum` 已知 schema 小瑕疵**（同 M1）：类型是 uint 但 preset 为 -1，Full 导出→导入会丢这个 child 并给 warning，字节仍幂等。

## 7. 已知缺陷 / 有意为之

- **16.0.6 / 17.0.6 不可用**：wasm 包只导出 `format`/`version`，没有 `dump_config`。
- **22.x / 23.x 不可用**：`dump_config` 值域错位，被 schema 校验闸门拦下，等上游修。
- **M2 未覆盖的 e2e**：>2 MB 输入横幅（2 MB 级键盘输入太慢，CI 会超时）、worker 崩溃横幅（无自然触发路径，只有单测覆盖队列/超时/重建）；抽屉的"从文件加载"未单独测（M1 对话框同类路径已覆盖）。
- **配置抽屉 mode 切换丢弃未 Apply 的编辑**（设计如此，避免"改一半再切模式"产生歧义）；如觉得反直觉，M3 可加确认提示。
- **快速导入/导出对话框与配置抽屉功能重叠**（有意保留两个入口：前者面向"粘贴一份文件"，后者面向"直接编辑 YAML"）；若 M3 想收敛，删 `ConfigDialog` 即可，`config-io` 不动。
- **docs HTML 里 code-block 的渲染还很粗糙**（枚举表格的 "Meaning" 列会出现字面 `code-block:: c++`）——`tools/lib/rst.mjs` 子集渲染的局限，M2 未修。
- **没有持久化 / 主题切换 / 移动端 tabs / 完整 a11y**（M3）。
- 没有 ESLint/Prettier（无 `npm run lint`）；没有 Dependabot；action 用 major 版本；没有 per-PR 预览。

## 8. e2e 覆盖清单（33 条）

**smoke（4，M0，已适配 CM6）**：首屏格式化 / 换风格 / 换版本 / 改源码。

**m1.spec.ts（17，M1）**：纯 UI 生成配置、reset、Minimal roundtrip、Full roundtrip、导入 warning + legacy 转换、稀疏 map、struct list、list<string>、过滤 chips、对话框焦点管理、非法 YAML、文件加载、下载、复制、docs 懒加载、enum/bool 控件、依赖项 override 警告。

**m2.spec.ts（12，M2）**：

1. 编辑器语义：source `contenteditable=true` / output `contenteditable=false` + `aria-readonly=true`，对 output 打字无效，改 source 会重新格式化
2. Auto 关闭时 Ctrl/Cmd+Enter 立即格式化（且之前没有防抖触发的格式化）
3. 文件名 → 语言徽标：main.cc→C/C++、Main.java→Java、Program.cs→C#、service.proto→Protobuf、`.clang-format`→YAML、README→Plain text
4. 字号选择器 13→18→12 px 反映到 `.cm-content` 计算字号
5. Diff 开关：`diff-view` 出现，内部恰好一个 source/output（普通双栏 unmount），`.cm-changedLine`/`.cm-changedText` > 0
6. 在 diff 左侧输入会重新格式化右侧；关掉 Diff 恢复双栏
7. 抽屉实时校验：非法 YAML → `config-errors` role=alert 且 Apply 不关闭；合法 → `config-valid` + preview "Added IndentWidth"；未知键 → `config-warnings`
8. Apply `IndentWidth: 7` → modified=1、输出缩进 7 空格、Minimal 导出含该键
9. Minimal/Full 切换重新序列化（>1000 字符、含 AccessModifierOffset）
10. 下载 `.clang-format`（Edge 下建议文件名是 `clang-format`）
11. 关闭按钮与 Escape 关闭抽屉并把焦点还给 `open-config`
12. 结构化错误：`ColumnLimit: 1e21` → 摘要 + 展开后 `<pre>` 含 `<command-line>:1:38: error: invalid number` 与 style JSON；dismiss 后清空配置可恢复格式化

## 9. 下一步：M3（按 plan §9）

建议顺序（每步可单独提交、可验证）：

1. **持久化**：localStorage 保存 `{version, style, modified, code, theme, editorFontSize}`（带 schema 版本号，不兼容时丢弃并提示）；刷新恢复；与 e2e 加一条"改配置 → reload → 状态还在"。
2. **主题切换 + 响应式**：`prefers-color-scheme` 已有，补手动切换（light/dark/system，写 `data-theme` 或 class）；<768px 变成"选项 / 代码"选项卡；已有 900/1100px 断点仅做布局，需要真正的移动端切换控件。
3. **可访问性**：键盘全流程、对比度 AA、`prefers-reduced-motion`（styles.css 已有全局规则）；错误用 `role="alert"` + `aria-live`（编辑器输出需要 aria-live 容器）；焦点管理已由两个对话框覆盖。
4. **离线**：Service Worker（Vite 插件或手写）缓存 app shell + 当前版本 wasm/schema；`vite.config` 需注意 base；离线首次访问的失败路径已有横幅（M0）但未做 SW。
5. **性能预算脚本**：`scripts/check-size.mjs`（读 dist，按 §1 限额失败）+ 接 CI；同时把"选项变更 → p95 ≤ 80 ms（20 KB 代码）"测出来（Playwright 计时或 bench 脚本）。
6. **黄金对拍**：`tests/golden/*.json` 24 组（代码 + 风格），期望输出由 native clang-format 21.1.8 生成（CI `pip install clang-format==21.1.8`），CI 用 wasm 跑并逐字节比较。
7. **收尾**：README/NOTICE 授权与致谢（计划已有 MIT + LLVM + wasm-fmt 说明，需落 `NOTICE` 文件）、截图更新、plan §9 标 M3 状态。

估时（plan §9 校准）：M3 ≈ 1.7 天 P50（a11y + SW + 250 KB 预算是下界偏紧的三块）。

## 10. 待决策

- **16/17/22/23 怎么办**：(a) 用 PyPI native binary 做构建期 dump（schema 仍提交，运行时不变）；(b) 支持范围改成 18+；(c) 等上游修 22/23。
- 仓库是否长期 public（影响 Pages 免费额度）。
- 是否要 per-PR 预览（Pages 原生不支持，需 Cloudflare Pages 等）。
- 是否删掉 M1 的快速导入/导出模态框、只保留配置抽屉（见 §7）。

## 11. 约定

- `plan.md` 是设计与取舍的唯一事实来源；实现偏离时先改 plan 再改代码。
- 提交信息用 `area: summary`（`ci:` / `test:` / `docs:` / `feat:`），一次提交一件事。
- 加版本：`tools/versions.json` 加一行 → `npm run prepare:assets -- --only=<ver>` → 提交 `public/schema/<ver>` 与 lock → push。CI 不重跑 schema 生成（只 `prepare:wasm`）。
- 改 UI 文案/行为时顺手更新 README 的支持版本表与截图（`docs/screenshot.png`；截图可用 Playwright 脚本，1440×900；M2 的截图是 Diff 模式）。
- 改导出/导入格式时**必须**跑 `src/lib/config-io.test.ts` 的 roundtrip 与 e2e 的 roundtrip 两条；破坏字节幂等是最容易漏的回归。
- 改 CM6 编辑器/语言时跑 `src/editor/languages.test.ts` 与 `tests/e2e/m2.spec.ts`（前 6 条），并留意首屏预算（别把 merge 或 Lezer 语言包 import 进入口）。
- 提交前至少跑 `npm run verify`；动到 UI/base 路径时再跑 `npx playwright test`（base `/` 与子路径各一遍）。
- 改 `.github/workflows/*.yml`：保持 Playwright 浏览器缓存 + `npx playwright install chromium`（无 `--with-deps`）；不要引入每次运行的 apt 步骤（见 §4）。
- 网络抖动时不要写重试循环：直接看 Actions 网页或等几分钟。

## 12. 最近验证记录

### 本地（2026-10-24，M2 完成后）

| 项 | 结果 |
|---|---|
| `npm run verify` | ✅ typecheck 0 错 + **146 unit（9 文件）** + build |
| `npx playwright test`（base `/`，production build） | ✅ **33 passed**（4 smoke + 17 m1 + 12 m2，24.0 s） |
| `npx playwright test`（`VITE_BASE=/clang-format-configurator-v3/`） | ✅ **33 passed**（23.8 s） |
| 首屏 JS | 入口 223.54 KB gzip（build 报告）；实测首次加载 215.45（入口）+ 7.50（clike）= **222.9 KB gzip**，不含 wasm glue；含 21.1.8 glue 13.56 KB 也 < 250 |
| 单测覆盖 | `config` / `config-state` / `config-io` / `schema-store` / `schema` / `config-diff` / `diagnostics` / `formatter-client` / `editor/languages` |
| 页面运行时错误 | 0（首页加载 + 格式化 + diff 切换） |

### CI / 部署（GitHub Actions）

| 项 | 结果 |
|---|---|
| ci（M2 提交 `267f1de`） | ✅ [40051244202](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40051244202) |
| deploy（M2 线上） | ✅ [40051244118](https://github.com/lzh0394/clang-format-configurator-v3/actions/runs/40051244118)：build（含 33 条 e2e）→ deploy → 对线上 URL 再跑整套 e2e，全绿 |
| 线上复跑 M2 组（本地执行） | ✅ `PW_BASE_URL=https://lzh0394.github.io/clang-format-configurator-v3/ npx playwright test tests/e2e/m2.spec.ts` → **12 passed**（40.2 s）；线上页面 200，入口与 CSS 资产 200 |
