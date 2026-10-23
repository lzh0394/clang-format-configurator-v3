# clang-format configurator v3

[![ci](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/ci.yml/badge.svg)](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/ci.yml)
[![deploy](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/deploy.yml/badge.svg)](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/deploy.yml)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

纯静态的 clang-format 配置器：选版本、选风格、在选项面板里改选项，浏览器内 wasm 实时格式化，导入/导出 `.clang-format`。没有后端，可以离线跑。

**在线**：<https://lzh0394.github.io/clang-format-configurator-v3/>

![screenshot](docs/screenshot.png)

当前进度：**M1 已完成**（选项引擎 + 面板 + 配置导入/导出），M0 的骨架、资源流水线、CI 与 GitHub Pages 已在线上跑通。开发状态、命令与踩过的坑见 [docs/handoff.md](docs/handoff.md)；设计与取舍的唯一事实来源是 [plan.md](plan.md)。

## 快速开始

```bash
npm install
npm run prepare:assets   # 下载 wasm、生成 schema（首次需要网络）
npm run dev              # http://localhost:5173
```

`public/schema/` 已提交进仓库；`public/wasm/` 不提交，由 `prepare:assets` 按 `tools/wasm.lock.json` 复现。

## 已实现（M0 + M1）

- **3 个版本**（21.1.8 默认 / 20.1.7 / 18.1.8）× **7 种风格**，版本列表由生成的 `schema/index.json` 驱动，加版本不用改代码。
- **选项面板**：189 个选项的虚拟列表（动态行高）、搜索（键名 + 文档全文，120 ms 防抖）、过滤 chips（全部 / 已修改 / 已废弃）、逐项显示「继承值 vs 修改值」与单行 reset。
- **五种控件**：bool / int / uint / string 标量、enum 下拉、map（结构体，稀疏修改）、`List of Strings`、`List of Structs`（增删条目、逐字段编辑）。
- **只发送改动项**：内部状态是 `{version, style, modified}`，格式化 payload 是 `{BasedOnStyle, ...modified}`；默认值只用于显示，不会再像 v2 那样把 190 个默认值全量物化。
- **导出/导入**：Minimal（默认，只含 `BasedOnStyle` + 改动项）/ Full（全部写死，供锁版本）；导入按当前版本 schema 校验，未知键与非法值收集为 warning（不硬失败），legacy `AlignConsecutive*` / `SortIncludes` / `AlignTrailingComments` 自动转换成嵌套形式；YAML 语法错误带行列号。**导出 → 再导入 → 再导出字节幂等**（minimal 与 full 都有单测与 e2e）。
- **文档懒加载**：`docs.json` 首次搜索或首次展开某选项帮助时才拉取（~23 KB gzip），用构建期生成好的 HTML 渲染。
- **wasm 在 Worker 里跑**：主线程不阻塞，一个版本一个实例，换版本 terminate 旧 worker。
- **首屏 JS 119.8 KB gzip**（预算 250 KB），单版本 wasm ~0.95 MB gzip。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | Vite 开发服务器 |
| `npm run build` | 生产构建到 `dist/` |
| `npm run preview` | 预览构建产物 |
| `npm run prepare:assets` | fetch-wasm + gen-schema |
| `npm run prepare:wasm` | 只下载 wasm（CI 用，schema 已入库） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest 单测 |
| `npm run test:e2e` | Playwright（本地用 Edge：`channel=msedge`；CI 里 `PW_CHANNEL=chromium`） |
| `npm run verify` | typecheck + test + build |

GitHub Pages 子路径构建：

```bash
VITE_BASE=/<repo>/ npm run build
```

## 目录

```
tools/
  versions.json          版本清单（唯一事实来源）
  fetch-wasm.mjs         从 npm 拉 wasm，校验 sha512，生成统一 entry.js
  gen-schema.mjs         dump_config + LLVM RST → public/schema/<ver>/
  lib/rst.mjs            RST 解析 + 子集渲染成 HTML
src/
  App.tsx                版本/风格/文件名 + 选项面板 + 双栏编辑 + 状态栏
  components/            OptionPanel / OptionRow / controls（五种控件）/ ConfigDialog / useDocs
  lib/
    schema.ts            schema 类型、资源加载、buildStylePayload
    schema-store.ts      版本 schema 与 docs 的 LRU 缓存（3 版本，失败不缓存）
    config.ts            modified 模型：继承值、稀疏 map、set/reset
    config-state.ts      ConfigState + useReducer reducer + 版本切换归一
    config-io.ts         .clang-format YAML 导出/导入（纯逻辑）
    formatter-client.ts  worker 封装，换版本 terminate
  worker/                formatter.worker.ts（持有唯一 wasm 实例）+ 协议
tests/e2e/               smoke（M0）+ m1（选项引擎 / 导入导出 roundtrip）
public/
  schema/<ver>/          core.json（选项 + 默认值）、docs.json（文档），已提交
  schema/index.json      版本下拉的数据源
  wasm/<ver>/            不提交，由 prepare:assets 生成
```

## 支持的版本

| 版本 | 状态 |
|---|---|
| 21.1.8（默认） | ✅ |
| 20.1.7 | ✅ |
| 18.1.8 | ✅ |
| 16.x / 17.x | ❌ wasm 构建没有 `dump_config`，拿不到各风格默认值 |
| 22.x / 23.x | ❌ 上游 `dump_config` 输出值域错位（枚举↔布尔），被 schema 校验闸门拦下 |

详见 [plan.md 第 3.1 节](plan.md)。

## 部署

推到 `main` 即自动发布到 GitHub Pages（`Settings → Pages → Source: GitHub Actions`）。工作流分三段：build（含 e2e）→ deploy → smoke（对线上 URL 再跑一遍 Playwright，等 Pages 返回 200 后开始）。子路径与缓存策略见 plan.md 第 8.1 节。

## 致谢

- [clang-format-configurator v2](https://github.com/Wirena/clang-format-configurator-v2)（MIT）：v3 的功能范围与交互设计参考了 v2 的实现与线上行为。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：本项目的开发与文档工作借助 dsh 完成。
- [LLVM](https://llvm.org/)：clang-format 本体及选项文档。
- [@wasm-fmt/clang-format](https://github.com/wasm-fmt/clang-format)：浏览器内运行的 clang-format wasm 构建。
- [React](https://react.dev/)、[Vite](https://vite.dev/)、[Playwright](https://playwright.dev/)、[Vitest](https://vitest.dev/)、[TanStack Virtual](https://tanstack.com/virtual)：界面、构建与测试依赖。

## 授权

代码 MIT。docstring 来自 LLVM 文档（Apache-2.0 WITH LLVM-exception），wasm 构建来自 [`@wasm-fmt/clang-format`](https://github.com/wasm-fmt/clang-format)（MIT）。
