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
  generateEditDiff,
} from "./utils/edit-diff.js";
import { resolvePath, normalizePath } from "./utils/paths.js";
import { withFileMutationQueue } from "./utils/mutation-queue.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./utils/truncate.js";
import { detectSupportedImageMimeTypeFromFile } from "./utils/mime.js";
import { OutputBuffer } from "./utils/output-buffer.js";

export const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES; // 50KB
export const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

export { resolvePath, normalizePath, withFileMutationQueue };

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

// 1. read tool (with byte and line limit + CRLF preservation + out-of-bounds error handling)
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

      // Image detection uses the file content, not the extension: a .png that is not a PNG is text.
      const imageMimeType = await detectSupportedImageMimeTypeFromFile(fullPath).catch(() => null);

      if (imageMimeType) {
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Read image file [${imageMimeType}]\n` +
                  `[Image omitted: ${formatSize(stat.size)} exceeds the ${formatSize(MAX_IMAGE_BYTES)} inline image size limit. Use bash to inspect or convert it.]`,
              },
            ],
          };
        }
        const buffer = await fs.readFile(fullPath);
        return {
          content: [
            {
              type: "text",
              text: `Read image file [${imageMimeType}]`,
            },
            {
              type: "image",
              data: buffer.toString("base64"),
              mimeType: imageMimeType,
            },
          ],
        };
      }

      // Read text file (splitting on \n keeps the \r of CRLF files)
      const raw = await fs.readFile(fullPath, "utf-8");
      const allLines = raw.split("\n");
      const totalFileLines = allLines.length;

      // Convert offset from 1-indexed input to 0-indexed line access, like pi.
      const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      const endLine =
        params.limit === undefined ? undefined : Math.min(startLine + params.limit, allLines.length);
      // truncateHead ignores a trailing empty line, so a file ending in a newline is not truncated early.
      const truncation = truncateHead(allLines.slice(startLine, endLine).join("\n"));
      const firstLineBytes = truncation.firstLineExceedsLimit
        ? Buffer.byteLength(allLines[Math.trunc(startLine)] ?? "", "utf-8")
        : 0;

      if (startLine >= totalFileLines) {
        return {
          content: [
            {
              type: "text",
              text: `Offset ${params.offset} is beyond end of file (${totalFileLines} lines total)`,
            },
          ],
          isError: true,
        };
      }

      // A user-specified limit is honored before truncation.
      const userLimitedLines =
        params.limit === undefined
          ? undefined
          : Math.min(startLine + params.limit, totalFileLines) - startLine;

      let outputText;
      if (truncation.firstLineExceedsLimit) {
        // First line alone exceeds the byte limit. Point the model at a bash fallback.
        outputText = `[Line ${startLineDisplay} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}]`;
      } else if (truncation.truncated) {
        // Truncation occurred. Build an actionable continuation notice.
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
        // User-specified limit stopped early, but the file still has more content.
        const remaining = totalFileLines - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
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

// 2. write tool (with mutation queue & aligned phrasing)
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
    return withFileMutationQueue(fullPath, async () => {
      try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, params.content, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: `Successfully wrote to ${params.path}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error writing file: ${err.message}` }],
          isError: true,
        };
      }
    });
  },
};

// 3. edit tool (CRLF preservation + fuzzy match + diff + mutation queue)
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
    return withFileMutationQueue(fullPath, async () => {
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

        const { baseContent, newContent, replacements } = applyEditsToNormalizedContent(
          normalizedOriginal,
          edits,
          params.path
        );

        // Diff only around the replacements (same content the edit was computed on), before writing.
        const editDiff = generateEditDiff(params.path, baseContent, newContent, replacements);

        // Restore line endings: untouched lines keep original line endings
        const finalContent = bom + (content === normalizedOriginal
          ? newContent
          : applyReplacementsToOriginal(content, replacements));

        await fs.writeFile(fullPath, finalContent, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${params.path}.` }],
          details: editDiff,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error editing file: ${err.message}` }],
          isError: true,
        };
      }
    });
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
      if (params.timeout * 1000 > MAX_TIMEOUT_MS) {
        return {
          content: [{ type: "text", text: `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds` }],
          isError: true,
        };
      }
    }
    const command = params.command;
    const timeoutSec = params.timeout ?? 0;

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

    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Command aborted" }], isError: true };
    }

    return new Promise((resolve) => {
      // Bounded memory: full output streams to a temp file once it outgrows the inline limits.
      const output = new OutputBuffer({ tempFilePrefix: "pi-bash" });
      let timedOut = false;
      let aborted = false;
      let timer = null;
      let settled = false;

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

      const onAbort = () => {
        aborted = true;
        killChild();
      };

      if (timeoutSec > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killChild();
        }, timeoutSec * 1000);
      }

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const onData = (data) => {
        if (!settled) {
          output.append(data);
        }
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const finish = async (statusText, emptyText, isError) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);

        output.finish();
        const snapshot = output.snapshot();
        const truncation = snapshot.truncation;
        const lastLineBytes = output.getLastLineBytes();
        await output.close().catch(() => {});

        let text = snapshot.content || emptyText;
        let details;
        if (truncation.truncated) {
          // `_meta` already carries the mirrored text, so leave the tail out of the truncation details.
          const { content: _tail, ...truncationDetails } = truncation;
          details = { truncation: truncationDetails, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes)}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }

        // Same status joining as pi's appendStatus: no leading blank lines when there is no output.
        const finalText = statusText ? (text ? `${text}\n\n${statusText}` : statusText) : text;
        resolve({
          content: [{ type: "text", text: finalText }],
          ...(details ? { details } : {}),
          isError,
        });
      };

      child.on("close", async (code, signalName) => {
        if (timedOut) {
          await finish(`Command timed out after ${timeoutSec} seconds`, "", true);
          return;
        }
        if (aborted) {
          await finish("Command aborted", "", true);
          return;
        }
        // A signal-killed shell has no exit code. Use the standard shell convention so callers
        // do not mistake the termination for a successful command.
        let resolvedCode = code;
        if (resolvedCode === null && signalName) {
          resolvedCode = 128 + (os.constants.signals[signalName] ?? 0);
        }
        if (resolvedCode === null) {
          await finish("Command terminated without an exit code", "(no output)", true);
        } else if (resolvedCode !== 0) {
          await finish(`Command exited with code ${resolvedCode}`, "(no output)", true);
        } else {
          await finish("", "(no output)", false);
        }
      });

      child.on("error", async (err) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        output.finish();
        await output.close().catch(() => {});
        resolve({
          content: [{ type: "text", text: err.message }],
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

export function extractCodemodeResult(res) {
  if (!res || !Array.isArray(res.content)) return typeof res === "string" ? res : JSON.stringify(res);
  const imageItem = res.content.find((c) => c.type === "image");
  if (imageItem) {
    const textItem = res.content.find((c) => c.type === "text");
    return {
      type: "image",
      data: imageItem.data,
      mimeType: imageItem.mimeType,
      note: textItem ? textItem.text : "",
    };
  }
  return res.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
}

// 5. codemode tool (with inputSchema + proper subtool error throwing + image support)
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
        inputSchema: t.parameters,
        execute: async (args, { signal: sbSignal }) => {
          const res = await t.execute("codemode-subcall", args, sbSignal ?? signal);
          const val = extractCodemodeResult(res);
          if (res && res.isError) {
            throw new Error(typeof val === "string" ? val : JSON.stringify(val));
          }
          return val;
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

/**
 * Map a tool result to an MCP CallToolResult. The model-facing content is unchanged;
 * result details (for example the edit diff) ride along in `_meta` for display clients
 * such as agy, which decodes `_meta` but is free to ignore unknown keys.
 */
export function toCallToolResult(result) {
  const response = {
    content: result.content,
    isError: result.isError ?? false,
  };
  if (result.details !== undefined) {
    response._meta = { "pisoul/toolDetails": result.details };
  }
  return response;
}
