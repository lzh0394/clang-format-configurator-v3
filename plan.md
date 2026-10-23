# Clang-format Configurator v3 — 纯前端重建方案

> 状态：待评审 · 目标产物：`C:\workspaces\clang-format-configurator-v3`
> 依据：对 v2（https://github.com/Wirena/clang-format-configurator-v2）的源码审查与线上实测

## 0. 已确定的前提

| 决策 | 结论 |
|---|---|
| 版本范围 | 16.0.6 – 23.1.1，**首批发布 8 个**（每个 minor 取最新 patch）；其余 44 个已发布 wasm 版本可按需加，一条配置即可。实测修正：M0 先落地 18.1.8 / 20.1.7 / 21.1.8，16/17 与 22/23 的阻塞见 §3.1 |
| 后端 | **完全没有**。静态站点 + 浏览器内 wasm |
| 老版本 7–15 | 不支持；页面上留一条指向 v2 的说明链接 |
| 代码位置 | `C:\workspaces\clang-format-configurator-v3`，全新仓库（v2 的 clone 仅作参考，不 fork） |
| 技术栈 | Vite（起项目取当前 major）+ React 19 + TypeScript + CodeMirror 6 + TanStack Virtual；样式 CSS Modules；状态 `useReducer`；Vitest + Playwright（详见 §2.1） |
| 数据来源 | 选项 schema 由 LLVM RST 文档 + wasm 的 `--dump-config` 生成；**不需要编译 LLVM、不需要 Docker** |

## 1. 目标与验收标准

**目标**：把"交互式生成 clang-format 配置"这件事做成一个可离线、无服务器、加版本只要两分钟的静态应用；所有格式化在本地 wasm 里完成。

| 指标 | 验收值 |
|---|---|
| 首屏 JS（gzip，不含 wasm/schema） | ≤ 250 KB |
| 单版本 schema 首包 | ≤ 25 KB gzip（core）；文档 ≤ 45 KB gzip（首次点开帮助才加载） |
| 单版本 wasm | ≤ 1.0 MB gzip（现网实测 0.97 MB） |
| 选项变更 → 新格式化结果 | p95 ≤ 80 ms（20 KB 代码） |
| 版本切换可用时间 | 冷切换 ≤ 1.2 s；已缓存 ≤ 200 ms |
| 一致性 | 24 组 fixture 在 native clang-format 21.1.8 与 wasm 上**逐字节相同** |
| 导出幂等 | `.clang-format` 导出 → 再导入 → 再导出，字节相同 |
| 功能对齐 | v2 的用户可见功能全部保留（除版本范围），并修复第 6 节列出的 7 个缺陷 |
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

选型的四个硬约束：纯静态无服务器、8 个 wasm 大资源、190 个选项的交互密度、首屏 ≤ 250 KB gzip。任何一项不满足即出局。

| 层 | 选型 | 负责什么 | 被否的方案 |
|---|---|---|---|
| 构建 | Vite（当前 major；草案写的 6 只是落笔时的版本） | dev/build、`base` 注入、Worker 与资源 URL | CRA（已停更，v2 的 6 MB bundle 即其产物）、webpack（配置成本）、Next/Astro（无 SSR 需求，wasm 只能在客户端） |
| UI | React 19 | 选项面板、编辑器编排、状态派生 | Preact（省 ~30 KB 但要补生态，留作超预算时的 `compat` 别名兜底）、Svelte（整体重写） |
| 编辑器 | CodeMirror 6 | 可编辑源码、只读结果、行级 diff | Monaco（2 MB+，自带 worker 体系，diff 是实例级 API）、Ace（v2 的选择，diff 需自研） |
| 长列表 | TanStack Virtual | 190 行 + 动态行高（展开文档会变高） | `react-window`（以固定行高为主，动态测量要手写） |
| 计算 | clang-format wasm（Emscripten，单线程），跑在 Worker 内 | 真正的格式化，主线程不阻塞 | 后端 exec（v2 方案，需服务器）、WebContainer（过重） |
| 数据 | 构建期生成的 JSON schema | 选项定义、七风格默认值、文档 | 运行时抓 RST 解析（慢、不可控、CI 依赖上游） |
| YAML | `yaml`（eemeli） | 导入 `.clang-format`、带行列号报错 | `js-yaml`（无 CST，unknown key 定位弱） |
| 样式 | **CSS Modules + design tokens** | 选项行、抽屉、编辑器外框 | Tailwind（purge 对动态 class 不友好，reset 与 CM6 主题变量冲突）、CSS-in-JS（运行时开销 + 额外 8–12 KB） |
| 状态 | **`useReducer` + context**，不引库 | `{version, style, modified}` 单一对象 | Zustand（3 KB；等面板重渲染真成瓶颈再换，用 selector 化）、Redux（过重） |
| 路由 | 不用 | 单视图；分享链接走 URL hash | React Router（唯一需求是 hash 解析，20 行足够） |
| 测试 | Vitest + Playwright | 纯逻辑单测 + 真浏览器 e2e | Jest（另配一套 transform）、jsdom（测不了 wasm/Worker/SW） |

四个决定值得单独说明：

- **CM6 而非 Monaco**：`@codemirror/merge` 给的是**文档级** diff（可折叠未变更区、可嵌入 unified 视图）；Monaco 的 diff 绑定编辑器实例，塞进现有双栏要绕着走。CM6 还能按需组装语言包（只需 C/C++/C#/Java/Proto）。
- **没有组件库**：`IncludeCategories`、`RawStringFormats` 这类结构体数组编辑器组件库覆盖不了，最后仍要手写；五种控件自己写更快，也省掉 100 KB+ 与样式覆盖成本。
- **Worker 不用 Comlink**：协议需要"新请求到达即丢弃过期 id"（§5），这正是 RPC 封装会藏起来的控制权，裸 `postMessage` + 30 行协议文件更好调试。
- **不引 React Compiler**：构建复杂度换不到这个体量的收益。

**首屏预算怎么花**（M0 用 `rollup-plugin-visualizer` 实测后定稿）：

| 项 | 估算 gzip |
|---|---|
| react + react-dom 19 | ~45 KB |
| CM6 core + C++ 语言包 | ~90–110 KB |
| `yaml` | ~20 KB |
| 业务代码 | ~40 KB |
| 合计 | ~200 KB（余量 ~50 KB） |

余量不厚，两个预设阀门：merge 视图与非常用语言包一律懒加载；真超预算就 `react` → `preact/compat` 别名替换（CM6 与 TanStack Virtual 不直接用 React 内部 API，风险低）。

**与部署耦合的两点**：

1. **不用 `SharedArrayBuffer`**，因此不需要 COOP/COEP。GitHub Pages 不能自定义响应头，多线程 wasm 在那里根本开不了跨源隔离——单线程不是保守选择，是唯一可行解。
2. **wasm 路径运行时才确定**：`import()` 必须带 `/* @vite-ignore */`，路径用 `import.meta.env.BASE_URL` 拼；worker 用 `new Worker(new URL(...), { type: 'module' })` 交给 Vite 处理 base 与 chunk 名。这两处写错会"本地正常、部署 404"。

**已知风险**：CM6 merge 在 2 MB 级文件上可能卡顿（§7 的 2 MB 上限正好兜住）；wasm 实例常驻 ~54 MB，所以"同一时刻一个实例 + 换版本 terminate"是内存策略，不是洁癖。

## 3. 资源流水线（替换掉 Docker + 30 分钟编译）

`tools/versions.json` 是唯一事实来源：

```json
[{ "version": "21.1.8", "tag": "llvmorg-21.1.8", "pkg": "@wasm-fmt/clang-format@21.1.8" },
 { "version": "20.1.7", "tag": "llvmorg-20.1.7", "pkg": "@wasm-fmt/clang-format@20.1.7" }]
```

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
| 18.1.8 – 21.1.8 | 单 glue，default init + 命名导出 | 有，输出正确 | 首批采用 |
| 22.x / 23.x | 拆成 glue + `clang-format-binding.js` + `clang-format-web.js` | 有，但**值域错位** | 暂不可用 |

- **22/23 的 dump 错位**：`AlignAfterOpenBracket: true`（枚举位置输出布尔）、`Cpp11BracedListStyle: AlignFirstComment`（布尔位置输出枚举名）。CLI 构建同样错，不是调用方式问题，是上游构建的问题；已用类型校验闸门拦截，等上游修复或改用 native dump。
- **22+ 的入口差异**已抹平：`fetch-wasm.mjs` 按包内是否存在 `clang-format-web.js` 选择入口，生成 `entry.js` 统一导出（default init + `format`/`dump_config`/`version`），worker 与 gen-schema 都只 import `entry.js`。
- **大小写**：`RawStringFormats[].BasedOnStyle` 的默认值输出为小写（`google`），枚举校验按大小写不敏感处理。
- **体积**（实测）：单版本 wasm 2.16–2.45 MB 原始 / 0.92–0.97 MB gzip；schema core 6.8–7.7 KB gzip、docs 21.5–23.2 KB gzip——都在 §1 的预算内。
- **M0 已落地版本**：21.1.8（默认）、20.1.7、18.1.8；16/17/22/23 待解。

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

**Schema Store**：`fetch + Cache Storage`（缓存键含 schema hash），内存 LRU 保留 3 个版本；`docs.json` 在首次展开某选项帮助时才拉取。

**选项面板**：搜索框（键名 + 文档全文，防抖 120 ms）、过滤 chips（全部 / 已修改 / 已废弃）、虚拟列表（TanStack Virtual）、每行显示"继承值 vs 修改值"、`BraceWrapping`/`SpaceBeforeParensOptions` 的 override 警告、折叠文档用 `dangerouslySetInnerHTML`（内容只来自构建期生成的 schema，不接受运行时输入）。

**编辑器与 diff**：CodeMirror 6，左栏可编辑源码，右栏只读格式化结果，`@codemirror/merge` 的 split 视图做真实行级 diff（v2 的 "Diff mode" 其实只是左右并排，不算 diff）。输入防抖 250 ms；Ctrl/Cmd+Enter 立即格式化；"auto-format" 开关保留。

**配置页**：抽屉式，CM6 YAML 编辑器 + 基于 schema 的实时校验 + 上传/下载 + Apply/Close；底部显示"相对于当前风格会新增/删除哪些键"的预览。

**持久化**：localStorage 保存 `{version, style, modified, code, theme}`（带 schema 版本号，不兼容时丢弃并提示）；分享链接把状态编码进 URL hash（M4）。

**主题/响应式/可访问性**：跟随系统 + 手动切换；≥1024 px 双栏，<768 px 改为"选项 / 代码"选项卡；所有控件有 label，错误用 `role="alert"` + `aria-live`。

## 6. 与 v2 的行为差异（明确取舍）

| v2 | v3 | 原因 |
|---|---|---|
| 25 个版本（7.0.1–21.1.8） | 8 个（16.0.6+），可扩展 | 无 wasm 构建；页面上给出 v2 链接 |
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
| 非 UTF-8 文件上传 | 用 `TextDecoder('utf-8', {fatal:true})` 校验，失败则明确提示"浏览器内无法无损处理非 UTF-8 源文件"，并提供"按 Latin-1 解读"的显式选项 |
| 输入 > 2 MB | 警告并要求确认；worker 内仍同步执行，UI 显示进度 |
| wasm trap / OOM | worker 重建 + 提示；保留用户状态 |
| schema 与 wasm 版本不匹配 | schema 文件名带 hash，worker 只接受与当前 schema 同版本的 wasm |
| 版本没有对应 wasm 资源 | 下拉框置灰 + tooltip 说明 |
| 部署在 `/<repo>/` 子路径下 | 构建期注入 `VITE_BASE`，运行期只用 `import.meta.env.BASE_URL` 拼路径；发布后对真实 URL 跑 smoke |

## 8. 测试与 CI

- **单元（Vitest）**：schema 归一化、默认值合并、`modified` 差分、导出/导入往返、legacy `AlignConsecutive` 转换、Minimal/Full 两种导出。
- **组件**：选项行渲染（scalar/enum/map/list/struct-list 五种）、override 警告、搜索过滤。
- **黄金对拍**：`tests/golden/*.json`（24 组代码 + 风格），期望输出由 **native** clang-format 21.1.8 生成（CI 里 `pip install clang-format==21.1.8`，该 PyPI 包带原生二进制）。CI 用 wasm 跑同样 fixture 并逐字节比较——这是"wasm 与原生一致"的守门员。
- **E2E（Playwright）**：冷启动 → 选 Chromium → 改 IndentWidth → 输出变化 → 导出配置 → 重载恢复状态；错误路径（配置页写错键 → 看到 LLVM 诊断）；版本切换；离线模式。
- **性能预算**：构建后脚本检查 gzip 体积上限，超限即失败。
- **CI**：GitHub Actions，`npm ci` + `prepare:assets`（wasm 走缓存）+ typecheck + lint + unit + 黄金对拍 + build + e2e；main 绿了自动发布到 GitHub Pages（见 8.1）。

### 8.1 部署到 GitHub Pages

用官方 Pages Actions：OIDC 鉴权，**不需要任何 secret，也不需要 `gh-pages` 分支**。

| 项 | 结论 |
|---|---|
| 发布链路 | `actions/upload-pages-artifact` → `actions/deploy-pages`；仓库 Settings → Pages → Source 选 "GitHub Actions"（一次性手工操作） |
| 触发 | push 到 `main`（忽略 `**.md`、`docs/**`）+ `workflow_dispatch` 手动重发 |
| 权限 | `contents: read`、`pages: write`、`id-token: write`，并挂 `environment: github-pages` |
| 构建频率 | 自定义 workflow **不受** 10 次/小时软限制约束（官方文档明确排除）；部署仍有 10 分钟超时 |
| 体积 | 首批 8 版本 ≈ 9 MB（wasm 8×1.0 MB + glue + schema + app），远低于 1 GB 站点上限；将来补齐 52 个版本约 60 MB 仍安全 |

**四个必须处理的点**：

1. **子路径**：项目页在 `https://<user>.github.io/<repo>/`，构建期 `base` 必须是 `/<repo>/`（CI 注入 `VITE_BASE`，本地默认 `/`）。运行期所有路径——schema `fetch`、wasm `locateFile`、worker URL、Service Worker scope——一律用 `import.meta.env.BASE_URL` 拼接；写死 `/schema/...` 会"本地正常、部署后 404"，这是这类站点最常见的翻车点。
2. **wasm 不在仓库里**：CI 用 `actions/cache`，key 为 `hashFiles('tools/versions.json')`；`prepare:assets` 本身幂等，命中缓存即跳过。fork PR 只能读 default 分支的缓存，冷跑多花约 30 s（8 个 tarball，约 10 MB）。
3. **schema 不在 CI 重抓**：schema 已入库，CI 不访问 `raw.githubusercontent.com`，因此部署不会被上游网络或 RST 改动卡住。上游漂移检查放 nightly：重新生成到临时目录 + `git diff --exit-code`，失败只开 issue，不阻塞发布。
4. **E2E 要覆盖真实部署路径**：本地 e2e 用 `base=/` 跑业务逻辑；发布完成后再对 `steps.deploy.outputs.page_url` 跑一小组 smoke（能加载、能格式化一次、能切版本），这是唯一能发现 base／资源路径错误的测试。Page 没有 per-PR 预览环境，PR 用 Playwright trace + 截图 artifact 代替。

```yaml
name: deploy
on:
  push:
    branches: [main]
    paths-ignore: ['**.md', 'docs/**']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  ship:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: npm }
      - uses: actions/cache@v6
        with:
          path: public/wasm
          key: wasm-${{ hashFiles('tools/versions.json') }}
          restore-keys: wasm-
      - run: npm ci
      - run: npm run prepare:assets          # schema 已入库，只补 wasm
      - run: npm run verify                  # typecheck + lint + unit + golden
      - run: npm run build
        env:
          VITE_BASE: /${{ github.event.repository.name }}/
      - run: npm run check:size
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test             # webServer 起 vite preview
        env:
          VITE_BASE: /${{ github.event.repository.name }}/
      - uses: actions/upload-pages-artifact@v5
        with: { path: dist }
      - id: deploy
        uses: actions/deploy-pages@v5
      - run: npx playwright test e2e/smoke.spec.ts
        env:
          PW_BASE_URL: ${{ steps.deploy.outputs.page_url }}
```

Notes：

- 单个 job 串行跑完约 2.5–4 分钟（缓存命中时），不需要拆 job；PR 校验与 main 发布复用同一份步骤，**不要**拆成两条 workflow 各 build 一遍。
- 上面的 `VITE_BASE` 假设是普通项目仓库（`/<repo>/`）。若仓库本身就是 `<user>.github.io`（用户主页），base 应为 `/`；两种都覆盖的写法是用 `actions/configure-pages@v5` 的 `base_path` 输出，而不是自己拼仓库名。
- `playwright.config.ts` 里 `baseURL` 与 `webServer` 都从 `VITE_BASE` 派生（`http://127.0.0.1:4173${VITE_BASE}`），否则 preview 下子路径直接 404。
- action 版本按 2026-10 的 majors 写；建议 pin 到 commit SHA 并开 Dependabot，第三方 action 是供应链入口。
- **兜底**：组织策略若禁 `pages: write`，退回 `gh-pages` 分支 + `peaceiris/actions-gh-pages`；再不行换 Cloudflare Pages，构建命令不变。
- **已落地**：`.github/workflows/ci.yml`（build + e2e，按子路径构建）与 `deploy.yml`（build → deploy → smoke 对真实 URL 再跑一遍）；本地与线上均验证通过。

## 9. 里程碑

| 阶段 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **M0** 骨架与流水线 | Vite/TS/CI 脚手架、`versions.json`、fetch-wasm、gen-schema（先跑通 3 个版本）、最小页面 + worker 完成一次格式化 | `npm run dev` 能格式化，`npm run build` 产出静态包 | 0.5–1 天 |
| **M1** 选项引擎与 UI | schema store、虚拟列表、五种控件、`modified` 模型、Minimal/Full 导出、配置导入 | 能不碰编辑器、纯靠 UI 生成一份可用的 `.clang-format` | 1.5–2 天 |
| **M2** 编辑器 / diff / 错误 | CM6、split diff、防抖、错误面板、快捷键、语言切换 | 输入代码即时看到格式化与差异；故意写错选项能读到 LLVM 原文 | 1–1.5 天 |
| **M3** 打磨与上线 | 持久化、响应式、a11y、离线、性能预算、黄金对拍、部署配置、README/NOTICE | 全部验收指标达标，站点静态部署成功 | 1–1.5 天 |
| **M4**（可选） | 分享链接、PWA、C#/proto 代码示例、按 minor 补齐全部 52 个版本 | — | 按需 |

**M3 完成即视为 v3 交付**，M4 不阻塞上线。

**M0 状态（2026-10-22，已完成）**：`npm run dev` 与 `npm run build` 均能格式化；Playwright 冒烟 4 条全绿（Edge，含 `/<repo>/` 子路径构建）；3 个版本 schema 生成并通过类型校验；首屏 JS 71 KB gzip。**已建仓库并跑通 CI 与 Pages 发布**：<https://github.com/lzh0394/clang-format-configurator-v3>，线上 <https://lzh0394.github.io/clang-format-configurator-v3/>，部署后 smoke 对真实 URL 通过。遗留项：16/17 缺 `dump_config`、22/23 dump 值域错位（§3.1）。

**M1 状态（2026-10-23，已完成）**：选项引擎与 UI 按本节验收落地——schema store（LRU 3 版本 + docs 懒加载，失败可重试）、`modified` 模型（只发改动项；16 个 map 选项存稀疏 patch，显示值 = `modified[key] ?? defaults[style][key]`；版本切换自动剔除目标 schema 不认识的键）、虚拟化选项面板（189 行、动态行高、键名+文档搜索、全部/已修改/已废弃 chips、五种控件、逐项继承值/reset）、Minimal/Full 导出、带 schema 校验与 warning 的导入、legacy `AlignConsecutive*` / `SortIncludes` / `AlignTrailingComments` 转换。验收证据：纯 UI 生成 `.clang-format` 的 e2e 通过；**导出→导入→导出字节相同**（minimal/full，单测 78 条 + e2e 双向覆盖）；`npm run verify` 全绿（typecheck + 100 单测 + build）；Playwright 20 条（4 M0 smoke + 16 M1）在 base `/` 与 `/<repo>/` 子路径构建下全绿；首屏 JS 119.8 KB gzip（预算 250 KB）。新增运行时依赖 `@tanstack/react-virtual`、`yaml`（后者从 devDependencies 移动）。M1 的并行开发契约（接口/测试 id/归属）随完成后删除，实现细节见 `docs/handoff.md`。

**估时口径**：单人、熟悉 React/TS、无会议，1 天 = 6 h 净编码；不含 review 往返、CI 排队、部署调试。基准不是"写多少行代码"，而是 v2 的可见功能清单——每条标成**照搬 / 重写 / 新增**三档分别加权，漏项比写得慢更容易让工期翻倍。每项拆到 ≤4 h 再估，给"乐观–最可能"区间；悲观情况不摊进区间，而是单列成 §10 的回退路径（平摊出来的 buffer 最后都会被吃掉，还看不出是哪一项超了）。

**校准**：按拆解重算，P50 ≈ 6.2 天（M0 1.0 / M1 2.2 / M2 1.3 / M3 1.7），P80 ≈ 8.5 天。上表的 5–6 天是"零返工、零等待"的乐观值，当 P30 看更合适：M1（虚拟列表行高 + 五种控件 + 配置页抽屉）与 M3（a11y + SW + 250 KB 预算）的下界偏紧。日历时间再乘 1.3–1.5；M0 结束后用实测值重估一次 M1–M3。

## 10. 风险与明确不做

**风险**

1. `@wasm-fmt/clang-format` 的构建可能带补丁 → 用黄金对拍兜底；若发现行为差异，锁定到验证过的版本号，或在仓库内自建 wasm。
2. CM6 集成（尤其 merge view）比 Ace 复杂 → 若 M2 超期，退回 Ace + 自研行级 diff，功能不变。
3. 老版本用户流失 → 页面上明确提示并链接 v2；README 说明自建老版本 wasm 的路径。
4. npm registry / raw.githubusercontent 在 CI 不可达 → schema 已提交，wasm 走缓存或镜像；构建可降级为"只带已有资源"。
5. **wasm 构建的 `dump-config` 回归** → 22/23 已出现值域错位（§3.1）。schema 生成内置类型校验闸门，任何新版本过不了就不合并；黄金对拍作为运行期兜底。

**不做**：后端格式化、账号体系、7–15 版本、服务端存储分享、遥测、i18n、Monaco 编辑器。

**授权**：代码 MIT；`NOTICE` 中标注 docstring 来自 LLVM 文档（Apache-2.0 WITH LLVM-exception）、wasm 构建来自 `@wasm-fmt/clang-format`（MIT）。

## 附：v2 现状（用于对照）

- 前端：React 17 + CRA 5，`config.json` 4.7 MB 内联进 bundle，6.0 MB 未压缩 JS，25 个版本 schema 全量加载。
- 后端：Go 1.17 + `exec` 25 个原生 ELF，`-style={...}` 走命令行参数，stdin/stdout 传代码；无超时、无 body 上限、CORS `*`。
- 构建：Docker + 全量编译 LLVM × 25（约 30 分钟），二进制不入库，生产 Dockerfile 为空。
- 已知缺陷：文本变更无防抖、`WriteHeader` 早于 `Content-Type`、测试用例参数名写成 `filename`（handler 要求 `filext`）、`prepare.sh` 少管道符与未定义 `start` 变量、"Remove duplicates" 未测试。
