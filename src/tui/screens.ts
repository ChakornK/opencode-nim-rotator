import { Box, Text } from "@opentui/core";
import {
  getActiveTheme,
  getTheme,
  getResolvedTheme,
  getThemeOverride,
  listThemes,
  saveThemeOverride,
  setPreviewTheme,
  dangerSelectColors,
} from "../themes.js";
import {
  addKey,
  getActiveKeys,
  getMaxFailures,
  removeKey,
  renameKey,
  resetFailures,
  saveStore,
  toggleKey,
} from "../storage.js";
import {
  state,
  navigate,
  callRenderApp,
  refreshStore,
  setStatus,
  clampIndex,
} from "./state.js";
import {
  themedSelect,
  themedInput,
  events,
  maskKey,
  applyThemeToScreen,
} from "./ui.js";
import type { ScreenContent, SelectOption } from "./types.js";
import { handleMenuSelect, handleKeyAction } from "./actions.js";

function keyStatus(entry: { enabled: boolean; failureCount: number }): string {
  const maxFails = getMaxFailures();
  return !entry.enabled
    ? "OFF"
    : entry.failureCount >= maxFails
      ? "FAIL"
      : "OK";
}

// ---------------------------------------------------------------------------
// Main Menu
// ---------------------------------------------------------------------------

export function buildMainMenu(): ScreenContent {
  const { store } = state;
  const hasKeys = store.keys.length > 0;
  const theme = getActiveTheme();
  const override = getThemeOverride();

  const opts: (SelectOption | false)[] = [
    hasKeys && {
      name: "Manage Keys",
      description: "Select a key to rename, delete, or toggle",
      value: "manage",
    },
    {
      name: "Add Key",
      description: "Add a new NVIDIA NIM API key",
      value: "add",
    },
    hasKeys && {
      name: "Reset Failures",
      description: "Reset all failure counts to zero",
      value: "reset-failures",
    },
    {
      name: `Strategy: ${store.rotationStrategy}`,
      description: "Toggle between round-robin and least-failures",
      value: "toggle-strategy",
    },
    {
      name: `Theme: ${theme.name}${!override ? " (synced with opencode)" : ""}`,
      description: "Change the color theme",
      value: "theme",
    },
    { name: "Quit", description: "Exit the key manager", value: "quit" },
  ];
  const options = opts.filter(Boolean) as SelectOption[];

  state.mainMenuIndex = clampIndex(state.mainMenuIndex, options.length);

  const menu = themedSelect(
    "main-menu",
    56,
    12,
    options,
    state.mainMenuIndex,
    (idx, opt) => {
      state.mainMenuIndex = idx;
      handleMenuSelect(opt.value);
    },
  );

  return { element: menu, helpText: "[Ctrl+C] quit" };
}

// ---------------------------------------------------------------------------
// Key Selector
// ---------------------------------------------------------------------------

export function buildKeySelector(): ScreenContent {
  const options: SelectOption[] = state.store.keys.map((entry) => ({
    name: `${entry.name} [${keyStatus(entry)}]`,
    description: `${maskKey(entry.key)} fails:${entry.failureCount} ${entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleString() : "never used"}`,
    value: entry.id,
  }));

  if (options.length === 0) {
    navigate("list");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  state.keySelectorIndex = clampIndex(state.keySelectorIndex, options.length);

  const selector = themedSelect(
    "key-selector",
    64,
    12,
    options,
    state.keySelectorIndex,
    (idx, opt) => {
      state.keySelectorIndex = idx;
      state.selectedKeyId = opt.value;
      state.keyActionsIndex = 0;
      navigate("key-actions");
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({
        content: " Select a key to manage:",
        fg: getActiveTheme().primary,
      }),
      selector,
    ),
    helpText: "[Esc] back",
  };
}

// ---------------------------------------------------------------------------
// Key Actions
// ---------------------------------------------------------------------------

export function buildKeyActions(): ScreenContent {
  const { selectedKeyId } = state;
  if (!selectedKeyId) {
    navigate("key-selector");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  const entry = state.store.keys.find((k) => k.id === selectedKeyId);
  if (!entry) {
    state.selectedKeyId = null;
    navigate("key-selector");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  const options: SelectOption[] = [
    {
      name: `Toggle ${entry.enabled ? "OFF" : "ON"}`,
      description: `${entry.enabled ? "Disable" : "Enable"} this key`,
      value: "toggle",
    },
    {
      name: "Rename",
      description: "Change the friendly name",
      value: "rename",
    },
    {
      name: "Delete",
      description: "Remove this key permanently",
      value: "delete",
    },
    { name: "Back", description: "Return to key list", value: "back" },
  ];

  state.keyActionsIndex = clampIndex(state.keyActionsIndex, options.length);

  const actions = themedSelect(
    "key-actions",
    40,
    8,
    options,
    state.keyActionsIndex,
    (idx, opt) => {
      state.keyActionsIndex = idx;
      handleKeyAction(opt.value);
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({
        content: ` Key: ${entry.name} (${maskKey(entry.key)})`,
        fg: getActiveTheme().primary,
      }),
      actions,
    ),
    helpText: "[Esc] back",
  };
}

// ---------------------------------------------------------------------------
// Theme Selector
// ---------------------------------------------------------------------------

export function buildThemeSelector(): ScreenContent {
  const theme = getActiveTheme();
  const allThemes = listThemes();
  const currentOverride = getThemeOverride();
  const resolvedId = getResolvedTheme().id;
  const activeId = theme.id;

  const options: SelectOption[] = [
    {
      name: "sync",
      description: "Sync with opencode theme (default)",
      value: "sync",
    },
    ...allThemes.map((th) => ({
      name: th.id,
      description: `${th.name}${th.id === activeId ? " *" : ""}${th.id === resolvedId && !currentOverride ? " (opencode)" : ""}`,
      value: th.id,
    })),
  ];

  state.themeSelectorIndex = clampIndex(
    currentOverride ? options.findIndex((o) => o.value === currentOverride) : 0,
    options.length,
  );

  const selector = themedSelect(
    "theme-selector",
    56,
    12,
    options,
    state.themeSelectorIndex,
    (_index, option) => {
      state.themeSelectorIndex = _index;
      setPreviewTheme(null);
      if (option.value === "sync") {
        saveThemeOverride("");
        setStatus("Theme synced with opencode", theme.success);
      } else {
        saveThemeOverride(option.value);
        setStatus(`Theme set to ${option.value}`, theme.success);
      }
      refreshStore();
      navigate("list");
    },
  );

  events(selector).on("selectionChanged" as any, (index: number) => {
    state.themeSelectorIndex = index;
    const option = options[index];
    if (!option) return;
    const previewId =
      option.value === "sync" ? getResolvedTheme().id : option.value;
    setPreviewTheme(previewId);
    applyThemeToScreen(getTheme(previewId));
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({
        id: "theme-label",
        content: " Select a theme:",
        fg: theme.primary,
      }),
      selector,
    ),
    helpText: "[Esc] back  [Enter] apply",
  };
}

// ---------------------------------------------------------------------------
// Confirm Delete
// ---------------------------------------------------------------------------

export function buildConfirmDelete(): ScreenContent {
  const entry = state.store.keys.find((k) => k.id === state.deleteTargetId);
  const name = entry?.name ?? "this key";

  const options: SelectOption[] = [
    {
      name: "Yes, delete",
      description: `Permanently remove "${name}"`,
      value: "yes",
    },
    { name: "No, cancel", description: "Keep the key", value: "no" },
  ];

  const confirm = themedSelect(
    "confirm-delete",
    40,
    6,
    options,
    0,
    (_index, option) => {
      if (option.value === "yes" && state.deleteTargetId) {
        const e = state.store.keys.find((k) => k.id === state.deleteTargetId);
        const n = e?.name ?? "key";
        removeKey(state.store, state.deleteTargetId);
        saveStore(state.store);
        refreshStore();
        if (state.keySelectorIndex >= state.store.keys.length)
          state.keySelectorIndex = Math.max(0, state.store.keys.length - 1);
        setStatus(`Deleted "${n}"`, getActiveTheme().error);
      }
      state.deleteTargetId = null;
      navigate("key-actions");
    },
    dangerSelectColors(getActiveTheme()),
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({
        content: "Are you sure you want to delete this key?",
        fg: getActiveTheme().error,
      }),
      confirm,
    ),
    helpText: "[Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Add Name Input
// ---------------------------------------------------------------------------

export function buildAddNameInput(): ScreenContent {
  const theme = getActiveTheme();
  const input = themedInput(
    "add-name-input",
    "e.g. work-key, personal, team-alpha",
    40,
  );

  events(input).on("enter" as any, (value: string) => {
    state.pendingKeyName = value.trim();
    if (!state.pendingKeyName) {
      setStatus("Name is required", theme.error);
      callRenderApp();
      return;
    }
    if (state.store.keys.some((k) => k.name === state.pendingKeyName)) {
      setStatus("A key with this name already exists", theme.error);
      callRenderApp();
      return;
    }
    navigate("add-key");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: "Enter a friendly name for this key:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] next  [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Add Key Input
// ---------------------------------------------------------------------------

export function buildAddKeyInput(): ScreenContent {
  const theme = getActiveTheme();
  const input = themedInput("add-key-input", "nvapi-...", 55);

  events(input).on("enter" as any, (value: string) => {
    const key = value.trim();
    if (!key) {
      setStatus("API key is required", theme.error);
      callRenderApp();
      return;
    }
    if (!key.startsWith("nvapi-")) {
      setStatus("Key must start with 'nvapi-'", theme.error);
      callRenderApp();
      return;
    }
    addKey(state.store, state.pendingKeyName, key);
    saveStore(state.store);
    refreshStore();
    setStatus(`Added key "${state.pendingKeyName}"`, theme.success);
    state.pendingKeyName = "";
    navigate("list");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: `Name: ${state.pendingKeyName}`, fg: theme.primary }),
      Text({ content: "Enter the NVIDIA NIM API key:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] confirm  [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Rename Input
// ---------------------------------------------------------------------------

export function buildRenameInput(): ScreenContent {
  const theme = getActiveTheme();
  if (!state.renameTargetId) {
    return {
      element: Text({ content: "Error: no key selected", fg: theme.error }),
      helpText: "",
    };
  }
  const entry = state.store.keys.find((k) => k.id === state.renameTargetId);
  const currentName = entry?.name ?? "";

  const input = themedInput("rename-input", "New friendly name", 40);
  (input as any).value = currentName;

  events(input).on("enter" as any, (value: string) => {
    const newName = value.trim();
    if (!newName) {
      setStatus("Name is required", theme.error);
      callRenderApp();
      return;
    }
    if (
      state.store.keys.some(
        (k) => k.name === newName && k.id !== state.renameTargetId,
      )
    ) {
      setStatus("A key with this name already exists", theme.error);
      callRenderApp();
      return;
    }
    renameKey(state.store, state.renameTargetId!, newName);
    saveStore(state.store);
    refreshStore();
    setStatus(`Renamed to "${newName}"`, theme.success);
    state.renameTargetId = null;
    navigate("key-actions");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: "Enter new name:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] confirm  [Esc] cancel",
  };
}
