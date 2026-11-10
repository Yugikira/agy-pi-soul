import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const MAX_OUTPUT_LINES = 2000;

function resolvePath(targetPath) {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.resolve(process.cwd(), targetPath);
}

function findBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs\\Git\\bin\\bash.exe"),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return "bash.exe";
}

const bashPath = findBash();

// 1. read tool (with byte and line limit + out-of-bounds error handling)
const readTool = {
  name: "read",
  description:
    "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). " +
    "Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). " +
    "Use offset/limit for large files. When you need the full file, continue with offset until complete.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative or absolute)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
    },
  },
  async execute(_id, params) {
    const fullPath = resolvePath(params.path);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return {
          content: [{ type: "text", text: `Error: ${params.path} is a directory, not a file.` }],
          isError: true,
        };
      }

      const ext = path.extname(fullPath).toLowerCase();
      const imageMimeTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
      };

      if (imageMimeTypes[ext]) {
        const buffer = await fs.readFile(fullPath);
        return {
          content: [
            {
              type: "image",
              data: buffer.toString("base64"),
              mimeType: imageMimeTypes[ext],
            },
          ],
        };
      }

      // Read text file
      const raw = await fs.readFile(fullPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      const totalLines = lines.length;

      const offset = params.offset && params.offset > 0 ? Math.floor(params.offset) : 1;
      if (offset > totalLines) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Offset ${offset} is beyond end of file (${totalLines} lines total).`,
            },
          ],
          isError: true,
        };
      }

      const startIdx = offset - 1;
      const maxRequestedLines =
        params.limit && params.limit > 0 ? Math.floor(params.limit) : MAX_OUTPUT_LINES;

      const selectedLines = [];
      let accumulatedBytes = 0;
      let truncatedByBytes = false;
      let endIdx = startIdx;

      for (let i = startIdx; i < totalLines && selectedLines.length < maxRequestedLines; i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf-8") + (selectedLines.length > 0 ? 1 : 0);
        if (accumulatedBytes + lineBytes > MAX_OUTPUT_BYTES) {
          truncatedByBytes = true;
          break;
        }
        selectedLines.push(line);
        accumulatedBytes += lineBytes;
        endIdx = i + 1;
      }

      let outputText = selectedLines.join("\n");
      if (truncatedByBytes) {
        outputText += `\n\n[Showing lines ${offset}-${endIdx} of ${totalLines} (${Math.round(MAX_OUTPUT_BYTES / 1024)}KB limit). Use offset=${endIdx + 1} to continue.]`;
      } else if (endIdx < totalLines) {
        const remaining = totalLines - endIdx;
        outputText += `\n\n[${remaining} more lines in file. Use offset=${endIdx + 1} to continue.]`;
      }

      return {
        content: [{ type: "text", text: outputText }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading file: ${err.message}` }],
        isError: true,
      };
    }
  },
};

// 2. write tool
const writeTool = {
  name: "write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write (relative or absolute)",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
  },
  async execute(_id, params) {
    const fullPath = resolvePath(params.path);
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, params.content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `Successfully wrote ${Buffer.byteLength(params.content, "utf-8")} bytes to ${params.path}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error writing file: ${err.message}` }],
        isError: true,
      };
    }
  },
};

// 3. edit tool (CRLF normalization + flexible input parsing)
const editTool = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. " +
    "If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. " +
    "Do not include large unchanged regions just to connect distant changes.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit (relative or absolute)",
      },
      edits: {
        type: "array",
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally.",
        items: {
          type: "object",
          required: ["oldText", "newText"],
          properties: {
            oldText: {
              type: "string",
              description: "Exact text for one targeted replacement. It must be unique in the original file.",
            },
            newText: {
              type: "string",
              description: "Replacement text for this targeted edit.",
            },
          },
        },
      },
      oldText: {
        type: "string",
        description: "Exact text to find (if passing a single edit directly)",
      },
      newText: {
        type: "string",
        description: "Replacement text (if passing a single edit directly)",
      },
    },
  },
  async execute(_id, params) {
    const fullPath = resolvePath(params.path);
    try {
      let edits = params.edits;
      if (typeof edits === "string") {
        try {
          edits = JSON.parse(edits);
        } catch {}
      }
      if (!edits || !Array.isArray(edits)) {
        if (params.oldText !== undefined && params.newText !== undefined) {
          edits = [{ oldText: params.oldText, newText: params.newText }];
        } else if (edits && typeof edits.oldText === "string" && typeof edits.newText === "string") {
          edits = [edits];
        } else {
          return {
            content: [{ type: "text", text: "Error: Either 'edits' array or 'oldText'/'newText' must be provided." }],
            isError: true,
          };
        }
      }

      if (edits.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No edits provided." }],
          isError: true,
        };
      }

      const rawContent = await fs.readFile(fullPath, "utf-8");
      const isCrlf = rawContent.includes("\r\n");
      const normalizedOriginal = rawContent.replace(/\r\n/g, "\n");

      // Normalize all edits to LF for matching
      const normalizedEdits = edits.map((e) => ({
        oldText: String(e.oldText ?? "").replace(/\r\n/g, "\n"),
        newText: String(e.newText ?? "").replace(/\r\n/g, "\n"),
      }));

      // Locate all replacements in normalized original
      const occurrences = [];
      for (let i = 0; i < normalizedEdits.length; i++) {
        const { oldText, newText } = normalizedEdits[i];
        if (!oldText) {
          return {
            content: [{ type: "text", text: `Error in edit[${i}]: 'oldText' cannot be empty.` }],
            isError: true,
          };
        }

        let count = 0;
        let pos = 0;
        let firstIndex = -1;
        while ((pos = normalizedOriginal.indexOf(oldText, pos)) !== -1) {
          count++;
          if (firstIndex === -1) firstIndex = pos;
          pos += oldText.length;
        }

        if (count === 0) {
          return {
            content: [{ type: "text", text: `Error: Could not find exact match for 'oldText' in ${params.path}:\n${oldText}` }],
            isError: true,
          };
        }
        if (count > 1) {
          return {
            content: [
              {
                type: "text",
                text: `Error: 'oldText' matched ${count} times in ${params.path}. Please provide more surrounding context to disambiguate:\n${oldText}`,
              },
            ],
            isError: true,
          };
        }

        occurrences.push({
          index: firstIndex,
          length: oldText.length,
          newText,
          order: i,
        });
      }

      // Sort by index to check for overlaps
      occurrences.sort((a, b) => a.index - b.index);
      for (let i = 0; i < occurrences.length - 1; i++) {
        const cur = occurrences[i];
        const next = occurrences[i + 1];
        if (cur.index + cur.length > next.index) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Overlapping edits detected between edit[${cur.order}] and edit[${next.order}]. Merge nearby edits into a single block.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Apply replacements backwards in LF space
      let modified = normalizedOriginal;
      for (let i = occurrences.length - 1; i >= 0; i--) {
        const { index, length, newText } = occurrences[i];
        modified = modified.slice(0, index) + newText + modified.slice(index + length);
      }

      if (modified === normalizedOriginal) {
        return {
          content: [{ type: "text", text: `Error: Replacement produced identical content for ${params.path}. No changes made.` }],
          isError: true,
        };
      }

      // Restore CRLF if original file used CRLF
      const finalContent = isCrlf ? modified.replace(/\n/g, "\r\n") : modified;

      await fs.writeFile(fullPath, finalContent, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully applied ${edits.length} edit(s) to ${params.path}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error editing file: ${err.message}` }],
        isError: true,
      };
    }
  },
};

// 4. bash tool (unified real-time stdout/stderr streaming + proper signal/timeout exit code)
const bashTool = {
  name: "bash",
  description:
    "Execute a bash command in the current working directory. Returns stdout and stderr. " +
    "Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. " +
    "Optionally provide a timeout in seconds.",
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (optional, no default timeout)",
      },
    },
  },
  async execute(_id, params, signal) {
    const command = params.command;
    const timeoutSec = params.timeout && params.timeout > 0 ? params.timeout : 0;

    return new Promise((resolve) => {
      let combinedOutput = "";
      let timedOut = false;
      let timer = null;

      const child = spawn(bashPath, ["-c", command], {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
      });

      const killChild = () => {
        if (process.platform === "win32") {
          try {
            spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
          } catch {}
        } else {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      };

      if (timeoutSec > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killChild();
        }, timeoutSec * 1000);
      }

      if (signal) {
        signal.addEventListener("abort", () => {
          killChild();
        }, { once: true });
      }

      const onData = (data) => {
        combinedOutput += data.toString("utf-8");
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("close", async (code) => {
        if (timer) clearTimeout(timer);

        let finalOutput = combinedOutput;
        const lines = finalOutput.split(/\r?\n/);
        const byteLen = Buffer.byteLength(finalOutput, "utf-8");

        if (lines.length > MAX_OUTPUT_LINES || byteLen > MAX_OUTPUT_BYTES) {
          const tmpFile = path.join(os.tmpdir(), `pi-bash-${Date.now().toString(36)}.log`);
          await fs.writeFile(tmpFile, finalOutput, "utf-8").catch(() => {});

          const truncatedLines = lines.slice(-MAX_OUTPUT_LINES);
          let truncatedText = truncatedLines.join("\n");
          if (Buffer.byteLength(truncatedText, "utf-8") > MAX_OUTPUT_BYTES) {
            const buf = Buffer.from(truncatedText, "utf-8");
            truncatedText = buf.subarray(buf.length - MAX_OUTPUT_BYTES).toString("utf-8");
          }
          finalOutput = `[Showing last ${truncatedLines.length} lines (${Math.round(MAX_OUTPUT_BYTES / 1024)}KB limit). Full output: ${tmpFile}]\n\n${truncatedText}`;
        }

        if (timedOut) {
          resolve({
            content: [
              {
                type: "text",
                text: finalOutput
                  ? `${finalOutput}\n\nCommand timed out after ${timeoutSec} seconds.`
                  : `Command timed out after ${timeoutSec} seconds.`,
              },
            ],
            isError: true,
          });
          return;
        }

        // code !== 0 includes code === null (terminated by signal/killed)
        if (code !== 0) {
          const exitMsg =
            code === null
              ? "Command terminated by signal without exit code"
              : `Command exited with code ${code}`;
          resolve({
            content: [
              {
                type: "text",
                text: finalOutput ? `${finalOutput}\n\n${exitMsg}` : exitMsg,
              },
            ],
            isError: true,
          });
        } else {
          resolve({
            content: [{ type: "text", text: finalOutput || "(Command executed with no output)" }],
          });
        }
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          content: [{ type: "text", text: `Failed to execute command: ${err.message}` }],
          isError: true,
        });
      });
    });
  },
};

const piTools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
};

function extractTextResult(res) {
  if (!res || !Array.isArray(res.content)) return typeof res === "string" ? res : JSON.stringify(res);
  return res.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
}

// 5. codemode tool (with proper subtool error throwing)
const codemodeTool = {
  name: "codemode",
  description:
    "Execute a JavaScript async function body inside an isolated QuickJS sandbox with direct access to `tools.read`, `tools.write`, `tools.edit`, and `tools.bash`. " +
    "Nested tool calls inside codemode never bloat the LLM context—only what you pass to `text(...)`, `console.log(...)`, or `return` is returned. " +
    "Use this whenever chaining multiple searches (e.g., `rg`), reading multiple files, filtering output, or performing batch edits.",
  parameters: {
    type: "object",
    required: ["code"],
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript async function body. Top-level `await` and `return` are supported. Example:\n" +
          "const out = await tools.bash({ command: 'rg -l TODO src/' });\n" +
          "return out;",
      },
    },
  },
  async execute(_id, params, signal) {
    const sandbox = new CodemodeSandbox({
      timeoutMs: 120_000,
      tools: Object.values(piTools).map((t) => ({
        name: t.name,
        description: t.description,
        execute: async (args, { signal: sbSignal }) => {
          const res = await t.execute("codemode-subcall", args, sbSignal ?? signal);
          const text = extractTextResult(res);
          if (res && res.isError) {
            throw new Error(text);
          }
          return text;
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

const allTools = { ...piTools, codemode: codemodeTool };

// MCP Server Setup
const server = new Server(
  { name: "pisoul", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(allTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
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
