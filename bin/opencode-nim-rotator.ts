#!/usr/bin/env bun

import { createCliRenderer, Text, Box, Input, Select } from "@opentui/core";
import type { VNode } from "@opentui/core";
import type { KeyStore } from "../src/types.js";
import {
  loadStore,
  saveStore,
  addKey,
  removeKey,
  renameKey,
  toggleKey,
  resetFailures,
  getActiveKeys,
  getMaxFailures,
} from "../src/storage.js";
import {
  getActiveTheme,
  getTheme,
  listThemes,
  saveThemeOverride,
  getThemeOverride,
  getResolvedTheme,
  setPreviewTheme,
  selectColors,
  inputColors,
  dangerSelectColors,
  applySelectColors,
} from "../src/themes.js";
import type { RotatorTheme } from "../src/themes.js";

// --- types ---

type Screen =
  | "list"
  | "key-selector"
  | "key-actions"
  | "add-name"
  | "add-key"
  | "rename"
  | "confirm-delete"
  | "theme-selector";

interface SelectOption {
  name: string;
  description: string;
  value: string;
}

interface ScreenContent {
  element: VNode;
  helpText: string;
}

// --- helpers ---

const renderer = await createCliRenderer({ exitOnCtrlC: false });

let store = loadStore() as KeyStore;
let currentScreen: Screen = "list";
let deleteTargetId: string | null = null;
let renameTargetId: string | null = null;
let pendingKeyName = "";
let selectedKeyId: string | null = null;
let statusMessage = "";
let statusColor = "#888888";
let focusTargetId: string | null = null;
let mainMenuIndex = 0;
let keySelectorIndex = 0;
let keyActionsIndex = 0;
let themeSelectorIndex = 0;
let isRendering = false;
let renderPending = false;

function t(): RotatorTheme {
  return getActiveTheme();
}
function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function refreshStore(): void {
  store = loadStore() as KeyStore;
}
function setStatus(msg: string, color?: string): void {
  statusMessage = msg;
  statusColor = color ?? t().textMuted;
}
function clampIndex(index: number, length: number): number {
  return index >= length ? Math.max(0, length - 1) : index;
}
function navigate(screen: Screen): void {
  currentScreen = screen;
  renderApp();
}

function events(vnode: VNode): VNode & Record<string, any> {
  return vnode as any;
}

function asRenderable<T>(id: string): any {
  return renderer.root.findDescendantById(id);
}

// --- component factories ---

function themedSelect(
  id: string,
  width: number,
  height: number,
  options: SelectOption[],
  index: number,
  onItemSelected: (_index: number, option: SelectOption) => void,
  colors?: ReturnType<typeof selectColors>,
): VNode {
  const c = colors ?? selectColors(t());
  const sel = Select({
    id,
    width,
    height,
    options,
    selectedIndex: index,
    backgroundColor: c.backgroundColor,
    focusedBackgroundColor: c.focusedBackgroundColor,
    focusedTextColor: c.focusedTextColor,
    selectedBackgroundColor: c.selectedBackgroundColor,
    selectedTextColor: c.selectedTextColor,
    textColor: c.textColor,
    descriptionColor: c.descriptionColor,
    selectedDescriptionColor: c.selectedDescriptionColor,
  });
  events(sel).on("itemSelected" as any, onItemSelected);
  focusTargetId = id;
  return sel;
}

function themedInput(
  id: string,
  placeholder: string,
  width: number,
): VNode & { value: string } {
  const c = inputColors(t());
  focusTargetId = id;
  return Input({
    id,
    placeholder,
    width,
    backgroundColor: c.backgroundColor,
    focusedBackgroundColor: c.focusedBackgroundColor,
    textColor: c.textColor,
    cursorColor: c.cursorColor,
  }) as any;
}

// --- screen content builders ---

function buildMainMenu(): ScreenContent {
  const theme = t();
  const options: SelectOption[] = [];
  if (store.keys.length > 0) {
    options.push({
      name: "Manage Keys",
      description: "Select a key to rename, delete, or toggle",
      value: "manage",
    });
  }
  options.push({
    name: "Add Key",
    description: "Add a new NVIDIA NIM API key",
    value: "add",
  });
  if (store.keys.length > 0) {
    options.push({
      name: "Reset Failures",
      description: "Reset all failure counts to zero",
      value: "reset-failures",
    });
  }
  options.push({
    name: `Strategy: ${store.rotationStrategy}`,
    description: "Toggle between round-robin and least-failures",
    value: "toggle-strategy",
  });
  options.push({
    name: `Theme: ${theme.name}`,
    description: "Change the color theme (syncs with opencode)",
    value: "theme",
  });
  options.push({
    name: "Quit",
    description: "Exit the key manager",
    value: "quit",
  });

  mainMenuIndex = clampIndex(mainMenuIndex, options.length);

  const menu = themedSelect(
    "main-menu",
    56,
    12,
    options,
    mainMenuIndex,
    (_index, option) => {
      mainMenuIndex = _index;
      handleMenuSelect(option.value);
    },
  );

  return { element: menu, helpText: "[Ctrl+C] quit" };
}

function buildKeySelector(): ScreenContent {
  const options: SelectOption[] = store.keys.map((entry) => {
    const status = !entry.enabled
      ? "OFF"
      : entry.failureCount >= getMaxFailures()
        ? "FAIL"
        : "OK";
    return {
      name: `${entry.name} [${status}]`,
      description: `${maskKey(entry.key)} fails:${entry.failureCount} ${entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleString() : "never used"}`,
      value: entry.id,
    };
  });

  if (options.length === 0) {
    navigate("list");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  keySelectorIndex = clampIndex(keySelectorIndex, options.length);

  const selector = themedSelect(
    "key-selector",
    64,
    12,
    options,
    keySelectorIndex,
    (index, option) => {
      keySelectorIndex = index;
      selectedKeyId = option.value;
      keyActionsIndex = 0;
      navigate("key-actions");
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: " Select a key to manage:", fg: t().primary }),
      selector,
    ),
    helpText: "[Esc] back",
  };
}

function buildKeyActions(): ScreenContent {
  const theme = t();
  if (!selectedKeyId) {
    navigate("key-selector");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }
  const entry = store.keys.find((k) => k.id === selectedKeyId);
  if (!entry) {
    selectedKeyId = null;
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

  keyActionsIndex = clampIndex(keyActionsIndex, options.length);

  const actions = themedSelect(
    "key-actions",
    40,
    8,
    options,
    keyActionsIndex,
    (_index, option) => {
      keyActionsIndex = _index;
      handleKeyAction(option.value);
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({
        content: ` Key: ${entry.name} (${maskKey(entry.key)})`,
        fg: theme.primary,
      }),
      actions,
    ),
    helpText: "[Esc] back",
  };
}

function buildThemeSelector(): ScreenContent {
  const theme = t();
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
    ...allThemes.map((th) => {
      let desc = th.name;
      if (th.id === activeId) desc += " *";
      if (th.id === resolvedId && !currentOverride) desc += " (opencode)";
      return { name: th.id, description: desc, value: th.id };
    }),
  ];

  themeSelectorIndex = clampIndex(
    currentOverride ? options.findIndex((o) => o.value === currentOverride) : 0,
    options.length,
  );

  const selector = themedSelect(
    "theme-selector",
    56,
    12,
    options,
    themeSelectorIndex,
    (_index, option) => {
      themeSelectorIndex = _index;
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
    themeSelectorIndex = index;
    const option = options[index];
    if (!option) return;
    const previewId =
      option.value === "sync" ? getResolvedTheme().id : option.value;
    setPreviewTheme(previewId);
    applyThemeToScreen(getTheme(previewId));
  });

  const wrapper = Box(
    { flexDirection: "column", gap: 1 },
    Text({ id: "theme-label", content: " Select a theme:", fg: theme.primary }),
    selector,
  );

  return { element: wrapper, helpText: "[Esc] back  [Enter] apply" };
}

function buildConfirmDelete(): ScreenContent {
  const theme = t();
  const entry = store.keys.find((k) => k.id === deleteTargetId);
  const name = entry?.name ?? "this key";

  const options: SelectOption[] = [
    {
      name: "Yes, delete",
      description: `Permanently remove "${name}"`,
      value: "yes",
    },
    { name: "No, cancel", description: "Keep the key", value: "no" },
  ];

  const confirmSelect = themedSelect(
    "confirm-delete",
    40,
    6,
    options,
    0,
    (_index, option) => {
      if (option.value === "yes" && deleteTargetId) {
        const e = store.keys.find((k) => k.id === deleteTargetId);
        const n = e?.name ?? "key";
        removeKey(store, deleteTargetId);
        saveStore(store);
        refreshStore();
        if (keySelectorIndex >= store.keys.length)
          keySelectorIndex = Math.max(0, store.keys.length - 1);
        setStatus(`Deleted "${n}"`, theme.error);
      }
      deleteTargetId = null;
      navigate("key-actions");
    },
    dangerSelectColors(theme),
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({
        content: "Are you sure you want to delete this key?",
        fg: theme.error,
      }),
      confirmSelect,
    ),
    helpText: "[Esc] cancel",
  };
}

function buildAddNameInput(): ScreenContent {
  const theme = t();
  const input = themedInput(
    "add-name-input",
    "e.g. work-key, personal, team-alpha",
    40,
  );

  events(input).on("enter" as any, (value: string) => {
    pendingKeyName = value.trim();
    if (!pendingKeyName) {
      setStatus("Name is required", theme.error);
      renderApp();
      return;
    }
    if (store.keys.some((k) => k.name === pendingKeyName)) {
      setStatus("A key with this name already exists", theme.error);
      renderApp();
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

function buildAddKeyInput(): ScreenContent {
  const theme = t();
  const input = themedInput("add-key-input", "nvapi-...", 55);

  events(input).on("enter" as any, (value: string) => {
    const key = value.trim();
    if (!key) {
      setStatus("API key is required", theme.error);
      renderApp();
      return;
    }
    if (!key.startsWith("nvapi-")) {
      setStatus("Key must start with 'nvapi-'", theme.error);
      renderApp();
      return;
    }
    addKey(store, pendingKeyName, key);
    saveStore(store);
    refreshStore();
    setStatus(`Added key "${pendingKeyName}"`, theme.success);
    pendingKeyName = "";
    navigate("list");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: `Name: ${pendingKeyName}`, fg: theme.primary }),
      Text({ content: "Enter the NVIDIA NIM API key:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] confirm  [Esc] cancel",
  };
}

function buildRenameInput(): ScreenContent {
  const theme = t();
  if (!renameTargetId)
    return {
      element: Text({ content: "Error: no key selected", fg: theme.error }),
      helpText: "",
    };
  const entry = store.keys.find((k) => k.id === renameTargetId);
  const currentName = entry?.name ?? "";

  const input = themedInput("rename-input", "New friendly name", 40);
  (input as any).value = currentName;

  events(input).on("enter" as any, (value: string) => {
    const newName = value.trim();
    if (!newName) {
      setStatus("Name is required", theme.error);
      renderApp();
      return;
    }
    if (store.keys.some((k) => k.name === newName && k.id !== renameTargetId)) {
      setStatus("A key with this name already exists", theme.error);
      renderApp();
      return;
    }
    renameKey(store, renameTargetId!, newName);
    saveStore(store);
    refreshStore();
    setStatus(`Renamed to "${newName}"`, theme.success);
    renameTargetId = null;
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

// --- action handlers ---

function handleKeyAction(action: string): void {
  if (!selectedKeyId) return;
  const entry = store.keys.find((k) => k.id === selectedKeyId);
  const theme = t();

  switch (action) {
    case "toggle":
      if (entry) {
        toggleKey(store, selectedKeyId);
        saveStore(store);
        refreshStore();
        setStatus(
          `Toggled "${entry.name}" ${entry.enabled ? "OFF" : "ON"}`,
          theme.success,
        );
      }
      navigate("key-actions");
      break;
    case "rename":
      renameTargetId = selectedKeyId;
      navigate("rename");
      break;
    case "delete":
      deleteTargetId = selectedKeyId;
      navigate("confirm-delete");
      break;
    case "back":
      navigate("key-selector");
      break;
  }
}

function handleMenuSelect(value: string): void {
  const theme = t();
  switch (value) {
    case "add":
      navigate("add-name");
      break;
    case "manage":
      navigate("key-selector");
      break;
    case "reset-failures":
      resetFailures(store);
      saveStore(store);
      refreshStore();
      setStatus("All failure counts reset", theme.success);
      navigate("list");
      break;
    case "toggle-strategy":
      store.rotationStrategy =
        store.rotationStrategy === "round-robin"
          ? "least-failures"
          : "round-robin";
      saveStore(store);
      refreshStore();
      setStatus(`Strategy: ${store.rotationStrategy}`, theme.primary);
      navigate("list");
      break;
    case "theme":
      setPreviewTheme(null);
      navigate("theme-selector");
      break;
    case "quit":
      renderer.destroy(); // @ts-expect-error Bun runtime provides process
      process.exit(0);
  }
}

// --- theme preview ---

function applyThemeToScreen(theme: RotatorTheme): void {
  renderer.setBackgroundColor(theme.background);

  const sel = asRenderable("theme-selector");
  if (sel) applySelectColors(sel, selectColors(theme));

  const screenRoot = asRenderable("screen-root");
  if (screenRoot) screenRoot.backgroundColor = theme.background;

  const panel = asRenderable("panel");
  if (panel) {
    panel.backgroundColor = theme.backgroundPanel;
    panel.borderColor = theme.border;
  }

  for (const [id, color] of [
    ["title-text", theme.primary],
    ["keys-count", theme.textMuted],
    ["active-count", theme.success],
    ["status-text", statusColor],
    ["help-text", theme.textMuted],
    ["theme-label", theme.primary],
  ] as const) {
    const el = asRenderable(id);
    if (el) el.fg = color;
  }
}

// --- rendering ---

function renderApp(): void {
  if (isRendering) {
    renderPending = true;
    return;
  }
  isRendering = true;
  try {
    doRenderApp();
  } finally {
    isRendering = false;
    if (renderPending) {
      renderPending = false;
      queueMicrotask(renderApp);
    }
  }
}

function doRenderApp(): void {
  // clear previous tree
  focusTargetId = null;
  for (const child of renderer.root.getChildren()) child.destroyRecursively();

  const theme = t();

  const { element: content, helpText } = ((): ScreenContent => {
    switch (currentScreen) {
      case "list":
        return buildMainMenu();
      case "key-selector":
        return buildKeySelector();
      case "key-actions":
        return buildKeyActions();
      case "theme-selector":
        return buildThemeSelector();
      case "confirm-delete":
        return buildConfirmDelete();
      case "add-name":
        return buildAddNameInput();
      case "add-key":
        return buildAddKeyInput();
      case "rename":
        return buildRenameInput();
    }
  })();

  const title = Box(
    { flexDirection: "row" },
    Text({
      id: "title-text",
      content: "NVIDIA NIM Key Rotator",
      fg: theme.primary,
    }),
  );

  const status = Box(
    { flexDirection: "row", gap: 2 },
    Text({
      id: "keys-count",
      content: `Keys: ${store.keys.length}`,
      fg: theme.textMuted,
    }),
    Text({
      id: "active-count",
      content: `Active: ${getActiveKeys(store).length}`,
      fg: theme.success,
    }),
    Text({ id: "status-text", content: statusMessage, fg: statusColor }),
  );

  const help = Box(
    { flexDirection: "row" },
    Text({ id: "help-text", content: helpText, fg: theme.textMuted }),
  );

  renderer.root.add(
    Box(
      {
        id: "screen-root",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        backgroundColor: theme.background,
      },
      Box(
        {
          id: "panel",
          flexDirection: "column",
          paddingX: 2,
          paddingY: 1,
          border: true,
          borderStyle: "rounded",
          borderColor: theme.border,
          gap: 1,
          backgroundColor: theme.backgroundPanel,
        },
        title,
        status,
        content,
        help,
      ),
    ),
  );

  if (focusTargetId) {
    const renderable = renderer.root.findDescendantById(focusTargetId);
    if (renderable && typeof renderable.focus === "function")
      renderable.focus();
  }
}

// --- key bindings ---

(renderer.keyInput as any).on("keypress", (key: any) => {
  if (key.name === "escape") {
    switch (currentScreen) {
      case "list":
        return;
      case "key-selector":
        return navigate("list");
      case "key-actions":
        return navigate("key-selector");
      case "add-name":
      case "add-key":
        pendingKeyName = "";
        return navigate("list");
      case "rename":
        renameTargetId = null;
        return navigate("key-actions");
      case "confirm-delete":
        deleteTargetId = null;
        return navigate("key-actions");
      case "theme-selector":
        setPreviewTheme(null);
        return navigate("list");
    }
  }

  if (key.ctrl && key.name === "c") {
    renderer.destroy();
    // @ts-expect-error Bun runtime provides process
    process.exit(0);
  }
});

renderApp();
