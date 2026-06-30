import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startProxy } from "./proxy.js";
import type { ProxyState } from "./proxy.js";
import type { KeyStore } from "./types.js";
import { getDefaultStore } from "./storage.js";
import { tmpdir } from "os";
import { join } from "path";

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
    // Use a temp file for the store to avoid overwriting the real store
    process.env.NIM_ROTATOR_STORE_PATH = join(
      tmpdir(),
      `nim-rotator-test-${Date.now()}.json`,
    );

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

  it("should return 502 when target server is unreachable", async () => {
    // Start a proxy that points to a non-existent server
    const badProxy = startProxy({
      port: 0,
      store: getDefaultStore(),
      sessions: new Map(),
      targetUrl: "http://localhost:65432", // Non-existent server on valid port
    });

    try {
      const response = await fetch(
        `http://localhost:${badProxy.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "hello" }],
          }),
        },
      );

      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Proxy error");
    } finally {
      badProxy.server.stop(true);
    }
  });
});

describe("startProxy with API keys", () => {
  it("should rotate API keys and set Authorization header", async () => {
    // Use a temp file for the store to avoid overwriting the real store
    process.env.NIM_ROTATOR_STORE_PATH = join(
      tmpdir(),
      `nim-rotator-test-${Date.now()}.json`,
    );

    const testServer = Bun.serve({
      port: 0,
      async fetch(req) {
        return new Response("{}", { status: 200 });
      },
    });

    const store = getDefaultStore();
    store.keys = [
      {
        id: "key-1",
        name: "key1",
        key: "nvapi-test-key-1",
        createdAt: Date.now(),
        rateLimitCount: 0,
        enabled: true,
      },
      {
        id: "key-2",
        name: "key2",
        key: "nvapi-test-key-2",
        createdAt: Date.now(),
        rateLimitCount: 0,
        enabled: true,
      },
    ];

    let receivedAuth: string | null = null;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedAuth = req.headers.get("authorization");
        return new Response("{}", { status: 200 });
      },
    });

    const proxy = startProxy({
      port: 0,
      store,
      sessions: new Map(),
      targetUrl: `http://localhost:${upstream.port}`,
    });

    try {
      const response = await fetch(
        `http://localhost:${proxy.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "hello" }],
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(receivedAuth!).toBe("Bearer nvapi-test-key-1");

      // Second request should rotate to the next key
      const response2 = await fetch(
        `http://localhost:${proxy.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "hello" }],
          }),
        },
      );

      expect(response2.status).toBe(200);
      expect(receivedAuth!).toBe("Bearer nvapi-test-key-2");
    } finally {
      proxy.server.stop(true);
      upstream.stop(true);
      testServer.stop(true);
    }
  });
});
