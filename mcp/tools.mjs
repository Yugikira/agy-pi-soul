import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { formatSize } from "./utils/format.js";
import {
  splitBom,
  normalizeToLF,
  applyReplacementsToOriginal,
  applyEditsToNormalizedContent,
} from "./utils/edit-diff.js";
import { resolvePath, normalizePath } from "./utils/paths.js";

export const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
export const MAX_OUTPUT_LINES = 2000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

export { resolvePath, normalizePath };

function findExecutableOnPath(executable) {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("where", [executable], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && fsSync.existsSync(firstMatch)) {
          return firstMatch;
        }
      }
    } catch {}
    return null;
  }
  try {
    const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {}
  return null;
}

export function findBash() {
  if (process.platform !== "win32") {
    if (fsSync.existsSync("/bin/bash")) return "/bin/bash";
    const bashOnPath = findExecutableOnPath("bash");
    if (bashOnPath) return bashOnPath;
    return "sh";
  }
  const paths = [];
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    paths.push(`${programFiles}\\Git\\usr\\bin\\bash.exe`);
  }
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFilesX86) {
    paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  }
  if (process.env.LOCALAPPDATA) {
    paths.push(path.join(process.env.LOCALAPPDATA, "Programs\\Git\\bin\\bash.exe"));
  }
  for (const p of paths) {
    if (fsSync.existsSync(p)) return p;
  }
  const bashOnPath = findExecutableOnPath("bash.exe");
  if (bashOnPath) return bashOnPath;

  return null;
}

export const bashPath = findBash();

// 1. read tool (with byte and line limit + out-of-bounds error handling)
export const readTool = {
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
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            content: [
              {
                type: "text",
                text: `Image file ${params.path} (${formatSize(stat.size)}) exceeds the ${formatSize(MAX_IMAGE_BYTES)} limit. Please resize or inspect it using bash/scripts.`,
              },
            ],
            isError: true,
          };
        }
        const buffer = await fs.readFile(fullPath);
        return {
          content: [
            {
              type: "text",
              text: `Read image file [${imageMimeTypes[ext]}]`,
            },
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

      const firstLineBytes = Buffer.byteLength(lines[startIdx] ?? "", "utf-8");
      if (firstLineBytes > MAX_OUTPUT_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `[Line ${offset} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(MAX_OUTPUT_BYTES)} limit. Use bash: sed -n '${offset}p' ${params.path} | head -c ${MAX_OUTPUT_BYTES}]`,
            },
          ],
        };
      }

      const selectedLines = [];
      let accumulatedBytes = 0;
      let truncatedByBytes = false;

      for (let i = startIdx; i < totalLines && selectedLines.length < maxRequestedLines; i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf-8") + (selectedLines.length > 0 ? 1 : 0);
        if (accumulatedBytes + lineBytes > MAX_OUTPUT_BYTES) {
          truncatedByBytes = true;
          break;
        }
        selectedLines.push(line);
        accumulatedBytes += lineBytes;
      }

      const endLineDisplay = offset + selectedLines.length - 1;
      const nextOffset = endLineDisplay + 1;

      let outputText = selectedLines.join("\n");
      if (truncatedByBytes) {
        outputText += `\n\n[Showing lines ${offset}-${endLineDisplay} of ${totalLines} (${formatSize(MAX_OUTPUT_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      } else if (endLineDisplay < totalLines) {
        const remaining = totalLines - endLineDisplay;
        outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
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
export const writeTool = {
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

// 3. edit tool (CRLF preservation + fuzzy match + flexible input parsing)
export const editTool = {
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
      if (edits && typeof edits === "object" && !Array.isArray(edits)) {
        if (typeof edits.oldText === "string" && typeof edits.newText === "string") {
          edits = [edits];
        }
      }
      edits = Array.isArray(edits) ? [...edits] : [];
      if (typeof params.oldText === "string" && typeof params.newText === "string") {
        edits.push({ oldText: params.oldText, newText: params.newText });
      }

      if (edits.length === 0) {
        return {
          content: [{ type: "text", text: "Error: Either 'edits' array or 'oldText'/'newText' must be provided." }],
          isError: true,
        };
      }

      const rawContent = await fs.readFile(fullPath, "utf-8");
      const { bom, text: content } = splitBom(rawContent);
      const normalizedOriginal = normalizeToLF(content);

      const { newContent, replacements } = applyEditsToNormalizedContent(
        normalizedOriginal,
        edits,
        params.path
      );

      // Restore line endings: untouched lines keep original line endings
      const finalContent = bom + (content === normalizedOriginal
        ? newContent
        : applyReplacementsToOriginal(content, replacements));

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
export const bashTool = {
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
    if (params.timeout !== undefined) {
      if (typeof params.timeout !== "number" || !Number.isFinite(params.timeout) || params.timeout <= 0) {
        return {
          content: [{ type: "text", text: "Invalid timeout: must be a finite number of seconds" }],
          isError: true,
        };
      }
    }
    const command = params.command;
    const timeoutSec = params.timeout && params.timeout > 0 ? params.timeout : 0;

    if (!bashPath) {
      return {
        content: [
          {
            type: "text",
            text:
              "No bash shell found. Options:\n" +
              "  1. Install Git for Windows: https://git-scm.com/download/win\n" +
              "  2. Add your bash to PATH (Cygwin, MSYS2, etc.)",
          },
        ],
        isError: true,
      };
    }

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

export const piTools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
};

export function extractTextResult(res) {
  if (!res || !Array.isArray(res.content)) return typeof res === "string" ? res : JSON.stringify(res);
  return res.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
}

// 5. codemode tool (with proper subtool error throwing)
export const codemodeTool = {
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

export const allTools = { ...piTools, codemode: codemodeTool };
