import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, bashTool, toCallToolResult } from "../mcp/tools.mjs";

// 1x1 transparent PNG: the only "valid image" fixture these tests need.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

function numberedLines(count) {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

test("read: a file with exactly 2000 lines and a trailing newline is not truncated", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "boundary.txt");

  try {
    await fs.writeFile(tmpFile, numberedLines(2000) + "\n", "utf-8");

    const result = await readTool.execute("call_1", { path: tmpFile });
    const text = result.content[0].text;

    assert.equal(result.isError ?? false, false);
    assert.ok(!text.includes("to continue"), "the trailing newline must not count as an extra line");
    assert.equal(text.split("\n").length, 2001); // 2000 lines + trailing newline
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read: line-limit truncation uses pi's 'Showing lines' wording", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "big.txt");

  try {
    await fs.writeFile(tmpFile, numberedLines(2500) + "\n", "utf-8");

    const text = (await readTool.execute("call_1", { path: tmpFile })).content[0].text;
    assert.ok(
      text.endsWith("[Showing lines 1-2000 of 2501. Use offset=2001 to continue.]"),
      `unexpected continuation notice: ${JSON.stringify(text.split("\n").slice(-1)[0])}`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read: limit 0 selects no lines, like pi", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "limit.txt");

  try {
    await fs.writeFile(tmpFile, numberedLines(2500) + "\n", "utf-8");

    const text = (await readTool.execute("call_1", { path: tmpFile, limit: 0 })).content[0].text;
    assert.equal(text, "\n\n[2501 more lines in file. Use offset=1 to continue.]");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read: images are detected by content, not by extension", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const fakePng = path.join(tmpDir, "not-really.png");
  const imageWithoutImageExtension = path.join(tmpDir, "picture.bin");

  try {
    await fs.writeFile(fakePng, "hello world\n", "utf-8");
    const asText = await readTool.execute("call_1", { path: fakePng });
    assert.equal(asText.content.length, 1);
    assert.equal(asText.content[0].text, "hello world\n");

    await fs.writeFile(imageWithoutImageExtension, ONE_PIXEL_PNG);
    const asImage = await readTool.execute("call_2", { path: imageWithoutImageExtension });
    assert.equal(asImage.content.length, 2);
    assert.equal(asImage.content[0].text, "Read image file [image/png]");
    assert.equal(asImage.content[1].type, "image");
    assert.equal(asImage.content[1].mimeType, "image/png");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read: oversized image returns a text note instead of an error", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "huge.png");

  try {
    const padded = Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(6 * 1024 * 1024)]);
    await fs.writeFile(tmpFile, padded);

    const result = await readTool.execute("call_1", { path: tmpFile });
    assert.equal(result.isError ?? false, false, "an oversized image is a note, not a tool error");
    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /^Read image file \[image\/png\]\n\[Image omitted: 6\.0MB exceeds the 5\.0MB inline image size limit/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("bash: tail truncation shows exactly the last 2000 lines with pi's wording", async () => {
  const result = await bashTool.execute("call_1", {
    command: "for i in $(seq 1 3000); do echo line-$i; done",
  });
  const text = result.content[0].text;

  assert.equal(result.isError ?? false, false);
  assert.ok(text.startsWith("line-1001\n"), `first shown line should be line-1001, got ${JSON.stringify(text.slice(0, 20))}`);
  assert.ok(!text.includes("line-1000\n"));
  assert.match(text, /line-3000\n\n\[Showing lines 1001-3000 of 3000\. Full output: .+\]$/);

  // The full output is available in the temp file referenced by the notice and by details.
  const fullOutputPath = result.details.fullOutputPath;
  assert.ok(fullOutputPath && text.includes(fullOutputPath));
  const full = await fs.readFile(fullOutputPath, "utf-8");
  assert.equal(full.trimEnd().split("\n").length, 3000);
});

test("bash: timeout above pi's maximum is rejected instead of overflowing setTimeout", async () => {
  const result = await bashTool.execute("call_1", { command: "echo ok", timeout: 1e9 });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Invalid timeout: maximum is 2147483.647 seconds");
});

test("bash: abort reports 'Command aborted'", async () => {
  const controller = new AbortController();
  const pending = bashTool.execute("call_1", { command: "echo start; sleep 3; echo done" }, controller.signal);
  setTimeout(() => controller.abort(), 300);

  const result = await pending;
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.endsWith("Command aborted"), result.content[0].text);
});

test("bash: truncation details ride along in _meta when mapped to an MCP result", async () => {
  const result = await bashTool.execute("call_1", {
    command: "for i in $(seq 1 3000); do echo line-$i; done",
  });

  const mapped = toCallToolResult(result);
  const details = mapped._meta["pisoul/toolDetails"];

  assert.equal(mapped.content[0].text, result.content[0].text);
  assert.equal(details.truncation.truncated, true);
  assert.equal(details.truncation.truncatedBy, "lines");
  assert.equal(details.truncation.totalLines, 3000);
  assert.ok(details.fullOutputPath);

  await fs.rm(details.fullOutputPath, { force: true });
});
