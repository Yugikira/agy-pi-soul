import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { codemodeTool } from "../mcp/tools.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

function textOf(result) {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

test("codemode: tool description declares the nested tools with signatures", () => {
  const description = codemodeTool.description;

  assert.match(description, /declare const tools: \{/);
  assert.match(description, /read\(args: \{/);
  assert.match(description, /read\(args: \{[\s\S]*?\): Promise<string \|/);
  assert.match(description, /bash\(args: \{/);
  assert.match(description, /exit_code: number/);
  assert.match(description, /@options/);
});

test("codemode: a non-zero bash exit resolves to the structured value instead of throwing", async () => {
  const result = await codemodeTool.execute("call_1", {
    code: 'const r = await tools.bash({ command: "echo out; exit 3" }); return { exit_code: r.exit_code, output: r.output };',
  });

  assert.equal(result.isError ?? false, false);
  assert.match(textOf(result), /"exit_code":3/);
  assert.match(textOf(result), /"output":"out\\n"/);
});

test("codemode: bash structured output is not limited by the 50KB display cap", async () => {
  const result = await codemodeTool.execute("call_1", {
    code: 'const r = await tools.bash({ command: "seq 1 50000" }); return r.output.length;',
  });

  assert.equal(result.isError ?? false, false);
  const reported = Number(textOf(result).trim().split("\n").slice(-1)[0]);
  assert.ok(reported > 50 * 1024, `structured output should exceed the display cap, got ${reported}`);
});

test("codemode: returned values and console output are laid out like pi", async () => {
  const result = await codemodeTool.execute("call_1", {
    code: 'console.log("from console"); text("first"); return "second";',
  });

  const text = textOf(result);
  assert.match(text, /^Script completed\nWall time [\d.]+ seconds\nOutput:\n/);
  assert.match(text, /==> text 1\/2 <==\nfirst/);
  assert.match(text, /==> text 2\/2 <==\nsecond/);
  assert.match(text, /<console_output>\nfrom console\n<\/console_output>/);
});

test("codemode: script errors are reported with the tool calls made before the failure", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "boom.txt");

  try {
    await fs.writeFile(tmpFile, "hello\n");

    const result = await codemodeTool.execute("call_1", {
      code: `await tools.read({ path: ${JSON.stringify(tmpFile)} }); throw new Error("boom");`,
    });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /^Script failed\n/);
    assert.match(text, /Script error:\nError: boom/);
    assert.match(text, /Tool calls made before the failure \(they are not undone\): read \(ok\)/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("codemode: the // @options line sets the script deadline", async () => {
  const startedAt = Date.now();
  const result = await codemodeTool.execute("call_1", {
    code: '// @options: {"timeout_ms": 200}\nwhile (true) {}',
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Script timed out/);
  assert.ok(Date.now() - startedAt < 10_000, "the script must stop at its own deadline");
});

test("codemode: aborting the call stops the script", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);

  const result = await codemodeTool.execute("call_1", { code: "while (true) {}" }, controller.signal);

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Script aborted/);
});

test("codemode: image results are passed through and saved to a temp file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
  const tmpFile = path.join(tmpDir, "one.png");

  try {
    await fs.writeFile(tmpFile, ONE_PIXEL_PNG);

    const result = await codemodeTool.execute("call_1", {
      code: `const r = await tools.read({ path: ${JSON.stringify(tmpFile)} }); image(r); return r.mimeType;`,
    });

    assert.equal(result.isError ?? false, false);
    assert.ok(result.content.some((block) => block.type === "image"));
    const saved = result.content.find(
      (block) => block.type === "text" && block.text.includes("[Image saved to")
    );
    assert.ok(saved, "a saved path label should precede the image");

    const savedPath = saved.text.match(/\[Image saved to (.+?) \(/)[1];
    await fs.rm(savedPath, { force: true });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
