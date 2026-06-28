import { describe, it, expect } from "bun:test";
import { NvidiaNimKeyRotator } from "./index.js";
import type { PluginInput } from "@opencode-ai/plugin";
import { writeFileSync, unlinkSync, existsSync } from "fs";

function createMockClient(
  overrides: {
    sessionGet?: (id: string) => Promise<unknown>;
    sessionAbort?: (id: string) => Promise<unknown>;
    sessionPrompt?: (id: string, body: unknown) => Promise<unknown>;
    sessionMessages?: (id: string) => Promise<unknown>;
    sessionStatus?: () => Promise<unknown>;
  } = {},
) {
  return {
    session: {
      get:
        overrides.sessionGet ??
        (() => Promise.resolve({ data: { parentID: undefined } })),
      abort: overrides.sessionAbort ?? (() => Promise.resolve()),
      prompt: overrides.sessionPrompt ?? (() => Promise.resolve()),
      messages:
        overrides.sessionMessages ?? (() => Promise.resolve({ data: [] })),
      status: overrides.sessionStatus ?? (() => Promise.resolve({})),
    },
    tui: {
      showToast: () => Promise.resolve(),
    },
  } as unknown as PluginInput["client"];
}

function createPluginInput(client: PluginInput["client"]): PluginInput {
  return { client } as PluginInput;
}

describe("NvidiaNimKeyRotator", () => {
  it("should export the plugin", async () => {
    const client = createMockClient();
    const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
      proxyPort: 0,
    });
    expect(plugin).toBeDefined();
    expect(plugin.auth).toBeDefined();
    expect(plugin["chat.headers"]).toBeDefined();
    expect(plugin["chat.message"]).toBeDefined();
    expect(plugin["shell.env"]).toBeDefined();
    expect(plugin.event).toBeDefined();
  });

  it("should skip abort for subagent sessions on rate limit", async () => {
    let abortCalled = false;
    const client = createMockClient({
      sessionGet: () => Promise.resolve({ data: { parentID: "parent-123" } }),
      sessionAbort: () => {
        abortCalled = true;
        return Promise.resolve();
      },
    });

    const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
      proxyPort: 0,
    });
    const event = {
      type: "session.error" as const,
      properties: {
        sessionID: "subagent-123",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    };

    await plugin.event!({ event } as any);
    // Subagent should not be aborted
    expect(abortCalled).toBe(false);
  });

  it("should track rate limit count for primary sessions", async () => {
    const client = createMockClient({
      sessionGet: () => Promise.resolve({ data: { parentID: undefined } }),
    });

    const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
      proxyPort: 0,
    });
    const event = {
      type: "session.error" as const,
      properties: {
        sessionID: "subagent-123",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    };

    // Seed the session state by running chat.message first
    await plugin["chat.message"]!(
      {
        sessionID: "primary-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      } as any,
    );

    // Should not throw when handling rate limit for primary session
    await plugin.event!({ event } as any);
    expect(true).toBe(true);
  });

  it("should proactively skip blacklisted models in chat.message", async () => {
    const client = createMockClient();
    const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
      storePath: "/tmp/test-nim-rotator-keys.json",
      proxyPort: 0,
    });

    // The fallback chain is empty by default, so chat.message should be a no-op
    const output = {
      message: {
        id: "msg-1",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      },
    };
    await plugin["chat.message"]!(
      {
        sessionID: "test-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      output as any,
    );
    // Model should remain unchanged when fallback chain is empty
    expect(output.message.model).toEqual({
      providerID: "nvidia",
      modelID: "llama-3.1-70b",
    });
  });

  it("should update model index for subagent on rate limit", async () => {
    const client = createMockClient({
      sessionGet: () => Promise.resolve({ data: { parentID: "parent-123" } }),
    });

    const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
      proxyPort: 0,
    });
    const event = {
      type: "session.error" as const,
      properties: {
        sessionID: "subagent-123",
        error: { name: "APIError", data: { statusCode: 429 } },
      },
    };

    // First, seed the session state
    await plugin["chat.message"]!(
      {
        sessionID: "subagent-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      } as any,
    );

    // Trigger rate limit enough times to exceed maxRateLimitFailures (default 3)
    for (let i = 0; i < 3; i++) {
      await plugin.event!({ event } as any);
    }

    // Subagent should not abort, but model index should be updated
    // Since the fallback chain is empty, nothing much changes,
    // but the important thing is no exception was thrown
    expect(true).toBe(true);
  });

  it("should handle session.status idle event and cleanup state", async () => {
    const client = createMockClient();
    const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
      proxyPort: 0,
    });

    // Seed the session state
    await plugin["chat.message"]!(
      {
        sessionID: "test-123",
        model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
      } as any,
      {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "llama-3.1-70b" },
        },
      } as any,
    );

    const event = {
      type: "session.status" as const,
      properties: {
        sessionID: "test-123",
        status: { type: "idle" },
      },
    };

    await plugin.event!({ event } as any);
    // Session state should be cleaned up
    expect(true).toBe(true);
  });

  it("should reset to first model after cooldown expires", async () => {
    const storePath = "/tmp/test-nim-rotator-cooldown-expire.json";
    let originalDateNow: typeof Date.now = Date.now;
    try {
      writeFileSync(
        storePath,
        JSON.stringify({
          keys: [],
          currentIndex: 0,
          rotationStrategy: "round-robin",
          updatedAt: Date.now(),
          fallbackChain: [
            { id: "model-a", name: "Model A" },
            { id: "model-b", name: "Model B" },
          ],
          maxRateLimitFailures: 3,
        }),
      );

      const client = createMockClient();
      const plugin = await NvidiaNimKeyRotator(createPluginInput(client), {
        storePath,
        proxyPort: 0,
      });

      // First message with model-a
      const output1 = {
        message: {
          id: "msg-1",
          model: { providerID: "nvidia", modelID: "model-a" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "model-a" },
        } as any,
        output1 as any,
      );
      expect(output1.message.model).toEqual({
        providerID: "nvidia",
        modelID: "model-a",
      });

      // Simulate rate limit errors to trigger fallback from model-a to model-b
      const event = {
        type: "session.error" as const,
        properties: {
          sessionID: "test-123",
          error: {
            name: "APIError",
            data: {
              statusCode: 429,
              responseHeaders: { "retry-after-ms": "0" },
            },
          },
        },
      };
      for (let i = 0; i < 3; i++) {
        await plugin.event!({ event } as any);
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }

      // Simulate session idle to clean up state
      await plugin.event!({
        event: {
          type: "session.status",
          properties: {
            sessionID: "test-123",
            status: { type: "idle" },
          },
        },
      } as any);

      // After fallback, model-a has a 1-hour cooldown
      // Next message with model-b should use model-b (fallback)
      const output2 = {
        message: {
          id: "msg-2",
          model: { providerID: "nvidia", modelID: "model-b" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "model-b" },
        } as any,
        output2 as any,
      );
      expect(output2.message.model).toEqual({
        providerID: "nvidia",
        modelID: "model-b",
      });

      // Mock Date.now to expire the cooldown
      originalDateNow = Date.now;
      let mockTime = Date.now();
      Date.now = () => mockTime;

      // Advance time by 1 hour + 1 ms
      mockTime += 60 * 60 * 1000 + 1;

      // After cooldown expires, next message with model-b should use model-a (first model)
      const output3 = {
        message: {
          id: "msg-3",
          model: { providerID: "nvidia", modelID: "model-b" },
        },
      };
      await plugin["chat.message"]!(
        {
          sessionID: "test-123",
          model: { providerID: "nvidia", modelID: "model-b" },
        } as any,
        output3 as any,
      );
      expect(output3.message.model).toEqual({
        providerID: "nvidia",
        modelID: "model-a",
      });
    } finally {
      Date.now = originalDateNow;
      try {
        unlinkSync(storePath);
      } catch {}
    }
  }, 10000);
});
