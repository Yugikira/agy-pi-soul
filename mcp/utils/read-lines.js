/**
 * Line selection for the read tool, ported from pi-coding-agent.
 *
 * Streaming keeps memory independent of the file size: only the lines truncateHead can show are
 * stored, so a 1 GB single-line file is measured but never held in memory.
 */
import { open } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.js";

/**
 * Stream a local file the way fs.readFile reads it: a regular file up to its size when opened, so
 * text appended during the read is not counted and a growing file still ends; a file reporting size
 * 0 (such as /proc files) and other file types until EOF.
 */
export async function* readLocalFileChunks(filePath, { signal } = {}) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
    yield* handle.createReadStream({ end, signal, autoClose: false });
  } finally {
    await handle.close();
  }
}

/**
 * Whether a range can be streamed. Other values (fractional, negative limit) keep the whole-file path,
 * whose array slicing defines what they select, for example limit -1 as all lines but the last.
 */
export function isStreamableRange(offset, limit) {
  return (
    (offset === undefined || Number.isInteger(offset)) &&
    (limit === undefined || (Number.isInteger(limit) && limit >= 0))
  );
}

/** Select lines from a whole file in memory: for operations without createReadStream and unusual ranges. */
export function selectLinesFromBuffer(buffer, startLine, limit) {
  const allLines = buffer.toString("utf-8").split("\n");
  const endLine = limit === undefined ? undefined : Math.min(startLine + limit, allLines.length);
  const truncation = truncateHead(allLines.slice(startLine, endLine).join("\n"));
  const firstLineBytes = truncation.firstLineExceedsLimit
    ? Buffer.byteLength(allLines[startLine], "utf-8")
    : 0;
  return { totalFileLines: allLines.length, truncation, firstLineBytes };
}

/**
 * Select lines from a file read in chunks. Only lines truncateHead can show are stored; the rest are
 * counted, so memory does not grow with the file. Stops reading when the signal aborts.
 */
export async function selectLinesFromStream(chunks, startLine, limit, signal) {
  const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + limit;
  // Non-fatal UTF-8 that keeps a byte order mark decodes like Buffer.toString("utf-8").
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const storedLines = [];
  let storedBytes = 0;
  let storedPastCaps = false;
  let line = 0;
  let selectedLines = 0;
  let selectedBytes = 0;
  let firstLineBytes = 0;
  let lastLineEmpty = true;
  // The selected line being read: its text, while it is stored, and its size.
  let pieces = [];
  let lineBytes = 0;
  let lineHasText = false;

  const appendToLine = (text, start, end) => {
    lineHasText = true;
    if (!pieces) return;
    const piece = text.slice(start, end);
    // A line over the byte cap is never shown, and a first line over it is only measured: never store
    // all of a 1 GB line.
    if (lineBytes <= DEFAULT_MAX_BYTES) pieces.push(piece);
    lineBytes += Buffer.byteLength(piece, "utf-8");
  };

  const finishLine = () => {
    if (pieces) {
      if (selectedLines === 0) firstLineBytes = lineBytes;
      // Storing continues one line past the caps: truncateHead ignores a trailing empty line, so the
      // line after the cap must be there for it to decide truncation as for the full text.
      if (storedLines.length > DEFAULT_MAX_LINES || storedBytes > DEFAULT_MAX_BYTES) {
        storedPastCaps = true;
      }
      const text = pieces.join("");
      storedBytes += Buffer.byteLength(text, "utf-8") + (storedLines.length > 0 ? 1 : 0);
      storedLines.push(text);
    }
    selectedLines++;
    lastLineEmpty = !lineHasText;
    pieces = storedPastCaps ? undefined : [];
    lineBytes = 0;
    lineHasText = false;
  };

  const select = (text) => {
    let position = 0;
    // Start of the selected text in this piece, measured as a whole: the joined lines' size.
    let selectionStart = -1;
    while (true) {
      const selected = line >= startLine && line < endLine;
      if (selected && selectionStart === -1) selectionStart = position;
      const newline = text.indexOf("\n", position);
      const end = newline === -1 ? text.length : newline;
      if (selected && end > position) appendToLine(text, position, end);
      if (newline === -1) break;
      if (selected) {
        finishLine();
        if (line + 1 === endLine) {
          selectedBytes += Buffer.byteLength(text.slice(selectionStart, newline), "utf-8");
          selectionStart = -1;
        }
      }
      line++;
      position = newline + 1;
    }
    if (selectionStart !== -1) {
      selectedBytes += Buffer.byteLength(text.slice(selectionStart), "utf-8");
    }
  };

  for await (const chunk of chunks) {
    // Leaving the loop closes the stream.
    if (signal?.aborted) throw new Error("Operation aborted");
    select(decoder.decode(chunk, { stream: true }));
  }
  select(decoder.decode());
  if (line >= startLine && line < endLine) finishLine();

  const truncation = {
    ...truncateHead(storedLines.join("\n")),
    // truncateHead's counts for the joined selected lines, which drop a trailing empty line.
    totalLines: selectedBytes === 0 ? 0 : selectedLines - (lastLineEmpty ? 1 : 0),
    totalBytes: selectedBytes,
  };
  return { totalFileLines: line + 1, truncation, firstLineBytes };
}
