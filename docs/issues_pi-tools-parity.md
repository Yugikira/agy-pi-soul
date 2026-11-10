# Code Review：`mcp/index.mjs` 中的 pi 工具与 pi-coding-agent 内置工具的一致性检查

> 状态：**仅检查，未修改任何代码**
> 日期：2026-11-10
> 范围：`mcp/index.mjs` 中注册的 `read` / `write` / `edit` / `bash`（附带 `codemode`）与 `@earendil-works/pi-coding-agent` 内置实现的对比

---

## 1. 仓库概览

`pi-soul` 用一个 MCP stdio server 把 **pi-coding-agent 的工具能力**移植到 **Antigravity CLI (agy)** 的自定义 agent 中。

| 文件 | 作用 |
|---|---|
| `mcp/index.mjs`（634 行） | MCP stdio server。**手写重实现** pi 的 `read` / `write` / `edit` / `bash`，外加一个 `codemode` 工具。仅依赖 `@earendil-works/pi-codemode` 与 `@modelcontextprotocol/sdk`，不依赖 `pi-coding-agent`，目的是冷启动 < 300ms |
| `agents/pi-soul.md` | agy agent 定义（`excludeDefaultComponents: true`，`mcpServers: pisoul` 指向本 server） |
| `README.md` | 设计说明，明确写了这些工具是 "natively implemented" 重实现 |

### 对比基准

- 参考实现：`node_modules/@earendil-works/pi-coding-agent@1.5.1/dist/core/tools/{read,write,edit,bash}.js` 及 `dist/core/tools/edit-diff.js`、`dist/core/tools/truncate.js`、`dist/core/tools/path-utils.js`、`dist/utils/{shell,paths}.js`
- 本机安装的 CLI 为 **1.5.2**；核对 CHANGELOG 后确认 1.5.1 → 1.5.2 **无任何工具行为变更**（1.5.2 仅涉及 session fork / OAuth / UI），故 1.5.1 源码可作为有效基准。

### 验证方式

1. 逐行阅读 `mcp/index.mjs` 与 pi 内置实现，对比 schema / 描述文案 / 截断阈值 / 错误语义 / 行尾处理 / 路径解析 / 环境变量。
2. 另外用 MCP SDK client **实际驱动** `mcp/index.mjs` 做黑盒验证，测试脚本放在 `%TEMP%\pi-soul-check\`（**未改动仓库任何文件**），复现了下文标注"实测复现"的各项结论。

---

## 2. 一致的部分 ✅

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

## 3. 发现的问题

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

## 4. 建议修复方案（尚未实施）

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
