import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startProxy } from "./proxy.js";
import type { ProxyState } from "./proxy.js";
import type { KeyStore } from "./types.js";
import { getDefaultStore } from "./storage.js";

describe("startProxy", () => {
  let proxy: ReturnType<typeof startProxy>;
  let sessions: Map<string, ProxyState>;
  let rateLimitCalls: Array<{ sessionID: string; modelId: string }>;
  let port: number;
  let testServer: ReturnType<typeof Bun.serve>;
  let testServerPort: number;
  let lastRequest:
    | { url: string; body: Record<string, unknown>; headers: Headers }
    | undefined;
  let nextResponseStatus: number = 200;

  beforeAll(() => {
    sessions = new Map();
    rateLimitCalls = [];
    lastRequest = undefined;

    testServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = req.url;
        const bodyText = await req.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(bodyText);
        } catch {}
        lastRequest = { url, body, headers: req.headers };
        return new Response("{}", { status: nextResponseStatus });
      },
    });
    testServerPort = testServer.port ?? 0;

    const store: KeyStore = getDefaultStore();
    proxy = startProxy({
      port: 0,
      store,
      sessions,
      targetUrl: `http://localhost:${testServerPort}`,
      onRateLimit: (sessionID, modelId) => {
        rateLimitCalls.push({ sessionID, modelId });
      },
    });
    port = proxy.port;
  });

  afterAll(() => {
    proxy.server.stop(true);
    testServer.stop(true);
  });

  it("should start on a random port when port=0", () => {
    expect(port).toBeGreaterThan(0);
    expect(testServerPort).toBeGreaterThan(0);
  });

  it("should rewrite model in request body when session has activeChainModelId", async () => {
    sessions.set("test-session-1", {
      activeChainModelId: "fallback-model-id",
      currentModelId: "original-model-id",
    });
    lastRequest = undefined;
    nextResponseStatus = 200;

    const response = await fetch(
      `http://localhost:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
          "X-Nim-Rotator-Session-ID": "test-session-1",
        },
        body: JSON.stringify({
          model: "original-model-id",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.body.model).toBe("fallback-model-id");
    expect(lastRequest!.headers.get("authorization")).toBe("Bearer test-key");
    expect(lastRequest!.headers.get("x-nim-rotator-session-id")).toBeNull();
  });

  it("should not rewrite model when no activeChainModelId is set", async () => {
    sessions.delete("test-session-2");
    lastRequest = undefined;
    nextResponseStatus = 200;

    const response = await fetch(
      `http://localhost:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
          "X-Nim-Rotator-Session-ID": "test-session-2",
        },
        body: JSON.stringify({
          model: "original-model-id",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.body.model).toBe("original-model-id");
  });

  it("should not rewrite model when activeChainModelId equals target model", async () => {
    sessions.set("test-session-3", {
      activeChainModelId: "same-model-id",
      currentModelId: "same-model-id",
    });
    lastRequest = undefined;
    nextResponseStatus = 200;

    const response = await fetch(
      `http://localhost:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
          "X-Nim-Rotator-Session-ID": "test-session-3",
        },
        body: JSON.stringify({
          model: "same-model-id",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.body.model).toBe("same-model-id");
  });

  it("should call onRateLimit when response is 429", async () => {
    sessions.set("test-session-4", {
      activeChainModelId: "fallback-model-id",
      currentModelId: "original-model-id",
    });
    rateLimitCalls.length = 0;
    lastRequest = undefined;
    nextResponseStatus = 429;

    const response = await fetch(
      `http://localhost:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
          "X-Nim-Rotator-Session-ID": "test-session-4",
        },
        body: JSON.stringify({
          model: "original-model-id",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    expect(response.status).toBe(429);
    expect(rateLimitCalls.length).toBe(1);
    expect(rateLimitCalls[0].sessionID).toBe("test-session-4");
    expect(rateLimitCalls[0].modelId).toBe("fallback-model-id");
  });
});
