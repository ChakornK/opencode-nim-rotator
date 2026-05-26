import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import {
  loadStore,
  saveStore,
  addKey,
  getNextKey,
  recordFailure,
  resetFailures,
  getActiveKeys,
} from "./storage.js";
import type { KeyStore, KeyStoreConfig } from "./types.js";

const PROVIDER_ID = "nvidia";
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;

function isValidStrategy(
  val: unknown,
): val is KeyStoreConfig["rotationStrategy"] {
  return typeof val === "string" && VALID_STRATEGIES.includes(val as any);
}

function createRotatingFetch(store: KeyStore, config?: KeyStoreConfig) {
  return async function rotatingFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const next = getNextKey(store, config);
    if (!next) {
      return fetch(input, init);
    }

    saveStore(store, config);

    const headers = new Headers(
      init?.headers instanceof Headers
        ? init.headers
        : Array.isArray(init?.headers)
          ? init.headers
          : (init?.headers as Record<string, string> | undefined),
    );

    headers.delete("authorization");
    headers.delete("Authorization");
    headers.set("Authorization", `Bearer ${next.key.key}`);

    const newInit: RequestInit = {
      ...init,
      headers,
    };

    try {
      const response = await fetch(input, newInit);
      if (response.status === 401 || response.status === 403) {
        recordFailure(store, next.key.id);
        saveStore(store, config);

        const retry = getNextKey(store, config);
        if (retry && retry.key.id !== next.key.id) {
          const retryHeaders = new Headers(headers);
          retryHeaders.delete("authorization");
          retryHeaders.delete("Authorization");
          retryHeaders.set("Authorization", `Bearer ${retry.key.key}`);
          saveStore(store, config);
          const retryResponse = await fetch(input, {
            ...newInit,
            headers: retryHeaders,
          });
          if (retryResponse.status === 401 || retryResponse.status === 403) {
            recordFailure(store, retry.key.id);
            saveStore(store, config);
          }
          return retryResponse;
        }
      } else if (response.ok) {
        if (next.key.failureCount > 0) {
          resetFailures(store, next.key.id);
          saveStore(store, config);
        }
      }
      return response;
    } catch (err) {
      recordFailure(store, next.key.id);
      saveStore(store, config);
      throw err;
    }
  };
}

function isAuthError(obj: unknown): boolean {
  if (typeof obj === "object" && obj !== null) {
    const code = (obj as any).code;
    const status = (obj as any).status;
    if (code === 401 || code === 403 || status === 401 || status === 403)
      return true;
  }
  const msg = String(obj).toLowerCase();
  return (
    msg.includes("401") || msg.includes("403") || msg.includes("unauthorized")
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

  const rotatingFetch = createRotatingFetch(store, config);

  const hooks: Hooks = {
    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth) => {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};

        return {
          apiKey: auth.key,
          fetch: rotatingFetch,
        };
      },
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
      if (event.type === "session.error" && isAuthError((event as any).error)) {
        const active = getActiveKeys(store, config);
        if (active.length > 0 && store.currentIndex < store.keys.length) {
          recordFailure(store, store.keys[store.currentIndex].id);
          saveStore(store, config);
        }
      }
    },
  };

  return hooks;
};

export default NvidiaNimKeyRotator;
