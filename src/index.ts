import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import {
  loadStore,
  saveStore,
  addKey,
  getNextKey,
  recordFailure,
  getActiveKeys,
} from "./storage.js";
import type { KeyStore, KeyStoreConfig } from "./types.js";

const PROVIDER_ID = "nvidia";
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;

function isValidStrategy(
  val: unknown,
): val is KeyStoreConfig["rotationStrategy"] {
  return val === "round-robin" || val === "least-failures";
}

function isRecoverableError(obj: unknown): boolean {
  if (typeof obj === "object" && obj !== null) {
    const rec = obj as Record<string, unknown>;
    const name = rec.name;
    if (name === "ProviderAuthError") return true;
    if (name === "APIError") {
      const data = rec.data as Record<string, unknown> | undefined;
      const statusCode = data?.statusCode;
      if (statusCode === 401 || statusCode === 403 || statusCode === 429)
        return true;
    }
  }
  const msg = String(obj).toLowerCase();
  return (
    /\b401\b/.test(msg) ||
    /\b403\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    msg.includes("unauthorized") ||
    msg.includes("rate limit")
  );
}

export const NvidiaNimKeyRotator: Plugin = async (
  input: PluginInput,
  options?: Record<string, unknown>,
) => {
  const config: KeyStoreConfig = {
    storePath: options?.storePath as string | undefined,
    rotationStrategy: isValidStrategy(options?.rotationStrategy)
      ? options!.rotationStrategy
      : "round-robin",
  };

  const store = loadStore(config);
  const activeKeys = getActiveKeys(store, config);

  // Seed an env key if the store is empty
  if (activeKeys.length === 0) {
    const envKey = process.env.NVIDIA_API_KEY;
    if (envKey) {
      const existing = store.keys.find((k) => k.name === "env-default");
      if (!existing) {
        addKey(store, "env-default", envKey);
        saveStore(store, config);
      }
    }
  }

  const hooks: Hooks = {
    auth: {
      provider: PROVIDER_ID,
      // We deliberately omit auth.loader. The fetch we used
      // to return was never called by opencode; it only uses
      // the apiKey string from the authorize step.  Rotation is
      // handled in chat.headers instead.
      methods: [
        {
          type: "api",
          label: "Enter NVIDIA NIM API Key",
          async authorize(inputs) {
            const key = inputs?.["apiKey"];
            if (!key) return { type: "failed" };

            try {
              const res = await fetch(`${NIM_BASE_URL}/v1/models`, {
                headers: { Authorization: `Bearer ${key}` },
              });
              if (!res.ok) return { type: "failed" };
            } catch {
              return { type: "failed" };
            }

            return {
              type: "success",
              key,
              provider: PROVIDER_ID,
            };
          },
        },
      ],
    },
    // Rotate the API key on every outgoing request by mutating the
    // Authorization header.  This is the hook that actually runs
    // before each LLM call, unlike auth.loader which only runs once.
    "chat.headers": async (_input, _output) => {
      const next = getNextKey(store, config);
      if (next) {
        _output.headers["Authorization"] = `Bearer ${next.key.key}`;
        saveStore(store, config);
      }
    },
    "shell.env": async (_input, output) => {
      if (output.env.NVIDIA_API_KEY !== undefined) {
        const next = getNextKey(store, config);
        if (next) {
          output.env.NVIDIA_API_KEY = next.key.key;
          saveStore(store, config);
        }
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const evt = event as Record<string, unknown>;
        const props = evt.properties as Record<string, unknown> | undefined;
        const error = evt.error ?? props?.error;
        if (isRecoverableError(error)) {
          if (store.lastUsedKeyId) {
            recordFailure(store, store.lastUsedKeyId);
            saveStore(store, config);
          }
        }
      }
    },
  };

  return hooks;
};

export default NvidiaNimKeyRotator;
