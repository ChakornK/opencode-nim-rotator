import { Box, Text } from "@opentui/core";
import { getActiveKeys } from "../storage.js";
import { getActiveTheme, setPreviewTheme } from "../themes.js";
import { state, setNavigate, setRenderApp } from "./state.js";
import type { Screen } from "./types.js";
import {
  buildMainMenu,
  buildKeySelector,
  buildKeyActions,
  buildThemeSelector,
  buildConfirmDelete,
  buildAddNameInput,
  buildAddKeyInput,
  buildRenameInput,
} from "./screens.js";
import type { ScreenContent } from "./types.js";

export function initApp(): void {
  // Wire up navigation and render loop
  setNavigate((screen: Screen) => {
    state.currentScreen = screen;
    renderApp();
  });

  setRenderApp(renderApp);

  // Key bindings
  if (!state.renderer) return;
  state.renderer.keyInput.on("keypress", (key: any) => {
    if (key.name === "escape") {
      switch (state.currentScreen) {
        case "list":
          return;
        case "key-selector":
          return navigateTo("list");
        case "key-actions":
          return navigateTo("key-selector");
        case "add-name":
        case "add-key":
          state.pendingKeyName = "";
          return navigateTo("list");
        case "rename":
          state.renameTargetId = null;
          return navigateTo("key-actions");
        case "confirm-delete":
          state.deleteTargetId = null;
          return navigateTo("key-actions");
        case "theme-selector":
          setPreviewTheme(null);
          return navigateTo("list");
      }
    }

    if (key.ctrl && key.name === "c") {
      if (state.renderer) state.renderer.destroy();
      process.exit(0);
    }
  });

  // Initial render
  renderApp();
}

function navigateTo(screen: Screen): void {
  state.currentScreen = screen;
  renderApp();
}

function renderApp(): void {
  if (state.isRendering) {
    state.renderPending = true;
    return;
  }
  state.isRendering = true;
  try {
    doRenderApp();
  } finally {
    state.isRendering = false;
    if (state.renderPending) {
      state.renderPending = false;
      queueMicrotask(renderApp);
    }
  }
}

function doRenderApp(): void {
  if (!state.renderer) return;
  state.focusTargetId = null;
  for (const child of state.renderer.root.getChildren())
    child.destroyRecursively();

  const theme = getActiveTheme();

  const { element: content, helpText }: ScreenContent = (() => {
    switch (state.currentScreen) {
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
      content: `Keys: ${state.store.keys.length}`,
      fg: theme.textMuted,
    }),
    Text({
      id: "active-count",
      content: `Active: ${getActiveKeys(state.store).length}`,
      fg: theme.success,
    }),
    Text({
      id: "status-text",
      content: state.statusMessage,
      fg: state.statusColor,
    }),
  );

  const help = Box(
    { flexDirection: "row" },
    Text({ id: "help-text", content: helpText, fg: theme.textMuted }),
  );

  state.renderer.root.add(
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

  if (state.focusTargetId) {
    const renderable = state.renderer.root.findDescendantById(
      state.focusTargetId,
    );
    if (renderable && typeof renderable.focus === "function")
      renderable.focus();
  }
}
