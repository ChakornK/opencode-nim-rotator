import { getActiveTheme, setPreviewTheme } from "../themes.js";
import type { FallbackModel } from "../types.js";
import {
  exportKeys,
  applyImport,
  resetFailures,
  toggleKey,
  writeExportFile,
} from "../storage.js";
import { safeSaveStore } from "./state.js";
import {
  state,
  navigate,
  callRenderApp,
  refreshStore,
  setStatus,
} from "./state.js";

export function handleKeyAction(action: string): void {
  if (!state.selectedKeyId) return;
  const entry = state.store.keys.find((k) => k.id === state.selectedKeyId);
  const theme = getActiveTheme();

  switch (action) {
    case "toggle":
      if (entry) {
        toggleKey(state.store, state.selectedKeyId);
        safeSaveStore();
        refreshStore();
        setStatus(
          `Toggled "${entry.name}" to ${entry.enabled ? "ON" : "OFF"}`,
          theme.success,
        );
      }
      navigate("key-actions");
      break;
    case "rename":
      state.renameTargetId = state.selectedKeyId;
      navigate("rename");
      break;
    case "delete":
      state.deleteTargetId = state.selectedKeyId;
      navigate("confirm-delete");
      break;
    case "back":
      navigate("key-selector");
      break;
  }
}

export function handleMenuSelect(value: string): void {
  const theme = getActiveTheme();
  switch (value) {
    case "add":
      navigate("add-name");
      break;
    case "manage":
      navigate("key-selector");
      break;
    case "reset-failures":
      resetFailures(state.store);
      safeSaveStore();
      refreshStore();
      setStatus("All failure counts reset", theme.success);
      navigate("list");
      break;
    case "toggle-strategy": {
      const current = state.store.rotationStrategy;
      state.store.rotationStrategy =
        current === "round-robin" ? "least-failures" : "round-robin";
      safeSaveStore();
      refreshStore();
      setStatus(`Strategy: ${state.store.rotationStrategy}`, theme.primary);
      navigate("list");
      break;
    }
    case "theme":
      setPreviewTheme(null);
      navigate("theme-selector");
      break;
    case "export":
      navigate("export-path");
      break;
    case "import":
      navigate("import-path");
      break;
    case "quit":
      if (state.renderer) state.renderer.destroy();
      process.exit(0);
  }
}

export function handleExport(filePath: string): void {
  const theme = getActiveTheme();
  const path = filePath.trim();
  if (!path) {
    setStatus("File path is required", theme.error);
    callRenderApp();
    return;
  }
  try {
    const payload = exportKeys(state.store);
    writeExportFile(payload, path);
    setStatus(
      `Exported ${payload.keys.length} key(s) to ${path}`,
      theme.success,
    );
    navigate("list");
  } catch (err) {
    console.error("[nim-rotator] Export failed:", err);
    setStatus(`Export failed: check file path and permissions`, theme.error);
    callRenderApp();
  }
}

export function handleImportConfirm(value: string): void {
  const theme = getActiveTheme();
  if (value !== "yes" || !state.pendingImportResult) {
    state.pendingImportPath = "";
    state.pendingImportResult = null;
    navigate("list");
    return;
  }
  const { added, skipped } = applyImport(
    state.store,
    state.pendingImportResult.pendingKeys,
  );
  safeSaveStore();
  refreshStore();
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  setStatus(`Import complete: ${parts.join(", ")}`, theme.success);
  state.pendingImportPath = "";
  state.pendingImportResult = null;
  navigate("list");
}

// ---------------------------------------------------------------------------
// Fallback Chain Actions
// ---------------------------------------------------------------------------

export function handleFallbackChainKey(keyName: string): void {
  const chain = state.store.fallbackChain;
  const totalItems = chain.length + 1;

  switch (keyName) {
    case "up":
      state.fallbackChainIndex = Math.max(0, state.fallbackChainIndex - 1);
      callRenderApp();
      break;
    case "down":
      state.fallbackChainIndex = Math.min(
        totalItems - 1,
        state.fallbackChainIndex + 1,
      );
      callRenderApp();
      break;
    case "x": {
      // Remove item
      if (state.fallbackChainIndex < chain.length) {
        chain.splice(state.fallbackChainIndex, 1);
        safeSaveStore();
        refreshStore();
        if (state.fallbackChainIndex >= chain.length) {
          state.fallbackChainIndex = Math.max(0, chain.length - 1);
        }
        callRenderApp();
      }
      break;
    }
    case "j": {
      // Move item down
      const jIndex = state.fallbackChainIndex;
      if (jIndex < chain.length - 1) {
        const temp = chain[jIndex];
        chain[jIndex] = chain[jIndex + 1];
        chain[jIndex + 1] = temp;
        state.fallbackChainIndex = jIndex + 1;
        safeSaveStore();
        refreshStore();
        callRenderApp();
      }
      break;
    }
    case "k": {
      // Move item up
      const kIndex = state.fallbackChainIndex;
      if (kIndex > 0 && kIndex < chain.length) {
        const temp = chain[kIndex];
        chain[kIndex] = chain[kIndex - 1];
        chain[kIndex - 1] = temp;
        state.fallbackChainIndex = kIndex - 1;
        safeSaveStore();
        refreshStore();
        callRenderApp();
      }
      break;
    }
    case "a": {
      // Add new model below current item
      if (state.fallbackChainIndex >= chain.length) {
        // At "Add model" position, just add at end
        state.modelSelectorIndex = 0;
        state.modelSelectorScrollOffset = 0;
        navigate("model-selector");
      } else {
        // Insert below current
        state.modelSelectorIndex = 0;
        state.modelSelectorScrollOffset = 0;
        // We'll insert after the current index when they select a model
        navigate("model-selector");
      }
      break;
    }
    case "b": {
      // Benchmark all models
      startBenchmark();
      break;
    }
    case "return":
    case "enter": {
      if (state.fallbackChainIndex >= chain.length) {
        // "Add model" selected
        state.modelSelectorIndex = 0;
        state.modelSelectorScrollOffset = 0;
        navigate("model-selector");
      }
      break;
    }
  }
}

export async function fetchNimModels(): Promise<void> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      setStatus("Failed to fetch models from NVIDIA NIM", "#FF5555");
      return;
    }
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string }>;
    };
    if (!data.data || !Array.isArray(data.data)) {
      setStatus("Invalid response from NVIDIA NIM", "#FF5555");
      return;
    }
    state.availableModels = data.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
    }));
  } catch (err) {
    console.error("[nim-rotator] Failed to fetch models:", err);
    setStatus("Failed to fetch models from NVIDIA NIM", "#FF5555");
  }
}

export function addFallbackModel(id: string, name: string): void {
  const chain = state.store.fallbackChain;

  // Prevent duplicates (by id, not name, since upstream may have duplicate display names)
  if (chain.some((m) => m.id === id)) {
    setStatus(
      `Model "${name}" (${id}) is already in the fallback chain`,
      getActiveTheme().warning,
    );
    return;
  }

  const insertIndex =
    state.fallbackChainIndex >= chain.length
      ? chain.length
      : state.fallbackChainIndex + 1;

  chain.splice(insertIndex, 0, {
    id, // Use the actual model API ID
    name,
    benchmarkTtfb: undefined,
    benchmarkTps: undefined,
    benchmarkStatus: "idle",
  });

  safeSaveStore();
  refreshStore();
  state.fallbackChainIndex = insertIndex;
}

// ---------------------------------------------------------------------------
// Benchmarking
// ---------------------------------------------------------------------------

let benchmarkSpinnerInterval: ReturnType<typeof setInterval> | null = null;

export async function startBenchmark(): Promise<void> {
  const chain = state.store.fallbackChain;
  for (const m of chain) {
    if (m.benchmarkStatus === "error") m.benchmarkStatus = "idle";
  }
  const modelsToBenchmark = chain.filter((m) => m.benchmarkStatus === "idle");

  if (modelsToBenchmark.length === 0) {
    setStatus("No models to benchmark", getActiveTheme().warning);
    return;
  }

  // Clear any leftover spinner from a previous run before starting a new one
  if (benchmarkSpinnerInterval) {
    clearInterval(benchmarkSpinnerInterval);
    benchmarkSpinnerInterval = null;
  }

  state.benchmarkAbortController = new AbortController();

  // Start spinner animation interval (runs on fallback-chain screen)
  benchmarkSpinnerInterval = setInterval(() => {
    if (state.currentScreen === "fallback-chain") {
      callRenderApp();
    }
  }, 80);

  const batchSize = state.benchmarkBatchSize;
  const batches: (typeof modelsToBenchmark)[] = [];
  for (let i = 0; i < modelsToBenchmark.length; i += batchSize) {
    batches.push(modelsToBenchmark.slice(i, i + batchSize));
  }

  try {
    for (const batch of batches) {
      if (state.benchmarkAbortController.signal.aborted) break;

      await Promise.all(
        batch.map(async (model) => {
          if (state.benchmarkAbortController?.signal.aborted) return;

          model.benchmarkStatus = "running";
          callRenderApp();

          try {
            await benchmarkModel(model, state.benchmarkAbortController!.signal);
            model.benchmarkStatus = "done";
          } catch (err) {
            if (state.benchmarkAbortController?.signal.aborted) {
              model.benchmarkStatus = "idle";
            } else {
              model.benchmarkStatus = "error";
              model.benchmarkError =
                err instanceof Error ? err.message : "Benchmark failed";
            }
          }

          callRenderApp();
        }),
      );

      safeSaveStore();
    }

    safeSaveStore();
    callRenderApp();
  } finally {
    // Always clear the spinner interval, even on exceptions
    if (benchmarkSpinnerInterval) {
      clearInterval(benchmarkSpinnerInterval);
      benchmarkSpinnerInterval = null;
    }
    state.benchmarkAbortController = null;
  }
}

async function benchmarkModel(
  model: FallbackModel,
  signal: AbortSignal,
): Promise<void> {
  const startTime = Date.now();
  const apiKey =
    state.store.keys.find((k) => k.enabled && k.key)?.key ||
    process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    throw new Error("No API key available for benchmarking");
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 30000);
  const onAbort = () => timeoutController.abort();
  signal.addEventListener("abort", onAbort);

  try {
    const res = await fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 50,
          stream: true,
        }),
        signal: timeoutController.signal,
      },
    );

    // TTFB: time from start to first byte received
    model.benchmarkTtfb = Date.now() - startTime;
    callRenderApp();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("Response body is empty");
    }
    let tokenCount = 0;
    const streamStart = Date.now();
    let lastTpsUpdate = streamStart;
    let buffer = "";

    let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const startStreamTimeout = () => {
      streamTimeoutId = setTimeout(async () => {
        try {
          await reader?.cancel();
        } catch {}
      }, 30000);
    };
    startStreamTimeout();

    const decoder = new TextDecoder();

    try {
      while (true) {
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await reader.read();
        } catch (e) {
          if (
            e instanceof Error &&
            (e.name === "AbortError" || e.name === "CanceledError")
          ) {
            throw new Error("Stream timeout");
          }
          throw e;
        }

        const { done, value } = readResult;
        if (done) {
          if (streamTimeoutId) {
            clearTimeout(streamTimeoutId);
            streamTimeoutId = null;
          }
          break;
        }

        if (streamTimeoutId) {
          clearTimeout(streamTimeoutId);
        }
        startStreamTimeout();

        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed?.choices?.[0]?.delta?.content;
              if (content) {
                tokenCount++;
              }
            } catch {}
          }
        }

        const now = Date.now();
        if (now - lastTpsUpdate >= 500) {
          const elapsed = Math.max(1, now - streamStart);
          model.benchmarkTps = (tokenCount / elapsed) * 1000;
          lastTpsUpdate = now;
          callRenderApp();
        }
      }
    } finally {
      if (streamTimeoutId) {
        clearTimeout(streamTimeoutId);
        streamTimeoutId = null;
      }
      try {
        reader.releaseLock();
      } catch {}
    }

    // Final TPS after stream ends
    const streamDuration = Math.max(1, Date.now() - streamStart);
    model.benchmarkTps = (tokenCount / streamDuration) * 1000;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", onAbort);
  }
}

export function cancelBenchmark(): void {
  const c = state.benchmarkAbortController;
  if (c) c.abort();
  if (benchmarkSpinnerInterval) {
    clearInterval(benchmarkSpinnerInterval);
    benchmarkSpinnerInterval = null;
  }
}
