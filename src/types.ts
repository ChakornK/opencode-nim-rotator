export interface ApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  lastUsedAt?: number;
  failureCount: number;
  enabled: boolean;
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
