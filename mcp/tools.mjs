import {
  CodemodeSandbox,
  parseCodemodeSource,
  renderDeclarations,
  renderToolSample,
} from "@earendil-works/pi-codemode";
import { randomBytes } from "node:crypto";
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
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./utils/truncate.js";
import {
  isStreamableRange,
  readLocalFileChunks,
  selectLinesFromBuffer,
  selectLinesFromStream,
} from "./utils/read-lines.js";
import { detectSupportedImageMimeTypeFromFile } from "./utils/mime.js";
import { OutputBuffer } from "./utils/output-buffer.js";

export const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES; // 50KB
export const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Output limit of `structuredContent.output`, which codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

export { resolvePath, normalizePath, withFileMutationQueue };

/** Throw when the caller aborted, so long operations can stop between filesystem steps. */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

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
  // Mirrors pi's read output: programmatic callers (codemode scripts) get the text, or an image block.
  outputSchema: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        required: ["type", "data", "mimeType", "note"],
        properties: {
          type: { type: "string", const: "image" },
          data: { type: "string" },
          mimeType: { type: "string" },
          note: { type: "string" },
        },
      },
    ],
  },
  async execute(_id, params, signal) {
    const fullPath = resolvePath(params.path);
    try {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      // Same preflight as pi: a missing or unreadable file reports the raw fs error.
      await fs.access(fullPath, fsSync.constants.R_OK);
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
          const note =
            `Read image file [${imageMimeType}]\n` +
            `[Image omitted: ${formatSize(stat.size)} exceeds the ${formatSize(MAX_IMAGE_BYTES)} inline image size limit. Use bash to inspect or convert it.]`;
          return {
            content: [{ type: "text", text: note }],
            structuredContent: note,
          };
        }
        const buffer = await fs.readFile(fullPath);
        const note = `Read image file [${imageMimeType}]`;
        const data = buffer.toString("base64");
        return {
          content: [
            {
              type: "text",
              text: note,
            },
            {
              type: "image",
              data,
              mimeType: imageMimeType,
            },
          ],
          structuredContent: { type: "image", data, mimeType: imageMimeType, note },
        };
      }

      // Convert offset from 1-indexed input to 0-indexed line access, like pi.
      const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      // Stream normal ranges so memory stays flat; fractional/negative ranges keep pi's buffer slicing.
      const { totalFileLines, truncation, firstLineBytes } = isStreamableRange(params.offset, params.limit)
        ? await selectLinesFromStream(
            readLocalFileChunks(fullPath, { signal }),
            startLine,
            params.limit,
            signal
          )
        : selectLinesFromBuffer(await fs.readFile(fullPath), startLine, params.limit);

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
        structuredContent: outputText,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
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
  async execute(_id, params, signal) {
    const fullPath = resolvePath(params.path);
    return withFileMutationQueue(fullPath, async () => {
      try {
        // Check the signal instead of rejecting from an abort listener: the queue must stay locked
        // until the in-flight filesystem operation has settled.
        throwIfAborted(signal);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        throwIfAborted(signal);
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
          content: [{ type: "text", text: err.message }],
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
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        items: {
          type: "object",
          required: ["oldText", "newText"],
          properties: {
            oldText: {
              type: "string",
              description:
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            },
            newText: {
              type: "string",
              description: "Replacement text for this targeted edit.",
            },
          },
        },
      },
      // Compatibility aliases for models that send one edit instead of an edits array.
      oldText: {
        type: "string",
        description: "Exact text to find (compatibility alias for a single edit, use edits instead)",
      },
      newText: {
        type: "string",
        description: "Replacement text (compatibility alias for a single edit, use edits instead)",
      },
    },
  },
  async execute(_id, params, signal) {
    const fullPath = resolvePath(params.path);
    return withFileMutationQueue(fullPath, async () => {
      try {
        throwIfAborted(signal);
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
            content: [
              {
                type: "text",
                text: "Edit tool input is invalid. edits must contain at least one replacement.",
              },
            ],
            isError: true,
          };
        }

        // Same preflight as pi: report a missing or read-only file before reading, with the error code.
        try {
          await fs.access(fullPath, fsSync.constants.R_OK | fsSync.constants.W_OK);
        } catch (error) {
          const errorMessage =
            error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
          throw new Error(`Could not edit file: ${params.path}. ${errorMessage}.`);
        }
        throwIfAborted(signal);

        const rawContent = await fs.readFile(fullPath, "utf-8");
        throwIfAborted(signal);
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
        throwIfAborted(signal);
        return {
          content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${params.path}.` }],
          details: editDiff,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: err.message }],
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
  // Mirrors pi's bash output: codemode scripts get the exit code and the (up to 1MB) full output.
  outputSchema: {
    type: "object",
    required: ["output", "truncated", "exit_code", "wall_time_seconds"],
    properties: {
      output: { type: "string", description: "Combined stdout and stderr, possibly truncated" },
      truncated: { type: "boolean" },
      full_output_path: { type: "string", description: "Full output, when truncated" },
      exit_code: { type: "number" },
      wall_time_seconds: { type: "number" },
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
      const startedAt = performance.now();
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

      const finish = async (statusText, emptyText, isError, exit) => {
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

        // The value a codemode script receives: like pi, only for a normal exit (timeouts and
        // aborts reject there, so they must not resolve to a value here either).
        let structuredContent;
        if (exit) {
          const fullOutput = await output
            .readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES)
            .catch(() => ({ content: "", truncated: false }));
          structuredContent = {
            output: fullOutput.content,
            truncated: fullOutput.truncated,
            ...(fullOutput.truncated && snapshot.fullOutputPath
              ? { full_output_path: snapshot.fullOutputPath }
              : {}),
            exit_code: exit.exitCode,
            wall_time_seconds: exit.wallTimeSeconds,
          };
        }

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
          ...(structuredContent ? { structuredContent } : {}),
          isError,
        });
      };

      child.on("close", async (code, signalName) => {
        const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
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
        const resolvedCode = code ?? (signalName ? 128 + (os.constants.signals[signalName] ?? 0) : 1);
        const isError = resolvedCode !== 0;
        await finish(isError ? `Command exited with code ${resolvedCode}` : "", "(no output)", isError, {
          exitCode: resolvedCode,
          wallTimeSeconds,
        });
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

// 5. codemode tool (pi-compatible: declared tools, outputSchema values, // @options, bounded output)

const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const CODEMODE_DEFAULT_TIMEOUT_MS = 300_000;
const CODEMODE_DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CODEMODE_CHARS_PER_TOKEN = 4;

const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** `description` + signature, the shape pi uses for sandbox tool descriptions and ALL_TOOLS. */
function codemodeToolSample(tool) {
  return renderToolSample({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: tool.outputSchema,
  });
}

const CODEMODE_TOOL_DECLARATIONS = renderDeclarations({
  tools: Object.values(piTools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: tool.outputSchema,
  })),
});

/** Like the script's `text()`: strings as is, other values as JSON. */
function valueText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}
/**
 * Lay out the script's output so the model can tell items apart. With more than one text item
 * (`text()` or the returned value), each starts with a `==> text N/M <==` line. `console.*` lines
 * follow all other output in one `<console_output>` block.
 */
function formatCodemodeOutput(output) {
  const total = output.filter((item) => item.type === "text" && !item.console).length;
  const items = [];
  const consoleLines = [];
  let index = 0;
  for (const item of output) {
    if (item.type === "image") {
      items.push(item);
    } else if (item.console) {
      consoleLines.push(item.text);
    } else {
      index++;
      items.push({
        type: "text",
        text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text,
      });
    }
  }
  if (consoleLines.length > 0) {
    items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
  }
  return items;
}
/** Join adjacent text items into one, each part starting on its own line. */
function joinAdjacentText(items) {
  const joined = [];
  let parts = [];
  let lastPart = "";
  const flush = () => {
    if (parts.length > 0) joined.push({ type: "text", text: parts.join("") });
    parts = [];
    lastPart = "";
  };
  for (const item of items) {
    if (item.type !== "text") {
      flush();
      joined.push(item);
      continue;
    }
    if (lastPart !== "" && !lastPart.endsWith("\n")) {
      parts.push("\n");
      lastPart = "\n";
    }
    parts.push(item.text);
    if (item.text !== "") lastPart = item.text;
  }
  flush();
  return joined;
}
function formatCallSummary(calls) {
  if (calls.length === 0) return "No tool calls were made.";
  return `Tool calls made before the failure (they are not undone): ${calls
    .map((call) => `${call.name} (${call.status})`)
    .join(", ")}`;
}
function formatCodemodeError(result) {
  const { error } = result;
  const head =
    error.kind === "script"
      ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  return `${head}\n\n${formatCallSummary(result.calls ?? [])}`;
}
/** Output can carry private data, so only the user may read these files. */
async function writeOutputFile(prefix, extension, data) {
  const filePath = path.join(os.tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
  // `wx` never follows a link someone else placed at the path.
  await fs.writeFile(filePath, data, { mode: 0o600, flag: "wx" });
  return filePath;
}
/** Write the full text output to a temp file, like bash does for truncated output. */
async function spillCodemodeOutput(text) {
  try {
    return { path: await writeOutputFile("pi-codemode", ".txt", text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
/**
 * Save each image to a temp file and put a text item with its path before it: scripts cannot write
 * files, so this is how the model can reach the bytes later. Images shown more than once are saved once.
 */
async function saveCodemodeImages(items) {
  const labels = new Map();
  const label = async ({ data, mimeType }) => {
    const bytes = Buffer.from(data, "base64");
    const kind = `${mimeType}, ${formatSize(bytes.length)}`;
    const extension = IMAGE_EXTENSIONS[mimeType];
    if (!extension) {
      throw new Error(`No file extension for image type ${mimeType}`);
    }
    try {
      const filePath = await writeOutputFile("pi-codemode", extension, bytes);
      return `[Image saved to ${filePath} (${kind})]`;
    } catch (error) {
      return `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
    }
  };
  const result = await Promise.all(
    items.map(async (item) => {
      if (item.type !== "image") return [item];
      let pending = labels.get(item.data);
      if (!pending) {
        pending = label(item);
        labels.set(item.data, pending);
      }
      return [{ type: "text", text: await pending }, item];
    })
  );
  return result.flat();
}
/** Returns at most the first `maxUnits` UTF-16 code units of `text`, without splitting a surrogate pair. */
function sliceHead(text, maxUnits) {
  const end = Math.max(0, maxUnits);
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? text.slice(0, end - 1)
    : text.slice(0, end);
}
/** Returns at most the last `maxUnits` UTF-16 code units of `text`, without splitting a surrogate pair. */
function sliceTail(text, maxUnits) {
  if (maxUnits <= 0) return "";
  const start = Math.max(0, text.length - maxUnits);
  return isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
    ? text.slice(start + 1)
    : text.slice(start);
}
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}
/**
 * Apply the token budget: when the combined text exceeds it, the text items become one item that
 * keeps the start and end of the text, images follow it, and the full text is written to a temp file.
 */
async function truncateCodemodeOutput(items, maxTokens) {
  const texts = items.filter((item) => item.type === "text").map((item) => item.text);
  const combined = texts.join("\n");
  const budget = maxTokens * CODEMODE_CHARS_PER_TOKEN;
  if (texts.length === 0 || combined.length <= budget) {
    return { items };
  }
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - headChars - tailChars;
  const head = sliceHead(combined, headChars);
  const tail = sliceTail(combined, tailChars);
  let text = `Warning: truncated output (original token count: ${Math.ceil(
    combined.length / CODEMODE_CHARS_PER_TOKEN
  )})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(
    removed / CODEMODE_CHARS_PER_TOKEN
  )} tokens truncated…${tail}`;
  const spilled = await spillCodemodeOutput(combined);
  text +=
    "path" in spilled
      ? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
      : `\n\n[Could not save the full output: ${spilled.error}]`;
  return {
    items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
    ...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
  };
}

/** Fallback for results without a structured value: text blocks joined, or the image block. */
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

export const codemodeTool = {
  name: "codemode",
  description:
    "Execute a JavaScript async function body inside an isolated QuickJS sandbox with direct access to the tools below. " +
    "Nested tool calls inside codemode never bloat the LLM context—only what you pass to `text(...)`, `console.log(...)`, or `return` is returned. " +
    "Use this whenever chaining multiple searches (e.g., `rg`), reading multiple files, filtering output, or performing batch edits. " +
    "Scripts may start with an options line, e.g. `// @options: {\"max_output_tokens\": 2000, \"timeout_ms\": 30000}`. " +
    "`ALL_TOOLS` lists every nested tool.\n\n" +
    "Declared tools:\n```ts\n" +
    CODEMODE_TOOL_DECLARATIONS +
    "\n```",
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
    if (typeof params.code !== "string") {
      return {
        content: [{ type: "text", text: "Invalid codemode input: 'code' must be a string." }],
        isError: true,
      };
    }

    const startedAt = performance.now();
    let parsed;
    try {
      parsed = parseCodemodeSource(params.code);
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    const { code, options } = parsed;

    const sandbox = new CodemodeSandbox({
      timeoutMs: options.timeoutMs ?? CODEMODE_DEFAULT_TIMEOUT_MS,
      memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
      tools: Object.values(piTools).map((tool) => ({
        name: tool.name,
        description: codemodeToolSample(tool),
        inputSchema: tool.parameters,
        outputSchema: tool.outputSchema,
        execute: async (args, { signal: callSignal }) => {
          const res = await tool.execute("codemode-subcall", args, callSignal ?? signal);
          // Like pi: a tool that declares an output schema resolves to its structured value, also
          // for error results that carry one (such as a non-zero bash exit code).
          if (tool.outputSchema && res.structuredContent !== undefined) {
            return res.structuredContent;
          }
          const value = extractCodemodeResult(res);
          if (res.isError) {
            throw new Error(typeof value === "string" ? value : JSON.stringify(value));
          }
          return value;
        },
      })),
    });

    let result;
    try {
      result = await sandbox.execute(code, { signal });
    } finally {
      await sandbox.close();
    }

    // Calls still marked running were cut off by the script ending, a timeout, or an abort.
    for (const call of result.calls ?? []) {
      if (call.status === "running") call.status = "cancelled";
    }

    const scriptOutput = [...result.output];
    if (result.ok && result.value !== undefined) {
      scriptOutput.push({ type: "text", text: valueText(result.value) });
    }
    const items = formatCodemodeOutput(scriptOutput);
    if (!result.ok) {
      items.push({ type: "text", text: `Script error:\n${formatCodemodeError(result)}` });
    }

    const truncated = await truncateCodemodeOutput(
      joinAdjacentText(items),
      options.maxOutputTokens ?? CODEMODE_DEFAULT_MAX_OUTPUT_TOKENS
    );
    // After truncation, which moves images after the text, so each saved path stays next to its image.
    const output = joinAdjacentText(await saveCodemodeImages(truncated.items));
    const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
    const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;

    return {
      content: [{ type: "text", text: header }, ...output],
      ...(truncated.fullOutputPath ? { details: { fullOutputPath: truncated.fullOutputPath } } : {}),
      ...(result.ok ? {} : { isError: true }),
    };
  },
};

export const allTools = { ...piTools, codemode: codemodeTool };

const REQUIRED_TOOL_ARGUMENTS = {
  read: { path: "string" },
  write: { path: "string", content: "string" },
  edit: { path: "string" },
  bash: { command: "string" },
  codemode: { code: "string" },
};

/**
 * pi validates tool input in its agent loop; an MCP client is not required to. Without this,
 * a missing argument reaches `resolvePath` or `spawn` as `undefined` and produces confusing
 * filesystem or shell errors, so check the required fields here instead.
 */
export function validateToolArguments(toolName, args) {
  const required = REQUIRED_TOOL_ARGUMENTS[toolName];
  if (!required) {
    return null;
  }
  const value = args && typeof args === "object" ? args : {};
  for (const [field, type] of Object.entries(required)) {
    if (typeof value[field] !== type) {
      return `Invalid ${toolName} input: '${field}' must be a ${type}.`;
    }
  }
  return null;
}

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
