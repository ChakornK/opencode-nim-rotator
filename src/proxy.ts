import type { KeyStore, KeyStoreConfig } from "./types.js";
import {
  getNextKey,
  saveStore,
  loadStore,
  recordRateLimit,
  recordModelRateLimit,
} from "./storage.js";

import { logDebug } from "./logger.js";

const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const PROXY_TIMEOUT_MS = 120_000; // 2 minutes

export interface ProxyState {
  activeChainModelId: string | undefined;
  currentModelId: string | undefined;
}

export interface ProxyOptions {
  port: number;
  store: KeyStore;
  sessions: Map<string, ProxyState>;
  config?: KeyStoreConfig;
  targetUrl?: string;
  onRateLimit?: (sessionID: string, modelId: string) => void;
}

export function startProxy(options: ProxyOptions) {
  const { store, sessions, onRateLimit, config } = options;
  const targetBaseUrl = options.targetUrl ?? DEFAULT_NVIDIA_BASE_URL;

  // Track 429 counts per session to trigger fallback from proxy level
  const session429Counts = new Map<string, number>();

  // Helper to reload store from disk before saving, to avoid overwriting
  // changes made by other processes (e.g., the TUI).
  function safeSaveStore() {
    try {
      const fresh = loadStore(config);
      if (fresh) {
        // Copy proxy-managed fields into the fresh store
        fresh.currentIndex = store.currentIndex;
        fresh.lastUsedKeyId = store.lastUsedKeyId;
        // keys may have been updated by TUI, so don't copy them
        // fallbackChain may have been updated by TUI, so don't copy it
        saveStore(fresh, config);
      } else {
        saveStore(store, config);
      }
    } catch (err) {
      logDebug(
        `[nim-rotator] safeSaveStore failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const server = Bun.serve({
    port: options.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const sessionID = req.headers.get("x-nim-rotator-session-id");

      logDebug(
        `[nim-rotator] Proxy received request: ${req.method} ${url.pathname} sessionID=${sessionID ?? "none"}`,
      );

      try {
        // Read and potentially modify the request body
        let bodyText: string | undefined;
        let targetModel: string | undefined;

        if (req.body) {
          bodyText = await req.text();
          try {
            const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
            targetModel = parsedBody.model as string | undefined;

            // Check if this session has a fallback model configured
            if (sessionID) {
              const state = sessions.get(sessionID);
              if (
                state?.activeChainModelId &&
                state.activeChainModelId !== targetModel
              ) {
                parsedBody.model = state.activeChainModelId;
                targetModel = state.activeChainModelId;
                bodyText = JSON.stringify(parsedBody);
              }
            }
          } catch {
            // Not JSON, use original body as-is
          }
        }

        // Strip /v1 prefix from incoming path to avoid duplication
        // when appending to targetBaseUrl which already includes /v1
        let upstreamPath = url.pathname;
        if (upstreamPath === "/v1") upstreamPath = "";
        else if (upstreamPath.startsWith("/v1/"))
          upstreamPath = upstreamPath.replace(/^\/v1/, "");

        const upstream = `${targetBaseUrl}${upstreamPath}${url.search}`;

        // Forward the request
        const headers = new Headers(req.headers);
        // Remove our custom header and host before forwarding
        headers.delete("x-nim-rotator-session-id");
        headers.delete("host");

        // Handle API key rotation in the proxy
        const modelIdForRotation = targetModel;
        const next = getNextKey(store, config, modelIdForRotation);
        logDebug(
          `[nim-rotator] Proxy key lookup: modelId=${modelIdForRotation ?? "none"}, found=${next !== null}, keyId=${next?.key.id ?? "none"}`,
        );
        if (next) {
          const authValue = `Bearer ${next.key.key}`;
          headers.set("Authorization", authValue);
          logDebug(
            `[nim-rotator] Proxy set Authorization header: ${authValue.substring(0, 20)}...`,
          );
          try {
            safeSaveStore();
          } catch (err) {
            logDebug(
              `[nim-rotator] Failed to save store after key rotation: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          logDebug(
            `[nim-rotator] Proxy: no active key found, not setting Authorization header`,
          );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetch(upstream, {
            method: req.method,
            headers,
            body: bodyText,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        // Check for rate limit and notify
        if (response.status === 429 && sessionID && targetModel) {
          onRateLimit?.(sessionID, targetModel);
          // Also record rate limit for the key that was just used
          const errorKeyId = store.lastUsedKeyId;
          if (errorKeyId) {
            recordRateLimit(store, errorKeyId);
            recordModelRateLimit(store, errorKeyId, targetModel);
            try {
              safeSaveStore();
            } catch (err) {
              logDebug(
                `[nim-rotator] Failed to save store after rate limit: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Track 429 count for this session and trigger fallback if needed
          const currentCount = (session429Counts.get(sessionID) || 0) + 1;
          session429Counts.set(sessionID, currentCount);
          logDebug(
            `[nim-rotator] Proxy 429 count for session ${sessionID}: ${currentCount}/${store.maxRateLimitFailures || 3}`,
          );

          if (currentCount >= (store.maxRateLimitFailures || 3)) {
            // Find the next model in the fallback chain
            const chain = store.fallbackChain;
            const currentIndex = chain.findIndex((m) => m.id === targetModel);
            logDebug(
              `[nim-rotator] Proxy fallback check: targetModel=${targetModel}, chainIndex=${currentIndex}, chainLength=${chain.length}`,
            );
            if (currentIndex >= 0 && currentIndex < chain.length - 1) {
              const nextModel = chain[currentIndex + 1];
              const proxyState = sessions.get(sessionID) || {
                activeChainModelId: undefined,
                currentModelId: undefined,
              };
              proxyState.activeChainModelId = nextModel.id;
              sessions.set(sessionID, proxyState);
              logDebug(
                `[nimQr-rotator] Proxy triggered fallback: ${targetModel} -> ${nextModel.id}`,
              );
            }
          }
        } else if (sessionID) {
          // Reset 429 count on successful/non-429 response
          session429Counts.delete(sessionID);
        }

        return response;
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "Proxy error",
            message: error instanceof Error ? error.message : String(error),
          }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    },
  });

  return { server, port: server.port ?? options.port };
}
