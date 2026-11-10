import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool, writeTool, editTool, codemodeTool, validateToolArguments } from "../mcp/tools.mjs";

function setup() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-soul-test-"));
}

test("edit: error texts match pi (missing text, duplicate, empty, no change, overlap)", async () => {
  const tmpDir = await setup();
  const tmpFile = path.join(tmpDir, "a.txt");

  try {
    await fs.writeFile(tmpFile, "abc\nabc\n", "utf-8");

    const missing = await editTool.execute("c1", {
      path: tmpFile,
      edits: [{ oldText: "zzz", newText: "q" }],
    });
    assert.equal(
      missing.content[0].text,
      `Could not find the exact text in ${tmpFile}. The old text must match exactly including all whitespace and newlines.`
    );

    const missingMulti = await editTool.execute("c2", {
      path: tmpFile,
      edits: [
        { oldText: "abc", newText: "q" },
        { oldText: "zzz", newText: "q" },
      ],
    });
    assert.equal(
      missingMulti.content[0].text,
      `Found 2 occurrences of edits[0] in ${tmpFile}. Each oldText must be unique. Please provide more context to make it unique.`
    );

    const duplicate = await editTool.execute("c3", {
      path: tmpFile,
      edits: [{ oldText: "abc", newText: "q" }],
    });
    assert.equal(
      duplicate.content[0].text,
      `Found 2 occurrences of the text in ${tmpFile}. The text must be unique. Please provide more context to make it unique.`
    );

    const empty = await editTool.execute("c4", {
      path: tmpFile,
      edits: [{ oldText: "", newText: "q" }],
    });
    assert.equal(empty.content[0].text, `oldText must not be empty in ${tmpFile}.`);

    await fs.writeFile(tmpFile, "xyz\n", "utf-8");
    const noChange = await editTool.execute("c5", {
      path: tmpFile,
      edits: [{ oldText: "xyz", newText: "xyz" }],
    });
    assert.equal(
      noChange.content[0].text,
      `No changes made to ${tmpFile}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    );

    await fs.writeFile(tmpFile, "abab\n", "utf-8");
    const overlap = await editTool.execute("c6", {
      path: tmpFile,
      edits: [
        { oldText: "a", newText: "A" },
        { oldText: "a", newText: "B" },
      ],
    });
    assert.equal(
      overlap.content[0].text,
      `Found 2 occurrences of edits[0] in ${tmpFile}. Each oldText must be unique. Please provide more context to make it unique.`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("edit: invalid input and missing files use pi's messages", async () => {
  const tmpDir = await setup();
  const tmpFile = path.join(tmpDir, "missing.txt");

  try {
    const empty = await editTool.execute("c1", { path: tmpFile, edits: [] });
    assert.equal(empty.content[0].text, "Edit tool input is invalid. edits must contain at least one replacement.");

    const noFile = await editTool.execute("c2", {
      path: tmpFile,
      edits: [{ oldText: "a", newText: "b" }],
    });
    assert.equal(noFile.content[0].text, `Could not edit file: ${tmpFile}. Error code: ENOENT.`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("read and write: filesystem errors surface raw, like pi", async () => {
  const tmpDir = await setup();
  const missing = path.join(tmpDir, "missing.txt");

  try {
    const readResult = await readTool.execute("c1", { path: missing });
    assert.equal(readResult.isError, true);
    assert.match(readResult.content[0].text, /^ENOENT: no such file or directory, access '/);

    const writeResult = await writeTool.execute("c2", { path: tmpDir, content: "x" });
    assert.equal(writeResult.isError, true);
    assert.match(writeResult.content[0].text, /^EISDIR: illegal operation on a directory, open '/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("edit: schema descriptions match pi and keep the compatibility aliases", () => {
  const { parameters } = editTool;

  assert.equal(
    parameters.properties.edits.description,
    "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead."
  );
  assert.equal(
    parameters.properties.edits.items.properties.oldText.description,
    "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
  );
  assert.ok(parameters.properties.oldText, "legacy oldText stays in the schema for compatibility");
  assert.ok(parameters.properties.newText, "legacy newText stays in the schema for compatibility");
});

test("validateToolArguments rejects missing or mistyped required arguments", () => {
  assert.equal(validateToolArguments("read", { path: "x" }), null);
  assert.equal(validateToolArguments("read", {}), "Invalid read input: 'path' must be a string.");
  assert.equal(validateToolArguments("read", undefined), "Invalid read input: 'path' must be a string.");
  assert.equal(
    validateToolArguments("write", { path: "x" }),
    "Invalid write input: 'content' must be a string."
  );
  assert.equal(
    validateToolArguments("bash", { command: 42 }),
    "Invalid bash input: 'command' must be a string."
  );
  assert.equal(
    validateToolArguments("codemode", {}),
    "Invalid codemode input: 'code' must be a string."
  );
  assert.equal(validateToolArguments("unknown", {}), null);
});

test("codemode: invalid // @options lines surface the parser message", async () => {
  const result = await codemodeTool.execute("c1", {
    code: '// @options: {"nope": 1}\nreturn 1;',
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "@options only supports `max_output_tokens` and `timeout_ms`; got `nope`");
});
