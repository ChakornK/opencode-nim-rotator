export interface ModelBlacklistEntry {
  blacklistedUntil: number;
  nextDurationMs: number;
}

export interface ApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  lastUsedAt?: number;
  failureCount: number;
  rateLimitCount: number;
  enabled: boolean;
  modelBlacklist?: { [modelId: string]: ModelBlacklistEntry };
}

export interface FallbackModel {
  id: string;
  name: string;
  benchmarkTtfb?: number;
  benchmarkTps?: number;
  benchmarkStatus?: "idle" | "running" | "done" | "error";
  benchmarkError?: string;
}

export interface KeyStore {
  keys: ApiKeyEntry[];
  currentIndex: number;
  rotationStrategy: "round-robin" | "least-failures";
  updatedAt: number;
  lastUsedKeyId?: string;
  fallbackChain: FallbackModel[];
  maxRateLimitFailures: number;
}

export interface ExportedKey {
  name: string;
  key: string;
}

export interface ExportPayload {
  version: 1;
  exportedAt: number;
  keys: ExportedKey[];
}

export type KeyStoreConfig = {
  storePath?: string;
  rotationStrategy?: "round-robin" | "least-failures";
  maxFailuresBeforeDisable?: number;
};
