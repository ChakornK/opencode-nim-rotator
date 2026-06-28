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
    async fetch(request) {
      const url = new URL(request.url);
      const sessionID = request.headers.get("x-nim-rotator-session-id");

      try {
        // Read the request body to potentially modify it
        let body: string | null = null;
        let parsedBody: Record<string, unknown> | undefined;
        if (request.body) {
          const cloned = request.clone();
          body = await cloned.text();
          try {
            parsedBody = JSON.parse(body);
          } catch {
            // Not JSON, pass through as-is
          }
        }

        // Determine target model and API key
        let targetModel = parsedBody?.model as string | undefined;

        // Check if this session has a fallback model configured
        if (sessionID) {
          const state = sessions.get(sessionID);
          if (
            state?.activeChainModelId &&
            state.activeChainModelId !== targetModel
          ) {
            console.debug(
              `[nim-rotator] proxy: rewriting model for ${sessionID}: ${targetModel} → ${state.activeChainModelId}`,
            );
            targetModel = state.activeChainModelId;
            if (parsedBody) {
              parsedBody.model = targetModel;
              body = JSON.stringify(parsedBody);
            }
          }
        }

        // Build target URL
        const targetUrl = new URL(url.pathname + url.search, targetBaseUrl);

        // Forward the request, preserving the Authorization header set by chat.headers
        const headers = new Headers(request.headers);
        // Remove our custom header before forwarding
        headers.delete("x-nim-rotator-session-id");

        console.debug(
          `[nim-rotator] proxy: forwarding ${request.method} ${url.pathname} to ${targetUrl.toString()}`,
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => {
          console.error(
            `[nim-rotator] proxy: timeout after ${PROXY_TIMEOUT_MS}ms, aborting`,
          );
          controller.abort();
        }, PROXY_TIMEOUT_MS);

        let response: Response;
        try {
          response = await fetch(targetUrl.toString(), {
            method: request.method,
            headers,
            body: body ?? undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        console.debug(
          `[nim-rotator] proxy: received ${response.status} from ${targetUrl.toString()}`,
        );

        // Check for rate limit and notify
        if (response.status === 429 && sessionID && targetModel) {
          onRateLimit?.(sessionID, targetModel);
        }

        return response;
      } catch (error) {
        console.error(
          `[nim-rotator] proxy: error handling request to ${url.pathname}:`,
          error,
        );
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

  console.debug(
    `[nim-rotator] proxy listening on http://localhost:${server.port}`,
  );
  return { server, port: server.port ?? options.port };
}
