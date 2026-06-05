import { getActiveTheme, setPreviewTheme } from "../themes.js";
import {
  exportKeys,
  applyImport,
  resetFailures,
  saveStore,
  toggleKey,
  writeExportFile,
} from "../storage.js";
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
        saveStore(state.store);
        refreshStore();
        setStatus(
          `Toggled "${entry.name}" ${entry.enabled ? "OFF" : "ON"}`,
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
      saveStore(state.store);
      refreshStore();
      setStatus("All failure counts reset", theme.success);
      navigate("list");
      break;
    case "toggle-strategy": {
      const current = state.store.rotationStrategy;
      state.store.rotationStrategy =
        current === "round-robin" ? "least-failures" : "round-robin";
      saveStore(state.store);
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
  } catch (err: any) {
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
  saveStore(state.store);
  refreshStore();
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  setStatus(`Import complete: ${parts.join(", ")}`, theme.success);
  state.pendingImportPath = "";
  state.pendingImportResult = null;
  navigate("list");
}
