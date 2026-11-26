# AGENTS.md

## 本仓库

CGS Desktop（Electron 应用）。当前默认分支 `master` 上是基于 ompweb 的 0.1.0 实现；主线将按新设计重做（TSP 主导界面、Vite + React SPA、不再内置 ompweb），旧的 ompweb 版本线归档为单独分支（分支名见设计文档 ADR 0009，目前待定）。

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

## 当前代码里仍然有效的约定（重做前）

- 构建与发布流程见 `README.md`；发布由推送 `v*` tag 触发 `.github/workflows/release.yml`。
- omp 在隔离环境运行：配置根 `~/.cgs`（`PI_CONFIG_DIR`），agent 目录在 userData 下，不继承用户的 `PI_*` / `OMP_*` 变量（`src/main/services.js` 的 `buildEnv`）。
- CGS 服务器地址可用 `CGS_BASE_URL` 覆盖。
- 测试：`npm test`。
