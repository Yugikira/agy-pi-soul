import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 1. 直接引入 pi-coding-agent 官方导出的工具工厂和 Skills 加载器
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  loadSkills,
} from "@earendil-works/pi-coding-agent";

// 2. 直接引入官方 QuickJS 沙盒实现 codemode
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { homedir } from "node:os";
import { join } from "node:path";

const cwd = process.cwd();

// 实例化 Pi 的 4 个原汁原味的核心工具
// 注：createBashTool 在 Windows 下会自动解析 Git Bash (bash.exe)
const piTools = {
  read: createReadTool(cwd),
  write: createWriteTool(cwd),
  edit: createEditTool(cwd),
  bash: createBashTool(cwd),
};

// 辅助函数：将 Pi 工具的执行结果提取为纯文本（供 codemode 沙盒内部调用）
function extractTextResult(res) {
  if (!res || !Array.isArray(res.content)) return res;
  return res.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
}

// 3. 构建官方 Codemode 工具（在 QuickJS 沙盒中注入 read, write, edit, bash）
const codemodeTool = {
  name: "codemode",
  description:
    "Execute a JavaScript async function body inside an isolated QuickJS sandbox with direct access to `tools.read`, `tools.write`, `tools.edit`, and `tools.bash`. " +
    "Nested tool calls inside codemode never bloat the LLM context—only what you pass to `text(...)`, `console.log(...)`, or `return` is returned. " +
    "Use this whenever chaining multiple searches (e.g., `rg`), reading multiple files, filtering output, or performing batch edits.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript async function body. Top-level `await` and `return` are supported. Example:\n" +
          "const out = await tools.bash({ command: 'rg -l TODO src/' });\n" +
          "return out;",
      },
    },
    required: ["code"],
  },
  async execute(_id, params, signal) {
    const sandbox = new CodemodeSandbox({
      timeoutMs: 120_000,
      tools: Object.values(piTools).map((t) => ({
        name: t.name,
        description: t.description,
        execute: async (args, { signal: sbSignal }) => {
          const res = await t.execute(
            "codemode-subcall",
            args,
            sbSignal ?? signal
          );
          return extractTextResult(res);
        },
      })),
    });

    try {
      const result = await sandbox.execute(params.code);
      const logs = (result.output || [])
        .map((item) => (item.type === "text" ? item.text : JSON.stringify(item)))
        .join("\n");

      if (!result.ok) {
        const errText = `Codemode Error (${result.error?.kind}): ${result.error?.message}`;
        return {
          content: [{ type: "text", text: logs ? `${logs}\n${errText}` : errText }],
          isError: true,
        };
      }

      const finalValue =
        result.value !== undefined
          ? typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value, null, 2)
          : "";

      const combined = [logs, finalValue].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: combined || "(Executed successfully with no output)" }],
      };
    } finally {
      await sandbox.close();
    }
  },
};

// 4. 动态加载 Skills 摘要（同时兼容 AGY 和 Pi 的技能目录），pi-soul的agent定义里 inheritCustomizations:true，skill加载可以交由agy来实现。
// function getSkillsAppendix() {
//   try {
//     // 尝试调用 Pi 原生的 loadSkills 或读取常见技能目录
//     const skillsResult = loadSkills({
//       cwd,
//       agentDir: join(homedir(), ".gemini", "antigravity"),
//       skillPaths: [
//         join(cwd, ".agents", "skills"),
//         join(cwd, ".agent", "skills"),
//         join(homedir(), ".gemini", "antigravity", "skills"),
//       ],
//     });
//     const skills = Array.isArray(skillsResult)
//       ? skillsResult
//       : skillsResult?.skills || [];
//     if (skills.length === 0) return "";
//
//     const lines = skills.map(
//       (s) => `- ${s.name}: ${s.description} (Location: ${s.filePath})`
//     );
//     return `\n\n<available_skills>\nWhen a task matches a skill below, use \`read\` to load its SKILL.md first:\n${lines.join("\n")}\n</available_skills>`;
//   } catch {
//     return "";
//   }
// }

const allTools = { ...piTools, codemode: codemodeTool };

// 5. 启动 MCP Server 并开启 antigravity/alwaysLoad
const server = new Server(
  { name: "pisoul", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const skillsAppendix = getSkillsAppendix();
  return {
    tools: Object.values(allTools).map((tool) => ({
      name: tool.name,
      // 将扫描到的 Skills 动态附着在 read 工具的描述末尾
      description:
        tool.name === "read"
          ? tool.description + skillsAppendix
          : tool.description,
      // 直接使用 Pi 原生的 TypeBox JSON Schema！
      inputSchema: tool.parameters,
      // 强制 AGY 将其作为顶层工具急切加载（Eager Load）
      _meta: {
        "antigravity/alwaysLoad": true,
      },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  const tool = allTools[toolName];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const args = request.params.arguments ?? {};
  const result = await tool.execute(
    `call_${Date.now()}`,
    args,
    extra.signal
  );

  return {
    content: result.content,
    isError: result.isError ?? false,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
