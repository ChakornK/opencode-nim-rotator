# @hallaxius/opencode-nim-rotator

An [OpenCode](https://opencode.ai) plugin for managing and rotating multiple [NVIDIA NIM](https://build.nvidia.com) API keys, with automatic model fallback, per-model blacklisting with exponential escalation, benchmarking, and both a CLI TUI manager and an integrated OpenCode TUI plugin.

## Features

- **API Key Rotation** — round-robin or least-failures strategy across multiple NVIDIA NIM keys
- **Model Fallback Chain** — automatically retries with alternative models on streaming timeout, rate limit (429), or retryable server errors (408, 500, 502, 503, 504)
- **Model Blacklisting** — automatically blacklists a model on a per-key basis when 429 rate limits are detected, with exponential escalation (30s base, max 1h). Blacklisted keys are skipped for that model until the timer expires
- **Benchmarking** — measure TTFB and TPS for models in your fallback chain
- **CLI TUI Manager** — terminal UI for managing keys, fallback chain, blacklists, and settings
- **OpenCode TUI Plugin** — 5 interactive palette commands with dialog-based navigation, key toggling, blacklist clearing, and rate-limit resets — all without leaving OpenCode
- **Themes** — syncs with your OpenCode theme or select independently

## How It Works

The plugin hooks into OpenCode's request pipeline:

- **`chat.headers`** injects a rotated API key into the `Authorization` header on every outgoing NVIDIA NIM request. When a key receives a 429, its `rateLimitCount` is incremented and the model is added to that key's per-model blacklist (with exponential escalation). Blacklisted keys are automatically skipped for that model. Successful requests reset the rate-limit count.
- **`shell.env`** rotates `NVIDIA_API_KEY` for shell commands too.
- **`chat.message`** rewrites the model to the matching entry in your fallback chain. If the streaming response stalls for more than 60 seconds, returns a retryable server error (408, 429, 500, 502, 503, 504), or accumulates `maxRateLimitFailures` consecutive 429s, the plugin aborts the request and re-prompts the session with the next model in the chain. A toast notification appears when fallback activates. The last model in the chain is never timed out.
- **`session.error`** / **`session.status`** / **`session.next.step.failed`** record key-level rate-limit failures and per-model blacklists, which reset when the next request succeeds on that key.

## Install

```bash
bun install -g @hallaxius/opencode-nim-rotator
```

The postinstall script automatically adds the plugin to your `~/.config/opencode/opencode.json`.

## Setup

### 1. Add API keys

Run the CLI TUI manager:

```bash
opencode-nim-rotator
```

Or:

```bash
bunx @hallaxius/opencode-nim-rotator
```

Or manually — add at least one key via OpenCode's auth system:

```bash
opencode /connect nvidia
```

Select "Enter NVIDIA NIM API Key" and paste your key.

### 2. Add more keys, build a fallback chain

The CLI TUI covers everything from one terminal:

- **API Key Rotation** — add, rename, delete, toggle keys; reset rate-limit counts; clear model blacklists; switch strategy (round-robin / least-failures); export to JSON; import from JSON.
- **Model Fallback Chain** — build an ordered list of NVIDIA NIM models. On a failure, the plugin walks the chain from top to bottom. You can also benchmark any model in the chain to record its TTFB and TPS, and tune the rate-limit threshold (how many consecutive 429s trigger fallback).
- **Themes** — pick a color theme, or sync with `opencode.json`.

### 3. Restart OpenCode

After adding keys, restart opencode. The plugin will rotate keys on every NVIDIA API request and retry failed requests against your fallback chain.

## OpenCode TUI Commands

Once installed, the plugin registers 5 commands in the OpenCode command palette and keybindings under `Leader n`:

| Command | Palette Name | Keybinding | Description |
|---------|-------------|------------|-------------|
| `nim-rotator.status` | NIM Key Rotator: Status | `Leader n s` | Overview of all keys with status, rate-limit counts, and active blacklists. Drill into a key to toggle, reset, or clear blacklists |
| `nim-rotator.manage-keys` | NIM Key Rotator: Manage Keys | `Leader n m` | Alias for the Status dialog |
| `nim-rotator.blacklisted` | NIM Key Rotator: Blacklisted Models | `Leader n b` | Dedicated view of all blacklisted models across keys. Clear individual entries or all at once |
| `nim-rotator.reset-rates` | NIM Key Rotator: Reset Rate Limits | `Leader n r` | Confirmation dialog to reset all rate-limit counts and clear every model blacklist |
| `nim-rotator.fallback-chain` | NIM Key Rotator: Fallback Chain | `Leader n f` | View the fallback chain with benchmark data (TTFB, TPS). Drill into models for details |

All dialogs support navigation with arrow keys and `Escape` to go back. Write actions (toggle, reset, clear) take effect immediately and refresh the dialog.

## Model Fallback Chain

In addition to rotating API keys, the plugin can automatically retry failed requests against a chain of alternative NVIDIA NIM models. When the primary model times out, returns a retryable server error, or hits the rate-limit threshold, the plugin automatically retries the same prompt with the next model in your chain.

### Benchmarking Models

Each model in the chain can be benchmarked to measure its latency and throughput on your network. The benchmark runs a streaming programming prompt (`max_tokens: 1024`) and records:

- **TTFB** — milliseconds until the first token streams back
- **TPS** — throughput during streaming, estimated from character count (`4 chars/token`)

Results are saved with the model in the key store.

## Model Blacklisting

When a key receives a 429 rate-limit response for a specific model, that model is added to the key's per-model blacklist. While blacklisted, the key is skipped for that model during rotation, and only that key–model combination is affected — the same key can still be used for other models.

### Escalation

Each blacklist entry escalates exponentially with repeated 429s:

| Parameter | Value |
|-----------|-------|
| Base duration | 30 seconds |
| Escalation factor | 1.5× per subsequent 429 |
| Maximum duration | 1 hour |

If a model is already blacklisted when another 429 arrives, the timer is extended and the next duration is escalated (capped at 1 hour). Expired entries are automatically pruned on store load and save.

### Clearing Blacklists

Blacklists can be cleared from:

- **OpenCode TUI** — `nim-rotator.blacklisted` (`Leader n b`) for individual or bulk clearing; `nim-rotator.reset-rates` (`Leader n r`) to clear everything
- **CLI TUI** — the Keys tab, per-key detail view
- The blacklist entries are also cleaned up automatically whenever the store is loaded or saved (`pruneAllExpiredBlacklists`)

## Configuration

### Environment Variables

| Variable                   | Description                         | Default                                    |
| -------------------------- | ----------------------------------- | ------------------------------------------ |
| `NIM_ROTATOR_STORE_PATH`   | Path to key store JSON file         | `~/.config/opencode/nim-rotator-keys.json` |
| `NVIDIA_API_KEY`           | Fallback API key (auto-seeded)      | —                                          |

### opencode.json Options

```json
{
  "plugin": [
    [
      "@hallaxius/opencode-nim-rotator",
      {
        "rotationStrategy": "round-robin",
        "storePath": "/custom/path/to/keys.json"
      }
    ],
    "@hallaxius/opencode-nim-rotator/tui"
  ]
}
```

### Rotation Strategies

- **`round-robin`** (default): Cycles through active (non-blacklisted for the current model) keys in order
- **`least-failures`**: Always uses the key with the fewest active blacklists — keys with shorter total blacklist time are preferred, and ties are broken by least-recently-used

### Rate-Limit Threshold

`maxRateLimitFailures` (default: `3`) controls how many consecutive 429 errors on a session trigger a cross-model fallback. This value is stored in the key store and can be adjusted from the CLI TUI's Settings tab.

## Key Store Format

Keys, fallback chain, and blacklists are stored in `~/.config/opencode/nim-rotator-keys.json` with file mode `0600`:

```json
{
  "keys": [
    {
      "id": "uuid",
      "name": "work-key",
      "key": "nvapi-...",
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000100000,
      "rateLimitCount": 0,
      "enabled": true,
      "modelBlacklist": {
        "nvidia/llama-3.1-70b-instruct": {
          "blacklistedUntil": 1700000300000,
          "nextDurationMs": 45000
        }
      }
    }
  ],
  "currentIndex": 0,
  "rotationStrategy": "round-robin",
  "updatedAt": 1700000000000,
  "lastUsedKeyId": "uuid",
  "fallbackChain": [
    {
      "id": "nvidia/llama-3.1-70b-instruct",
      "name": "Llama 3.1 70B",
      "benchmarkTtfb": 320,
      "benchmarkTps": 85.4,
      "benchmarkStatus": "done"
    }
  ],
  "maxRateLimitFailures": 3
}
```

`rateLimitCount` tracks consecutive 429 errors per key. `modelBlacklist` maps model IDs to `{ blacklistedUntil, nextDurationMs }` entries — keys with an active blacklist entry for the requested model are skipped during rotation. `maxRateLimitFailures` controls how many consecutive 429s trigger a cross-model fallback.

### Theme Override

The TUI theme is stored separately in `~/.config/opencode/nim-rotator-theme.json`:

```json
{
  "theme": "dracula"
}
```

Set `theme` to a theme ID to override the TUI theme independently, or delete the file to sync with `opencode.json`.

## Themes

The TUI supports multiple color themes that match OpenCode's built-in themes. By default, the rotator **syncs with your `opencode.json` theme setting**.

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

To override via `opencode.json`:

```json
{
  "theme": "dracula"
}
```

To override independently, select a theme from the CLI TUI's Settings tab — this writes to `~/.config/opencode/nim-rotator-theme.json`. Delete that file or set it to `"opencode"` to revert to syncing with `opencode.json`.

## Development

```bash
# Install dependencies
bun install

# Run CLI TUI locally
bun run tui

# Build TypeScript
bun run build
```

## Uninstall

To remove the plugin and clean up all associated data:

```bash
bun remove -g @hallaxius/opencode-nim-rotator
```

The uninstaller will automatically:

1.  Removes both `@hallaxius/opencode-nim-rotator` and `@hallaxius/opencode-nim-rotator/tui` from your `~/.config/opencode/opencode.json` plugin list
2. Prompt to delete your key store file at `~/.config/opencode/nim-rotator-keys.json`
3. Remove the theme preference file at `~/.config/opencode/nim-rotator-theme.json`

**Note:** Uninstalling will prompt before deleting stored API keys. After uninstalling, restart opencode to apply the changes.

## License

MIT
