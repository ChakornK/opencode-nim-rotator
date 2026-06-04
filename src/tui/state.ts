import type { KeyStore } from "../types.js";
import { loadStore } from "../storage.js";
import { getActiveTheme } from "../themes.js";
import type { Screen } from "./types.js";
import type { CliRenderer } from "@opentui/core";

export const state: {
  store: KeyStore;
  currentScreen: Screen;
  deleteTargetId: string | null;
  renameTargetId: string | null;
  pendingKeyName: string;
  selectedKeyId: string | null;
  statusMessage: string;
  statusColor: string;
  focusTargetId: string | null;
  mainMenuIndex: number;
  keySelectorIndex: number;
  keyActionsIndex: number;
  themeSelectorIndex: number;
  isRendering: boolean;
  renderPending: boolean;
  renderer: CliRenderer | null;
} = {
  store: loadStore() as KeyStore,
  currentScreen: "list",
  deleteTargetId: null,
  renameTargetId: null,
  pendingKeyName: "",
  selectedKeyId: null,
  statusMessage: "",
  statusColor: "#888888",
  focusTargetId: null,
  mainMenuIndex: 0,
  keySelectorIndex: 0,
  keyActionsIndex: 0,
  themeSelectorIndex: 0,
  isRendering: false,
  renderPending: false,
  renderer: null,
};

let navigateImpl: ((screen: Screen) => void) | null = null;
let renderAppImpl: (() => void) | null = null;

export function setNavigate(fn: (screen: Screen) => void): void {
  navigateImpl = fn;
}

export function setRenderApp(fn: () => void): void {
  renderAppImpl = fn;
}

export function navigate(screen: Screen): void {
  if (navigateImpl) navigateImpl(screen);
}

export function callRenderApp(): void {
  if (renderAppImpl) renderAppImpl();
}

export function refreshStore(): void {
  state.store = loadStore() as KeyStore;
}

export function setStatus(msg: string, color?: string): void {
  state.statusMessage = msg;
  state.statusColor = color ?? getActiveTheme().textMuted;
}

export function clampIndex(index: number, length: number): number {
  return index >= length ? Math.max(0, length - 1) : index;
}
