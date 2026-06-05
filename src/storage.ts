import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import type {
  ApiKeyEntry,
  ExportedKey,
  ExportPayload,
  KeyStore,
  KeyStoreConfig,
} from "./types.js";

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "nim-rotator-keys.json",
);
export const DEFAULT_MAX_FAILURES = 5;

const MAX_IMPORT_SIZE = 1024 * 1024;
const MAX_IMPORT_KEYS = 100;
const MAX_KEY_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const SYSTEM_PATH_PREFIXES = ["/etc/", "/proc/", "/sys/", "/dev/"];

function getDefaultStore(): KeyStore {
  return {
    keys: [],
    currentIndex: 0,
    rotationStrategy: "round-robin",
    updatedAt: Date.now(),
    lastUsedKeyId: undefined,
  };
}

export function resolveStorePath(config?: KeyStoreConfig): string {
  return (
    config?.storePath ??
    process.env.NIM_ROTATOR_STORE_PATH ??
    DEFAULT_STORE_PATH
  );
}

export function checkFilePermissions(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return "File does not exist";
    const resolvedPath = realpathSync(filePath);
    const lstat = lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
      return "File is a symbolic link. Refusing to follow symlinks.";
    }
    const stat = statSync(resolvedPath);
    const mode = stat.mode;
    const othersPerm = mode & 0o007;
    if (othersPerm !== 0) {
      return "File is world-accessible. Refusing to read from insecure file.";
    }
    const groupPerm = mode & 0o070;
    if ((groupPerm & 0o040) !== 0) {
      return "File is group-readable. Refusing to read from insecure file.";
    }
    if ((groupPerm & 0o020) !== 0) {
      return "File is group-writable. Refusing to read from insecure file.";
    }
    return null;
  } catch {
    return "Cannot verify file permissions";
  }
}

export function validateExportPath(filePath: string): string | null {
  const resolved = resolve(filePath);
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (resolved.startsWith(prefix)) {
      return "Cannot write to system directories";
    }
  }
  return null;
}

function readSecureFile(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const mode = stat.mode;
    const othersPerm = mode & 0o007;
    if (othersPerm !== 0) return null;
    const groupPerm = mode & 0o070;
    if ((groupPerm & 0o040) !== 0) return null;
    if ((groupPerm & 0o020) !== 0) return null;
    const buf = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buf, 0, stat.size, 0);
    return buf.toString("utf-8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function loadStore(config?: KeyStoreConfig): KeyStore {
  const storePath = resolveStorePath(config);
  try {
    if (existsSync(storePath)) {
      const resolvedPath = realpathSync(storePath);
      const lstat = lstatSync(storePath);
      if (lstat.isSymbolicLink()) {
        console.error(
          "[nim-rotator] SECURITY: Key store is a symlink. Refusing to load.",
        );
        return getDefaultStore();
      }
      const permError = checkFilePermissions(storePath);
      if (permError) {
        console.error(`[nim-rotator] SECURITY: ${permError}`);
        console.error(
          `[nim-rotator] Fix permissions: chmod 600 "${storePath}"`,
        );
        return getDefaultStore();
      }
      const raw = readFileSync(resolvedPath, "utf-8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || !Array.isArray(data.keys)) {
        console.warn("[nim-rotator] Store has invalid format, using defaults");
        return getDefaultStore();
      }
      return {
        keys: Array.isArray(data.keys) ? data.keys : [],
        currentIndex:
          typeof data.currentIndex === "number" ? data.currentIndex : 0,
        rotationStrategy:
          data.rotationStrategy === "least-failures"
            ? "least-failures"
            : "round-robin",
        updatedAt:
          typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
        lastUsedKeyId:
          typeof data.lastUsedKeyId === "string"
            ? data.lastUsedKeyId
            : undefined,
      };
    }
  } catch {
    console.error(
      "[nim-rotator] Failed to load key store. Check file permissions and format.",
    );
    console.warn(
      "[nim-rotator] Starting with a fresh store. Your existing keys are preserved on disk.",
    );
  }
  return getDefaultStore();
}

export function saveStore(store: KeyStore, config?: KeyStoreConfig): void {
  const storePath = resolveStorePath(config);
  const dir = dirname(storePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  store.updatedAt = Date.now();
  const tmpPath = storePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmpPath, storePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function addKey(store: KeyStore, name: string, key: string): void {
  const entry: ApiKeyEntry = {
    id: crypto.randomUUID(),
    name,
    key,
    createdAt: Date.now(),
    failureCount: 0,
    enabled: true,
  };
  store.keys.push(entry);
}

export function removeKey(store: KeyStore, id: string): void {
  const index = store.keys.findIndex((k) => k.id === id);
  if (index === -1) return;
  store.keys.splice(index, 1);
  if (store.currentIndex >= store.keys.length) {
    store.currentIndex = 0;
  }
}

export function renameKey(store: KeyStore, id: string, newName: string): void {
  const entry = store.keys.find((k) => k.id === id);
  if (entry) entry.name = newName;
}

export function toggleKey(
  store: KeyStore,
  id: string,
  enabled?: boolean,
): void {
  const entry = store.keys.find((k) => k.id === id);
  if (entry) entry.enabled = enabled ?? !entry.enabled;
}

export function getMaxFailures(config?: KeyStoreConfig): number {
  return (
    config?.maxFailuresBeforeDisable ??
    (Number(process.env.NIM_ROTATOR_MAX_FAILURES) || DEFAULT_MAX_FAILURES)
  );
}

export function getActiveKeys(
  store: KeyStore,
  config?: KeyStoreConfig,
): ApiKeyEntry[] {
  const maxFailures = getMaxFailures(config);
  return store.keys.filter((k) => k.enabled && k.failureCount < maxFailures);
}

export function getNextKey(
  store: KeyStore,
  config?: KeyStoreConfig,
): { key: ApiKeyEntry; index: number } | null {
  const active = getActiveKeys(store, config);
  if (active.length === 0) return null;

  const strategy =
    config?.rotationStrategy ?? store.rotationStrategy ?? "round-robin";

  if (strategy === "least-failures") {
    const sorted = [...active].sort((a, b) => a.failureCount - b.failureCount);
    const best = sorted[0];
    const idx = store.keys.indexOf(best);
    store.currentIndex = idx;
    store.lastUsedKeyId = best.id;
    best.lastUsedAt = Date.now();
    return { key: best, index: idx };
  }

  // round-robin
  let idx = store.currentIndex % active.length;
  const selected = active[idx];
  const realIdx = store.keys.indexOf(selected);
  store.currentIndex = (idx + 1) % active.length;
  store.lastUsedKeyId = selected.id;
  selected.lastUsedAt = Date.now();
  return { key: selected, index: realIdx };
}

export function recordFailure(store: KeyStore, keyId: string): void {
  const entry = store.keys.find((k) => k.id === keyId);
  if (entry) entry.failureCount++;
}

export function resetFailures(store: KeyStore, keyId?: string): void {
  if (keyId) {
    const entry = store.keys.find((k) => k.id === keyId);
    if (entry) entry.failureCount = 0;
  } else {
    for (const k of store.keys) k.failureCount = 0;
  }
}

export function exportKeys(store: KeyStore): ExportPayload {
  return {
    version: 1,
    exportedAt: Date.now(),
    keys: store.keys.map((k) => ({ name: k.name, key: k.key })),
  };
}

export function writeExportFile(
  payload: ExportPayload,
  filePath: string,
): void {
  const pathError = validateExportPath(filePath);
  if (pathError) throw new Error(pathError);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function readAndValidateImportFile(
  filePath: string,
): { raw: string } | { error: string } {
  const resolved = resolve(filePath);
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (resolved.startsWith(prefix)) {
      return { error: "Cannot read from system directories" };
    }
  }
  const permError = checkFilePermissions(filePath);
  if (permError) return { error: permError };

  const raw = readSecureFile(filePath);
  if (raw === null)
    return { error: "Cannot read file or file has insecure permissions" };
  return { raw };
}

export interface ImportResult {
  added: number;
  skipped: number;
  errors: string[];
  pendingKeys: ExportedKey[];
}

export function validateImportPayload(raw: string): ImportResult {
  const result: ImportResult = {
    added: 0,
    skipped: 0,
    errors: [],
    pendingKeys: [],
  };

  if (raw.length > MAX_IMPORT_SIZE) {
    result.errors.push(
      `Import file too large (max ${MAX_IMPORT_SIZE / 1024}KB)`,
    );
    return result;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    result.errors.push("Invalid JSON format");
    return result;
  }

  if (typeof data !== "object" || data === null) {
    result.errors.push("Expected a JSON object");
    return result;
  }

  const rec = data as Record<string, unknown>;
  if (rec.version !== 1) {
    result.errors.push("Unsupported export version");
    return result;
  }

  if (!Array.isArray(rec.keys)) {
    result.errors.push("Missing or invalid 'keys' array");
    return result;
  }

  for (const entry of rec.keys) {
    if (result.pendingKeys.length >= MAX_IMPORT_KEYS) {
      result.errors.push(
        `Too many keys in import file (max ${MAX_IMPORT_KEYS})`,
      );
      break;
    }

    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).name !== "string" ||
      typeof (entry as Record<string, unknown>).key !== "string"
    ) {
      result.errors.push(
        "Invalid key entry: must have 'name' and 'key' strings",
      );
      continue;
    }

    const name = ((entry as Record<string, unknown>).name as string).trim();
    const key = ((entry as Record<string, unknown>).key as string).trim();

    if (!name) {
      result.errors.push("Key entry has empty name");
      continue;
    }
    if (name.length > MAX_NAME_LENGTH) {
      result.errors.push("Key name exceeds maximum length");
      continue;
    }
    if (!key) {
      result.errors.push(`Key "${name}" has empty key value`);
      continue;
    }
    if (key.length > MAX_KEY_LENGTH) {
      result.errors.push(`Key "${name}" exceeds maximum length`);
      continue;
    }
    if (!key.startsWith("nvapi-")) {
      result.errors.push(`Key "${name}" does not start with 'nvapi-'`);
      continue;
    }

    result.pendingKeys.push({ name, key });
  }

  return result;
}

export function applyImport(
  store: KeyStore,
  pendingKeys: ExportedKey[],
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;

  for (const { name, key } of pendingKeys) {
    const existingByName = store.keys.find((k) => k.name === name);
    if (existingByName) {
      skipped++;
      continue;
    }

    const existingByKey = store.keys.find((k) => k.key === key);
    if (existingByKey) {
      skipped++;
      continue;
    }

    addKey(store, name, key);
    added++;
  }

  return { added, skipped };
}
