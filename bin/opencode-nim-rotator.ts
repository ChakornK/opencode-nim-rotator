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

type Screen =
  | "list"
  | "key-selector"
  | "key-actions"
  | "add-name"
  | "add-key"
  | "rename"
  | "confirm-delete"

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

function maskKey(key: string): string {
  if (key.length <= 8) return "****"
  return key.slice(0, 4) + "****" + key.slice(-4)
}

function refreshStore(): void {
  store = loadStore()
}

function setStatus(msg: string, color = "#888888"): void {
  statusMessage = msg
  statusColor = color
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
  options.push({ name: "Quit", description: "Exit the key manager", value: "quit" })

  if (mainMenuIndex >= options.length) mainMenuIndex = Math.max(0, options.length - 1)

  const menu = Select({
    id: "main-menu",
    width: 50,
    height: 10,
    options,
    selectedIndex: mainMenuIndex,
    backgroundColor: "#111111",
    selectedBackgroundColor: "#1a3a1a",
    selectedTextColor: "#76FF03",
    textColor: "#AAAAAA",
    descriptionColor: "#666666",
    selectedDescriptionColor: "#88CC88",
  })

  menu.on("itemSelected" as any, (index: number, option: { value: string }) => {
    mainMenuIndex = index
    handleMenuSelect(option.value)
  })

  focusTargetId = "main-menu"
  return menu
}

function buildKeySelector(): any {
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
    backgroundColor: "#111111",
    selectedBackgroundColor: "#1a3a1a",
    selectedTextColor: "#76FF03",
    textColor: "#AAAAAA",
    descriptionColor: "#666666",
    selectedDescriptionColor: "#88CC88",
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
    backgroundColor: "#111111",
    selectedBackgroundColor: "#1a3a1a",
    selectedTextColor: "#76FF03",
    textColor: "#AAAAAA",
  })

  actions.on("itemSelected" as any, (index: number, option: { value: string }) => {
    keyActionsIndex = index
    handleKeyAction(option.value)
  })

  focusTargetId = "key-actions"
  return Box(
    { flexDirection: "column", gap: 1 },
    Text({ content: ` Key: ${entry.name} (${maskKey(entry.key)})`, fg: "#76FF03" }),
    actions,
  )
}

function handleKeyAction(action: string): void {
  if (!selectedKeyId) return
  const entry = store.keys.find((k) => k.id === selectedKeyId)

  switch (action) {
    case "toggle":
      if (entry) {
        toggleKey(store, selectedKeyId)
        saveStore(store)
        refreshStore()
        setStatus(`Toggled "${entry.name}" ${entry.enabled ? "OFF" : "ON"}`, "#66FF66")
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
      setStatus("All failure counts reset", "#66FF66")
      currentScreen = "list"
      renderApp()
      break
    case "toggle-strategy":
      store.rotationStrategy = store.rotationStrategy === "round-robin" ? "least-failures" : "round-robin"
      saveStore(store)
      refreshStore()
      setStatus(`Strategy: ${store.rotationStrategy}`, "#76FF03")
      currentScreen = "list"
      renderApp()
      break
    case "quit":
      renderer.destroy()
      process.exit(0)
  }
}

function buildAddNameInput(): any {
  const input = Input({
    id: "add-name-input",
    placeholder: "e.g. work-key, personal, team-alpha",
    width: 40,
    backgroundColor: "#1a1a1a",
    focusedBackgroundColor: "#2a2a2a",
    textColor: "#FFFFFF",
    cursorColor: "#76FF03",
  })

  input.on("enter" as any, (value: string) => {
    pendingKeyName = value.trim()
    if (!pendingKeyName) {
      setStatus("Name is required", "#FF5555")
      renderApp()
      return
    }
    if (store.keys.some((k) => k.name === pendingKeyName)) {
      setStatus("A key with this name already exists", "#FF5555")
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
  const input = Input({
    id: "add-key-input",
    placeholder: "nvapi-...",
    width: 55,
    backgroundColor: "#1a1a1a",
    focusedBackgroundColor: "#2a2a2a",
    textColor: "#FFFFFF",
    cursorColor: "#76FF03",
  })

  input.on("enter" as any, (value: string) => {
    const key = value.trim()
    if (!key) {
      setStatus("API key is required", "#FF5555")
      renderApp()
      return
    }
    if (!key.startsWith("nvapi-")) {
      setStatus("Key must start with 'nvapi-'", "#FF5555")
      renderApp()
      return
    }
    addKey(store, pendingKeyName, key)
    saveStore(store)
    refreshStore()
    setStatus(`Added key "${pendingKeyName}"`, "#66FF66")
    pendingKeyName = ""
    currentScreen = "list"
    renderApp()
  })

  focusTargetId = "add-key-input"
  return input
}

function buildRenameInput(): any {
  if (!renameTargetId) return Text({ content: "Error: no key selected", fg: "#FF5555" })
  const entry = store.keys.find((k) => k.id === renameTargetId)
  const currentName = entry?.name ?? ""

  const input = Input({
    id: "rename-input",
    placeholder: "New friendly name",
    width: 40,
    backgroundColor: "#1a1a1a",
    focusedBackgroundColor: "#2a2a2a",
    textColor: "#FFFFFF",
    cursorColor: "#76FF03",
  })

  input.value = currentName

  input.on("enter" as any, (value: string) => {
    const newName = value.trim()
    if (!newName) {
      setStatus("Name is required", "#FF5555")
      renderApp()
      return
    }
    if (store.keys.some((k) => k.name === newName && k.id !== renameTargetId)) {
      setStatus("A key with this name already exists", "#FF5555")
      renderApp()
      return
    }
    renameKey(store, renameTargetId!, newName)
    saveStore(store)
    refreshStore()
    setStatus(`Renamed to "${newName}"`, "#66FF66")
    renameTargetId = null
    currentScreen = "key-actions"
    renderApp()
  })

  focusTargetId = "rename-input"
  return input
}

function buildConfirmDelete(): any {
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
    backgroundColor: "#111111",
    selectedBackgroundColor: "#3a1a1a",
    selectedTextColor: "#FF5555",
    textColor: "#AAAAAA",
  })

  confirmSelect.on("itemSelected" as any, (_index: number, option: { value: string }) => {
    if (option.value === "yes" && deleteTargetId) {
      const e = store.keys.find((k) => k.id === deleteTargetId)
      const n = e?.name ?? "key"
      removeKey(store, deleteTargetId)
      saveStore(store)
      refreshStore()
      if (keySelectorIndex >= store.keys.length) keySelectorIndex = Math.max(0, store.keys.length - 1)
      setStatus(`Deleted "${n}"`, "#FF5555")
    }
    deleteTargetId = null
    currentScreen = "key-actions"
    renderApp()
  })

  focusTargetId = "confirm-delete"
  return confirmSelect
}

function renderApp(): void {
  clearRoot()

  const title = Box(
    {
      flexDirection: "row",
      paddingBottom: 1,
      paddingLeft: 1,
    },
    Text({ content: "NVIDIA NIM API Key Rotator", fg: "#76FF03" }),
  )

  const status = Box(
    {
      flexDirection: "row",
      gap: 2,
      paddingLeft: 1,
      paddingTop: 1,
      paddingBottom: 1,
    },
    Text({ content: `Keys: ${store.keys.length}`, fg: "#AAAAAA" }),
    Text({ content: `Active: ${getActiveKeys(store).length}`, fg: "#66FF66" }),
    Text({ content: statusMessage, fg: statusColor }),
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
        Text({ content: " Select a key to manage:", fg: "#76FF03" }),
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
        Text({ content: "Enter a friendly name for this key:", fg: "#AAAAAA" }),
        buildAddNameInput(),
      )
      helpText = "[Enter] next [Esc] cancel"
      break
    case "add-key":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: `Name: ${pendingKeyName}`, fg: "#76FF03" }),
        Text({ content: "Enter the NVIDIA NIM API key:", fg: "#AAAAAA" }),
        buildAddKeyInput(),
      )
      helpText = "[Enter] confirm [Esc] cancel"
      break
    case "rename":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Enter new name:", fg: "#AAAAAA" }),
        buildRenameInput(),
      )
      helpText = "[Enter] confirm [Esc] cancel"
      break
    case "confirm-delete":
      content = Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Are you sure you want to delete this key?", fg: "#FF5555" }),
        buildConfirmDelete(),
      )
      helpText = "[Esc] cancel"
      break
  }

  const help = Box(
    {
      flexDirection: "row",
      paddingLeft: 1,
      paddingTop: 1,
    },
    Text({ content: helpText, fg: "#666666" }),
  )

  const screen = Box(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: "#0a0a0a",
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
    }
    renderApp()
  }

  if (key.ctrl && key.name === "c") {
    renderer.destroy()
    process.exit(0)
  }
})

renderApp()
