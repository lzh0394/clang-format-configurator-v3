# clang-format configurator v3

[![ci](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/ci.yml/badge.svg)](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/ci.yml)
[![deploy](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/deploy.yml/badge.svg)](https://github.com/lzh0394/clang-format-configurator-v3/actions/workflows/deploy.yml)

纯静态的 clang-format 配置器：选版本、选风格、改选项，浏览器内 wasm 实时格式化，导出 `.clang-format`。没有后端，可以离线跑。

**在线**：<https://lzh0394.github.io/clang-format-configurator-v3/>

![screenshot](docs/screenshot.png)

当前进度：**M0 已完成**（骨架 + 资源流水线 + 一次真实格式化），CI 与 Pages 发布已跑通。

## 快速开始

```bash
npm install
npm run prepare:assets   # 下载 wasm、生成 schema（首次需要网络）
npm run dev              # http://localhost:5173
```

`public/schema/` 已提交进仓库；`public/wasm/` 不提交，由 `prepare:assets` 按 `tools/wasm.lock.json` 复现。

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
| `npm run test:e2e` | Playwright 冒烟（本地用 Edge：`channel=msedge`；CI 里 `PW_CHANNEL=chromium`） |
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
public/
  wasm/<ver>/            运行时 wasm（不提交）
  schema/<ver>/          core.json（选项 + 默认值）、docs.json（文档）
src/
  App.tsx                版本/风格选择 + 双栏编辑
  worker/                formatter.worker.ts（持有唯一 wasm 实例）+ 协议
  lib/                   worker 客户端、schema 类型与加载
tests/e2e/               Playwright 冒烟
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

## 授权

代码 MIT。docstring 来自 LLVM 文档（Apache-2.0 WITH LLVM-exception），wasm 构建来自 [`@wasm-fmt/clang-format`](https://github.com/wasm-fmt/clang-format)（MIT）。
