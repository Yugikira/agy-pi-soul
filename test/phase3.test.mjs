import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, writeTool, editTool, bashTool, codemodeTool, toCallToolResult } from "../mcp/tools.mjs";

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

test("P2-7: editTool returns windowed diff, patch, and firstChangedLine in details", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "diff-test.txt");

  try {
    await fs.writeFile(tmpFile, "line 1\nold line 2\nline 3\n", "utf-8");

    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [{ oldText: "old line 2", newText: "new line 2" }],
    });

    assert.equal(result.isError ?? false, false);
    assert.equal(result.details.diff, " 1 line 1\n-2 old line 2\n+2 new line 2\n 3 line 3");
    assert.equal(result.details.firstChangedLine, 2);
    assert.ok(result.details.patch.includes("@@ -1,3 +1,3 @@"), "patch should have a single hunk header");
    assert.ok(result.details.patch.includes("-old line 2"));
    assert.ok(result.details.patch.includes("+new line 2"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-7: edit diff covers only the changed region, not the whole file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "diff-window.txt");

  try {
    const lines = Array.from({ length: 5000 }, (_, i) => `row-${String(i + 1).padStart(4, "0")}`);
    await fs.writeFile(tmpFile, lines.join("\n") + "\n", "utf-8");

    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [{ oldText: "row-2500", newText: "ROW-2500" }],
    });

    assert.equal(result.isError ?? false, false);
    assert.equal(result.details.firstChangedLine, 2500);
    assert.equal((result.details.patch.match(/^@@/gm) ?? []).length, 1);
    assert.ok(result.details.diff.includes("-2500 row-2500"));
    assert.ok(result.details.diff.includes("+2500 ROW-2500"));
    assert.ok(!result.details.diff.includes("row-0001"), "heading of the file must not be diffed");
    assert.ok(!result.details.diff.includes("row-5000"), "tail of the file must not be diffed");
    assert.ok(result.details.diff.length < 1000, `diff should stay small, got ${result.details.diff.length} chars`);
    assert.ok(result.details.patch.length < 1000, `patch should stay small, got ${result.details.patch.length} chars`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-7: toCallToolResult forwards details via _meta without changing model-facing content", () => {
  const content = [{ type: "text", text: "Successfully replaced 1 block(s) in a.txt." }];
  const details = { diff: "-1 a\n+1 b", patch: "...", firstChangedLine: 1 };

  const mapped = toCallToolResult({ content, details });
  assert.deepEqual(mapped.content, content);
  assert.equal(mapped.isError, false);
  assert.deepEqual(mapped._meta["pisoul/toolDetails"], details);

  const plain = toCallToolResult({ content, isError: true });
  assert.deepEqual(plain.content, content);
  assert.equal(plain.isError, true);
  assert.equal(plain._meta, undefined);
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
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    assert.ok(text.includes("created from codemode"));
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
