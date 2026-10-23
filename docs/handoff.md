# 交接文档（M1 完成 → 准备 M2）

> 新会话先读本文件，再读 [`plan.md`](../plan.md)。plan.md 是设计与取舍的唯一事实来源；本文只记状态、命令、坑和待办。
> 最后更新：2026-10-23，M1 代码/测试提交 `a031305`、`9dc4e44`。

## 1. 一句话现状

**M1 已完成**：选项引擎（schema store / `modified` 模型 / 虚拟列表 / 五种控件）、`.clang-format` 的 Minimal/Full 导出与带校验的导入都已在线上；纯 UI 能生成可用的配置文件，**导出 → 再导入 → 再导出字节相同**。M0 的骨架、资源流水线、CI 与 Pages 发布保持可用。
**M2（CM6 编辑器 / diff / 错误面板）尚未开始。**

## 2. 链接

| 项 | 地址 |
|---|---|
| 仓库（public） | <https://github.com/lzh0394/clang-format-configurator-v3> |
| Actions | <https://github.com/lzh0394/clang-format-configurator-v3/actions> |
| 线上 | <https://lzh0394.github.io/clang-format-configurator-v3/> |
| 本地路径 | `C:\workspaces\clang-format-configurator-v3` |

## 3. 本地怎么跑 / 怎么验

```powershell
npm install
npm run prepare:assets   # 首次：下载 wasm + 生成 schema（需联网）
npm run dev              # http://localhost:5173
```

验证三件套（提交前跑）：

```powershell
npm run verify           # typecheck + vitest + build
npx playwright test      # 本地用 Edge（channel=msedge），20 条
```

只跑 M1 那组：

```powershell
npx playwright test tests/e2e/m1.spec.ts
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

单测 100 条（5 个文件）、e2e 20 条（4 smoke + 16 m1），全部应绿。

## 4. 环境事实与坑（踩过的）

- 本机 **Windows + PowerShell**；Node **v26.12.0**、npm **11.20.0**。CI 用 Node **22**。
- 本地 npm 配了腾讯镜像，但 `tools/fetch-wasm.mjs` 默认直接访问 `registry.npmjs.org`；可用 `NPM_REGISTRY` 覆盖。
- 本地 Playwright 用 **Edge**（`channel: "msedge"`，无需下载浏览器）；CI 用 `PW_CHANNEL=chromium` + `npx playwright install`。
- **`vite preview` 必须 `--host 127.0.0.1`**：runner 上 `localhost` 解析到 `::1`，Playwright 连 `127.0.0.1` 会 60s 超时。
- **e2e 里必须 `page.goto("./")`，不能 `page.goto("/")`**：`/` 会丢掉 baseURL 的 `/<repo>/` 前缀。
- **e2e 迭代技巧**：`npm run dev`（5173）+ `$env:PW_BASE_URL='http://127.0.0.1:5173/'` 跑 Playwright，不用反复 build；但**最终验收必须对 production build 跑**（`vite preview` + 无 `PW_BASE_URL`）。
- **端口冲突会挂住 Playwright**：若 4173 上已有 preview（例如截图脚本留下的），再起 webServer 会卡到超时。跑 e2e 前确认 4173/5173 没有残留进程（`Get-NetTCPConnection -LocalPort 4173`），或先清掉后台任务。
- **Windows 剪贴板会把换行归一成 CRLF**：e2e 里复制 `.clang-format` 后比较文本要 `replace(/\r\n/g,"\n")`。
- TypeScript **7.0.2**：对重复的索引访问（`isPlainObject(modified[option.key]) ? {...modified[option.key]} : {}`）不做持续窄化，会报 TS2698；先取局部变量再窄化（`const existing = ...`）。
- 网络偶发 DNS/TLS 抖动（`github.com`、`api.github.com`）；`git push` / `gh` 重试即可。
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
  App.tsx              版本/风格/文件名 + 选项面板 + 双栏 textarea/pre + 状态栏 + 导入/导出入口
  App.module.css       布局（≥1100px: 面板 | 编辑区；<900px 上下堆叠）
  main.tsx / styles.css
  components/
    OptionPanel.tsx    虚拟列表 + 搜索 + 过滤 chips + 面板头（count/reset all）
    OptionRow.tsx      单行：key/徽标/控件/docs 开关/继承值/reset，map/list 的展开体
    controls.tsx       五种控件：标量（bool/int/uint/string）、enum、map、list<string>、list<struct>
    useDocs.ts         docs 懒加载 hook（search 首次触发 / 首次展开触发，失败可 retry）
    ConfigDialog.tsx   导入/导出模态框（tabs、Minimal/Full、YAML 预览、复制/下载、文件选择、Apply）
  lib/
    schema.ts          SchemaCore/OptionDef 类型、loadSchema/loadDocs、buildStylePayload
    schema-store.ts    版本 schema/docs 的 LRU(3) 缓存，in-flight 去重，失败不缓存
    config.ts          modified 模型：effectiveValue、稀疏 map 的 setChildOption、formatValue
    config-state.ts    ConfigState + configReducer + 版本切换 reconcileModified
    config-io.ts       serializeConfig（minimal/full）+ parseConfigText（校验/warning/legacy 转换）
    formatter-client.ts  worker 封装：init(version) 会 terminate 旧 worker
  worker/protocol.ts   init/format 请求与 ready/ok/err 响应
  worker/formatter.worker.ts  持有唯一 wasm 实例，import(entry.js) → format()
tests/e2e/
  smoke.spec.ts        M0 冒烟 4 条（格式化/换风格/换版本/改源码）
  m1.spec.ts           M1 16 条（详见 §6）
public/
  schema/<ver>/        已提交（core.json + docs.json），index.json 驱动版本下拉
  wasm/<ver>/          不提交（.gitignore），由 prepare:assets 生成
.github/workflows/     ci.yml（verify + e2e）、deploy.yml（build → deploy → 对真实 URL smoke）
docs/screenshot.png    线上截图（README 引用）
```

## 6. M1 已实现的行为与实现细节（读代码前必须知道）

1. **`modified` 模型**：`ConfigState = {version, style, modified}`，`modified` 只存用户改过的**顶层** key。显示值 = `effectiveValue(option, style, modified)` = `modified[key] ?? defaults[style][key] ?? undefined`（UI 显示 `—`）。
2. **map 选项是稀疏的**：16 个 map（`BraceWrapping`、`AlignConsecutive*`、`SortIncludes`…）在 `modified` 里只存改过的 child（`setChildOption`）；显示时 `effectiveValue` 把 patch 合到 preset 上，payload/导出写稀疏形式（wasm 实测接受 partial mapping）。删除最后一个 child 会移除整个 key。
3. **版本切换归一并不会把未知键发给 wasm**：`configReducer` 的 `setVersion` 调 `reconcileModified`，剔除目标版本不认识的顶层选项与 map child；`App` 在 `client.init` 后立即用归一后的 `modified` 格式化一次。
4. **导出格式是硬约束（别乱动）**：`serializeConfig` 按 `schema.options` 顺序输出（与用户修改顺序无关），`BasedOnStyle` 永远第一行，枚举值 canonical 化（`RawStringFormats[].BasedOnStyle` 的 preset 是小写 `google`，导出必须写 `Google`），`yaml.stringify(..., {lineWidth:0})` + 单个结尾换行，不输出 `---`。**导出→导入→导出的字节幂等靠这些约定成立**，改动要么同步改单测（`config-io.test.ts` 的 roundtrip 覆盖全部 7 种风格），要么会静默破坏 e2e 的 roundtrip 用例。
5. **导入是"降级"而不是"失败"**：YAML 语法错误 / 顶层不是 mapping 才抛 `ImportError`（对话框内联显示，带行列号，状态不变）；未知键、非法值、`Language`、多 document、`InheritParentConfig` 都收成 warning，能救的继续。legacy 写法自动转嵌套：map bool → `{Enabled: bool}`；`AlignConsecutive*` 旧枚举（`None/Consecutive/AcrossEmptyLines/...`）→ 嵌套；`AlignTrailingComments` bool → `{Kind: Always|Never}`。只导入第一个非空 YAML document（按语言分段的 .clang-format 不支持）。
6. **已知的 schema 小瑕疵**：`SpacesInLineCommentPrefix.Maximum` 声明为 `uint` 但 preset 是 `-1`。Full 导出会写出 `-1`，再导入时按 uint 规则丢这个 child 并给一条 warning；**Full roundtrip 字节仍相同**（preset 会重新填回 -1）。e2e 里用 `closeNoticeIfVisible` 处理这条提示。将来改 schema 类型（比如改成 `int`）时要同步更新这条记录。
7. **schema store**：`schemaStore.schema(version)` / `.docs(version)`，LRU 容量 3（正好当前 3 个版本），同版本并发请求共享一个 promise，失败不缓存（UI 可重试）。`docs.json` 只在首次搜索或首次展开帮助时拉取。
8. **选项面板**：`OptionPanel` 是纯展示组件，所有编辑通过 `onOptionChange(key, value)` / `onChildChange(option, childKey, value)`（value=undefined 表示恢复继承）交给 reducer。虚拟列表用 `@tanstack/react-virtual`，行高动态测量；搜索 120ms 防抖；docs 搜索时用去标签后的纯文本。**e2e 找行必须滚动 `data-testid="options-scroll"`**：虚拟列表里不可见的行不在 DOM 中。
9. **错误信息**：wasm 抛的 `Error.message` 里已含 LLVM 诊断（多行），worker 按首行/其余拆成 `message`/`detail` 显示。M2 要做结构化错误面板和请求串行化/只保留最新。
10. **入口/子路径**：统一入口 `entry.js`（fetch-wasm 生成，兼容 22+ 的拆包形态）；运行期所有 URL 用 `import.meta.env.BASE_URL` 拼，构建期 `base` 来自 `VITE_BASE`。

## 7. 已知缺陷 / 有意为之

- **16.0.6 / 17.0.6 不可用**：wasm 包只导出 `format`/`version`，没有 `dump_config`。
- **22.x / 23.x 不可用**：`dump_config` 值域错位，被 schema 校验闸门拦下，等上游修。
- **docs HTML 里 code-block 的渲染还很粗糙**（枚举表格的 "Meaning" 列会出现字面 `code-block:: c++`）——这是 `tools/lib/rst.mjs` 子集渲染的局限，M2/M3 有空再修，不影响功能。
- **配置页抽屉的"相对当前风格增删哪些键"预览还没做**（plan §5 配置页属于 M2 范围）；M1 的导入/导出对话框已覆盖核心需求。
- 30 条 gen-schema warning：都是 dump 里没有默认值的遗留/废弃选项，属预期；UI 显示 `—`。
- 没有 ESLint/Prettier（无 `npm run lint`）；没有 Dependabot；action 用 major 版本。
- M1 没有持久化 / 主题切换 / 移动端 tabs / 完整 a11y（M3）。
- 无 per-PR 预览环境。

## 8. M1 e2e 覆盖清单（`tests/e2e/m1.spec.ts`，16 条）

1. 纯 UI 生成配置（搜索 → 改 IndentWidth/ColumnLimit → 输出缩进变化 → Minimal 导出内容正确）
2. reset 恢复继承（modified 计数与输出一起回退，导出不再含该键）
3. Minimal 导出→导入→导出字节相同
4. Full 导出→导入→导出字节相同（含上面第 6 条的 warning 处理）
5. 导入 warning（未知键 + legacy bool）+ BasedOnStyle 生效 + 导出结构正确
6. map 稀疏编辑（`BraceWrapping.AfterClass`）导出为 `AfterClass: true`
7. struct list（`IncludeCategories`）改字段 + Add item 后导出条目数变化
8. `list<string>`（`ForEachMacros`）按行编辑导出
9. 过滤 chips（modified / deprecated）
10. 对话框焦点管理、ESC/遮罩关闭、焦点归还
11. 非法 YAML 内联报错且对话框不关闭，修正后可继续
12. 文件选择器把内容读进 textarea
13. Download 得到 `.clang-format`
14. Copy 到剪贴板内容与 YAML 一致
15. docs 展开触发懒加载并渲染 LLVM 文档（无 4xx）
16. 顶层 enum + bool 控件编辑并导出

## 9. 下一步：M2（按 plan §9）

顺序建议（每步可单独提交、可验证）：

1. **CodeMirror 6**：左栏可编辑源码、右栏只读结果；按需组装语言包（C/C++/C#/Java/Proto，非常用语言懒加载）；替换现在的 textarea/pre。
2. **split diff**：`@codemirror/merge` 的 split 视图做真实行级 diff（v2 的 "Diff mode" 只是并排）。
3. **请求协议升级**（`src/worker/protocol.ts` + `formatter-client.ts`）：请求串行化、新请求丢弃过期 id；格式化期间拦截 `console.error` 收集 LLVM 诊断进 `detail`（M0 发现 message 已含诊断，这里以实测为准，不重复采集）。
4. **错误面板**：结构化错误 = 首行摘要 + 可展开的 LLVM 诊断；保留 `role="alert"`。
5. **快捷键与语言切换**：Ctrl/Cmd+Enter 立即格式化；`auto-format` 开关；语言选择影响 worker 的 filename/语言包。
6. **配置页抽屉**：CM6 YAML 编辑器 + 基于 schema 的实时校验 + 上传/下载 + Apply/Close + 底部"相对当前风格会新增/删除哪些键"预览（可复用 `config-io.ts` 的 parse/serialize）。
7. 防抖 250ms（现在是 300ms，M2 一并调）；>2MB 输入与 worker trap/OOM 的失败路径（plan §7）。

验收（plan §9 M2）：输入代码即时看到格式化与差异；故意写错选项能读到 LLVM 原文。

## 10. 待决策

- **16/17/22/23 怎么办**：(a) 用 PyPI native binary 做构建期 dump（schema 仍提交，运行时不变）；(b) 支持范围改成 18+；(c) 等上游修 22/23。
- 仓库是否长期 public（影响 Pages 免费额度）。
- 是否要 per-PR 预览（Pages 原生不支持，需 Cloudflare Pages 等）。

## 11. 约定

- `plan.md` 是设计与取舍的唯一事实来源；实现偏离时先改 plan 再改代码。
- 提交信息用 `area: summary`（`ci:` / `test:` / `docs:` / `feat:`），一次提交一件事。
- 加版本：`tools/versions.json` 加一行 → `npm run prepare:assets -- --only=<ver>` → 提交 `public/schema/<ver>` 与 lock → push。CI 不重跑 schema 生成（只 `prepare:wasm`）。
- 改 UI 文案/行为时顺手更新 README 的支持版本表与截图（`docs/screenshot.png`）。
- 改导出/导入格式时**必须**跑 `src/lib/config-io.test.ts` 的 roundtrip 与 e2e 的 3/4 两条；破坏字节幂等是最容易漏的回归。
- 提交前至少跑 `npm run verify`；动到 UI/base 路径时再跑 `npx playwright test`（base `/` 与子路径各一遍）。

## 12. 最近验证记录（2026-10-23，本地）

| 项 | 结果 |
|---|---|
| `npm run verify` | ✅ typecheck + 100 unit（5 文件）+ build |
| `npx playwright test`（base `/`，production build） | ✅ 20 passed（4 smoke + 16 m1） |
| `npx playwright test`（`VITE_BASE=/clang-format-configurator-v3/`） | ✅ 20 passed |
| 首屏 JS | 387 KB raw / **119.8 KB gzip**（+CSS 14.1 KB / 3.3 KB gzip） |
| 单测覆盖 | `config` / `config-state` / `config-io` / `schema-store` / `schema`（`config-io.test.ts` 78 条含 minimal+full 全风格 roundtrip） |
| CI（GitHub Actions） | 见 push 后的 run（本文件随后续文档提交补充） |
| 线上 Pages smoke | 见 push 后的 run（同上） |
