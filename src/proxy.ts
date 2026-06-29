import type { KeyStore } from "./types.js";

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
  targetUrl?: string;
  onRateLimit?: (sessionID: string, modelId: string) => void;
}

export function startProxy(options: ProxyOptions) {
  const { store, sessions, onRateLimit } = options;
  const targetBaseUrl = options.targetUrl ?? DEFAULT_NVIDIA_BASE_URL;

  const server = Bun.serve({
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      const sessionID = req.headers.get("x-nim-rotator-session-id");

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

        // Forward the request, preserving the Authorization header set by chat.headers
        const headers = new Headers(req.headers);
        // Remove our custom header and host before forwarding
        headers.delete("x-nim-rotator-session-id");
        headers.delete("host");

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
