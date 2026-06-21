import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import {
  loadStore,
  saveStore,
  addKey,
  getNextKey,
  recordFailure,
  getActiveKeys,
  getDefaultStore,
  recordRateLimit,
  resetRateLimit,
  recordModelRateLimit,
} from "./storage.js";
import type { KeyStore, KeyStoreConfig, FallbackModel } from "./types.js";

const PROVIDER_ID = "nvidia";
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

interface SessionState {
  attemptIndex: number;
  timeoutTriggered: boolean;
  inRetry: boolean;
  aborting: boolean;
  pendingRetryIndex: number | undefined;
  lastUserMessageID: string | undefined;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  activeChainKey: string | undefined;
  rateLimitCount: number;
  currentModelId: string | undefined;
}

function isValidStrategy(
  val: unknown,
): val is KeyStoreConfig["rotationStrategy"] {
  return val === "round-robin" || val === "least-failures";
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as Record<string, unknown>;
  const data = rec.data as Record<string, unknown> | undefined;
  if (typeof data?.statusCode === "number") return data.statusCode;
  if (typeof data?.status === "number") return data.status;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return undefined;
}

function describeError(
  error: unknown,
  state: SessionState,
  maxRateLimitFailures: number,
): string {
  if (!error || typeof error !== "object") return "Unknown error";
  const rec = error as Record<string, unknown>;

  if (rec.name === "MessageAbortedError") {
    if (state.timeoutTriggered) return "Request timed out after 60s";
    const msg =
      typeof (rec.data as Record<string, unknown>)?.message === "string"
        ? ((rec.data as Record<string, unknown>).message as string)
        : "";
    if (/time\s*out|timed\s*out|timeout/i.test(msg))
      return "Request timed out after 60s";
    return `Message aborted: ${msg || "no details"}`;
  }

  if (rec.name === "APIError") {
    const data = rec.data as Record<string, unknown> | undefined;
    const statusCode = extractStatus(error);
    const body = data?.body as Record<string, unknown> | undefined;
    const apiMsg =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : typeof body?.title === "string"
            ? body.title
            : undefined;
    if (statusCode === 429) {
      return `Rate limited (429) — ${state.rateLimitCount + 1}/${maxRateLimitFailures} consecutive`;
    }
    if (typeof statusCode === "number") {
      return `API error ${statusCode}${apiMsg ? `: ${apiMsg}` : ""}`;
    }
    return `API error${apiMsg ? `: ${apiMsg}` : ""}`;
  }

  if (rec.name === "ProviderAuthError") return "Provider auth error";

  const statusCode = extractStatus(error);
  if (statusCode === 429) {
    return `Rate limited (429) — ${state.rateLimitCount + 1}/${maxRateLimitFailures} consecutive`;
  }
  if (typeof statusCode === "number") {
    const title =
      typeof rec.title === "string"
        ? rec.title
        : typeof rec.message === "string"
          ? rec.message
          : undefined;
    return `API error ${statusCode}${title ? `: ${title}` : ""}`;
  }

  const msg =
    typeof rec.message === "string"
      ? rec.message
      : typeof rec.code === "string"
        ? rec.code
        : "Unknown error";
  return msg;
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
    const statusCode = extractStatus(error);
    return (
      typeof statusCode === "number" && RETRYABLE_STATUS_CODES.has(statusCode)
    );
  }

  if (rec.name === "ProviderAuthError") return false;

  const statusCode = extractStatus(error);
  return (
    typeof statusCode === "number" && RETRYABLE_STATUS_CODES.has(statusCode)
  );
}

function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

const subAgentCache = new Map<string, boolean>();

async function isSubagentSession(
  client: PluginInput["client"],
  sessionID: string,
): Promise<boolean> {
  const cached = subAgentCache.get(sessionID);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const res = await (
      client.session as unknown as {
        get: (p: { path: { id: string } }) => Promise<unknown>;
      }
    ).get({ path: { id: sessionID } });
    const data =
      res && typeof res === "object" && "data" in res
        ? (res as { data: unknown }).data
        : res;
    if (data && typeof data === "object") {
      result = (data as Record<string, unknown>)?.parentID !== undefined;
    }
  } catch {
    result = false;
  }
  subAgentCache.set(sessionID, result);
  return result;
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
      store.maxRateLimitFailures =
        typeof fresh.maxRateLimitFailures === "number" &&
        Number.isFinite(fresh.maxRateLimitFailures) &&
        fresh.maxRateLimitFailures >= 1
          ? fresh.maxRateLimitFailures
          : getDefaultStore().maxRateLimitFailures;
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
      aborting: false,
      pendingRetryIndex: undefined,
      lastUserMessageID: undefined,
      timeoutHandle: undefined,
      activeChainKey: undefined,
      rateLimitCount: 0,
      currentModelId: undefined,
    };
    sessions.set(sessionID, next);
    return next;
  };

  const cleanupSession = (sessionID: string) => {
    sessions.delete(sessionID);
    subAgentCache.delete(sessionID);
  };

  const triggerRetry = async (
    sessionID: string,
    state: SessionState,
    reason?: string,
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
        `${source.name} → ${target.name}${reason ? `: ${reason}` : ""}`,
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

  const isRateLimit429Error = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    return extractStatus(error) === 429;
  };

  const is429Error = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    const statusCode = extractStatus(error);
    if (statusCode === 429) return true;
    const rec = error as Record<string, unknown>;
    if (rec.name === "APIError") {
      const data = rec.data as Record<string, unknown> | undefined;
      return data?.isRetryable === true;
    }
    return false;
  };

  const handleSessionError = async (event: Record<string, unknown>) => {
    const props = event.properties as Record<string, unknown> | undefined;
    const error = event.error ?? props?.error;
    const sessionID =
      (props?.sessionID as string | undefined) ??
      (event.sessionID as string | undefined);

    if (is429Error(error)) {
      reloadFromDisk();
      if (store.lastUsedKeyId) {
        recordFailure(store, store.lastUsedKeyId);
        recordRateLimit(store, store.lastUsedKeyId);
        if (isRateLimit429Error(error)) {
          const stateForBlacklist = sessionID
            ? sessions.get(sessionID)
            : undefined;
          if (stateForBlacklist?.currentModelId) {
            recordModelRateLimit(
              store,
              store.lastUsedKeyId,
              stateForBlacklist.currentModelId,
            );
          }
        }
      }
      saveStore(store, config);
    }

    if (!sessionID) return;

    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.aborting) {
      state.aborting = false;
      return;
    }
    if (state.inRetry) return;

    const isSubagent = await isSubagentSession(client, sessionID);
    const subagentRateLimited =
      isSubagent && state.rateLimitCount >= store.maxRateLimitFailures;

    if (!shouldRetryForError(error, state) && !subagentRateLimited) {
      if (!is429Error(error)) {
        state.rateLimitCount = 0;
      }
      return;
    }

    if (is429Error(error)) {
      state.rateLimitCount++;
      if (state.rateLimitCount < store.maxRateLimitFailures) return;
    } else if (!subagentRateLimited) {
      state.rateLimitCount = 0;
    }

    const reason = describeError(error, state, store.maxRateLimitFailures);
    const retried = await triggerRetry(sessionID, state, reason);
    if (!retried) {
      cleanupSession(sessionID);
    }
  };

  const handleSessionStatusRetry = async (
    sessionID: string,
    status: Record<string, unknown>,
  ) => {
    const message = status.message as string | undefined;
    const is429 =
      typeof message === "string" && /429|too many requests/i.test(message);
    if (!is429) return;

    reloadFromDisk();
    if (store.lastUsedKeyId) {
      recordFailure(store, store.lastUsedKeyId);
      recordRateLimit(store, store.lastUsedKeyId);
      const stateForBlacklist = sessions.get(sessionID);
      if (stateForBlacklist?.currentModelId) {
        recordModelRateLimit(
          store,
          store.lastUsedKeyId,
          stateForBlacklist.currentModelId,
        );
      }
    }
    saveStore(store, config);

    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.inRetry) return;

    state.rateLimitCount++;
    if (state.rateLimitCount < store.maxRateLimitFailures) return;

    if (await isSubagentSession(client, sessionID)) {
      return;
    }

    state.aborting = true;
    void client.session.abort({ path: { id: sessionID } });

    const reason = `Rate limited (429) — ${state.rateLimitCount}/${store.maxRateLimitFailures} consecutive`;
    const retried = await triggerRetry(sessionID, state, reason);
    if (!retried) {
      cleanupSession(sessionID);
    }
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
      const prevKeyId = store.lastUsedKeyId;
      const modelIdForRotation = _input.model?.id;
      const next = getNextKey(store, config, modelIdForRotation);
      if (next) {
        _output.headers["Authorization"] = `Bearer ${next.key.key}`;
        if (prevKeyId && prevKeyId !== next.key.id) {
          resetRateLimit(store, prevKeyId);
        }
        saveStore(store, config);
      }
      if (modelIdForRotation && _input.sessionID) {
        const state = getState(_input.sessionID);
        state.currentModelId = modelIdForRotation;
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

      output.message.model = {
        providerID: PROVIDER_ID,
        modelID: target.id,
      };

      state.activeChainKey = activeChainKeyStr;
      state.attemptIndex = desiredIndex;
      state.pendingRetryIndex = undefined;
      state.lastUserMessageID = output.message.id;
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
        await handleSessionError(event as Record<string, unknown>);
        return;
      }

      if (event.type === "session.status") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const sessionID = props?.sessionID as string | undefined;
        const status = props?.status as Record<string, unknown> | undefined;
        const statusType = status?.type;

        if (statusType === "retry" && sessionID && status) {
          await handleSessionStatusRetry(sessionID, status);
          return;
        }

        if (statusType === "idle" && sessionID) {
          const state = sessions.get(sessionID);
          if (!state) return;
          if (state.inRetry) return;
          if (state.pendingRetryIndex !== undefined) return;
          cleanupSession(sessionID);
          return;
        }
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
