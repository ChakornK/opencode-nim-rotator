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
import type { KeyStore, KeyStoreConfig, FallbackModel } from "./types.js";

const PROVIDER_ID = "nvidia";
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;
const FALLBACK_TIMEOUT_MS = 60_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

interface SessionState {
  attemptIndex: number;
  timeoutTriggered: boolean;
  inRetry: boolean;
  pendingRetryIndex: number | undefined;
  lastUserMessageID: string | undefined;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  activeChainKey: string | undefined;
}

function isValidStrategy(
  val: unknown,
): val is KeyStoreConfig["rotationStrategy"] {
  return val === "round-robin" || val === "least-failures";
}

function shouldRetryForError(error: unknown, state: SessionState): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as Record<string, unknown>;

  if (rec.name === "MessageAbortedError") {
    if (state.timeoutTriggered) return true;
    const msg =
      typeof (rec.data as Record<string, unknown>)?.message === "string"
        ? ((rec.data as Record<string, unknown>).message as string)
        : "";
    return /time\s*out|timed\s*out|timeout/i.test(msg);
  }

  if (rec.name === "APIError") {
    const data = rec.data as Record<string, unknown> | undefined;
    if (data?.isRetryable) return true;
    const statusCode = data?.statusCode;
    if (
      typeof statusCode === "number" &&
      RETRYABLE_STATUS_CODES.has(statusCode)
    )
      return true;
    return false;
  }

  if (rec.name === "ProviderAuthError") return false;

  return true;
}

function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

function findChainIndex(
  chain: FallbackModel[],
  model: { providerID: string; modelID: string } | undefined,
): number {
  if (!model) return -1;
  return chain.findIndex(
    (entry) => entry.id === model.modelID || entry.name === model.modelID,
  );
}

export const NvidiaNimKeyRotator: Plugin = async (
  input: PluginInput,
  options?: Record<string, unknown>,
) => {
  const client = input.client;
  const config: KeyStoreConfig = {
    storePath: options?.storePath as string | undefined,
    rotationStrategy: isValidStrategy(options?.rotationStrategy)
      ? options!.rotationStrategy
      : "round-robin",
  };

  const store = loadStore(config) ?? getDefaultStore();
  if (!Array.isArray(store.fallbackChain)) store.fallbackChain = [];

  const sessions = new Map<string, SessionState>();

  const reloadFromDisk = () => {
    const fresh = loadStore(config);
    if (fresh !== null) {
      store.keys = fresh.keys;
      store.currentIndex = fresh.currentIndex;
      store.rotationStrategy = fresh.rotationStrategy;
      store.updatedAt = fresh.updatedAt;
      store.lastUsedKeyId = fresh.lastUsedKeyId;
      store.fallbackChain = Array.isArray(fresh.fallbackChain)
        ? fresh.fallbackChain
        : [];
    }
  };

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

  const showToast = async (
    variant: "success" | "info" | "warning" | "error",
    message: string,
  ) => {
    try {
      await client.tui?.showToast?.({
        body: { title: "Model Fallback", message, variant },
      });
    } catch {}
  };

  const getState = (sessionID: string): SessionState => {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const next: SessionState = {
      attemptIndex: 0,
      timeoutTriggered: false,
      inRetry: false,
      pendingRetryIndex: undefined,
      lastUserMessageID: undefined,
      timeoutHandle: undefined,
      activeChainKey: undefined,
    };
    sessions.set(sessionID, next);
    return next;
  };

  const clearScheduledTimeout = (state: SessionState) => {
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = undefined;
    }
  };

  const scheduleTimeout = (
    sessionID: string,
    messageID: string,
    state: SessionState,
  ) => {
    clearScheduledTimeout(state);
    state.timeoutTriggered = false;
    state.timeoutHandle = setTimeout(() => {
      if (state.lastUserMessageID !== messageID) return;
      state.timeoutTriggered = true;
      void client.session.abort({ path: { id: sessionID } });
    }, FALLBACK_TIMEOUT_MS);
  };

  const cleanupSession = (sessionID: string) => {
    const state = sessions.get(sessionID);
    if (state) {
      clearScheduledTimeout(state);
      sessions.delete(sessionID);
    }
  };

  const triggerRetry = async (
    sessionID: string,
    state: SessionState,
  ): Promise<boolean> => {
    const chain = store.fallbackChain;
    if (chain.length < 2) return false;

    const nextIndex = (state.attemptIndex + 1) % chain.length;
    state.inRetry = true;
    state.pendingRetryIndex = nextIndex;

    try {
      const source = chain[state.attemptIndex];
      const target = chain[nextIndex];
      if (!source || !target) return false;

      await showToast(
        "warning",
        `${source.name} failed, retrying with ${target.name}...`,
      );

      const messagesResult = await client.session.messages({
        path: { id: sessionID },
      });
      const entries =
        messagesResult && "data" in messagesResult
          ? messagesResult.data
          : messagesResult;
      if (!Array.isArray(entries)) return false;

      const userMessages = (entries as Array<Record<string, unknown>>).filter(
        (entry) => (entry?.info as Record<string, unknown>)?.role === "user",
      );
      if (userMessages.length === 0) return false;

      const lastUser = userMessages[userMessages.length - 1] as Record<
        string,
        unknown
      >;
      const lastUserInfo = lastUser.info as Record<string, unknown>;
      const lastUserParts = lastUser.parts as Array<Record<string, unknown>>;

      if (
        state.lastUserMessageID &&
        (lastUserInfo?.id as string) !== state.lastUserMessageID
      ) {
        return false;
      }

      const promptParts: Array<{
        type: "text";
        id: string;
        text: string;
        synthetic?: boolean;
        ignored?: boolean;
      }> = [];
      if (Array.isArray(lastUserParts)) {
        for (const part of lastUserParts) {
          if (part?.type === "text") {
            promptParts.push({
              type: "text",
              id: part.id as string,
              text: part.text as string,
              synthetic: part.synthetic as boolean | undefined,
              ignored: part.ignored as boolean | undefined,
            });
          }
        }
      }

      await client.session.prompt({
        path: { id: sessionID },
        body: {
          messageID: lastUserInfo?.id as string,
          agent: lastUserInfo?.agent as string,
          model: {
            providerID: PROVIDER_ID,
            modelID: target.id,
          },
          parts: promptParts,
        },
      });

      return true;
    } catch {
      state.pendingRetryIndex = undefined;
      return false;
    } finally {
      state.inRetry = false;
    }
  };

  if (cleanupInterval) clearInterval(cleanupInterval);
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, state] of sessions) {
      if (state.timeoutHandle && !state.inRetry) {
        // stale sessions
      }
    }
  }, 30_000);
  if (cleanupInterval && typeof cleanupInterval === "object") {
    try {
      (cleanupInterval as ReturnType<typeof setTimeout>).unref?.();
    } catch {}
  }

  const is429Error = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    const rec = error as Record<string, unknown>;
    if (rec.name === "APIError") {
      const data = rec.data as Record<string, unknown> | undefined;
      const statusCode = data?.statusCode;
      return statusCode === 429 || data?.isRetryable === true;
    }
    return false;
  };

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
      reloadFromDisk();
      const next = getNextKey(store, config);
      if (next) {
        _output.headers["Authorization"] = `Bearer ${next.key.key}`;
        saveStore(store, config);
      }
    },
    "chat.message": async (input, output) => {
      const chain = store.fallbackChain;
      if (chain.length === 0) return;

      const sessionID = input.sessionID;
      const state = getState(sessionID);
      const requestedModel = output.message.model ?? input.model;

      let activeChainKey = state.activeChainKey;
      let activeChainKeyStr = activeChainKey;

      if (!activeChainKeyStr || state.pendingRetryIndex === undefined) {
        if (!requestedModel) {
          cleanupSession(sessionID);
          return;
        }
        activeChainKeyStr = modelKey(requestedModel);
      }

      // Find if the requested model is in our fallback chain
      const chainIndex = findChainIndex(chain, requestedModel);
      if (chainIndex < 0 && state.pendingRetryIndex === undefined) {
        cleanupSession(sessionID);
        return;
      }

      const desiredIndex =
        state.pendingRetryIndex ?? (chainIndex >= 0 ? chainIndex : 0);
      const target = chain[desiredIndex];
      if (!target) {
        cleanupSession(sessionID);
        return;
      }

      // Override the model in the output message
      output.message.model = {
        providerID: PROVIDER_ID,
        modelID: target.id,
      };

      state.activeChainKey = activeChainKeyStr;
      state.attemptIndex = desiredIndex;
      state.pendingRetryIndex = undefined;
      state.lastUserMessageID = output.message.id;

      // Don't timeout the last model in the chain
      const isLastModel = desiredIndex === chain.length - 1;
      if (isLastModel) {
        clearScheduledTimeout(state);
        state.timeoutTriggered = false;
        return;
      }

      scheduleTimeout(sessionID, output.message.id, state);
    },
    "shell.env": async (_input, output) => {
      if (output.env.NVIDIA_API_KEY !== undefined) {
        reloadFromDisk();
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
        const sessionID =
          ((props as Record<string, unknown> | undefined)?.sessionID as
            | string
            | undefined) ??
          ((evt as Record<string, unknown>).sessionID as string | undefined);

        if (is429Error(error)) {
          reloadFromDisk();
          if (store.lastUsedKeyId) {
            recordFailure(store, store.lastUsedKeyId);
          }
          saveStore(store, config);
        }

        if (!sessionID) return;

        const state = sessions.get(sessionID);
        if (!state) return;
        if (state.inRetry) return;

        clearScheduledTimeout(state);

        if (!shouldRetryForError(error, state)) {
          state.timeoutTriggered = false;
          return;
        }

        const retried = await triggerRetry(sessionID, state);
        if (!retried) {
          cleanupSession(sessionID);
        }

        return;
      }

      if (
        event.type === "session.status" &&
        (
          (event.properties as Record<string, unknown>)?.status as Record<
            string,
            unknown
          >
        )?.type === "idle"
      ) {
        const sessionID = (event.properties as Record<string, unknown>)
          .sessionID as string;
        if (!sessionID) return;

        const state = sessions.get(sessionID);
        if (!state) return;

        clearScheduledTimeout(state);

        if (state.inRetry) return;
        if (state.pendingRetryIndex !== undefined) return;

        if (state.timeoutTriggered) {
          reloadFromDisk();
          const retried = await triggerRetry(sessionID, state);
          if (!retried) {
            cleanupSession(sessionID);
          }
          saveStore(store, config);
          return;
        }

        cleanupSession(sessionID);
      }

      if (event.type === "session.idle") {
        const sessionID = (event.properties as Record<string, unknown>)
          ?.sessionID as string;
        if (sessionID) cleanupSession(sessionID);
      }

      if (event.type === "session.deleted") {
        const sessionID = (
          (event.properties as Record<string, unknown>)?.info as Record<
            string,
            unknown
          >
        )?.id as string;
        if (sessionID) cleanupSession(sessionID);
      }
    },
  };

  return hooks;
};

export default NvidiaNimKeyRotator;
