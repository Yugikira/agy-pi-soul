/**
 * Incremental, memory-bounded command output buffer, ported from pi-coding-agent's
 * OutputAccumulator (the parts the bash tool needs).
 *
 * The full output is streamed to a temp file once it outgrows the inline limits, while
 * only a rolling tail is kept in memory for the display snapshot. Decoding is streamed
 * so multi-byte UTF-8 characters split across chunks are not corrupted.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.js";

/** Output can carry private data, so only the user may read the file. */
const OUTPUT_FILE_MODE = 0o600;

function byteLength(text) {
  return Buffer.byteLength(text, "utf-8");
}

export class OutputBuffer {
  constructor({ maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES, tempFilePrefix = "pi-output" } = {}) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.maxRollingBytes = Math.max(maxBytes * 2, 1);
    this.tempFilePrefix = tempFilePrefix;
    this.decoder = new TextDecoder();
    this.rawChunks = [];
    this.tailText = "";
    this.tailBytes = 0;
    this.tailStartsAtLineBoundary = true;
    this.totalRawBytes = 0;
    this.totalDecodedBytes = 0;
    this.completedLines = 0;
    this.totalLines = 0;
    this.currentLineBytes = 0;
    this.hasOpenLine = false;
    this.finished = false;
    this.tempFilePath = undefined;
    this.tempFileStream = undefined;
  }

  append(data) {
    if (this.finished) {
      throw new Error("Cannot append to a finished output buffer");
    }
    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
  }

  snapshot() {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;
    const truncation = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  async close() {
    if (!this.tempFileStream) {
      return;
    }
    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  /** Bytes of the line being written, for the "line is X" truncation hint. */
  getLastLineBytes() {
    return this.currentLineBytes;
  }

  appendDecodedText(text) {
    if (text.length === 0) {
      return;
    }
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.trimTail();
    }
    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  trimTail() {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++;
    }
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  getSnapshotText() {
    if (this.tailStartsAtLineBoundary) {
      return this.tailText;
    }
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  shouldUseTempFile() {
    return (
      this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes ||
      this.totalLines > this.maxLines
    );
  }

  ensureTempFile() {
    if (this.tempFilePath) {
      return;
    }
    this.tempFilePath = join(
      tmpdir(),
      `${this.tempFilePrefix}-${randomBytes(8).toString("hex")}.log`
    );
    // `wx` never follows a link someone else placed at the path.
    this.tempFileStream = createWriteStream(this.tempFilePath, {
      mode: OUTPUT_FILE_MODE,
      flags: "wx",
    });
    // A failed write (disk full, unwritable temp dir) must not lose the command output.
    this.tempFileStream.on("error", () => {});
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk);
    }
    this.rawChunks = [];
  }
}
