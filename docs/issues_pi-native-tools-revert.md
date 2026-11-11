# Issue（待处理）：是否回退到 `pi-coding-agent` 原生工具实现

> 状态：**待决策 / 未执行**（记录于 2026-11-11；`inheritMcp: true` + 全局注册 + `eager` 的方案已由用户在他机完成端到端验证）
> 相关提交：`719c85a`（原生工具版最后一版）→ `1b2382b`…`07ed5d5`（自研 standalone 实现 + 两轮 parity 修复）
> 参考文档：[issues_pi-tools-parity.md](./issues_pi-tools-parity.md)、[issues_pi-tools-parity-round2.md](./issues_pi-tools-parity-round2.md)
> 结论先行：**回退不是修复，是重构**；当前实现可用，回退属于「低成本、长期收益」的清理项，建议按触发条件择机执行。

## 1. 新证据（推翻自研方案的原始前提）

自研 `mcp/tools.mjs` 的唯一硬核动机是：agy 启动时 MCP 冷启动太慢，导致 Turn 1 模型侧读不到工具。
实测确认了真正的成因，也确认了一个可用的规避方式（2026-11-11 本机握手实测 + 用户在他机端到端验证）：

| 配置 | 行为 |
|---|---|
| `inheritMcp: false` + 内联 `mcpServers`（含 `eager: true`），即当前 `agents/pi-soul.md` | **不会静默加载**：server 在第一条用户消息发出时才被拉起，首个会话 Turn 1 模型侧仍认为工具未注册 |
| `inheritMcp: true` + `agy mcp add pisoul …` 并在 `~/.gemini/config/mcp_config.json` 设 `"eager": true` | **可预热**：会话启动阶段即完成 MCP 握手，Turn 1 工具已在列表中 |
| 代价 | `inheritMcp: true` 会继承**全部**全局注册的 MCP server，其它 server 一并占用上下文 |

即：只要走「全局注册 + 预热」，MCP 启动时间不再影响 Turn 1，**「必须自研超快工具」的前提消失**。
仓库当前已完成的准备：`agy mcp add pisoul node D:/claude/agy-agents/pi-soul/mcp/index.mjs`（`eager: true`）、
`~/.gemini/config/agents/pi-soul/agent.md` 已同步为最新版；但 `agents/pi-soul.md` 仍是 `inheritMcp: false` +
内联 `mcpServers`，因此全局注册目前对该 agent 不生效。**仓库内 `agents/pi-soul.md` 与 `mcp/` 按用户决定暂不调整**，
推荐配置只写入 README（见「✅ Recommended usage: preload the MCP server」），由用户在本机全局 `agent.md` 中手工落地。

## 2. 两条路线对照（实测数据，非估算）

探针方式：`@modelcontextprotocol/sdk` 的 `StdioClientTransport` 直接连两个版本的 `mcp/index.mjs`，
计时 `connect → tools/list`，并逐个真实调用 `bash/write/edit/read/codemode`。

| 维度 | 保持自研 standalone（当前 `main`） | 回退原生工具（`719c85a` + 预热） |
|---|---|---|
| 代码量 | `index.mjs` 69 行 + `tools.mjs` 1068 行 + `utils/` 8 个模块 + 47 个测试 | `index.mjs` 约 230 行，无自研工具代码 |
| 依赖 | `pi-codemode`、`mcp/sdk`、`diff` | 追加 `@earendil-works/pi-coding-agent@1.5.1`（版本已由 lockfile 锁定） |
| 进程 import 耗时 | 182 ms | 1031 ms |
| MCP 握手（冷启动） | 284 ms | 1450 ms |
| 进程 RSS | 65 MB | 121 MB（node 基线 45 MB） |
| 工具行为一致性 | 手工移植，需持续对照（两轮审计已发现真实缺陷） | 构造上即一致 |
| 上游演进 | 需人工跟进 `pi-coding-agent` 每次改动 | 自动继承 |
| 回归保护 | 47 个单测 + 两轮 parity 矩阵 | 无（需自建 smoke 脚本） |
| 可定制性 | 高（可改文案、可加 `_meta` diff 转发） | 受上游约束（但 `edit` 的 `details` 可自行转发到 `_meta`） |
| 工具名/schema | `read/write/edit/bash/codemode` | 同名同义（`read` 描述、`edit` 的 `edits[]` 窗口化 schema 均已实测） |

> 冷启动差异（+1.17 s / +56 MB）在预热后只发生在**会话启动阶段**，与 Turn 1 无关；但每个新会话都要付一次。

## 3. 我的判断

**短时间内不回退也不会坏，但不是「没问题」——而是「问题被两轮人工审计压住了」。**

支持现在就回退：

- 自研一侧的维护成本是持续性的：parity 文档两轮都在**已经声称对齐**的代码里挖出真缺陷（B-1 `bash` stdin 未
  `ignore` 导致永久挂起、B-2 后台子进程占住管道、B-3 进程组未 kill、截断/图片嗅探细节）。这类缺陷不会在 happy
  path 暴露，属于「用久了才炸」的类型，且每次上游发版都可能新增同类。
- 回退成本已被实测压到很低：`719c85a` 的 `index.mjs` 原样可用，五个工具全部真实调用通过，lockfile 锁定的
  1.5.1 与现装版本一致。
- 回退后 `pi-soul.md` 的 prompt 与工具映射**完全不用改**（工具名与 schema 一致）。

支持维持现状：

- 当前版本工作正常，回退**不修复任何用户可见缺陷**，风险全部来自「换实现」本身。
- 自研版本有 47 个测试与两轮审计记录（`npm test` 47/47 通过），是唯一能证明行为的资产；原生版失去这层保护，只能靠 smoke。
- 若你打算就此**冻结**在与 `1.5.1` 的 parity 上、不再跟随 pi 演进，自研的缺陷面基本被封住。
- 121 MB / 1.45 s 的会话启动开销虽被预热掩盖，但仍比现状重一倍多。

**建议**：不作为紧急项，但按触发条件执行；执行时倾向「回退原生 + 自建 `scripts/smoke.mjs` 兜底」，
把自研那条线整体保存在 `feature-native-tools`（建议改名为 `feature-standalone-tools`）分支里。

决策触发条件（任一满足即执行）：

1. 需要 `pi-coding-agent` 新版的工具行为或修复；
2. 再出现第三轮 parity 缺陷；
3. 在未回退状态下累计修改 `mcp/tools.mjs` 三次以上（说明维护摊子已经开始收利息）。

## 4. 执行计划（若决定执行）

```bash
# Step 0 — 保存现状
git checkout -b feature-native-tools        # 停在当时的 main（含自研实现与全部测试）
# 建议分支名语义更准确：feature-standalone-tools

# Step 1 — main 回退到原生工具实现
git rm -r mcp/tools.mjs mcp/utils test docs
git checkout 719c85a -- mcp/index.mjs package.json package-lock.json
npm install                                  # 锁 1.5.1，与实测版本一致

# Step 2 — 轻量清理 mcp/index.mjs
#   删除已被注释掉的 getSkillsAppendix()、失效的 loadSkills/homedir/join import（skills 由 agy 注入）
#   保留 _meta.antigravity/alwaysLoad
#   可选：把原生 edit 的 details.diff 转发到 _meta["pisoul/toolDetails"]

# Step 3 — agents/pi-soul.md
#   YAML：删除内联 mcpServers，inheritMcp: false → true
#   正文 prompt 保持当前版本不变（仅修笔误 "session boo." → "session boot."）
#   同步 ~/.gemini/config/agents/pi-soul/agent.md

# Step 4 — README
#   概述/架构图改为「原生工具驱动」，删除 parity notes / deliberate differences 两节，
#   安装章节加回 pi-coding-agent，MCP 段改为 agy mcp add + inheritMcp: true，
#   仓库结构树去掉 tools.mjs / utils / test / docs

# Step 5 — 提交
#   revert: use pi-coding-agent native tools with preloaded MCP (inheritMcp: true)
```

## 5. 验证清单（必须全过）

1. `npm install` 后 `node -e "import('@earendil-works/pi-coding-agent')"` 正常，版本为 1.5.1。
2. MCP 冒烟（建议固化为 `scripts/smoke.mjs`）：`tools/list` 得到 `read/write/edit/bash/codemode`，逐个真实调用。
3. `agy agents` 仍能列出 `pi-soul`。
4. 真实会话：`agy --agent pi-soul`，**第一条消息**就要求 `bash` 执行 `rg --version`，确认 Turn 1 工具可用。
5. **cwd 校验**：原生工具用 `process.cwd()` 解析相对路径，确认全局注册的 server 以工作区为 cwd 启动；
   若不符合，加 `PI_SOUL_CWD` / `process.env.PWD` 回退（这会是相对 `719c85a` 的唯一功能性补丁）。
6. 工具名前缀确认：全局注册后暴露名仍是 `mcp_pisoul_read` 等，否则 `pi-soul.md` 映射需同步。

## 6. 风险与回退路径

| 风险 | 处理 |
|---|---|
| 全局注册的 server 在个别 agy 版本上仍不预热 | 退回方案 B：保留内联 `mcpServers` 并同时 `inheritMcp: true` |
| 全局 server 的 cwd ≠ 工作区，相对路径解析错位 | `index.mjs` 增加 cwd 回退（见 5.5） |
| 失去 47 个单测 | 全部保留在 `feature-native-tools` 分支；主分支以 `scripts/smoke.mjs` 兜底 |
| 上游升级改变工具行为 | lockfile 锁 1.5.1；升级时重跑 smoke 脚本 |
| 冷启动/RSS 翻倍（1.45 s / 121 MB） | 预热已消除 Turn 1 影响；若会话启动开销不可接受，则维持自研 |

## 7. 本次已落地的配套改动

- README 新增「✅ Recommended usage: preload the MCP server (`inheritMcp: true`)」：登记的推荐使用方式（已他机验证），
  并明确仓库内 `agents/pi-soul.md` / `mcp/` 暂不调整，实际生效的是用户本机 `~/.gemini/config/agents/pi-soul/agent.md`。
- `~/.gemini/config/mcp_config.json` 已加入 `pisoul` 且 `"eager": true`；在 `inheritMcp` 翻转前该条目对本 agent 不生效。
- `~/.gemini/config/agents/pi-soul/agent.md` 曾在本次同步为仓库版（用户稍后手工改为 `inheritMcp: true` 版本）。
