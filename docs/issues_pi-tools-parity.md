# Code Review：pi 工具与 pi-coding-agent 内置工具的一致性检查

> 状态：**已修复并验证（2026-11-11 更新）**
> 原始审查：2026-11-10（仅检查，未修改任何代码）
> 修复范围：`mcp/tools.mjs`、`mcp/index.mjs`、`mcp/utils/*.js`、`test/*.test.mjs`、`README.md`
>
> 本文保留原始审查结论（第 1–5 节），修复与验证记录见 **第 6 节**。
> 第 2–5 节里的 `mcp/index.mjs:<行号>` 是修复前单文件实现的历史定位；修复后实现位于 `mcp/tools.mjs` + `mcp/utils/`。

---

## 0. 状态总览（2026-11-11）

| 编号 | 问题 | 状态 | 修复提交 | 验证方式 |
|---|---|---|---|---|
| P0-1 | `read` 单行 >50KB 死循环 | ✅ 已修复 | `6265789` | 对拍 `offset=1/2/3` 及中间行超限，输出与 pi **逐字节相同** |
| P1-1 | `edit` 重写未改动行的行尾 | ✅ 已修复 | `6265789` | 对拍混合行尾文件落盘字节相同（含跨行 newText） |
| P1-2 | `edit` 缺模糊匹配 | ✅ 已修复 | `b1ee55d` | 对拍尾随空白 / 智能引号 / 破折号 / NBSP，结果相同 |
| P1-3 | legacy `oldText`/`newText` 被丢弃 | ✅ 已修复 | `6265789` | 与 pi `prepareEditArguments` 等价（两处都改） |
| P1-4 | 图片缺文本说明与压缩 | ✅ 已修复（不缩放，见 6.4） | `b1ee55d` + `9564e0f` | 文本说明 + 体积上限提示；判定改为按文件内容 |
| P2-1 | 路径解析 | ✅ 已修复 | `b1ee55d` | `~` / `@` / Windows shell 路径 / Unicode 空格 / `file://` 单测 |
| P2-2 | `read` 把 CRLF 归一成 LF | ✅ 已修复 | `6fe5b6e` | 对拍输出相同 |
| P2-3 | `bash` 发现 bash 路径 | ✅ 已修复 | `b1ee55d` | 候选路径为 pi 的超集；`findBash` 单测 |
| P2-4 | `timeout` 非法值被静默忽略 | ✅ 已修复 | `b1ee55d` + `9564e0f` | 非有限 / ≤0 / 超上限均拒绝，文案与 pi 相同 |
| P2-5 | `bash` env 与会话变量 | ➖ 不适用 | — | 见 6.5 |
| P2-6 | 缺文件变更队列 | ✅ 已修复 | `6fe5b6e` | 50 并发编辑同一文件，50/50 全部生效 |
| P2-7 | `edit` 不返回 diff | ✅ 已修复（改道 `_meta`） | `89a0d1c` | 窗口化 diff 与 pi 相同；10MB 文件 edit 74–90ms |
| P2-8 | `codemode` 缺声明与结构化值 | ✅ 已修复 | `7472ca6` | 结构化值、签名可见、`@options`、abort、256MB 限制 |
| P2-9 | 提示文案不一致 | ✅ 已修复 | `6fe5b6e` + `a40ea98` | 7 类 `edit` 错误与 read/bash 提示均与 pi 逐字相同 |
| N-1…N-13 | 审查中新发现的问题 | ✅ 已修复（N-12 按确认不改） | 见 6.2 | 见 6.2 |

> `6265789` / `b1ee55d` / `6fe5b6e` 为 Phase 1–3；`89a0d1c` / `9564e0f` / `7472ca6` / `a40ea98` 为本次 code review 后的修复。
> 回归入口：`npm test` → **43/43 通过**（对拍脚本为一次性验证，未入库）。

---

## 1. 仓库概览（修复前）

`pi-soul` 用一个 MCP stdio server 把 **pi-coding-agent 的工具能力**移植到 **Antigravity CLI (agy)** 的自定义 agent 中。

| 文件 | 作用 |
|---|---|
| `mcp/index.mjs`（634 行，修复前） | MCP stdio server。**手写重实现** pi 的 `read` / `write` / `edit` / `bash`，外加一个 `codemode` 工具。仅依赖 `@earendil-works/pi-codemode` 与 `@modelcontextprotocol/sdk`，不依赖 `pi-coding-agent`，目的是冷启动 < 300ms（修复后拆分为 `mcp/tools.mjs` + `mcp/utils/*.js`，`index.mjs` 只剩传输层） |
| `agents/pi-soul.md` | agy agent 定义（`excludeDefaultComponents: true`，`mcpServers: pisoul` 指向本 server） |
| `README.md` | 设计说明，明确写了这些工具是 "natively implemented" 重实现 |

### 对比基准

- 参考实现：`node_modules/@earendil-works/pi-coding-agent@1.5.1/dist/core/tools/{read,write,edit,bash}.js` 及 `dist/core/tools/edit-diff.js`、`dist/core/tools/truncate.js`、`dist/core/tools/path-utils.js`、`dist/utils/{shell,paths}.js`
- 本机安装的 CLI 为 **1.5.2**；核对 CHANGELOG 后确认 1.5.1 → 1.5.2 **无任何工具行为变更**（1.5.2 仅涉及 session fork / OAuth / UI），故 1.5.1 源码可作为有效基准。

### 验证方式

1. 逐行阅读 `mcp/index.mjs` 与 pi 内置实现，对比 schema / 描述文案 / 截断阈值 / 错误语义 / 行尾处理 / 路径解析 / 环境变量。
2. 另外用 MCP SDK client **实际驱动** `mcp/index.mjs` 做黑盒验证，测试脚本放在 `%TEMP%\pi-soul-check\`（**未改动仓库任何文件**），复现了下文标注"实测复现"的各项结论。

---

## 2. 一致的部分 ✅（原始审查）

> 注：本节中 `edit` 的 inputSchema 一项当时判断有误（实际有 4 处差异，见 P2-9）；现差异见 6.4 第 4 条。

以下各项与 pi 内置工具行为一致，无需改动：

- **工具名**：`read` / `write` / `edit` / `bash` / `codemode`
- **description 文案**：四个工具的描述文本与 pi 内置**逐字相同**
- **inputSchema**：字段名、类型、必填项与 pi 一致（`read`: `path` + 可选 `offset`/`limit`；`write`: `path`+`content`；`edit`: `path`+`edits[]`；`bash`: `command`+可选 `timeout`）
- **截断阈值**：`2000` 行 / `50KB`（`MAX_OUTPUT_LINES` / `MAX_OUTPUT_BYTES`），与 pi 的 `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` 相同
- **`edit` 唯一匹配要求**：多处匹配时报错要求补充上下文
- **`edit` 重叠编辑检测**：按匹配位置排序后检测区间重叠并报错
- **`edit` "无变化"报错**：替换后内容与原文完全相同时报错（pi 同样有 `getNoChangeError`）
- **`bash` exit code**：`exitCode !== 0` → `isError: true` + `Command exited with code N`（与 pi 一致）
- **`bash` 超时提示**：`Command timed out after N seconds`
- **`bash` 输出合并**：stdout 与 stderr 合并输出
- **`bash` 截断到临时文件**：超限时写临时文件并在消息中给出路径
- **`codemode`**：实测可用，沙箱内 `tools.bash` 正常执行

---

## 3. 发现的问题（原始审查，均已处理）

### P0-1　`read` 遇到单行 > 50KB 的文件 → 模型陷入死循环（实测复现）

**位置**：`mcp/index.mjs:119-142`（字节预算循环 `mcp/index.mjs:127`）

pi 的 `truncateHead`（`truncate.js:74`）在首行单独就超过字节上限时，返回空内容并置 `firstLineExceedsLimit = true`；`read.js:255` 随后输出一个**可执行的兜底提示**：

```
[Line 1 is 60KB, exceeds 50KB limit. Use bash: sed -n '1p' file | head -c 51200]
```

而 MCP 的实现（`mcp/index.mjs:127`）在第一行就超限时直接 `break`，`selectedLines` 为空，但仍拼出一个**自指的续读提示**：

```
[Showing lines 1-0 of 3 (50KB limit). Use offset=1 to continue.]
```

`offset` 传任何值结果都一样（`offset=2` → `Use offset=2 to continue`）。模型只会反复重试同一个 offset，**永远读不到该行**。minified JS、单行 base64、大 JSON、压缩后的 CSS 等都会踩中。

> 实测：`bundle.js`（第二行 80KB）从 `offset=2` 读取 → 输出 `"\n\n[Showing lines 2-1 of 4 (50KB limit). Use offset=2 to continue.]"`，内容为空。

---

### P1-1　`edit` 会重写整个文件的行尾（实测复现）

**位置**：`mcp/index.mjs:272`（整体 normalize 为 LF）+ `mcp/index.mjs:359`（按"出现过 CRLF 就整体转回 CRLF"）

对**混合行尾**的文件，一次编辑会把所有**未改动**的行尾也一并改掉：

```
编辑前: "line1\r\nline2\nline3\r\nline4\n"
编辑后: "line1\r\nline2-changed\r\nline3\r\nline4\r\n"
        ↑ line2 / line4 原本是 LF，被改成了 CRLF
```

pi 使用 `applyReplacementsToOriginal`（`edit-diff.js`）把替换区间**回贴到原文**，未触碰的行保持原行尾（`getLineEndingAt` 只对被替换区间套用局部行尾）。

纯 LF 文件与纯 CRLF 文件两者行为一致，**只有混合行尾文件会出现差异**，但差异是静默的、破坏性的。

---

### P1-2　`edit` 缺少 pi 的模糊匹配（whitespace / 引号 / 破折号容错）

**位置**：`mcp/index.mjs:281-320`（纯 `indexOf` 匹配）

pi 的 `fuzzyFindText`（`edit-diff.js:184`）在精确匹配失败时会用 `normalizeForFuzzyMatch`（`edit-diff.js:75`）归一化后再匹配一次，归一化包含：

- Unicode `NFKC`
- 去掉每行行尾空白
- 智能单引号 `''` → `'`，智能双引号 `""` → `"`
- 各类破折号（U+2010…U+2015、U+2212）→ `-`
- 特殊空格（NBSP、U+2002-U+200A、U+202F、U+205F、U+3000）→ 普通空格

MCP 只做纯字符串匹配，因此**缩进 / 引号 / 空格有细微差异就直接报 "Could not find exact match"**，而 pi 能成功。这是实际使用中失败率差距最大的一项。

---

### P1-3　`edit` 静默丢弃 legacy `oldText` / `newText`（实测复现）

**位置**：`mcp/index.mjs:251`

当 `edits[]` 存在时，MCP 完全忽略 legacy 的 `oldText`/`newText`。pi 的 `prepareEditArguments`（`edit.js`）是**追加**到 `edits` 数组：

```
输入 { path, edits: [{AAA→AAA2}], oldText: "BBB", newText: "BBB2" }

pi : AAA→AAA2 且 BBB→BBB2   （两处都改）
MCP: 只改了 AAA→AAA2          （BBB 被静默丢弃，无任何提示）
```

模型同时发送两种格式时，改动结果不同且用户无感知。

---

### P1-4　`read` 读图片时缺少文本说明与图片压缩

**位置**：`mcp/index.mjs:84-97`

pi 返回 `[{type:"text", text:"Read image file [image/png]"}, {type:"image", ...}]`，并且经 `processImage` 按模型的 `inputLimits.images.resize` **缩放**（`read.js:214`）。

MCP 只返回裸 image block，**既无文字说明也无缩放**，大图会以完整 base64 进入上下文（可能数 MB）。

---

### P2 级差异（影响较小）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `mcp/index.mjs:17` `resolvePath` | pi 的 `resolveToCwd` 会展开 `~`、去掉 `@` 前缀、归一化 Unicode 空格、支持 `file://`、处理 Windows shell 路径。MCP 只是 `path.resolve` → 实测 `write("~/x.txt")` 写到了 `<cwd>/~/x.txt` 而非 home 目录 |
| 2 | `mcp/index.mjs:103` | `read` 对 CRLF 文件的输出被 normalize 成 LF（pi 保留 `\r`） |
| 3 | `mcp/index.mjs:22` `findBash` | 硬编码 4 个候选路径，不读 `ProgramFiles` 环境变量、不搜索 PATH 上的 `bash.exe`；失败时只报 `spawn bash.exe ENOENT`，pi 有可读的安装提示并支持 `shellPath` 设置 |
| 4 | `mcp/index.mjs:398` | `timeout <= 0` / 非数字被**静默忽略**（pi 抛 `Invalid timeout: must be a finite number of seconds`） |
| 5 | `mcp/index.mjs:404` | env 直接用 `process.env`；pi 用 `getShellEnv()`（把 pi 的 bin 目录补进 PATH）并注入 `PI_SESSION_ID` / `PI_MODEL` / `PI_REASONING_LEVEL` 等会话变量 |
| 6 | `read`/`write`/`edit` | 无 pi 的 `withFileMutationQueue` 文件变更队列 → 同一文件的并发 edit/write 可能互相覆盖 |
| 7 | `mcp/index.mjs:363` | `edit` 不返回 diff（pi 返回 unified patch 到 `details`）→ 客户端无 diff 视图 |
| 8 | `mcp/index.mjs:526` `codemode` | 沙箱内 `ALL_TOOLS` 声明只有 description，**没有参数签名**（pi 用 `renderToolSample` 渲染成 `(args: {path: string, offset?: number}) => Promise<string>`）→ 沙箱内模型不知道 `tools.read` 该怎么传参；且 `extractTextResult` 把图片块降级成字符串 `"[image]"`，`image()` 拿不到图 |
| 9 | 若干文案 | `write` 成功提示 `"Successfully wrote N bytes to X"` vs pi `"Successfully wrote to X"`；`bash` 空输出 `"(Command executed with no output)"` vs pi `"(no output)"`；`edit` 报错文案与 pi 不同，且 MCP 会把 `oldText` 原文回显进错误消息 |

---

## 4. 建议修复方案（原始建议，已全部实施）

按 P0 → P2 排序。

### 修复 1：`read` 单行超限（P0-1，`mcp/index.mjs:119-142`）

在进入字节预算循环**之前**判断首行字节数，超限时返回 pi 同款 bash 兜底提示：

```js
const firstLineBytes = Buffer.byteLength(lines[startIdx] ?? "", "utf-8");
if (firstLineBytes > MAX_OUTPUT_BYTES) {
  return {
    content: [{ type: "text", text:
      `[Line ${offset} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(MAX_OUTPUT_BYTES)} limit. ` +
      `Use bash: sed -n '${offset}p' ${params.path} | head -c ${MAX_OUTPUT_BYTES}]` }],
  };
}
```

同时把 `endIdx` 初始化为 `startIdx`，保证提示中的 `offset` 不会自指。

### 修复 2：`edit` 保留原始行尾（P1-1，`mcp/index.mjs:270-361`）

不要"整体 normalize → 整体转回"，改为在**原文**中定位匹配区间（LF 偏移 → 原文偏移），只对被替换的区间套用局部行尾，未改动部分原样保留。等价做法：直接复用 pi 的 `applyEditsToNormalizedContent` / `applyReplacementsToOriginal`。

### 修复 3：`edit` 模糊匹配（P1-2，`mcp/index.mjs:281-320`）

复用 pi 的 `normalizeForFuzzyMatch` 逻辑做二级匹配。**注意权衡**：直接 `import` pi-coding-agent 的 `edit-diff.js` 最省事，但会打破"零重依赖、冷启动 < 300ms"这一设计约束；若要保持独立实现，需自行移植约 20 行归一化函数。

### 修复 4：`edit` legacy 参数追加（P1-3，`mcp/index.mjs:251`）

```js
if (params.oldText !== undefined && params.newText !== undefined) {
  edits = [...edits, { oldText: params.oldText, newText: params.newText }];
}
```

### 修复 5：`read` 图片（P1-4，`mcp/index.mjs:84-97`）

补一条文本块 `"Read image file [image/png]"`，并对超过阈值的图片做降采样保护（`sharp` / `canvas` 依赖较重，可先只加 text 块 + 体积上限保护）。

### 修复 6：路径解析（P2-1，`mcp/index.mjs:17`）

用 `os.homedir()` 展开 `~/`，去掉 `@` 前缀。

### 修复 7：`bash`（P2-3/4/5，`mcp/index.mjs:22`, `:398`, `:404`）

shell 发现改用 `process.env.ProgramFiles` + PATH 搜索 `bash.exe`；`timeout` 非法时返回错误而非静默忽略。

### 修复 8：codemode 声明（P2-8，`mcp/index.mjs:526`）

给沙箱工具补 `inputSchema` / 签名描述；图片块改为透传给 pi-codemode 的 `image()`。

### 修复 9：其余低优先级

加 per-file 变更队列、`edit` 返回 diff、统一提示文案。

---

## 5. 建议落地顺序

1. **P0-1 + P1-1 + P1-3** —— 改动小、风险低、收益最直接，建议先做。
2. **P1-2** —— 需要先决定是否放弃"零依赖"设计约束；若保持独立实现，则移植 `normalizeForFuzzyMatch` 即可。
3. **P1-4** —— 需要引入图像处理依赖，建议单独评估。
4. **P2 各项** —— 择机处理。

---

## 6. 修复与验证记录（2026-11-11）

### 6.1 修复摘要（按主题）

**截断与会话提示（`mcp/utils/truncate.js`，新增）**
逐字移植 pi 的 `splitLinesForCounting` / `truncateHead` / `truncateTail`。`read` 改为"先按 pi 的 buffer 语义切片，再 `truncateHead`"；`bash` 改用 `truncateTail` 并复用 pi 的三种提示文案。修掉 2000 行边界多算尾随空行、行数截断误用"N more lines"、bash 尾部少一行、提示放错位置等问题。

**`read`（`mcp/tools.mjs`）**
- 图片判定改为按文件内容嗅探（`mcp/utils/mime.js`，含 PNG/APNG、BMP 头校验、JPEG/GIF/WEBP），扩展名不再参与。
- 超 5MB 图片返回文本提示（非 `isError`），形状对齐 pi 的 `Read image file [mime]` 分支。
- 正常区间改为流式读取（`mcp/utils/read-lines.js`，移植 pi 的 `selectLinesFromStream` / `selectLinesFromBuffer`），内存不再随文件增长；小数/负数区间仍走 pi 的 buffer 切片语义。
- `offset` 越界文案与 pi 一致；缺文件报原始 `ENOENT ... access`。
- 响应 abort：预先 abort 或流中途 abort → `Operation aborted`。

**`edit`（`mcp/tools.mjs` + `mcp/utils/edit-diff.js`）**
- 错误文案换成 pi 的 `getNotFoundError` / `getDuplicateError` / `getEmptyOldTextError` / `getNoChangeError` 与 overlap 文本，不再回显 `oldText`。
- 增加 pi 同款 `R_OK|W_OK` 预检：`Could not edit file: <path>. Error code: ENOENT.`
- diff 改为窗口化 `generateEditDiff`（移植 `getDiffWindows` / `formatDisplayDiff`），返回 `{ diff, patch, firstChangedLine }`，只对改动 ±32 行生成；实测 10MB 文件 edit 从 205–260ms 降到 74–90ms（pi 74–79ms）。
- `details` 经 `toCallToolResult()` 放进 MCP `_meta["pisoul/toolDetails"]`（MCP 无 `details` 字段），模型看到的 `content` 不变。
- 响应 abort：在队列内按 pi 的方式检查信号，避免在 in-flight fs 操作完成前释放队列。

**`bash`（`mcp/tools.mjs` + `mcp/utils/output-buffer.js`，新增）**
- 内存有界：只保留滚动尾部，超出阈值即流式写临时文件（`OutputBuffer`，移植 pi `OutputAccumulator` 的计数/裁剪逻辑）；`structuredContent.output` 可另取最多 1MB 全文。
- 文案与语义对齐 pi：`[Showing lines X-Y of N ...]` 追加在末尾、`(no output)` 保留、`Command aborted`、`128+signal` 退出码、`Command timed out after N seconds`（无句号）。
- 补上 `Invalid timeout: maximum is 2147483.647 seconds`（原先 `1e9` 会导致 `setTimeout` 溢出并误报超时）。

**`codemode`（`mcp/tools.mjs`）**
- `read`/`bash` 声明 `outputSchema` 并返回 `structuredContent`（read：文本或图片块；bash：`{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`）。沙箱内按 pi 的规则解析：有结构化值就返回（含 `isError` 结果），否则 `isError` 抛错。脚本里 `await tools.bash({command:"exit 3"})` 不再抛异常。
- 沙箱工具 description 改用 `renderToolSample`；`codemode` 工具描述嵌入 `renderDeclarations`，模型与 `ALL_TOOLS` 都能看到签名。
- 支持 `// @options: {"max_output_tokens","timeout_ms"}`（`parseCodemodeSource`）；传入调用方 abort signal；设置 pi 的 256MB VM 内存上限；超时默认 300s。
- 输出排版对齐：`Script completed/failed` + wall time 头、`==> text N/M <==`、`<console_output>`、失败时的调用摘要、token 预算截断与临时文件落盘、图片保存路径标签。

**MCP 边界（`mcp/index.mjs`）**
- `toCallToolResult()`：`content` / `isError` 原样，`details` → `_meta`。
- `validateToolArguments()`：pi 在其 agent loop 里校验入参，MCP 客户端未必；缺 `path`/`command`/`code` 等不再演变成 `undefined is a directory` 或执行 `undefined` 命令。

### 6.2 审查中新发现的问题（N-1…N-13）

| # | 问题 | 状态 | 处理 |
|---|---|---|---|
| N-1 | `read` 按扩展名判定图片 | ✅ | `9564e0f`：改为内容嗅探（`mcp/utils/mime.js`） |
| N-2 | 恰好 2000 行 + 结尾换行被误截断 | ✅ | `9564e0f`：`truncateHead` 忽略尾随空行 |
| N-3 | 行数截断用了"N more lines"分支 | ✅ | `9564e0f`：区分 lines / bytes 两种提示 |
| N-4 | `bash` 输出在内存无上限累积 | ✅ | `9564e0f`：`OutputBuffer` 滚动尾部 + 溢出落盘 |
| N-5 | `read` 整文件读入内存 | ✅ | `a40ea98`：流式选择行（100MB 文件 RSS +1MB） |
| N-6 | `details` 在 MCP 层被丢弃 | ✅ | `89a0d1c`：改走 `_meta["pisoul/toolDetails"]` |
| N-7 | diff 结构与成本不符 pi | ✅ | `89a0d1c`：窗口化 + `{diff,patch,firstChangedLine}` |
| N-8 | `codemode` 语义缺口 | ✅ | `7472ca6`：structuredContent/声明/signal/内存/超时/排版 |
| N-9 | 缺参时错误信息误导 | ✅ | `a40ea98`：`validateToolArguments` |
| N-10 | abort / 信号退出码文案不符 | ✅ | `9564e0f` + `a40ea98` |
| N-11 | `bash` 截断提示位置/文案/少一行 | ✅ | `9564e0f` |
| N-12 | `bash` 固定 `process.cwd()` | ➖ | 已确认 agy 会话目录即 server cwd，不改 |
| N-13 | `read`/`write`/`edit` 忽略 abort signal | ✅ | `a40ea98` |

### 6.3 验证方式（可复现）

**差分对拍**：在同一个 Node 进程内 `import` 仓库实现与 `@earendil-works/pi-coding-agent@1.5.1` 的 dist 工具定义，用同一份夹具、同一组参数分别执行，比较返回文本、`isError`、落盘字节、`structuredContent`。对拍脚本放在临时目录，**不进入依赖、不入库**（`pi-coding-agent` 在 `node_modules` 中属于 extraneous，仅作基准）。

覆盖矩阵：

- `read`：1999 / 2000 / 2001 / 2500 行、`limit` 0 / -1 / 小数、`offset` 越界、60KB / 80KB 单行（首行/中间行）、CRLF、空文件、20 万行大文件。
- `bash`：3000 行尾截断、单行 60KB 部分截断、中文多字节、2000 / 2001 行、非零退出、超时、abort、`kill -9 $$`、结构化输出 >50KB 与 >1MB。
- `edit`：混合行尾（含跨行 newText）、模糊匹配（空白/引号/破折号/NBSP）、无结尾换行、CRLF、BOM、无变化、多义、重叠、缺失文件、7 类错误文案。
- diff：10 组夹具的 `diff` / `patch` / `firstChangedLine` 与 pi 完全相同。
- MCP 端到端：真实启动 `mcp/index.mjs`，验证 `tools/list`、`_meta`、缺参校验、bash 截断、codemode 结构化 bash 值。

**性能 / 内存实测**

| 场景 | 修复前 | 修复后 | pi |
|---|---|---|---|
| 10.5MB 文件 edit | 205–260ms（其中全文件 diff 131ms） | 74–90ms | 74–79ms |
| 100MB 单行 `read offset=1` | 整文件读入 | +8MB RSS / 242ms | — |
| 100MB 多行 `read offset=500000 limit=10` | 整文件读入 | +1MB RSS / 189ms | — |
| MCP server 启动到 initialize 响应 | ~250ms | ~250ms | — |

**回归**：`npm test`（`node --test`）共 **43** 项，覆盖 `phase1`–`phase6` 与 `messages`：截断边界、图片嗅探、bash 输出边界、`_meta` 映射、codemode 语义、错误文案、abort、流式读取。

### 6.4 故意保留的差异

1. `read` 遇到目录时返回 `Error: <path> is a directory, not a file.`，而 pi 抛原始 `EISDIR`（信息更清楚，行为无差异）。
2. 图片不做缩放（不引入 `sharp`/`canvas` 等依赖）：超过 5MB 时返回"图片已省略 + 尺寸说明"，而不是像 pi 那样尽量缩放。
3. `bash` 原样继承 MCP server 的环境变量；pi 注入的 `PI_SESSION_ID` / `PI_MODEL` 等只在 pi 进程内有意义。
4. `edit` 的 inputSchema 保留 legacy 兼容字段（`oldText`/`newText`，且 `required` 只有 `path`），以便同时接受单条编辑与数组两种写法；pi 的 schema 只声明 `edits`，运行时仍兼容单条对象。可选字段/描述文案已与 pi 对齐。

### 6.5 不适用 / 不修

- **P2-5（bash env 注入）**：`PI_*` 会话变量属于 pi 运行时契约，agy 下无对应概念；如需在 `bash` 内使用 agy 的信息，应另立约定。
- **N-12（`bash` cwd）**：已确认 agy 的会话目录等于 MCP server 的启动目录，保持 `process.cwd()`。

### 6.6 后续注意

- `read` 的小数 `offset` 且首行超限时，pi 的 buffer 路径本身会因 `allLines[startLine]` 越界而抛错；本实现沿用同一行为，未额外兜底，以免与 pi 产生新的行为差。
- `_meta["pisoul/toolDetails"]` 的消费方是客户端（agy）。已验证 `agy.exe` 的 MCP 客户端会解析 `_meta` / `structuredContent` 字段，但"是否用于展示"未实测；不消费也无副作用（仅很小的额外字节）。
