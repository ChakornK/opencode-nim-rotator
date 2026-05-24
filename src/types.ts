export interface ApiKeyEntry {
  id: string
  name: string
  key: string
  createdAt: number
  lastUsedAt?: number
  failureCount: number
  enabled: boolean
}

export interface KeyStore {
  keys: ApiKeyEntry[]
  currentIndex: number
  rotationStrategy: "round-robin" | "least-failures"
  updatedAt: number
}

export type KeyStoreConfig = {
  storePath?: string
  rotationStrategy?: "round-robin" | "least-failures"
  maxFailuresBeforeDisable?: number
}
