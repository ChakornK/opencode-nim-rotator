import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export const DEBUG_LOG_PATH =
  "/home/chakorn/.config/opencode/nim-rotator-debug.log";

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function logDebug(message: string) {
  try {
    ensureDir(DEBUG_LOG_PATH);
    const timestamp = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] ${message}\n`, {
      encoding: "utf-8",
    });
  } catch {
    // If we can't write to the file, silently ignore to avoid breaking the plugin
  }
}
