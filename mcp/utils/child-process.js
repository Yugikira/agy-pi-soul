/**
 * Child-process handling for the bash tool, ported from pi-coding-agent.
 *
 * Two things the plain `close` event gets wrong: a command that reads stdin waits forever for an EOF
 * nobody sends, and a descendant that inherits the output pipes keeps the tool open (or loses its tail
 * when the pipes are torn down on a deadline).
 */
import { spawn } from "node:child_process";
import path from "node:path";

/** How long the output pipes must stay idle after the shell exits before the tool finishes. */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr pipe open. We must
 * not resolve and destroy the streams on a fixed deadline measured from `exit`, or output still being
 * written past that deadline is silently lost (earendil-works/pi#5303). Instead, after `exit` we wait
 * for the pipes to fall idle: the grace timer is re-armed on every chunk, so an actively writing
 * descendant keeps us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 */
export function waitForChildProcess(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      // Output is still arriving after exit; defer finalizing so we don't destroy the stream mid-write
      // and truncate the tail.
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onExit = (code) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** Detached shells that are still running, so a shutting-down server can clean them up. */
const trackedDetachedChildPids = new Set();

export function trackDetachedChildPid(pid) {
  trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid) {
  trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren() {
  for (const pid of trackedDetachedChildPids) {
    killProcessTree(pid);
  }
  trackedDetachedChildPids.clear();
}

/** Kill a process and all its children (cross-platform). */
export function killProcessTree(pid) {
  if (process.platform === "win32") {
    // Use the trusted System32 executable so cleanup does not depend on PATH.
    try {
      const child = spawn(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", detached: true, windowsHide: true }
      );
      // A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
      child.once("error", () => {});
    } catch {
      // Ignore errors if taskkill fails.
    }
    return;
  }

  if (process.platform === "darwin") {
    // macOS signals group members individually after releasing the group lock. A killed child can wake
    // its waiting shell before that shell is signalled, letting `a; b` start b during cancellation
    // (#11252). Stop the group first to reduce this race; best-effort, not an atomic freeze. SIGKILL
    // also kills stopped processes.
    try {
      process.kill(-pid, "SIGSTOP");
    } catch {
      // A failed stop must not prevent the kill attempt or its single-process fallback.
    }
  }
  // The bash tool spawns its shell detached, so the group kill also reaches background children that
  // hold the output pipes.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead.
    }
  }
}
