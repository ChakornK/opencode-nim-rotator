import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import {
  loadStore,
  saveStore,
  addKey,
  getNextKey,
  recordFailure,
  getActiveKeys,
  getDefaultStore,
} from "./storage.js";
import type { KeyStore, KeyStoreConfig } from "./types.js";

const PROVIDER_ID = "nvidia";
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function isValidStrategy(
  val: unknown,
): val is KeyStoreConfig["rotationStrategy"] {
  return val === "round-robin" || val === "least-failures";
}

function isRecoverableError(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  if (rec.name === "ProviderAuthError") return true;
  if (rec.name === "APIError") {
    const data = rec.data as Record<string, unknown> | undefined;
    const statusCode = data?.statusCode;
    if (statusCode === 401 || statusCode === 403 || statusCode === 429)
      return true;
  }
  return false;
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

  const store = loadStore(config) ?? getDefaultStore();
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

  const FALLBACK_TTL_MS = 60_000;
  const pendingFallbacks = new Map<
    string,
    {
      pendingFallbackModel?: string;
      fallbackNotification?: string;
      createdAt: number;
    }
  >();

  const cleanupFallback = (sessionID: string) => {
    const fb = pendingFallbacks.get(sessionID);
    if (!fb) return;
    if (!fb.pendingFallbackModel && !fb.fallbackNotification) {
      pendingFallbacks.delete(sessionID);
    }
  };

  if (cleanupInterval) clearInterval(cleanupInterval);
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, fb] of pendingFallbacks) {
      if (now - fb.createdAt > FALLBACK_TTL_MS) {
        pendingFallbacks.delete(sid);
      }
    }
  }, 30_000).unref();

  const hooks: Hooks = {
    auth: {
      provider: PROVIDER_ID,
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
    "chat.headers": async (_input, _output) => {
      const next = getNextKey(store, config);
      if (next) {
        _output.headers["Authorization"] = `Bearer ${next.key.key}`;
        saveStore(store, config);
      }
    },
    "chat.params": async (_input, output) => {
      const fb = pendingFallbacks.get(_input.sessionID);
      if (fb?.pendingFallbackModel) {
        output.options = {
          ...output.options,
          model: fb.pendingFallbackModel,
        };
        fb.pendingFallbackModel = undefined;
        cleanupFallback(_input.sessionID);
      }
    },
    "chat.message": async (_input, output) => {
      const fb = pendingFallbacks.get(_input.sessionID);
      if (fb?.fallbackNotification) {
        const msg = fb.fallbackNotification;
        fb.fallbackNotification = undefined;
        cleanupFallback(_input.sessionID);

        try {
          output.parts.unshift({
            id: `fallback-${crypto.randomUUID()}`,
            sessionID: _input.sessionID,
            messageID: _input.messageID ?? "",
            type: "text" as const,
            text: `\n⚠️  ${msg}\n`,
            synthetic: true,
            ignored: true,
          });
        } catch (err) {
          console.error(
            "[nim-rotator] Failed to inject fallback notification:",
            err,
          );
        }
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

          if (store.fallbackChain.length > 0) {
            const fallbackModel = store.fallbackChain.shift()!;
            const msg = `Model fallback: switching to "${fallbackModel.name}" due to rate limit / auth error`;
            console.log(`[nim-rotator] ${msg}`);

            const sessionID =
              ((props as Record<string, unknown> | undefined)?.sessionID as
                | string
                | undefined) ??
              ((evt as Record<string, unknown>).sessionID as
                | string
                | undefined);

            if (sessionID) {
              pendingFallbacks.set(sessionID, {
                pendingFallbackModel: fallbackModel.id,
                fallbackNotification: msg,
                createdAt: Date.now(),
              });
            } else {
              console.warn(
                "[nim-rotator] session.error received but sessionID could not be located",
                evt,
              );
            }

            saveStore(store, config);
          }
        }
      }
    },
  };

  return hooks;
};

export default NvidiaNimKeyRotator;
