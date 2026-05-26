#!/usr/bin/env bun

import {
  createCliRenderer,
  Text,
  Box,
  Input,
  Select,
} from "@opentui/core"
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
} from "../src/storage.js"
import type { ApiKeyEntry, KeyStore } from "../src/types.js"
import {
  getActiveTheme,
  getTheme,
  listThemes,
  saveThemeOverride,
  getThemeOverride,
  getResolvedTheme,
  setPreviewTheme,
} from "../src/themes.js"
import type { RotatorTheme } from "../src/themes.js"

type Screen =
  | "list"
  | "key-selector"
  | "key-actions"
  | "add-name"
  | "add-key"
  | "rename"
  | "confirm-delete"
  | "theme-selector"

const renderer = await createCliRenderer({ exitOnCtrlC: false })

let store = loadStore()
let currentScreen: Screen = "list"
let deleteTargetId: string | null = null
let renameTargetId: string | null = null
let pendingKeyName = ""
let selectedKeyId: string | null = null
let statusMessage = ""
let statusColor = "#888888"
let focusTargetId: string | null = null
let mainMenuIndex = 0
let keySelectorIndex = 0
let keyActionsIndex = 0
let themeSelectorIndex = 0
let isRendering = false
let renderPending = false

function renderApp(): void {
  if (isRendering) {
    renderPending = true
    return
  }
  isRendering = true
  try {
    doRenderApp()
  } finally {
    isRendering = false
    if (renderPending) {
      renderPending = false
      queueMicrotask(renderApp)
    }
  }
}

function t(): RotatorTheme {
  return getActiveTheme()
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****"
  return key.slice(0, 4) + "****" + key.slice(-4)
}

function refreshStore(): void {
  store = loadStore()
}

function setStatus(msg: string, color?: string): void {
  statusMessage = msg
  statusColor = color ?? t().textMuted
}

function clearRoot(): void {
  focusTargetId = null
  const children = renderer.root.getChildren()
  for (const child of children) {
    child.destroyRecursively()
  }
}

function applyFocus(): void {
  if (!focusTargetId) return
  const renderable = renderer.root.findDescendantById(focusTargetId)
  if (renderable && typeof renderable.focus === "function") {
    renderable.focus()
  }
}

function buildKeyOptions(): Array<{ name: string; description: string; value: string }> {
  const theme = t()
  return store.keys.map((entry) => {
    const status = !entry.enabled ? "OFF" : entry.failureCount >= getMaxFailures() ? "FAIL" : "OK"
    return {
      name: `${entry.name} [${status}]`,
      description: `${maskKey(entry.key)} fails:${entry.failureCount} ${entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleString() : "never used"}`,
      value: entry.id,
    }
  })
}

function buildMainMenu(): any {
  const theme = t()
  const options: Array<{ name: string; description: string; value: string }> = []

  if (store.keys.length > 0) {
    options.push({ name: "Manage Keys", description: "Select a key to rename, delete, or toggle", value: "manage" })
  }
  options.push({ name: "Add Key", description: "Add a new NVIDIA NIM API key", value: "add" })
  if (store.keys.length > 0) {
    options.push({ name: "Reset Failures", description: "Reset all failure counts to zero", value: "reset-failures" })
  }
  options.push({
    name: `Strategy: ${store.rotationStrategy}`,
    description: "Toggle between round-robin and least-failures",
    value: "toggle-strategy",
  })
  options.push({
    name: `Theme: ${theme.name}`,
    description: "Change the color theme (syncs with opencode.json)",
    value: "theme",
  })
  options.push({ name: "Quit", description: "Exit the key manager", value: "quit" })

  if (mainMenuIndex >= options.length) mainMenuIndex = Math.max(0, options.length - 1)

  const menu = Select({
    id: "main-menu",
    width: 50,
    height: 12,
    options,
    selectedIndex: mainMenuIndex,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundElement,
    focusedTextColor: theme.primary,
    selectedBackgroundColor: theme.selectedBg,
    selectedTextColor: theme.selectedText,
    textColor: theme.text,
    descriptionColor: theme.description,
    selectedDescriptionColor: theme.selectedDescription,
  })

  menu.on("itemSelected" as any, (index: number, option: { value: string }) => {
    mainMenuIndex = index
    handleMenuSelect(option.value)
  })

  focusTargetId = "main-menu"
  return menu
}

function buildKeySelector(): any {
  const theme = t()
  const options = buildKeyOptions()
  if (options.length === 0) {
    currentScreen = "list"
    renderApp()
    return Text({ content: "", fg: "#000000" })
  }

  if (keySelectorIndex >= options.length) keySelectorIndex = Math.max(0, options.length - 1)

  const selector = Select({
    id: "key-selector",
    width: 60,
    height: 12,
    options,
    selectedIndex: keySelectorIndex,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundElement,
    focusedTextColor: theme.primary,
    selectedBackgroundColor: theme.selectedBg,
    selectedTextColor: theme.selectedText,
    textColor: theme.text,
    descriptionColor: theme.description,
    selectedDescriptionColor: theme.selectedDescription,
  })

  selector.on("itemSelected" as any, (index: number, option: { value: string }) => {
    keySelectorIndex = index
    selectedKeyId = option.value
    currentScreen = "key-actions"
    keyActionsIndex = 0
    renderApp()
  })

  focusTargetId = "key-selector"
  return selector
}

function buildKeyActions(): any {
  const theme = t()
  if (!selectedKeyId) {
    currentScreen = "key-selector"
    renderApp()
    return Text({ content: "", fg: "#000000" })
  }
  const entry = store.keys.find((k) => k.id === selectedKeyId)
  if (!entry) {
    selectedKeyId = null
    currentScreen = "key-selector"
    renderApp()
    return Text({ content: "", fg: "#000000" })
  }

  const options: Array<{ name: string; description: string; value: string }> = [
    { name: `Toggle ${entry.enabled ? "OFF" : "ON"}`, description: `${entry.enabled ? "Disable" : "Enable"} this key`, value: "toggle" },
    { name: "Rename", description: "Change the friendly name", value: "rename" },
    { name: "Delete", description: "Remove this key permanently", value: "delete" },
    { name: "Back", description: "Return to key list", value: "back" },
  ]

  if (keyActionsIndex >= options.length) keyActionsIndex = Math.max(0, options.length - 1)

  const actions = Select({
    id: "key-actions",
    width: 40,
    height: 8,
    options,
    selectedIndex: keyActionsIndex,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundElement,
    focusedTextColor: theme.primary,
    selectedBackgroundColor: theme.selectedBg,
    selectedTextColor: theme.selectedText,
    textColor: theme.text,
    descriptionColor: theme.description,
  })

  actions.on("itemSelected" as any, (index: number, option: { value: string }) => {
    keyActionsIndex = index
    handleKeyAction(option.value)
  })

  focusTargetId = "key-actions"
  return Box(
    { flexDirection: "column", gap: 1 },
    Text({ content: ` Key: ${entry.name} (${maskKey(entry.key)})`, fg: theme.primary }),
    actions,
  )
}

function applyThemeToScreen(_wrapper: any, theme: RotatorTheme): void {
  renderer.setBackgroundColor(theme.background)

  const selector = renderer.root.findDescendantById("theme-selector")
  if (selector) {
    selector.backgroundColor = theme.backgroundPanel
    selector.focusedBackgroundColor = theme.backgroundElement
    selector.focusedTextColor = theme.primary
    selector.selectedBackgroundColor = theme.selectedBg
    selector.selectedTextColor = theme.selectedText
    selector.textColor = theme.text
    selector.descriptionColor = theme.description
    selector.selectedDescriptionColor = theme.selectedDescription
  }

  const screenRoot = renderer.root.findDescendantById("screen-root")
  if (screenRoot) {
    screenRoot.backgroundColor = theme.background
  }

  const titleText = renderer.root.findDescendantById("title-text")
  if (titleText) titleText.fg = theme.primary
  const keysCount = renderer.root.findDescendantById("keys-count")
  if (keysCount) keysCount.fg = theme.text
  const activeCount = renderer.root.findDescendantById("active-count")
  if (activeCount) activeCount.fg = theme.success
  const statusTextEl = renderer.root.findDescendantById("status-text")
  if (statusTextEl) statusTextEl.fg = statusColor
  const helpTextEl = renderer.root.findDescendantById("help-text")
  if (helpTextEl) helpTextEl.fg = theme.textMuted
  const themeLabel = renderer.root.findDescendantById("theme-label")
  if (themeLabel) themeLabel.fg = theme.primary
}

function buildThemeSelector(): any {
  const theme = t()
  const allThemes = listThemes()
  const currentOverride = getThemeOverride()
  const resolvedId = getResolvedTheme().id
  const activeId = theme.id

  const options = allThemes.map((t) => {
    let desc = t.name
    if (t.id === activeId) desc += " *"
    if (t.id === resolvedId && !currentOverride) desc += " (opencode)"
    return {
      name: t.id,
      description: desc,
      value: t.id,
    }
  })

  options.unshift({
    name: "sync",
    description: "Sync with opencode theme (default)",
    value: "sync",
  })

  const currentIndex = currentOverride
    ? options.findIndex((o) => o.value === currentOverride)
    : 0
  themeSelectorIndex = currentIndex >= 0 ? currentIndex : 0

  const selector = Select({
    id: "theme-selector",
    width: 50,
    height: 12,
    options,
    selectedIndex: themeSelectorIndex,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundElement,
    focusedTextColor: theme.primary,
    selectedBackgroundColor: theme.selectedBg,
    selectedTextColor: theme.selectedText,
    textColor: theme.text,
    descriptionColor: theme.description,
    selectedDescriptionColor: theme.selectedDescription,
  })

  const wrapper = Box(
    { flexDirection: "column", gap: 1 },
    Text({ id: "theme-label", content: " Select a theme:", fg: theme.primary }),
    selector,
  )

  selector.on("selectionChanged" as any, (index: number) => {
    themeSelectorIndex = index
    const option = options[index]
    if (!option) return
    const previewId = option.value === "sync" ? getResolvedTheme().id : option.value
    setPreviewTheme(previewId)
    const previewTheme = getTheme(previewId)
    applyThemeToScreen(wrapper, previewTheme)
  })

  selector.on("itemSelected" as any, (index: number, option: { value: string }) => {
    themeSelectorIndex = index
    setPreviewTheme(null)
    if (option.value === "sync") {
      saveThemeOverride("")
      setStatus(`Theme synced with opencode`, theme.success)
    } else {
      saveThemeOverride(option.value)
      setStatus(`Theme set to ${option.value}`, theme.success)
    }
    refreshStore()
    currentScreen = "list"
    renderApp()
  })

  focusTargetId = "theme-selector"
  return wrapper
}

function handleKeyAction(action: string): void {
  if (!selectedKeyId) return
  const entry = store.keys.find((k) => k.id === selectedKeyId)
  const theme = t()

  switch (action) {
    case "toggle":
      if (entry) {
        toggleKey(store, selectedKeyId)
        saveStore(store)
        refreshStore()
        setStatus(`Toggled "${entry.name}" ${entry.enabled ? "OFF" : "ON"}`, theme.success)
      }
      currentScreen = "key-actions"
      renderApp()
      break
    case "rename":
      renameTargetId = selectedKeyId
      currentScreen = "rename"
      renderApp()
      break
    case "delete":
      deleteTargetId = selectedKeyId
      currentScreen = "confirm-delete"
      renderApp()
      break
    case "back":
      currentScreen = "key-selector"
      renderApp()
      break
  }
}

function handleMenuSelect(value: string): void {
  const theme = t()
  switch (value) {
    case "add":
      currentScreen = "add-name"
      renderApp()
      break
    case "manage":
      currentScreen = "key-selector"
      renderApp()
      break
    case "reset-failures":
      resetFailures(store)
      saveStore(store)
      refreshStore()
      setStatus("All failure counts reset", theme.success)
      currentScreen = "list"
      renderApp()
      break
    case "toggle-strategy":
      store.rotationStrategy = store.rotationStrategy === "round-robin" ? "least-failures" : "round-robin"
      saveStore(store)
      refreshStore()
      setStatus(`Strategy: ${store.rotationStrategy}`, theme.primary)
      currentScreen = "list"
      renderApp()
      break
    case "theme":
      setPreviewTheme(null)
      currentScreen = "theme-selector"
      renderApp()
      break
    case "quit":
      renderer.destroy()
      process.exit(0)
  }
}

function buildAddNameInput(): any {
  const theme = t()
  const input = Input({
    id: "add-name-input",
    placeholder: "e.g. work-key, personal, team-alpha",
    width: 40,
    backgroundColor: theme.inputBg,
    focusedBackgroundColor: theme.inputFocusedBg,
    textColor: theme.text,
    cursorColor: theme.cursor,
  })

  input.on("enter" as any, (value: string) => {
    pendingKeyName = value.trim()
    if (!pendingKeyName) {
      setStatus("Name is required", theme.error)
      renderApp()
      return
    }
    if (store.keys.some((k) => k.name === pendingKeyName)) {
      setStatus("A key with this name already exists", theme.error)
      renderApp()
      return
    }
    currentScreen = "add-key"
    renderApp()
  })

  focusTargetId = "add-name-input"
  return input
}

function buildAddKeyInput(): any {
  const theme = t()
  const input = Input({
    id: "add-key-input",
    placeholder: "nvapi-...",
    width: 55,
    backgroundColor: theme.inputBg,
    focusedBackgroundColor: theme.inputFocusedBg,
    textColor: theme.text,
    cursorColor: theme.cursor,
  })

  input.on("enter" as any, (value: string) => {
    const key = value.trim()
    if (!key) {
      setStatus("API key is required", theme.error)
      renderApp()
      return
    }
    if (!key.startsWith("nvapi-")) {
      setStatus("Key must start with 'nvapi-'", theme.error)
      renderApp()
      return
    }
    addKey(store, pendingKeyName, key)
    saveStore(store)
    refreshStore()
    setStatus(`Added key "${pendingKeyName}"`, theme.success)
    pendingKeyName = ""
    currentScreen = "list"
    renderApp()
  })

  focusTargetId = "add-key-input"
  return input
}

function buildRenameInput(): any {
  const theme = t()
  if (!renameTargetId) return Text({ content: "Error: no key selected", fg: theme.error })
  const entry = store.keys.find((k) => k.id === renameTargetId)
  const currentName = entry?.name ?? ""

  const input = Input({
    id: "rename-input",
    placeholder: "New friendly name",
    width: 40,
    backgroundColor: theme.inputBg,
    focusedBackgroundColor: theme.inputFocusedBg,
    textColor: theme.text,
    cursorColor: theme.cursor,
  })

  input.value = currentName

  input.on("enter" as any, (value: string) => {
    const newName = value.trim()
    if (!newName) {
      setStatus("Name is required", theme.error)
      renderApp()
      return
    }
    if (store.keys.some((k) => k.name === newName && k.id !== renameTargetId)) {
      setStatus("A key with this name already exists", theme.error)
      renderApp()
      return
    }
    renameKey(store, renameTargetId!, newName)
    saveStore(store)
    refreshStore()
    setStatus(`Renamed to "${newName}"`, theme.success)
    renameTargetId = null
    currentScreen = "key-actions"
    renderApp()
  })

  focusTargetId = "rename-input"
  return input
}

function buildConfirmDelete(): any {
  const theme = t()
  const entry = store.keys.find((k) => k.id === deleteTargetId)
  const name = entry?.name ?? "this key"

  const options = [
    { name: "Yes, delete", description: `Permanently remove "${name}"`, value: "yes" },
    { name: "No, cancel", description: "Keep the key", value: "no" },
  ]

  const confirmSelect = Select({
    id: "confirm-delete",
    width: 40,
    height: 6,
    options,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundElement,
    focusedTextColor: theme.error,
    selectedBackgroundColor: "#3a1a1a",
    selectedTextColor: theme.error,
    textColor: theme.text,
  })

  confirmSelect.on("itemSelected" as any, (_index: number, option: { value: string }) => {
    if (option.value === "yes" && deleteTargetId) {
      const e = store.keys.find((k) => k.id === deleteTargetId)
      const n = e?.name ?? "key"
      removeKey(store, deleteTargetId)
      saveStore(store)
      refreshStore()
      if (keySelectorIndex >= store.keys.length) keySelectorIndex = Math.max(0, store.keys.length - 1)
      setStatus(`Deleted "${n}"`, theme.error)
    }
    deleteTargetId = null
    currentScreen = "key-actions"
    renderApp()
  })

  focusTargetId = "confirm-delete"
  return confirmSelect
}

function doRenderApp(): void {
  clearRoot()
  const theme = t()

  const title = Box(
    {
      flexDirection: "row",
      paddingBottom: 1,
      paddingLeft: 1,
    },
    Text({ id: "title-text", content: "NVIDIA NIM API Key Rotator", fg: theme.primary }),
  )

  const status = Box(
    {
      flexDirection: "row",
      gap: 2,
      paddingLeft: 1,
      paddingTop: 1,
      paddingBottom: 1,
    },
    Text({ id: "keys-count", content: `Keys: ${store.keys.length}`, fg: theme.text }),
    Text({ id: "active-count", content: `Active: ${getActiveKeys(store).length}`, fg: theme.success }),
    Text({ id: "status-text", content: statusMessage, fg: statusColor }),
  )

  let content: any
  let helpText = "[Ctrl+C] quit"

  switch (currentScreen) {
    case "list":
      content = buildMainMenu()
      break
    case "key-selector":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: " Select a key to manage:", fg: theme.primary }),
        buildKeySelector(),
      )
      helpText = "[Esc] back"
      break
    case "key-actions":
      content = buildKeyActions()
      helpText = "[Esc] back"
      break
    case "add-name":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Enter a friendly name for this key:", fg: theme.text }),
        buildAddNameInput(),
      )
      helpText = "[Enter] next [Esc] cancel"
      break
    case "add-key":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: `Name: ${pendingKeyName}`, fg: theme.primary }),
        Text({ content: "Enter the NVIDIA NIM API key:", fg: theme.text }),
        buildAddKeyInput(),
      )
      helpText = "[Enter] confirm [Esc] cancel"
      break
    case "rename":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Enter new name:", fg: theme.text }),
        buildRenameInput(),
      )
      helpText = "[Enter] confirm [Esc] cancel"
      break
    case "confirm-delete":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Are you sure you want to delete this key?", fg: theme.error }),
        buildConfirmDelete(),
      )
      helpText = "[Esc] cancel"
      break
    case "theme-selector":
      content = buildThemeSelector()
      helpText = "[Esc] back"
      break
  }

  const help = Box(
    {
      flexDirection: "row",
      paddingLeft: 1,
      paddingTop: 1,
    },
    Text({ id: "help-text", content: helpText, fg: theme.textMuted }),
  )

  const screen = Box(
    {
      id: "screen-root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: theme.background,
    },
    title,
    status,
    Box({ paddingLeft: 1, paddingTop: 1 }, content),
    help,
  )

  renderer.root.add(screen)
  applyFocus()
}

renderer.keyInput.on("keypress", (key: any) => {
  if (key.name === "escape") {
    switch (currentScreen) {
      case "list":
        return
      case "key-selector":
        currentScreen = "list"
        break
      case "key-actions":
        currentScreen = "key-selector"
        break
      case "add-name":
      case "add-key":
        pendingKeyName = ""
        currentScreen = "list"
        break
      case "rename":
        renameTargetId = null
        currentScreen = "key-actions"
        break
      case "confirm-delete":
        deleteTargetId = null
        currentScreen = "key-actions"
        break
      case "theme-selector":
        setPreviewTheme(null)
        currentScreen = "list"
        break
    }
    renderApp()
  }

  if (key.ctrl && key.name === "c") {
    renderer.destroy()
    process.exit(0)
  }
})

renderApp()
