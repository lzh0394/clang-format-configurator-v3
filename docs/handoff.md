# 交接文档（M0 完成 → 准备 M1）

> 新会话先读本文件，再读 [`plan.md`](../plan.md)。plan.md 是设计与取舍的唯一事实来源；本文只记状态、命令、坑和待办。
> 最后更新：2026-10-22，commit `cf368c6`。

## 1. 一句话现状

M0 已完成并上线：仓库、CI、GitHub Pages 全绿，线上可用；3 个 clang-format 版本（21.1.8 / 20.1.7 / 18.1.8）的 schema 已生成入库，浏览器内 wasm 实时格式化跑通。
**M1（选项面板 + modified 模型 + 导出/导入）尚未开始。**

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
npx playwright test      # 本地用 Edge，需要 Edge 已安装
```

子路径构建（模拟 Pages）：

```powershell
$env:VITE_BASE='/clang-format-configurator-v3/'
npm run build
npx playwright test      # 会自动在 http://127.0.0.1:4173/clang-format-configurator-v3/ 起 preview
Remove-Item Env:VITE_BASE
```

验线上（发布后）：

```powershell
$env:PW_BASE_URL='https://lzh0394.github.io/clang-format-configurator-v3/'
npx playwright test
```

单测 4 条、e2e 4 条，全部应绿。

## 4. 环境事实与坑（踩过的）

- 本机 **Windows + PowerShell**；Node **v26.12.0**、npm **11.20.0**。CI 用 Node **22**。
- 本地 npm 配了腾讯镜像（`npm view` 的 tarball 指向镜像），但 `tools/fetch-wasm.mjs` 默认直接访问 `registry.npmjs.org`；可用 `NPM_REGISTRY` 覆盖。
- 本地 Playwright 用 **Edge**（`channel: "msedge"`，无需下载浏览器）；CI 用 `PW_CHANNEL=chromium` + `npx playwright install`。
- **`vite preview` 必须 `--host 127.0.0.1`**：runner 上 `localhost` 解析到 `::1`，Playwright 连 `127.0.0.1` 会 60s 超时（CI 第一次失败就是这个）。
- **e2e 里必须 `page.goto("./")`，不能 `page.goto("/")`**：`/` 会丢掉 baseURL 的 `/<repo>/` 前缀。本地 `vite preview` 会把 `/` 302 到子路径造成假绿，Pages 上则直接 404。
- 网络偶发 DNS/TLS 抖动（`github.com` 解析失败、`api.github.com` handshake timeout）；`git push` / `gh` 重试即可，不是配置问题。
- gh 已登录账号 **lzh0394**，仓库是 **public**（免费账户 Pages 需要 public）。Pages 已通过 API 设为 `build_type: workflow`。

## 5. 代码地图

```
tools/
  versions.json        版本清单（唯一事实来源，当前 3 个）
  fetch-wasm.mjs       拉 npm tarball → 校验 sha512 → public/wasm/<ver>/ + 生成 entry.js
  gen-schema.mjs       dump_config + LLVM RST → public/schema/<ver>/{core,docs}.json（含校验闸门）
  prepare-assets.mjs   依次跑上面两个；--only=<ver> / --refresh-rst 可传
  lib/rst.mjs          ClangFormatStyleOptions.rst 解析 + 子集 reST→HTML
  lib/tar.mjs          最小 ustar 读取（不引 tar 依赖）
  wasm.lock.json       已提交：每版本 integrity + 每个文件 sha256（幂等/可复现）
src/
  App.tsx              版本/风格/文件名 + 双栏 textarea/pre + auto-format（M0 形态，M2 换 CM6）
  App.module.css       布局样式
  main.tsx / styles.css
  lib/schema.ts        SchemaCore/OptionDef 类型、loadSchema/loadDocs、buildStylePayload、displayValue
  lib/formatter-client.ts  worker 封装：init(version) 会 terminate 旧 worker
  worker/protocol.ts   init/format 请求与 ready/ok/err 响应
  worker/formatter.worker.ts  持有唯一 wasm 实例，import(entry.js) → format()
tests/e2e/smoke.spec.ts 4 条冒烟
public/
  schema/<ver>/        已提交（core.json + docs.json），index.json 驱动版本下拉
  schema/index.json    { default, versions: [{version, options}] }
  wasm/<ver>/          不提交（.gitignore），由 prepare:assets 生成
  favicon.svg
.github/workflows/     ci.yml（verify）、deploy.yml（build → deploy → smoke）
docs/screenshot.png    线上截图（README 引用）
```

## 6. 读代码前必须知道的实现细节

1. **统一入口 `entry.js`**：18–21 的包是单个 glue（default init + 命名导出），22+ 拆成 `clang-format.js` + `binding` + `web` 包装。`fetch-wasm.mjs` 按包内是否存在 `clang-format-web.js` 自动选择，并生成 `entry.js` 统一导出；worker 和 gen-schema 都只 import `entry.js`。
2. **schema 两个数据源**：默认值来自该版本 wasm 的 `dump_config({style, filename, code})`（**没有 CLI 依赖**）；类型/枚举/文档来自对应 tag 的 LLVM RST。RST 类型是人读类型名（`Boolean` / `Integer` / `Unsigned` / `String` / `List of Strings`），不是 C++ 类型。
3. **类型校验闸门**：每个 dump 出来的默认值都要和 RST 推出的类型对上（bool/枚举/map/list，枚举大小写不敏感）。22/23 的 dump 错位就是被它挡下的；加新版本时如果闸门报错，**不要**放宽校验，先确认上游。
4. **子路径**：构建期 `base` 来自 `VITE_BASE`；运行期所有路径用 `import.meta.env.BASE_URL` 拼。CI 与 deploy 都用 `VITE_BASE=/<repo>/` 构建，e2e 也随之跑子路径。
5. **worker 生命周期**：一个版本一个 worker（wasm 实例常驻 ~50 MB），换版本 `terminate` 再建。协议目前只有 `init` / `format`；防抖在 App 侧 300 ms，过期响应靠 run id 丢弃。M2 再做请求串行化与“只保留最新”。
6. **错误信息**：wasm 抛的 `Error.message` 里已含 LLVM 诊断（多行），worker 按首行/其余拆成 `message`/`detail` 显示。不需要拦截 `console.error`（plan §2 第 4 条可据此简化）。

## 7. 已知缺陷 / 有意为之

- **16.0.6 / 17.0.6 不可用**：wasm 包只导出 `format`/`version`，没有 `dump_config`，拿不到每风格默认值。要支持得用 PyPI 的 native clang-format 只做构建期 dump。
- **22.x / 23.x 不可用**：`dump_config` 值域错位（`AlignAfterOpenBracket: true`、`Cpp11BracedListStyle: AlignFirstComment`），CLI 构建同样错，是上游问题。
- `docs.json` 已生成但 **UI 还没用**（M1 点开帮助时懒加载）。
- 30 条 gen-schema warning：都是 dump 里没有默认值的遗留/废弃选项，属预期；它们的 `defaults` 为空，UI 显示“—”。
- 没有 ESLint/Prettier（`npm run lint` 不存在）；代码风格靠 TS strict + 约定。
- 没有 Dependabot / 依赖固定 SHA（workflow 里 action 用的是 major）。
- 无 per-PR 预览环境。

## 8. 下一步：M1（按 plan §9）

顺序建议（每步都可单独提交、可验证）：

1. **schema store**：`loadSchema` + 内存 LRU（3 个版本）+ docs 懒加载；版本切换时复用。
2. **`modified` 模型**：`{version, style, modified}` state；`modified[key] ?? defaults[style][key]`；provide 一个 `setOption(key, value | undefined)`（undefined = 恢复继承）。
3. **选项面板**：虚拟列表（TanStack Virtual，动态行高）+ 搜索（键名/文档，120 ms 防抖）+ 过滤 chips（全部/已修改/已废弃）；五种控件（scalar bool/int/uint/string、enum、map、list<string>、list<struct>）。
4. **导出**：Minimal（BasedOnStyle + modified，默认）/ Full；YAML 序列化需保证键序稳定、幂等。
5. **导入**：`yaml` 包解析 → 展平 → 按当前版本校验 → 未知键收集为 warning；legacy `AlignConsecutive*` 标量自动转嵌套。
6. 把 App 的 `buildStylePayload(style)` 换成 `buildStylePayload(style, modified)`（函数已支持第二个参数）。

验收：不碰编辑器，纯靠 UI 生成一份可用的 `.clang-format`，导出→再导入→再导出字节相同。

## 9. 待决策

- **16/17/22/23 怎么办**：(a) 用 PyPI native binary 做构建期 dump（schema 仍提交，运行时不变）；(b) 支持范围改成 18+；(c) 等上游修 22/23。当前线上只有 3 个版本。
- 仓库是否长期 public（影响 Pages 免费额度）。
- 是否要 per-PR 预览（Pages 原生不支持，需 Cloudflare Pages 等）。

## 10. 约定

- `plan.md` 是设计与取舍的唯一事实来源；实现偏离时先改 plan 再改代码。
- 提交信息用 `area: summary`（`ci:` / `test:` / `docs:` / `feat:`），一次提交一件事。
- 加版本：`tools/versions.json` 加一行 → `npm run prepare:assets -- --only=<ver>` → 提交 `public/schema/<ver>` 与 lock → push。CI 不重跑 schema 生成（只 `prepare:wasm`）。
- 改 UI 文案/行为时顺手更新 README 的支持版本表。
- 提交前至少跑 `npm run verify`；动到 base 路径或 UI 时再跑 `npx playwright test`。

## 11. 最近验证记录（2026-10-22）

| 项 | 结果 |
|---|---|
| `npm run verify` | ✅ typecheck + 4 unit + build |
| `npx playwright test`（本地 base `/`） | ✅ 4 passed |
| `npx playwright test`（`VITE_BASE=/clang-format-configurator-v3/`） | ✅ 4 passed |
| `npx playwright test`（线上 Pages） | ✅ 4 passed |
| GitHub Actions `ci` | ✅ run 39750476398 |
| GitHub Actions `deploy` | ✅ run 39749784836（build / deploy / smoke 三段） |
