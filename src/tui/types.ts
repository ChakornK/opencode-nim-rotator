import type { VNode } from "@opentui/core";

export type Screen =
  | "list"
  | "key-selector"
  | "key-actions"
  | "add-name"
  | "add-key"
  | "rename"
  | "confirm-delete"
  | "theme-selector";

export interface SelectOption {
  name: string;
  description: string;
  value: string;
}

export interface ScreenContent {
  element: VNode;
  helpText: string;
}
