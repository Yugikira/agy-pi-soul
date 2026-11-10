import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, editTool } from "../mcp/tools.mjs";

test("P0-1: readTool returns actionable bash fallback for single line > 50KB", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "large-line.txt");

  try {
    // 60KB line
    const bigLine = "A".repeat(60 * 1024);
    await fs.writeFile(tmpFile, `${bigLine}\nsecond line\n`, "utf-8");

    const result = await readTool.execute("call_1", { path: tmpFile, offset: 1 });
    assert.equal(result.isError ?? false, false);
    const text = result.content[0].text;

    // Verify bash fallback message
    assert.match(text, /\[Line 1 is 60\.0KB, exceeds 50\.0KB limit\. Use bash: sed -n '1p'/);
    // Verify it does NOT contain the broken self-referencing offset=1 loop message
    assert.doesNotMatch(text, /Showing lines 1-0/);
    assert.doesNotMatch(text, /Use offset=1 to continue/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P0-1 continuation: multi-line truncation calculates next offset correctly", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "multiline.txt");

  try {
    // 100 lines, each 1KB
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: ${"x".repeat(1000)}`);
    await fs.writeFile(tmpFile, lines.join("\n"), "utf-8");

    const result1 = await readTool.execute("call_1", { path: tmpFile, offset: 1 });
    const text1 = result1.content[0].text;

    // Must show truncation with valid next offset > 1
    const match = text1.match(/\[Showing lines 1-(\d+) of 100 \(50\.0KB limit\)\. Use offset=(\d+) to continue\.\]/);
    assert.ok(match, "Expected truncation message matching pattern");
    const endLine = parseInt(match[1], 10);
    const nextOffset = parseInt(match[2], 10);
    assert.equal(nextOffset, endLine + 1);
    assert.ok(endLine > 1 && endLine < 100);

    // Reading with nextOffset should work and read subsequent lines
    const result2 = await readTool.execute("call_2", { path: tmpFile, offset: nextOffset });
    const text2 = result2.content[0].text;
    assert.ok(text2.includes(`Line ${nextOffset}:`));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P1-1: editTool preserves untouched line endings in mixed-line-ending files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "mixed-endings.txt");

  try {
    // line1 CRLF, line2 LF, line3 CRLF, line4 LF
    const originalContent = "line1\r\nline2\nline3\r\nline4\n";
    await fs.writeFile(tmpFile, originalContent, "utf-8");

    // Edit line 2
    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [{ oldText: "line2", newText: "line2-changed" }],
    });

    assert.equal(result.isError ?? false, false);
    const modified = await fs.readFile(tmpFile, "utf-8");

    // Expected:
    // line1 keeps \r\n
    // line2-changed gets \n (since line2 was \n)
    // line3 keeps \r\n
    // line4 keeps \n (MUST NOT be corrupted to \r\n!)
    const expected = "line1\r\nline2-changed\nline3\r\nline4\n";
    assert.equal(modified, expected);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P1-3: editTool merges legacy oldText/newText when edits array is present", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "legacy-edits.txt");

  try {
    await fs.writeFile(tmpFile, "AAA\nBBB\nCCC\n", "utf-8");

    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [{ oldText: "AAA", newText: "AAA-replaced" }],
      oldText: "BBB",
      newText: "BBB-replaced",
    });

    assert.equal(result.isError ?? false, false);
    const modified = await fs.readFile(tmpFile, "utf-8");

    assert.equal(modified, "AAA-replaced\nBBB-replaced\nCCC\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
