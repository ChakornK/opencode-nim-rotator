import type { KeyStore, KeyStoreConfig } from "./types.js";
import {
  getNextKey,
  saveStore,
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
            saveStore(store, config);
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
              saveStore(store, config);
            } catch (err) {
              logDebug(
                `[nim-rotator] Failed to save store after rate limit: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
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
