# Clang-format Configurator v3 — 纯前端重建方案

> 状态：M0–M4 已交付（2026-10-24）· 目标产物：`C:\workspaces\clang-format-configurator-v3`
> 依据：对 v2（https://github.com/Wirena/clang-format-configurator-v2）的源码审查与线上实测
> 本文只记设计与取舍；当前状态、命令、坑与验证记录见 [`docs/handoff.md`](docs/handoff.md)，未排期事项见 [`docs/todo.md`](docs/todo.md)。

## 0. 已确定的前提

| 决策 | 结论 |
|---|---|
| 版本范围 | 16.0.6 – 23.1.1，**全部 52 个已发布 wasm 版本**：16.x/17.x/22.x/23.x 的 schema 默认值走同版本 native dump，运行期格式化仍用 wasm（§3.1） |
| 后端 | **完全没有**。静态站点 + 浏览器内 wasm |
| 老版本 7–15 | 不支持（没有 wasm 构建）；README 致谢里给出 v2 链接 |
| 代码位置 | `C:\workspaces\clang-format-configurator-v3`，全新仓库（v2 的 clone 仅作参考，不 fork） |
| 技术栈 | Vite + React 19 + TypeScript + CodeMirror 6 + TanStack Virtual；样式 CSS Modules；状态 `useReducer`；Vitest + Playwright（详见 §2.1） |
| 数据来源 | 选项 schema 由 LLVM RST 文档 + wasm 的 `--dump-config` 生成；**不需要编译 LLVM、不需要 Docker** |

## 1. 目标与验收标准

**目标**：把"交互式生成 clang-format 配置"这件事做成一个可离线、无服务器、加版本只要两分钟的静态应用；所有格式化在本地 wasm 里完成。

| 指标 | 验收值 |
|---|---|
| 首屏 JS（gzip，不含 wasm/schema） | ≤ 250 KB |
| 单版本 schema 首包 | ≤ 25 KB gzip（core）；文档 ≤ 45 KB gzip（首次点开帮助才加载） |
| 单版本 wasm | ≤ 1.1 MB gzip（52 版本实测 902–1072 KB；23.1.0/23.1.1 因上游 23.x 构建增大约 4.6%，2026-10 把预算从 1.0 MB 调到 1.1 MB） |
| 选项变更 → 新格式化结果 | p95 ≤ 80 ms（20 KB 代码） |
| 版本切换可用时间 | 冷切换 ≤ 1.2 s；已缓存 ≤ 200 ms |
| 一致性 | 29 组 fixture 在 native clang-format 21.1.8 与 wasm 上**逐字节相同** |
| 导出幂等 | `.clang-format` 导出 → 再导入 → 再导出，字节相同 |
| 功能对齐 | v2 的用户可见功能全部保留（除版本范围），并修复第 6 节列出的 v2 已知缺陷 |
| 可访问性 | 键盘可完成全流程；对比度 AA；`prefers-reduced-motion` 生效 |

## 2. 架构

```
构建期（一次性、可缓存）
  tools/versions.json ──┬─► fetch-wasm.mjs ──► public/wasm/<ver>/{clang-format.js,.wasm}
                        └─► gen-schema.mjs ──► public/schema/<ver>/{core.json,docs.json}
                             ├─ LLVM RST (raw.githubusercontent, 按 tag)
                             └─ wasm CLI: clang-format --style=X --dump-config （7 种风格）

运行期
  React UI ──(id)──► Formatter Worker ──► import(/wasm/<ver>/clang-format.js) ──► format(code, name, styleJSON)
      │                      ▲
      └── Schema Store ──────┘  fetch /schema/<ver>/core.json + 懒加载 docs.json
```

四个关键决策：

1. **schema 在构建期生成并提交进仓库**（文本、可 diff、可 review），wasm 不提交（体积大、可由脚本复现）。这样 `npm run dev` 在没有网络重抓资源时也能跑。
2. **只发送用户改动过的选项**（`BasedOnStyle` + `modified`），不再像 v2 那样把 190 个默认值全量物化。默认值只用于**显示**，由 `modified[key] ?? defaults[style][key]` 派生。这从根上消灭了 v2 那个 "Remove duplicates (Not tested)"。
3. **格式化在 Worker 里跑**，主线程永不阻塞。同一时刻只有一个 wasm 实例（每实例常驻 ~54 MB）；换版本时 terminate 旧 worker 再起新的，靠进程边界回收内存。
4. **错误详情从 `console.error` 捕获**。wasm 版 `format()` 抛出的异常只有 `Error parsing -style: Invalid argument`，真正的诊断走 stderr；必须拦截才能保留 v2 "可读报错" 的卖点。

### 2.1 技术栈：选型与被否方案

选型的四个硬约束：纯静态无服务器、52 个 wasm 大资源、147–209 个选项的交互密度、首屏 ≤ 250 KB gzip。任何一项不满足即出局。

| 层 | 选型 | 负责什么 | 被否的方案 |
|---|---|---|---|
| 构建 | Vite | dev/build、`base` 注入、Worker 与资源 URL | CRA（已停更，v2 的 6 MB bundle 即其产物）、webpack（配置成本）、Next/Astro（无 SSR 需求，wasm 只能在客户端） |
| UI | React 19 | 选项面板、编辑器编排、状态派生 | Preact（省 ~30 KB 但要补生态，留作超预算时的 `compat` 别名兜底）、Svelte（整体重写） |
| 编辑器 | CodeMirror 6 | 可编辑源码、只读结果、行级 diff | Monaco（2 MB+，自带 worker 体系，diff 是实例级 API）、Ace（v2 的选择，diff 需自研） |
| 长列表 | TanStack Virtual | 147–209 行 + 动态行高（展开文档会变高） | `react-window`（以固定行高为主，动态测量要手写） |
| 计算 | clang-format wasm（Emscripten，单线程），跑在 Worker 内 | 真正的格式化，主线程不阻塞 | 后端 exec（v2 方案，需服务器）、WebContainer（过重） |
| 数据 | 构建期生成的 JSON schema | 选项定义、七风格默认值、文档 | 运行时抓 RST 解析（慢、不可控、CI 依赖上游） |
| YAML | `yaml`（eemeli） | 导入 `.clang-format`、带行列号报错 | `js-yaml`（无 CST，unknown key 定位弱） |
| 样式 | **CSS Modules + design tokens** | 选项行、抽屉、编辑器外框 | Tailwind（purge 对动态 class 不友好，reset 与 CM6 主题变量冲突）、CSS-in-JS（运行时开销 + 额外 8–12 KB） |
| 状态 | **`useReducer` + context**，不引库 | `{version, style, modified}` 单一对象 | Zustand（3 KB；等面板重渲染真成瓶颈再换，用 selector 化）、Redux（过重） |
| 路由 | 不用 | 单视图；分享链接走 URL hash | React Router（唯一需求是 hash 解析，20 行足够） |
| 测试 | Vitest + Playwright | 纯逻辑单测 + 真浏览器 e2e | Jest（另配一套 transform）、jsdom（测不了 wasm/Worker/SW） |

四个决定值得单独说明：

- **CM6 而非 Monaco**：`@codemirror/merge` 给的是**文档级** diff（可折叠未变更区、可嵌入 unified 视图）；Monaco 的 diff 绑定编辑器实例，塞进现有双栏要绕着走。CM6 还能按需组装语言包（C/C++、C#、Java、Kotlin、Objective-C、Proto、JS/TS，`.clang-format` 走 YAML）。
- **没有组件库**：`IncludeCategories`、`RawStringFormats` 这类结构体数组编辑器组件库覆盖不了，最后仍要手写；五种控件自己写更快，也省掉 100 KB+ 与样式覆盖成本。
- **Worker 不用 Comlink**：协议需要"新请求到达即丢弃过期 id"（§5），这正是 RPC 封装会藏起来的控制权，裸 `postMessage` + 30 行协议文件更好调试。
- **不引 React Compiler**：构建复杂度换不到这个体量的收益。

**首屏预算的两个阀门**：merge 视图与非常用语言包一律懒加载；实际首屏 JS 224.6 KB gzip（预算 250 KB，见 README），真超预算就把 `react` 换成 `preact/compat` 别名（CM6 与 TanStack Virtual 不直接用 React 内部 API，风险低）。

**与部署耦合的两点**：

1. **不用 `SharedArrayBuffer`**，因此不需要 COOP/COEP。GitHub Pages 不能自定义响应头，多线程 wasm 在那里根本开不了跨源隔离——单线程不是保守选择，是唯一可行解。
2. **wasm 路径运行时才确定**：`import()` 必须带 `/* @vite-ignore */`，路径用 `import.meta.env.BASE_URL` 拼；worker 用 `new Worker(new URL(...), { type: 'module' })` 交给 Vite 处理 base 与 chunk 名。这两处写错会"本地正常、部署 404"。

**已知风险**：CM6 merge 在 2 MB 级文件上可能卡顿（§7 的 2 MB 上限正好兜住）；wasm 实例常驻 ~54 MB，所以"同一时刻一个实例 + 换版本 terminate"是内存策略，不是洁癖。

## 3. 资源流水线（替换掉 Docker + 30 分钟编译）

`tools/versions.json` 是唯一事实来源：52 条 `{version, tag, pkg}` 记录（默认即最新 23.1.1；wasm 没有可用 `dump_config` 的版本额外带 `"dump": "native"`）。

- **fetch-wasm.mjs**：查 `registry.npmjs.org` 拿 tarball URL + `dist.integrity`，校验 sha512 后解出运行时文件到 `public/wasm/<ver>/`，并生成统一入口 `entry.js`（见 §3.1）。幂等：`tools/wasm.lock.json` 记录每个文件的 sha256，命中即跳过。
- **gen-schema.mjs**，对每个版本：
  1. 用该版本的 wasm 调 `dump_config({style, filename, code})`（不是 CLI；16/17 没有这个导出）拿到**全部选项键 + 嵌套值 + 七种风格的真实默认值**；
  2. 拉 `https://raw.githubusercontent.com/llvm/llvm-project/<tag>/clang/docs/ClangFormatStyleOptions.rst` 拿类型、枚举取值、docstring；
  3. 交叉校验后输出 `core.json`（选项定义 + 默认值）和 `docs.json`（key → HTML）。
- **类型映射**：RST 用的是人读类型名（`Boolean`/`Integer`/`Unsigned`/`String`/`List of Strings`），不是 C++ 类型；枚举靠 "Possible values" 列表解析；只有两个"结构体数组"需要硬编码字段表：`IncludeCategories`、`RawStringFormats`。其余类型全部从 dump + RST 推导。
- **校验闸门**：把每个 dump 出来的默认值与 RST 推出的类型逐一比对（bool 必须是布尔、枚举值必须在取值表里、map/list 形状必须对）。22/23 的 dump 错位就是被这道闸门挡下的，否则会静默产出错误 schema。
- **降级模式**：RST 拉不到时，仅用 dump 推断类型，枚举与文档留空并标记 `docsMissing`，生成流程不失败。

**加一个版本的完整操作**：往 `versions.json` 加一行 → `npm run prepare:assets` → `git commit` → 部署。目标 2 分钟，无容器。

### 3.1 wasm 构建的实测结论（2026-10-22）

| 版本段 | 打包形态 | `dump_config` | 结论 |
|---|---|---|---|
| 16.0.6 / 17.0.6 | 单 glue，只有 `format`/`version` | **无** | 拿不到 per-style 默认值；要支持只能用 native clang-format 兜底 |
| 18.1.8 – 21.1.8 | 单 glue，default init + 命名导出 | 有，输出正确 | wasm dump 可用 |
| 22.x / 23.x | 拆成 glue + `clang-format-binding.js` + `clang-format-web.js` | 有，但**值域错位** | wasm dump 不可用；schema 默认值改由同版本 native dump 生成 |

- **22/23 的 dump 错位**：`AlignAfterOpenBracket: true`（枚举位置输出布尔）、`Cpp11BracedListStyle: AlignFirstComment`（布尔位置输出枚举名）。CLI 构建同样错，不是调用方式问题，是上游构建的问题。**M4 已解决**：这些版本的 schema 默认值改由同版本 native clang-format `--dump-config` 生成（22.1.6/22.1.7 不在 PyPI，用 LLVM 官方 release 二进制），运行期格式化仍用 wasm；实测 26 个 native-dump 版本（16、17、18.1.0–18.1.7、22、23）的 CLI 输出与 wasm **312/312 次逐字节相同**。
- **22+ 的入口差异**已抹平：`fetch-wasm.mjs` 按包内是否存在 `clang-format-web.js` 选择入口，生成 `entry.js` 统一导出（default init + `format`/`dump_config`/`version`），worker 与 gen-schema 都只 import `entry.js`。
- **大小写**：`RawStringFormats[].BasedOnStyle` 的默认值输出为小写（`google`），枚举校验按大小写不敏感处理。
- **体积**（实测）：单版本 wasm 2.16–2.45 MB 原始 / 902–1072 KB gzip；schema core 6.4–8.5 KB gzip、docs 19.3–24.6 KB gzip——都在 §1 的预算内。

## 4. 数据契约

```ts
type StyleName = "LLVM"|"Google"|"Chromium"|"Mozilla"|"WebKit"|"Microsoft"|"GNU";

type Field = { key: string; type: OptionType };
type OptionType =
  | { kind: "scalar"; scalar: "bool"|"int"|"uint"|"string" }
  | { kind: "enum"; values: string[] }
  | { kind: "map"; children: Field[] }                      // BraceWrapping、AlignConsecutive* 等 16 个
  | { kind: "list"; item: "string" }                        // ForEachMacros 等
  | { kind: "list"; item: "struct"; fields: Field[] };      // IncludeCategories、RawStringFormats

type OptionDef = {
  key: string; type: OptionType; deprecated: boolean;
  defaults: Partial<Record<StyleName, unknown>>;           // 缺失 = 该风格未定义此选项
};

type SchemaCore = { version: string; styles: StyleName[]; options: OptionDef[] };
type SchemaDocs = Record<string, string>;
```

运行期状态：

```ts
type ConfigState = { version: string; style: StyleName | null; modified: Record<string, unknown> };
```

- 显示值 = `modified[key] ?? defaults[style][key] ?? unset`（UI 明确区分"继承自风格"和"你改过"）。
- 发送给 wasm 的 style = `JSON.stringify({ BasedOnStyle: style, ...modified })`。JSON 是 YAML 子集，21.1.8 实测可解析，**不再需要** v2 那套"数字必须加引号"的 flow-YAML hack。
- 导出 `.clang-format` 两种模式：**Minimal**（只含 BasedOnStyle + 改动项，默认）/ **Full**（把每个选项都写死，供"锁版本"的团队用）。
- 导入：YAML → 展平嵌套 → 校验键是否属于该版本 → 未知键收集成 warning 列表（不硬失败）；`AlignConsecutive*` 的 legacy 标量自动转成嵌套形式并 toast 提示。

## 5. 运行期子系统

**Worker 协议**（`src/worker/protocol.ts`）

```ts
type Req = { t: "init"; version: string } | { t: "format"; id: number; code: string; filename: string; style: string };
type Res = { t: "ready"; ms: number } | { t: "ok"; id: number; code: string; ms: number }
         | { t: "err"; id: number; message: string; detail: string } | { t: "fatal"; message: string };
```

- 请求串行化；新请求到达时只保留最新一条（丢弃过期 id，避免输入时排队）。
- `format` 期间临时接管 `console.error`/`console.warn`，把 LLVM 诊断拼进 `detail`；结束后还原。若未来 glue 暴露 `Module.printErr`，优先用它。
- worker `onerror` / `messageerror` → 重建 worker + 顶部提示条，不白屏。

**Schema Store**：按版本 `fetch` `core.json`/`docs.json`，内存 LRU 保留 3 个版本，进行中请求去重、失败不缓存（UI 可重试）；`docs.json` 在首次展开某选项帮助时才拉取。HTTP 层缓存交给 Service Worker。

**选项面板**：搜索框（键名 + 文档全文，防抖 120 ms）、过滤 chips（全部 / 已修改 / 已废弃）、虚拟列表（TanStack Virtual）、每行显示"继承值 vs 修改值"、`BraceWrapping`/`SpaceBeforeParensOptions` 的 override 警告、折叠文档用 `dangerouslySetInnerHTML`（内容只来自构建期生成的 schema，不接受运行时输入）。

**编辑器与 diff**：CodeMirror 6，左栏可编辑源码，右栏只读格式化结果，`@codemirror/merge` 的 split 视图做真实行级 diff（v2 的 "Diff mode" 其实只是左右并排，不算 diff）。输入防抖 250 ms；Ctrl/Cmd+Enter 立即格式化；"auto-format" 开关保留。**长行默认软折行**（`EditorView.lineWrapping`，源码 / 格式化结果 / diff 两侧 / 配置抽屉 YAML 一致），可在 Settings 的 "Soft wrap" 关闭并持久化；切换走 Compartment 运行时重配，不重建 view。

**配置页**：抽屉式，CM6 YAML 编辑器 + 基于 schema 的实时校验 + 上传/下载 + Apply/Close；底部显示"相对于当前风格会新增/删除哪些键"的预览。

**持久化**：localStorage 保存 `{version, style, modified, code, theme, editorFontSize, uiFontScale, softWrap}`（带 schema 版本号，不兼容时丢弃并提示）；分享链接把会话编码进 URL hash（`#s=<base64url(JSON)>`，载荷用短键 `{k, v, s, m, c?}`，`k` 是载荷格式版本；`c`（code）≤8 KB 才带，编码后 ≤48 KB）。优先级 **hash > storage**：首次渲染前解码，应用后 `history.replaceState` 清掉 fragment（避免每次刷新都被同一条链接覆盖），"Copy link" 再从当前会话重新生成；无效/截断的 hash 静默回退到 storage。界面字号缩放（`uiFontScale`，0.9/1/1.15 三档，相对设计基准）与软折行偏好（`softWrap`，默认 true）都作为**向后兼容的增字段**不 bump `STATE_VERSION`，旧存档按 1.0 / 开启加载；界面字号设计基准为浏览器默认字号的 **130%**（`styles.css` 的根字号，组件字号全部 rem）。

**主题/响应式/可访问性**：跟随系统 + 手动切换；桌面为选项面板 + 双栏编辑器，1100/900 px 是布局细化（≤900 px 时编辑器上下叠放、选项仍在左），≤768 px 改为「选项 / 代码」选项卡；所有控件有 label，错误用 `role="alert"` + `aria-live`。

## 6. 与 v2 的行为差异（明确取舍）

| v2 | v3 | 原因 |
|---|---|---|
| 25 个版本（7.0.1–21.1.8） | 52 个（16.0.6 – 23.1.1，全部已发布 wasm 构建） | 7–15 没有 wasm 构建；README 致谢里给出 v2 链接 |
| 服务端 25 个 ELF + 8080 端口 + 证书 | 无 | 架构简化 |
| `BasedOnStyle` 含 `InheritParentConfig` | 从列表移除 | 没有文件系统父目录，语义不成立（实测会静默退回 LLVM） |
| `Language` 作为普通选项 | 从 UI 隐藏 | 与"代码片段语言 + 文件名"重复 |
| "Remove duplicates (Not tested)" | 改为 Minimal/Full 导出模式 | 只发改动项后，该功能自然成立且可测 |
| 每次按键都发格式化请求 | 250 ms 防抖 + 丢弃过期请求 | 减少抖动与请求风暴 |
| 左右并排但不算 diff | 真实行级 diff | 兑现 "Diff mode" 的名字 |
| 错误弹窗里塞一段 stderr 文本 | 结构化错误：首行摘要 + 可展开的 LLVM 诊断 | 可读性 |
| 导入遇到未知键直接抛错 | 收集为 warning，允许继续 | 版本漂移是常态 |
| 190 行全量重渲染 | 虚拟列表 + 搜索 + 过滤 | 190 个选项没有搜索不可用 |

## 7. 失败模式

| 场景 | 处理 |
|---|---|
| wasm 下载失败 / 离线首次访问 | 顶部提示 + 重试按钮；选项面板仍可用（能生成配置，只是看不到效果） |
| Service Worker 已缓存该版本 | 完全离线可用 |
| 输入 > 2 MB | 警告并要求确认（Format anyway）；确认后仍在 worker 内格式化 |
| wasm trap / OOM | worker 重建 + 提示；保留用户状态 |
| schema 与 wasm 版本不匹配 | schema 与 wasm 都按版本目录存放，worker 只加载当前选中版本的资源；换版本时 terminate 旧 worker 再重建 |
| 版本没有对应 wasm 资源 | 版本列表来自 `schema/index.json`，资源缺失按下载失败处理（顶部提示 + 重试） |
| 部署在 `/<repo>/` 子路径下 | 构建期注入 `VITE_BASE`，运行期只用 `import.meta.env.BASE_URL` 拼路径；发布后对真实 URL 跑 smoke |

## 8. 测试与 CI

四道闸门，任何一道失败都不发布：

- **单元（Vitest）**：300 条 / 18 文件，覆盖 schema 归一化、默认值合并、`modified` 差分、导出/导入往返与字节幂等、legacy `AlignConsecutive*` 转换、Minimal/Full 导出、持久化（含软折行默认值）、分享链接、SW、roving 与焦点陷阱。
- **黄金对拍**：`tests/golden/golden-21.1.8.json`（29 组 fixture，覆盖 7 种风格与边界输入）由 **native** clang-format 21.1.8 生成（CI 里 `pip install clang-format==21.1.8`，该 PyPI 包带原生二进制，`golden:gen --check` 防提交物漂移）；e2e 用 wasm 跑同一组 fixture 逐字节比较——这是"wasm 与原生一致"的守门员。
- **E2E（Playwright）**：70 条（smoke + M1/M2/M3/M4 + PWA + a11y + soft-wrap + golden + perf），覆盖纯 UI 生成配置、diff、错误面板、持久化/主题/离线、分享链接、界面字号与软折行、52 版本切换与桌面布局；perf 用例在独立 project 里串行跑。
- **体积与性能预算**：`check:size` 按 §1 检查首屏 JS 与每版本 wasm/schema 的 gzip；`perf.spec.ts` 检查格式化 p95 与版本切换时限，超限即失败。
- **CI**：GitHub Actions，`npm ci` + `prepare:wasm`（wasm 走缓存）+ 黄金校验 + typecheck + unit + build + `check:size` + e2e；main 绿了自动发布到 GitHub Pages（见 8.1）。

### 8.1 部署到 GitHub Pages

用官方 Pages Actions：OIDC 鉴权，**不需要任何 secret，也不需要 `gh-pages` 分支**。

| 项 | 结论 |
|---|---|
| 发布链路 | `actions/upload-pages-artifact` → `actions/deploy-pages`；仓库 Settings → Pages → Source 选 "GitHub Actions"（一次性手工操作） |
| 触发 | push 到 `main`（忽略 `**.md`、`docs/**`）+ `workflow_dispatch` 手动重发 |
| 权限 | `contents: read`、`pages: write`、`id-token: write`，并挂 `environment: github-pages` |
| 构建频率 | 自定义 workflow **不受** 10 次/小时软限制约束（官方文档明确排除）；部署仍有 10 分钟超时 |
| 体积 | 52 版本实测 dist ≈ 130 MB（wasm 118 MB + schema 11.9 MB + app/图标），仍远低于 1 GB 站点上限；首屏 JS 224.6 KB gzip |

**四个必须处理的点**：

1. **子路径**：项目页在 `https://<user>.github.io/<repo>/`，构建期 `base` 必须是 `/<repo>/`（CI 注入 `VITE_BASE`，本地默认 `/`）。运行期所有路径——schema `fetch`、wasm `locateFile`、worker URL、Service Worker scope——一律用 `import.meta.env.BASE_URL` 拼接；写死 `/schema/...` 会"本地正常、部署后 404"，这是这类站点最常见的翻车点。
2. **wasm 不在仓库里**：CI 用 `actions/cache`，key 为 `hashFiles('tools/versions.json')`；`prepare:assets` 本身幂等，命中缓存即跳过。fork PR 只能读 default 分支的缓存，冷跑多花约 2–4 分钟（52 个 tarball，约 118 MB）。
3. **schema 不在 CI 重抓**：schema 已入库，CI 不访问 `raw.githubusercontent.com`，因此部署不会被上游网络或 RST 改动卡住。上游漂移检查放 nightly：重新生成到临时目录 + `git diff --exit-code`，失败只开 issue，不阻塞发布。**已落地**：`.github/workflows/nightly.yml` 每日跑 `npm run schema:check -- --allow-missing-native`（26 个 native-dump 版本跳过默认值、仍校验 RST 文档与结构），漂移时开/更新 tracking issue。
4. **E2E 要覆盖真实部署路径**：本地 e2e 用 `base=/` 跑业务逻辑；发布完成后再对 `steps.deploy.outputs.page_url` 跑整套 e2e（deploy 的 smoke job），这是唯一能发现 base／资源路径错误的测试。

**补充约定**（工作流本体以 `.github/workflows/{ci,deploy,nightly}.yml` 为准，本文件不复制 YAML）：

- **`VITE_BASE` 假设是普通项目仓库**（`/<repo>/`）。若仓库本身就是 `<user>.github.io`（用户主页），base 应为 `/`；两种都覆盖的写法是用 `actions/configure-pages@v5` 的 `base_path` 输出，而不是自己拼仓库名。
- `playwright.config.ts` 里 `baseURL` 与 `webServer` 都从 `VITE_BASE` 派生（`http://127.0.0.1:4173${VITE_BASE}`），否则 preview 下子路径直接 404。
- action 版本按 2026-10 的 majors 写；建议 pin 到 commit SHA 并开 Dependabot，第三方 action 是供应链入口。
- **兜底**：组织策略若禁 `pages: write`，退回 `gh-pages` 分支 + `peaceiris/actions-gh-pages`；再不行换 Cloudflare Pages，构建命令不变。

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** 骨架与流水线 | Vite/TS/CI 脚手架、`versions.json`、fetch-wasm、gen-schema（先跑通 3 个版本）、最小页面 + worker 完成一次格式化 | `npm run dev` 能格式化，`npm run build` 产出静态包 |
| **M1** 选项引擎与 UI | schema store、虚拟列表、五种控件、`modified` 模型、Minimal/Full 导出、配置导入 | 能不碰编辑器、纯靠 UI 生成一份可用的 `.clang-format` |
| **M2** 编辑器 / diff / 错误 | CM6、split diff、防抖、错误面板、快捷键、语言切换 | 输入代码即时看到格式化与差异；故意写错选项能读到 LLVM 原文 |
| **M3** 打磨与上线 | 持久化、响应式、a11y、离线、性能预算、黄金对拍、部署配置、README/NOTICE | 全部验收指标达标，站点静态部署成功 |
| **M4** 增量打磨 | 分享链接（URL hash）、PWA manifest/安装提示、C#/proto 示例与更多语言后缀、全部 52 个版本、界面字号缩放、虚拟列表 roving 键盘模型、ConfigDialog 焦点陷阱、docs `<pre>` 可聚焦、nightly schema 漂移检查 | 见 `docs/handoff.md` §11 的验证记录 |

**状态**：M0–M4 均已完成（2026-10-24）——M3 完成即 v3 可交付，M4 为增量打磨。实现细节、当前状态、坑与遗留项见 [`docs/handoff.md`](docs/handoff.md)。

## 10. 风险与明确不做

**风险**

1. `@wasm-fmt/clang-format` 的构建可能带补丁 → 用黄金对拍兜底；若发现行为差异，锁定到验证过的版本号，或在仓库内自建 wasm。
2. npm registry / raw.githubusercontent 在 CI 不可达 → schema 已提交，wasm 走缓存或镜像；构建可降级为"只带已有资源"。
3. **wasm 构建的 `dump-config` 回归** → 16/17/18.1.0–18.1.7/22/23 的 wasm 没有可用的 `dump_config`（§3.1）。这些版本的 schema 默认值由**同版本 native clang-format** dump 生成并提交（运行期仍用 wasm），并有 312/312 的逐字节对拍兜底；schema 生成内置的类型校验闸门继续拦截任何新版本的形状/值域错误。

**不做**：后端格式化、账号体系、7–15 版本、服务端存储分享、遥测、i18n、Monaco 编辑器；nightly 不做 1.9 GB native 二进制的全严格重建（严格 `npm run schema:check` 留在本地/发布前）。

**授权**：代码 MIT；`NOTICE` 中标注 docstring 来自 LLVM 文档（Apache-2.0 WITH LLVM-exception）、wasm 构建来自 `@wasm-fmt/clang-format`（MIT）。

