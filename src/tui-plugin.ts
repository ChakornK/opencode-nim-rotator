import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { KeyStore, ApiKeyEntry, ModelBlacklistEntry } from "./types.js";
import {
  loadStore,
  saveStore,
  resetFailures,
  resetRateLimit,
  toggleKey,
  clearModelBlacklist,
  pruneAllExpiredBlacklists,
} from "./storage.js";
import {
  loadStoreReadonly,
  getStorePath,
  formatKeyStatus,
  getBlacklistedModels,
} from "./storage-readonly.js";

type SelectOption<Value = unknown> = {
  title: string;
  value: Value;
  description?: string;
  footer?: string;
  disabled?: boolean;
};

type DialogSelectProps<Value = unknown> = {
  title: string;
  placeholder?: string;
  options: SelectOption<Value>[];
  flat?: boolean;
  onMove?: (option: SelectOption<Value>) => void;
  onFilter?: (query: string) => void;
  onSelect?: (option: SelectOption<Value>) => void;
  skipFilter?: boolean;
  current?: Value;
};

function getConfigDir(api: TuiPluginApi): string | undefined {
  try {
    if (api.state?.ready && api.state?.path?.config) {
      return api.state.path.config;
    }
  } catch {}
  return undefined;
}

function loadFullStore(configDir?: string): KeyStore | null {
  const storePath = getStorePath(configDir);
  try {
    return loadStore({ storePath });
  } catch {
    return null;
  }
}

function saveFullStore(store: KeyStore, configDir?: string): boolean {
  const storePath = getStorePath(configDir);
  try {
    pruneAllExpiredBlacklists(store);
    saveStore(store, { storePath });
    return true;
  } catch {
    return false;
  }
}

function showStatusDialog(api: TuiPluginApi) {
  const configDir = getConfigDir(api);
  const store = loadStoreReadonly(configDir);
  if (!store) {
    api.ui.toast({
      variant: "warning",
      title: "NIM Key Rotator",
      message: "No key store found. Run `bun opencode-nim-rotator` in a terminal to add keys.",
      duration: 5000,
    });
    return;
  }

  const now = Date.now();
  const active = store.keys.filter((k) => k.enabled);
  const blacklisted = getBlacklistedModels(store.keys, now);
  const strategy = store.rotationStrategy ?? "round-robin";

  const options: SelectOption<string>[] = [];

  for (const k of store.keys) {
    const enabled = k.enabled ? "ON" : "OFF";
    const rateStr = k.rateLimitCount > 0 ? ` | ${k.rateLimitCount} rate-limits` : "";
    const keyBlacklists = blacklisted.filter((b) => b.keyId === k.id);
    const blStr = keyBlacklists.length > 0
      ? ` | BL: ${keyBlacklists.map((b) => `${b.modelId} (${b.remainingSecs}s)`).join(", ")}`
      : "";
    options.push({
      title: `${k.name}  [${enabled}]`,
      value: k.id,
      description: `${strategy}${rateStr}${blStr}`,
      disabled: !k.enabled,
    });
  }

  if (store.fallbackChain.length > 0) {
    const chain = store.fallbackChain.map((m) => m.name).join(" → ");
    options.push({
      title: "Fallback Chain",
      value: "__fallback__",
      description: chain,
    });
  }

  if (blacklisted.length > 0) {
    options.push({
      title: `Blacklisted Models (${blacklisted.length})`,
      value: "__blacklisted__",
      description: "View and clear blacklisted models",
    });
  }

  options.push({
    title: "Reset All Rate Limits",
    value: "__reset_all__",
    description: "Clear all rate limit counts and blacklists",
  });

  options.push({
    title: "Close",
    value: "__close__",
  });

  api.ui.dialog.replace(() => {
    return (api.ui as any).DialogSelect({
      title: `NIM Key Rotator — ${active.length}/${store.keys.length} active | ${strategy}`,
      options,
      flat: true,
      skipFilter: true,
      onSelect: (opt: SelectOption<string>) => {
        const val = opt.value;
        if (val === "__close__") {
          api.ui.dialog.clear();
          return;
        }
        if (val === "__fallback__") {
          showFallbackChainDialog(api);
          return;
        }
        if (val === "__blacklisted__") {
          showBlacklistedDialog(api);
          return;
        }
        if (val === "__reset_all__") {
          showResetAllConfirmDialog(api);
          return;
        }
        showKeyDetailDialog(api, val);
      },
    }) as any;
  });
}

function showKeyDetailDialog(api: TuiPluginApi, keyId: string) {
  const configDir = getConfigDir(api);
  const store = loadFullStore(configDir);
  if (!store) {
    api.ui.dialog.clear();
    return;
  }

  const entry = store.keys.find((k) => k.id === keyId);
  if (!entry) {
    api.ui.dialog.clear();
    return;
  }

  const now = Date.now();
  const keyBlacklists = getBlacklistedModels([entry], now);

  const options: SelectOption<string>[] = [
    {
      title: `Toggle ${entry.enabled ? "OFF" : "ON"}`,
      value: "toggle",
      description: `${entry.enabled ? "Disable" : "Enable"} this key`,
    },
  ];

  if (entry.rateLimitCount > 0) {
    options.push({
      title: "Reset Rate Limit Count",
      value: "reset-rates",
      description: `Current: ${entry.rateLimitCount} rate-limits`,
    });
  }

  for (const bl of keyBlacklists) {
    options.push({
      title: `Clear Blacklist: ${bl.modelId}`,
      value: `clear-bl:${bl.modelId}`,
      description: `${bl.remainingSecs}s remaining | next: ${(bl.nextDurationMs / 1000).toFixed(1)}s`,
    });
  }

  options.push({
    title: "Back",
    value: "back",
  });

  api.ui.dialog.replace(() => {
    return (api.ui as any).DialogSelect({
      title: `Key: ${entry.name} [${entry.enabled ? "ON" : "OFF"}]`,
      options,
      flat: true,
      skipFilter: true,
      onSelect: (opt: SelectOption<string>) => {
        const action = opt.value;
        let didSave = false;

        if (action === "toggle") {
          toggleKey(store, keyId);
          didSave = true;
        } else if (action === "reset-rates") {
          resetRateLimit(store, keyId);
          didSave = true;
        } else if (action.startsWith("clear-bl:")) {
          const modelId = action.slice("clear-bl:".length);
          clearModelBlacklist(store, keyId, modelId);
          didSave = true;
        } else if (action === "back") {
          showStatusDialog(api);
          return;
        }

        if (didSave) {
          saveFullStore(store, configDir);
          api.ui.toast({
            variant: "success",
            title: "NIM Key Rotator",
            message: `Updated key "${entry.name}"`,
            duration: 2000,
          });
          showKeyDetailDialog(api, keyId);
        }
      },
    }) as any;
  });
}

function showBlacklistedDialog(api: TuiPluginApi) {
  const configDir = getConfigDir(api);
  const store = loadStoreReadonly(configDir);
  if (!store) {
    api.ui.dialog.clear();
    return;
  }

  const now = Date.now();
  const blacklisted = getBlacklistedModels(store.keys, now);

  if (blacklisted.length === 0) {
    api.ui.dialog.clear();
    api.ui.toast({
      variant: "info",
      title: "NIM Key Rotator",
      message: "No blacklisted models",
      duration: 3000,
    });
    return;
  }

  const options: SelectOption<string>[] = blacklisted.map((bl) => ({
    title: `${bl.keyName}: ${bl.modelId}`,
    value: `${bl.keyId}:${bl.modelId}`,
    description: `${bl.remainingSecs}s remaining | next: ${(bl.nextDurationMs / 1000).toFixed(1)}s`,
  }));

  options.push({
    title: "Clear All Blacklists",
    value: "__clear_all__",
    description: "Remove all model blacklists from all keys",
  });

  options.push({
    title: "Back",
    value: "__back__",
  });

  api.ui.dialog.replace(() => {
    return (api.ui as any).DialogSelect({
      title: "Blacklisted Models",
      options,
      flat: true,
      skipFilter: true,
      onSelect: (opt: SelectOption<string>) => {
        const val = opt.value;
        if (val === "__back__") {
          showStatusDialog(api);
          return;
        }
        if (val === "__clear_all__") {
          const fullStore = loadFullStore(configDir);
          if (fullStore) {
            for (const k of fullStore.keys) {
              delete k.modelBlacklist;
            }
            saveFullStore(fullStore, configDir);
            api.ui.toast({
              variant: "success",
              title: "NIM Key Rotator",
              message: "All model blacklists cleared",
              duration: 3000,
            });
          }
          showBlacklistedDialog(api);
          return;
        }
        const colonIdx = val.indexOf(":");
        if (colonIdx < 0) return;
        const keyId = val.slice(0, colonIdx);
        const modelId = val.slice(colonIdx + 1);
        const fullStore = loadFullStore(configDir);
        if (fullStore) {
          clearModelBlacklist(fullStore, keyId, modelId);
          saveFullStore(fullStore, configDir);
          api.ui.toast({
            variant: "success",
            title: "NIM Key Rotator",
            message: `Cleared blacklist for ${modelId}`,
            duration: 2000,
          });
        }
        showBlacklistedDialog(api);
      },
    }) as any;
  });
}

function showResetAllConfirmDialog(api: TuiPluginApi) {
  api.ui.dialog.replace(() => {
    return (api.ui as any).DialogConfirm({
      title: "Reset All Rate Limits?",
      message: "This will reset all rate limit counts and clear all model blacklists for every key.",
      onConfirm: () => {
        const configDir = getConfigDir(api);
        const store = loadFullStore(configDir);
        if (store) {
          resetFailures(store);
          saveFullStore(store, configDir);
          api.ui.toast({
            variant: "success",
            title: "NIM Key Rotator",
            message: "All rate limits and blacklists reset",
            duration: 3000,
          });
        }
        api.ui.dialog.clear();
      },
      onCancel: () => {
        showStatusDialog(api);
      },
    }) as any;
  });
}

function showFallbackChainDialog(api: TuiPluginApi) {
  const configDir = getConfigDir(api);
  const store = loadStoreReadonly(configDir);
  if (!store) {
    api.ui.dialog.clear();
    return;
  }

  const chain = store.fallbackChain;
  if (chain.length === 0) {
    api.ui.dialog.clear();
    api.ui.toast({
      variant: "info",
      title: "NIM Key Rotator",
      message: "No fallback chain configured. Use the CLI to add models:\n  bun opencode-nim-rotator",
      duration: 5000,
    });
    return;
  }

  const options: SelectOption<string>[] = chain.map((m, i) => {
    let benchStr = "";
    if (m.benchmarkStatus === "done" && m.benchmarkTtfb != null && m.benchmarkTps != null) {
      benchStr = ` | ${m.benchmarkTtfb.toFixed(0)}ms TTFB, ${m.benchmarkTps.toFixed(1)} TPS`;
    } else if (m.benchmarkStatus === "running") {
      benchStr = " | benchmarking...";
    } else if (m.benchmarkStatus === "error") {
      benchStr = ` | error: ${m.benchmarkError ?? "unknown"}`;
    }
    return {
      title: `${i + 1}. ${m.name}`,
      value: m.id,
      description: `ID: ${m.id}${benchStr}`,
    };
  });

  options.push({
    title: "Edit Chain (CLI)",
    value: "__cli__",
    description: "Open the CLI manager to edit the fallback chain",
  });

  options.push({
    title: "Back",
    value: "__back__",
  });

  api.ui.dialog.replace(() => {
    return (api.ui as any).DialogSelect({
      title: "Fallback Chain",
      options,
      flat: true,
      skipFilter: true,
      onSelect: (opt: SelectOption<string>) => {
        const val = opt.value;
        if (val === "__back__") {
          showStatusDialog(api);
          return;
        }
        if (val === "__cli__") {
          api.ui.dialog.clear();
          api.ui.toast({
            variant: "info",
            title: "NIM Key Rotator",
            message: "Run in a terminal:\n  bun opencode-nim-rotator\n\nThen go to the Fallback tab to edit the chain.",
            duration: 6000,
          });
          return;
        }
        const model = chain.find((m) => m.id === val);
        if (model) {
          const modelInfo = [
            `Name: ${model.name}`,
            `ID: ${model.id}`,
            `Position in chain: ${chain.findIndex((m) => m.id === val) + 1}/${chain.length}`,
          ];
          if (model.benchmarkTtfb != null) modelInfo.push(`TTFB: ${model.benchmarkTtfb.toFixed(0)}ms`);
          if (model.benchmarkTps != null) modelInfo.push(`TPS: ${model.benchmarkTps.toFixed(1)}`);
          api.ui.dialog.clear();
          api.ui.toast({
            variant: "info",
            title: "NIM Key Rotator",
            message: modelInfo.join("\n"),
            duration: 5000,
          });
        }
      },
    }) as any;
  });
}

const NimRotatorTuiPlugin: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "nim-rotator.status",
        title: "NIM Key Rotator: Status",
        category: "System",
        namespace: "palette",
        run() {
          showStatusDialog(api);
        },
      },
      {
        name: "nim-rotator.manage-keys",
        title: "NIM Key Rotator: Manage Keys",
        category: "System",
        namespace: "palette",
        run() {
          showStatusDialog(api);
        },
      },
      {
        name: "nim-rotator.blacklisted",
        title: "NIM Key Rotator: Blacklisted Models",
        category: "System",
        namespace: "palette",
        run() {
          showBlacklistedDialog(api);
        },
      },
      {
        name: "nim-rotator.reset-rates",
        title: "NIM Key Rotator: Reset Rate Limits",
        category: "System",
        namespace: "palette",
        run() {
          showResetAllConfirmDialog(api);
        },
      },
      {
        name: "nim-rotator.fallback-chain",
        title: "NIM Key Rotator: Fallback Chain",
        category: "System",
        namespace: "palette",
        run() {
          showFallbackChainDialog(api);
        },
      },
    ],
    bindings: {
      "nim-rotator.status": [["n", "s"]],
      "nim-rotator.blacklisted": [["n", "b"]],
      "nim-rotator.reset-rates": [["n", "r"]],
      "nim-rotator.fallback-chain": [["n", "f"]],
      "nim-rotator.manage-keys": [["n", "m"]],
    },
  });
};

const tuiPluginModule: TuiPluginModule = {
  id: "nim-rotator-tui",
  tui: NimRotatorTuiPlugin,
};

export default tuiPluginModule;
export { NimRotatorTuiPlugin };
