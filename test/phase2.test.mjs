import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, editTool, bashTool, resolvePath, findBash } from "../mcp/tools.mjs";

test("P1-2: editTool performs fuzzy matching for trailing whitespace and smart quotes/dashes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "fuzzy.txt");

  try {
    // Original file with straight quotes, normal dash, normal spaces
    const original = 'const msg = "hello-world";  \nconst next = \'ok\';\n';
    await fs.writeFile(tmpFile, original, "utf-8");

    // Edit using smart quotes, Unicode em-dash, and different trailing whitespace
    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [
        {
          oldText: "const msg = “hello—world”;\n", // smart quotes + em-dash + trimmed line end
          newText: "const msg = \"hello-fixed\";\n",
        },
      ],
    });

    assert.equal(result.isError ?? false, false);
    const modified = await fs.readFile(tmpFile, "utf-8");
    assert.equal(modified, 'const msg = "hello-fixed";\nconst next = \'ok\';\n');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P1-2: editTool handles special spaces (NBSP) in fuzzy match", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "fuzzy-spaces.txt");

  try {
    const original = "let total = a + b;\n";
    await fs.writeFile(tmpFile, original, "utf-8");

    // User provides NBSP (\u00A0) instead of normal space
    const result = await editTool.execute("call_1", {
      path: tmpFile,
      edits: [
        {
          oldText: "let\u00A0total = a + b;\n",
          newText: "let total = a * b;\n",
        },
      ],
    });

    assert.equal(result.isError ?? false, false);
    const modified = await fs.readFile(tmpFile, "utf-8");
    assert.equal(modified, "let total = a * b;\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P1-4: readTool returns text note with image and blocks oversized images", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const imgFile = path.join(tmpDir, "test.png");
  const bigImgFile = path.join(tmpDir, "huge.png");

  try {
    // Normal small image
    const smallBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(imgFile, smallBuffer);

    const result = await readTool.execute("call_1", { path: imgFile });
    assert.equal(result.isError ?? false, false);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, "Read image file [image/png]");
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].mimeType, "image/png");

    // Oversized image (6MB > 5MB limit)
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024);
    await fs.writeFile(bigImgFile, bigBuffer);

    const bigResult = await readTool.execute("call_2", { path: bigImgFile });
    assert.equal(bigResult.isError, true);
    assert.equal(bigResult.content.length, 1);
    assert.match(bigResult.content[0].text, /exceeds the 5\.0MB limit/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("P2-1: resolvePath handles ~, @ prefix, and Windows shell paths", () => {
  const home = os.homedir();
  assert.equal(resolvePath("~/foo/bar.txt"), path.join(home, "foo/bar.txt"));
  assert.equal(resolvePath("@src/utils.js"), path.resolve(process.cwd(), "src/utils.js"));

  if (process.platform === "win32") {
    assert.equal(resolvePath("/c/Windows"), "C:\\Windows");
    assert.equal(resolvePath("/d/projects/repo"), "D:\\projects\\repo");
  }
});

test("P2-3: findBash resolves a working bash executable", () => {
  const bash = findBash();
  assert.ok(bash, "findBash should find bash on system");
  assert.ok(typeof bash === "string" && bash.length > 0);
});

test("P2-4: bashTool validates timeout parameters and rejects invalid values", async () => {
  const resNegative = await bashTool.execute("call_1", { command: "echo ok", timeout: -5 });
  assert.equal(resNegative.isError, true);
  assert.equal(resNegative.content[0].text, "Invalid timeout: must be a finite number of seconds");

  const resZero = await bashTool.execute("call_2", { command: "echo ok", timeout: 0 });
  assert.equal(resZero.isError, true);
  assert.equal(resZero.content[0].text, "Invalid timeout: must be a finite number of seconds");

  const resNaN = await bashTool.execute("call_3", { command: "echo ok", timeout: "abc" });
  assert.equal(resNaN.isError, true);
  assert.equal(resNaN.content[0].text, "Invalid timeout: must be a finite number of seconds");
});
