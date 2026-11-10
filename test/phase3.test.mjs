import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, writeTool, editTool, bashTool, codemodeTool } from "../mcp/tools.mjs";

test("P2-2: readTool preserves CRLF line endings from the original file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "crlf.txt");

  try {
    const crlfContent = "line1\r\nline2\r\nline3\r\n";
    await fs.writeFile(tmpFile, crlfContent, "utf-8");

    const result = await readTool.execute("call_1", { path: tmpFile });
    assert.equal(result.isError ?? false, false);
    // Must contain \r\n
    assert.ok(result.content[0].text.includes("\r\n"), "readTool output should retain CRLF");
    assert.equal(result.content[0].text, crlfContent);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-6: writeTool and editTool serialize mutations on the same file via mutation queue", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "concurrent.txt");

  try {
    await fs.writeFile(tmpFile, "Initial content\n", "utf-8");

    // Launch multiple concurrent writes
    const writes = Array.from({ length: 5 }, (_, i) =>
      writeTool.execute(`call_${i}`, { path: tmpFile, content: `Content ${i}\n` })
    );

    const results = await Promise.all(writes);
    for (const r of results) {
      assert.equal(r.isError ?? false, false);
    }

    const finalContent = await fs.readFile(tmpFile, "utf-8");
    // Final content should cleanly match the last completed write without corruption
    assert.match(finalContent, /Content \d\n/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-7: editTool returns unified diff in details", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "diff-test.txt");

  try {
    await fs.writeFile(tmpFile, "line 1\nold line 2\nline 3\n", "utf-8");

    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [{ oldText: "old line 2", newText: "new line 2" }],
    });

    assert.equal(result.isError ?? false, false);
    assert.ok(result.details?.diff, "editTool should return details.diff");
    assert.ok(result.details.diff.includes("-old line 2"));
    assert.ok(result.details.diff.includes("+new line 2"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-8: codemode sandbox executes subcalls and respects declarations", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "codemode-test.txt");

  try {
    const code = `
      await tools.write({ path: ${JSON.stringify(tmpFile)}, content: "created from codemode" });
      const readBack = await tools.read({ path: ${JSON.stringify(tmpFile)} });
      return readBack;
    `;

    const result = await codemodeTool.execute("call_1", { code });
    assert.equal(result.isError ?? false, false);
    assert.ok(result.content[0].text.includes("created from codemode"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-9: wording alignment with pi built-in tools", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "wording.txt");

  try {
    // 1. writeTool: "Successfully wrote to <path>"
    const writeRes = await writeTool.execute("call_1", { path: tmpFile, content: "hello\n" });
    assert.equal(writeRes.content[0].text, `Successfully wrote to ${tmpFile}`);

    // 2. editTool: "Successfully replaced 1 block(s) in <path>."
    const editRes = await editTool.execute("call_2", {
      path: tmpFile,
      edits: [{ oldText: "hello", newText: "world" }],
    });
    assert.equal(editRes.content[0].text, `Successfully replaced 1 block(s) in ${tmpFile}.`);

    // 3. bashTool: "(no output)" when command produces no stdout/stderr
    const bashRes = await bashTool.execute("call_3", { command: "true" });
    assert.equal(bashRes.content[0].text, "(no output)");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
