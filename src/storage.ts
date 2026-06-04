import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { ApiKeyEntry, KeyStore, KeyStoreConfig } from "./types.js";

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "nim-rotator-keys.json",
);
export const DEFAULT_MAX_FAILURES = 5;

function getDefaultStore(): KeyStore {
  return {
    keys: [],
    currentIndex: 0,
    rotationStrategy: "round-robin",
    updatedAt: Date.now(),
  };
}

export function resolveStorePath(config?: KeyStoreConfig): string {
  return (
    config?.storePath ??
    process.env.NIM_ROTATOR_STORE_PATH ??
    DEFAULT_STORE_PATH
  );
}

export function loadStore(config?: KeyStoreConfig): KeyStore {
  const storePath = resolveStorePath(config);
  try {
    if (existsSync(storePath)) {
      const raw = readFileSync(storePath, "utf-8");
      const data = JSON.parse(raw) as KeyStore;
      if (!data.keys || !Array.isArray(data.keys)) {
        console.warn(
          `[nim-rotator] Store at "${storePath}" has invalid keys format, using defaults`,
        );
        return getDefaultStore();
      }
      return {
        ...getDefaultStore(),
        ...data,
      };
    }
  } catch (err) {
    console.error(`[nim-rotator] Failed to load store at "${storePath}":`, err);
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
    mkdirSync(dir, { recursive: true });
  }
  store.updatedAt = Date.now();
  writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  });
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
