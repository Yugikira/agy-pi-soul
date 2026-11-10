# Code Review Round 2：bash 进程等待逻辑与 codemode store 的 pi 一致性复查

> 状态：**未修复（2026-11-11）**
> 审查对象：`b750bcf`（round 1 修复完成后的工作区，工作树干净，43/43 测试通过）
> 参照基线：`node_modules/@earendil-works/pi-coding-agent@1.5.1/dist`（extraneous，仅作基准）
>
> Round 1 见 [issues_pi-tools-parity.md](./issues_pi-tools-parity.md)。本轮复查确认 round 1 声称的修复全部属实，
> 但发现 **bash 进程等待逻辑存在 2 个中危缺陷（B-1、B-2）**，pi 对应逻辑（`waitForChildProcess`、
> `stdio[0]="ignore"`、进程组 kill）在移植时被简化，未记录在 round 1 的 6.4–6.6「故意偏差」中。
> 另有 3 个低危差异（B-3…B-5）与 2 个无害差异。

## 1. 审查范围与方法

- `git log` 通读 round 1 的 9 个修复提交；逐行比对 `mcp/tools.mjs`、`mcp/utils/*.js` 与 pi 的
  `dist/core/tools/{read,write,edit,bash,edit-diff,output-accumulator,truncate}.js`、
  `dist/utils/{shell,child-process}.js`、`dist/extensions/codemode/execute.js`。
- 差异用同进程内实测验证（`node -e "import('./mcp/tools.mjs')…"`），不只看代码。
- 复核 round 1 的验证矩阵：`npm test` 43/43 通过。

## 2. 已确认修复项（抽查核对）

| 工具 | 核对点 | 结论 |
|---|---|---|
| `read` | 图片按内容嗅探（`utils/mime.js`）；`firstLineExceedsLimit` 提示与 `read.js:255` 逐字一致；offset 越界文案；`isStreamableRange` / `readLocalFileChunks` / `selectLinesFromStream` 与 `read.js:41-70` 语义一致（`stats.size - 1` 上界、`/proc` 空大小文件、小数/负数区间走 buffer 切片） | ✅ 与 pi 等价 |
| `edit` | 7 类错误文案（getNotFound/Duplicate/EmptyOldText/NoChange/overlap）；`R_OK\|W_OK` 预检带 `Error code:`；窗口化 diff（±32 行 margin、`getDiffWindows`/`formatDisplayDiff` 移植完整）；`applyReplacementsToOriginal` 还原 CRLF/BOM；mutation queue 内按信号检查；`_meta["pisoul/toolDetails"]` | ✅ 与 pi 等价 |
| `bash` | `OutputBuffer` 与 `OutputAccumulator` 计数/裁剪逻辑一致（滚动尾、溢出落盘 `wx` 0600、流式解码）；`(no output)`、`Command exited with code N`、`128+signal` 退出码、timeout 上限 `2147483.647 seconds`、状态拼接 `text\n\nstatus`（无前导空行）；structuredContent 仅正常退出返回（超时/abort 在 codemode 内应 reject） | ✅ 与 pi 等价 |
| `codemode` | 使用真实的 `@earendil-works/pi-codemode` 沙箱；`// @options`；256MB 内存上限、300s 默认超时；abort 信号透传；`==> text N/M <==`、`<console_output>`、`Script completed/failed` + wall time 头、失败调用摘要、token 预算截断+落盘、图片去重保存；`structuredContent` 解析规则与 pi 一致（含 isError 结果携带结构化值） | ✅ 与 pi 等价 |
| MCP 边界 | `toCallToolResult()` → `_meta`；`validateToolArguments()` 缺参校验；`tools/list` 带 `antigravity/alwaysLoad` | ✅ 已实现 |

## 3. 新发现问题

### B-1（中）stdin 未设为 `ignore`，读 stdin 的命令永久挂起

pi（`dist/core/tools/bash.js:79`）：

```js
stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
```

port（`mcp/tools.mjs` bash 工具）：

```js
const child = spawn(bashPath, ["-c", command], {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
});   // 未指定 stdio → 三路默认 pipe，stdin 永不写入也永不关闭
```

- 影响：`cat`、`tail -f`、`read x`、任何意外进入交互模式的命令都会等待 stdin EOF。
  bash 无默认超时（与 pi 一致），因此**默认永久挂起**。
- 实测：`bashTool.execute('t1', { command: 'cat' })` 挂起 >30s（测试进程被外部强杀）。
  pi 中 `cat` 立即返回 `(no output)`。

**修复**：spawn 选项加 `stdio: ["ignore", "pipe", "pipe"]`。

### B-2（中）用裸 `close` 事件等待进程结束，被持有管道的孙进程拖住

pi（`dist/utils/child-process.js`）不用 `close`：`waitForChildProcess` 在 `exit` 后等待管道
空闲 `EXIT_STDIO_GRACE_MS = 100` 即返回——宽限定时器每收到一个 chunk 就重置，因此活动写入的
孙进程不会丢输出，而安静的后台句柄（如 daemon 化的孙进程）会在宽限后释放等待。
该逻辑修的正是 pi 上游 issue earendil-works/pi#5303。pi 同时 `detached: true` + `trackDetachedChildPid`。

port 在 `child.on("close", …)` 中做全部收尾。Node 的 `close` 要等 stdio 流全部关闭，
孙进程持有 stdout/stderr 管道时 `close` 被推迟到孙进程退出。

- 实测 1：`echo started; sleep 5 & exit 0` 耗时 **5074ms**（pi 约 0.1s）。
- 实测 2（推演）：`nohup <daemon> &` 类命令，daemon 永不退出 → `close` 永不触发。
  且 timeout 也救不了：到时 `killChild()` 杀的是**已退出的** bash（Unix 上 `child.kill` 对已退出
  进程无效），daemon 继续持有管道 → **即使设了 timeout 也永久挂起**（Windows 侧
  `taskkill /f /t` 因按 pid 杀树而侥幸可用，Unix 无解）。

**修复**：按 pi 的方式改为 `exit` 事件 + 管道空闲宽限（100ms，收到 chunk 则重置），宽限后
`destroy()` stdout/stderr 并收尾。与 B-3 一并处理。

### B-3（低）Unix 上未用 detached 进程组 kill

pi：`detached: process.platform !== "win32"` + `killProcessTree(pid)`（`process.kill(-pid)` 杀整组，
注释明言「组杀能到达持有管道的后台进程」），并用 `trackDetachedChildPid` 追踪孤儿。
port：Windows `taskkill /f /t` 正确；Unix 仅 `child.kill("SIGKILL")` 杀 shell 本身，超时/abort 后
后台子进程存活（与 B-2 叠加导致超时失效）。

**修复**：非 Windows 以 `detached: true` spawn，kill 时 `process.kill(-child.pid, "SIGKILL")`
并回退到 `child.kill`。

### B-4（低）codemode `store`/`load` 不跨调用持久

pi（`dist/extensions/codemode/execute.js:530-547`）：store 初值来自会话分支的 `codemode-store`
entries（`readCodemodeStore`），脚本结束后把 `result.storeWrites` 写回会话，**跨 codemode 调用保持**。
port：每次调用新建 sandbox 且不传 store，`store()` 从空开始、写入即丢。
pi-codemode 自身对无会话上下文的调用方也是丢弃语义（`execute.js:428` 注释），但 MCP server 进程
长驻、完全可以在内存里持久化。参照：pi 宿主的 codemode 工具描述明确承诺
「`store(key, value)` 和 `load(key)` 跨 codemode 调用保持 JSON 值」，而 port 的工具描述没有做此承诺，
两者自洽，但与 pi 的实际行为不一致。

**修复**：模块级 `Map` 作为 store 传入 `sandbox.execute(code, { signal, store })`，并把
`result.storeWrites` 应用回该 Map；工具描述补充「跨调用保持」承诺。

### B-5（低）缺 legacy WSL bash 特例

pi（`dist/utils/shell.js` `getBashShellConfig`）：`C:\Windows\System32\bash.exe`（或 `Sysnative`）
判定为 legacy WSL，改用 `args: ["-s"], commandTransport: "stdin"`——因为 WSL 的 `bash -c` 会弄坏
参数编码。port 的 Windows PATH 回退（`where bash.exe`）可能选中它并按 `bash.exe -c "<command>"` 执行。
仅在「Windows 且无 Git Bash 且 PATH 上是 WSL bash」时触发，属边缘场景。

**修复**：`findBash()` 命中 `System32\|Sysnative\bash.exe` 时改走 stdin 传输（`child.stdin.end(command)`），
或至少在文档记录为已知差异。

## 4. 无害差异（可接受，无需修改）

1. **codemode 无 `searchTools` / `describeTool` / `describeNamespace` / `models` 全局**：port 的沙箱里
   只有 `tools`、`ALL_TOOLS`、`console`、`text`、`image`、`exit`、`store`、`load`（实测
   `typeof searchTools === "undefined"`）。port 仅注册 5 个全部声明的工具，发现类全局没有可发现的对象，
   省略合理；pi 侧它们服务于「未声明工具/MCP 工具/图像模型」的场景。
2. **`findBash()` 探测位置是 pi 的超集**：port 额外检查 `usr\bin\bash.exe`、x86 Git、
   `LOCALAPPDATA\Programs\Git`（round 1 P2-3 的改进），pi 只查 `ProgramFiles\Git\bin`。是改进。
3. **无 bash 时的报错**少列了 `Set shellPath in settings.json` 与已搜索路径——MCP 无 settings 概念，合理。
4. **bash 直接继承 `process.env`**：round 1 文档 6.4.3 已记录（pi 注入的 `PI_*` 在 MCP 下无意义）。合理。

## 5. 建议与验证

修复优先级：**B-1、B-2 必修**（真实挂起，且 timeout 形同虚设）；B-3 与 B-2 同一改造点顺手修；
B-4、B-5 低危可择机。修完后在 round 1 的差分对拍矩阵上补三组用例：

- `cat`（stdin 读取）→ 应立即返回 `(no output)`；
- `echo started; sleep 5 & exit 0` → 应 ~0.1s 返回（而非 5s）；
- `nohup sleep 300 & exit 0`（daemon 持管道）→ 应立即返回，且 `timeout=5` 能正常收尾。

回归基线：`npm test`（43 项，修复后应全绿并新增上述用例）。
