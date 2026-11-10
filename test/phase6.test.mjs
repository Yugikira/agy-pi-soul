import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, writeTool, editTool } from "../mcp/tools.mjs";

function numberedLines(count) {
  return Array.from({ length: count }, (_, i) => `line ${i + 1} ${"pad".repeat(10)}`).join("\n");
}

test("read: streaming a large file selects the same lines as the in-memory path", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "large.txt");
  const total = 200_000;

  try {
    await fs.writeFile(tmpFile, numberedLines(total) + "\n", "utf-8");

    // Integer range -> streamed path (a user limit before the end adds pi's continuation notice).
    const streamed = await readTool.execute("call_1", { path: tmpFile, offset: 123_456, limit: 3 });
    assert.equal(
      streamed.content[0].text,
      `line 123456 ${"pad".repeat(10)}\nline 123457 ${"pad".repeat(10)}\nline 123458 ${"pad".repeat(10)}\n\n[76543 more lines in file. Use offset=123459 to continue.]`
    );

    // Fractional limit -> pi keeps the whole-file path; both must agree on a plain prefix.
    const buffered = await readTool.execute("call_2", { path: tmpFile, offset: 1, limit: 2.5 });
    assert.ok(buffered.content[0].text.startsWith("line 1 "), buffered.content[0].text.slice(0, 40));

    // Whole-file read still truncates with pi's wording and the real total (bytes hit first here).
    const whole = await readTool.execute("call_3", { path: tmpFile });
    const lastLine = whole.content[0].text.split("\n").slice(-1)[0];
    const notice = lastLine.match(
      /^\[Showing lines 1-(\d+) of 200001 \(50\.0KB limit\)\. Use offset=(\d+) to continue\.\]$/
    );
    assert.ok(notice, lastLine);
    assert.equal(Number(notice[2]), Number(notice[1]) + 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read: a very long single line is measured without being stored", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "one-line.txt");

  try {
    // 20MB on one line, written in chunks so the test itself stays cheap.
    const handle = await fs.open(tmpFile, "w");
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) await handle.write(chunk);
    await handle.close();

    const result = await readTool.execute("call_1", { path: tmpFile });
    assert.match(
      result.content[0].text,
      /^\[Line 1 is 20\.0MB, exceeds 50\.0KB limit\. Use bash: sed -n '1p' .+ \| head -c 51200\]$/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("aborted signals stop read, write, and edit with pi's message", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "abort.txt");

  try {
    await fs.writeFile(tmpFile, "hello\n", "utf-8");
    const controller = new AbortController();
    controller.abort();

    const readResult = await readTool.execute("call_1", { path: tmpFile }, controller.signal);
    assert.equal(readResult.isError, true);
    assert.equal(readResult.content[0].text, "Operation aborted");

    const writeResult = await writeTool.execute(
      "call_2",
      { path: tmpFile, content: "changed\n" },
      controller.signal
    );
    assert.equal(writeResult.isError, true);
    assert.equal(writeResult.content[0].text, "Operation aborted");
    assert.equal(await fs.readFile(tmpFile, "utf-8"), "hello\n");

    const editResult = await editTool.execute(
      "call_3",
      { path: tmpFile, edits: [{ oldText: "hello", newText: "bye" }] },
      controller.signal
    );
    assert.equal(editResult.isError, true);
    assert.equal(editResult.content[0].text, "Operation aborted");
    assert.equal(await fs.readFile(tmpFile, "utf-8"), "hello\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
