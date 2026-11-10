import test from "node:test";
import assert from "node:assert/strict";
import { bashTool } from "../mcp/tools.mjs";

function elapsedSince(start) {
  return Math.round(performance.now() - start);
}

test("bash: a command reading stdin does not hang (stdin is ignored)", async () => {
  for (const [command, expected] of [
    // pi returns immediately with no output for both, because stdin is not an open pipe.
    ["cat", "(no output)"],
    ["read x", "(no output)\n\nCommand exited with code 1"],
  ]) {
    const started = performance.now();
    const result = await bashTool.execute("call_1", { command });
    const elapsed = elapsedSince(started);
    assert.equal(result.content[0].text, expected);
    assert.ok(elapsed < 5000, `${command} took ${elapsed}ms`);
    // No default timeout, so only the ignored stdin explains this: assert the exit status too.
    assert.equal(Boolean(result.isError), command !== "cat");
  }
});

test("bash: background children holding the output pipes do not hold the tool open", async () => {
  // The shell exits right away; a descendant keeps the inherited stdout/stderr handles open.
  // pi waits for the pipes to fall idle (100ms grace) instead of Node's `close` event.
  for (const command of ["echo started; sleep 5 & exit 0", "nohup sleep 2 & exit 0"]) {
    const started = performance.now();
    const result = await bashTool.execute("call_1", { command });
    const elapsed = elapsedSince(started);
    assert.ok(elapsed < 3000, `${command} took ${elapsed}ms`);
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, command.startsWith("echo") ? "started\n" : "(no output)");

    // A timeout smaller than the descendant's lifetime must not wait for it either: the shell already
    // exited, so the tool reports the normal result before the deadline.
    const withTimeout = await bashTool.execute("call_2", { command, timeout: 1 });
    assert.equal(withTimeout.isError, false);
    assert.equal(withTimeout.content[0].text, result.content[0].text);
  }
});

test("bash: a timeout of a live shell reports pi's message without the background note", async () => {
  const started = performance.now();
  const result = await bashTool.execute("call_1", { command: "sleep 5", timeout: 1 });
  const elapsed = elapsedSince(started);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Command timed out after 1 seconds");
  assert.ok(elapsed < 4000, `timeout returned after ${elapsed}ms`);
});

test("bash: aborting kills the shell and reports pi's message", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = performance.now();
  const result = await bashTool.execute("call_1", { command: "sleep 5" }, controller.signal);
  const elapsed = elapsedSince(started);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Command aborted");
  assert.ok(elapsed < 4000, `abort returned after ${elapsed}ms`);
});
