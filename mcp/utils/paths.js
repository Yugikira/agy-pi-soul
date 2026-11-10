import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input, options = {}) {
  if (typeof input !== "string") return "";
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces ?? true) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if ((options.stripAtPrefix ?? true) && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = normalizeWindowsShellPath(normalized);
  }
  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? homedir();
    if (normalized === "~") return home;
    if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
      return join(home, normalized.slice(2));
    }
  }
  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

export function resolvePath(input, baseDir = process.cwd(), options = {}) {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir, options);
  return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}
