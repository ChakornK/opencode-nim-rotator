# opencode-nvidia-nim-key-rotator

An [OpenCode](https://opencode.ai) plugin for managing and rotating multiple NVIDIA NIM API keys.

## How It Works

The plugin uses OpenCode's `auth` hook with a custom `fetch` function to intercept every NVIDIA NIM API call and inject a rotated API key into the `Authorization` header. This is the same pattern used by the codex and github-copilot plugins in production.

**Key rotation happens per-request**: each LLM call uses the next key in the rotation. If a key returns 401/403, it automatically increments the failure count and retries with the next key.

## Install

```bash
npm install -g opencode-nvidia-nim-key-rotator
```

The postinstall script automatically adds the plugin to your `~/.config/opencode/opencode.json`.

## Setup

### 1. Add API keys

Run the TUI manager:

```bash
bun opencode-nim-rotator
```

Or manually — add at least one key via OpenCode's auth system:

```bash
opencode /connect nvidia
```

Select "Enter NVIDIA NIM API Key" and paste your key.

### 2. Add more keys via the TUI

```bash
bun opencode-nim-rotator
```

The TUI lets you:

- **Add** keys with a friendly name
- **Rename** keys
- **Delete** keys
- **Toggle** keys on/off
- **Reset** failure counts
- **Switch** rotation strategy (round-robin or least-failures)

### 3. Restart OpenCode

After adding keys, restart opencode. The plugin's `auth` loader will fire on startup and provide the custom `fetch` that rotates keys.

## Configuration

### Environment Variables

| Variable                   | Description                         | Default                                    |
| -------------------------- | ----------------------------------- | ------------------------------------------ |
| `NIM_ROTATOR_STORE_PATH`   | Path to key store JSON file         | `~/.config/opencode/nim-rotator-keys.json` |
| `NIM_ROTATOR_MAX_FAILURES` | Max failures before disabling a key | `5`                                        |

### opencode.json Options

```json
{
  "plugin": [
    [
      "opencode-nvidia-nim-key-rotator",
      {
        "rotationStrategy": "round-robin",
        "storePath": "/custom/path/to/keys.json"
      }
    ]
  ]
}
```

### Rotation Strategies

- **`round-robin`** (default): Cycles through keys in order
- **`least-failures`**: Always uses the key with the fewest failures

## How Key Rotation Works

1. On startup, the `auth` hook `loader` registers a custom `fetch` for the `nvidia` provider
2. Every NVIDIA API call goes through this custom fetch
3. The fetch selects the next key based on the rotation strategy
4. The `Authorization: Bearer <key>` header is replaced with the rotated key
5. If the request returns 401/403, the failure count is incremented and the next key is tried
6. Keys that exceed `NIM_ROTATOR_MAX_FAILURES` are automatically skipped
7. Successful requests reset the key's failure count to 0

## Key Store Format

Keys are stored in `~/.config/opencode/nim-rotator-keys.json` with file mode `0600`:

```json
{
  "keys": [
    {
      "id": "uuid",
      "name": "work-key",
      "key": "nvapi-...",
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000100000,
      "failureCount": 0,
      "enabled": true
    }
  ],
  "currentIndex": 0,
  "rotationStrategy": "round-robin",
  "updatedAt": 1700000000000
}
```

## Themes

The TUI supports multiple color themes that match OpenCode's built-in themes. By default, the rotator **syncs with your `opencode.json` theme setting** — when you change your theme in OpenCode, the rotator picks it up automatically.

### Available Themes

| ID           | Name               |
| ------------ | ------------------ |
| `opencode`   | OpenCode (default) |
| `catppuccin` | Catppuccin Mocha   |
| `dracula`    | Dracula            |
| `gruvbox`    | Gruvbox            |
| `kanagawa`   | Kanagawa           |
| `nord`       | Nord               |
| `one-dark`   | One Dark           |
| `rosepine`   | Rose Pine          |
| `solarized`  | Solarized          |
| `tokyonight` | Tokyonight         |

### Setting a Theme

From the TUI main menu, select **Theme** to pick a theme or switch back to syncing with `opencode.json`.

To override via `opencode.json`:

```json
{
  "theme": "dracula"
}
```

To override independently (saved in the key store):

```json
{
  "theme": "kanagawa",
  "keys": [...]
}
```

Set the store `theme` field to `""` or remove it to revert to syncing with `opencode.json`.

## TUI

The TUI is built with [OpenTUI](https://opentui.com) and provides a menu-driven interface:

- Main menu with Add, Manage, Strategy, and Theme options
- Key selector showing name, masked key, failure count, last used
- Key actions: toggle, rename, delete
- Add key flow: enter name, then enter key
- Theme selector with sync-to-opencode option

## Development

```bash
# Install dependencies
bun install

# Run TUI locally
bun run tui

# Build TypeScript
bun run build
```

## Uninstall

To remove the plugin and clean up all associated data:

```bash
npm uninstall -g opencode-nvidia-nim-key-rotator
```

The uninstaller will automatically:

1. Remove `opencode-nvidia-nim-key-rotator` from your `~/.config/opencode/opencode.json` plugin list
2. Delete your key store file at `~/.config/opencode/nim-rotator-keys.json`

**Note:** This will permanently delete all stored API keys, so back them up first if needed. After uninstalling, restart opencode to apply the changes.

## License

MIT
