# AGENTS.md

## 本仓库

本仓库是 CGS Desktop 客户端。`next` 是从独立历史开始的新主线：目前实现为 Vite + React + TypeScript 的 Web SPA，源码位于 `src/`，不再内置旧版 ompweb。`master` 保留旧版基于 ompweb 的 Electron 实现。

## 设计文档在别处

跨仓库设计文档单独放在 **`../cgs-client-docs`**（与本仓库同级目录），不在本仓库内。涉及架构、协议、供应商适配、远程访问、发布流程、许可证的改动，动手前先读：

1. `../cgs-client-docs/README.md` 总目录与阅读顺序
2. `../cgs-client-docs/adr/` 已做出的决策与理由
3. `../cgs-client-docs/desktop/` 本仓库对应的文档：`architecture.md`、`tsp-renderer.md`、`web-client.md`、`ux-spec.md`、`account-billing.md`、`migration.md`、`release.md`
4. `../cgs-client-docs/cgsconnect/` 与本仓库有接口关系的 cgscli / cgsconnect 文档（尤其 `protocol.md`、`client-profiles.md`、`remote.md`）

## 规则

- 文档是设计决策的唯一来源。代码与文档冲突时，先在文档里提出并解决，再改代码；不要让两边悄悄分叉。
- 做出新的架构决策，在 `../cgs-client-docs/adr/` 新增 ADR；不改写已有 ADR，被取代的标注「被取代」。
- 文档里标记 `[待验证 Vn]` 的结论不要当事实使用；验证后把结果写回 `../cgs-client-docs/VERIFICATION.md`。
- 文档里标记 `[未决 On]` 的事项需要所有者决定，不要自行选择。
- 术语以 `../cgs-client-docs/GLOSSARY.md` 为准（`cgscli`、`cgsconnect`、`client profile` 等）。旧名 `cgsagent` 已改为 `cgsconnect`；`legacy cgs-agent` 指旧的 Go 版本。
- 许可证：新主线为 AGPL-3.0；`package.json` 目前仍是 `UNLICENSED`，改动许可证的细节见 `../cgs-client-docs/legal/LICENSING.md`。

## 当前代码里仍然有效的约定

- Web 客户端与宿主的共享契约集中在 `src/core/types.ts`；界面通过这套契约使用宿主能力，不直接依赖开发桥。
- `bridge/` 是本地开发桥。先构建 `dist/`，再运行 `bridge/run.sh`，由桥启动容器中的 `cgs --mode rpc-ui`，提供静态页面、RPC WebSocket 和宿主 HTTP API。默认仅监听回环地址；任何能访问该端口的人都能控制 agent。
- `CGS_BASE_URL` 可覆盖 CGS 服务器地址，`STATE` 可指定用于保留 `~/.cgs` 的 Docker 卷；未指定时，容器的 home 是临时的。
- 本地检查：`bun --bun run test`、`bun --bun run typecheck`、`bun --bun run build`。
