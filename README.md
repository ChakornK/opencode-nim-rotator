# opencode-nim-rotator

An [OpenCode](https://opencode.ai) plugin for managing and rotating multiple [NVIDIA NIM](https://build.nvidia.com) API keys, with automatic model fallback and benchmarking.

## Features

- **API Key Rotation** — round-robin or least-failures strategy across multiple NVIDIA NIM keys
- **Model Fallback Chain** — automatically retries with alternative models on streaming timeout, rate limit (429), or retryable server errors (408, 500, 502, 503, 504)
- **Benchmarking** — measure TTFB and TPS for models in your fallback chain
- **TUI Manager** — terminal UI for managing keys, the fallback chain, and settings
- **Themes** — syncs with your OpenCode theme or select independently

## How It Works

The plugin hooks into OpenCode's request pipeline:

- **`chat.headers`** injects a rotated API key into the `Authorization` header on every outgoing NVIDIA NIM request. If a key returns 401, 403, or 429, its failure count is incremented and the next key is tried. Keys that exceed `NIM_ROTATOR_MAX_FAILURES` are automatically skipped. Successful requests reset the failure count.
- **`shell.env`** rotates `NVIDIA_API_KEY` for shell commands too.
- **`chat.message`** rewrites the model to the first entry in your fallback chain. If the streaming response stalls for more than 60 seconds, returns a retryable server error, or accumulates `maxRateLimitFailures` consecutive 429s, the plugin aborts the request and prompts the session again with the next model in the chain. A toast notification appears when fallback activates. The last model in the chain is never timed out.
- **`session.error`** records key-level rate-limit failures, which reset when the next request succeeds on that key.

## Install

```bash
npm install -g opencode-nim-rotator
```

The postinstall script automatically adds the plugin to your `~/.config/opencode/opencode.json`.

## Setup

### 1. Add API keys

Run the TUI manager:

```bash
opencode-nim-rotator
```

Or manually — add at least one key via OpenCode's auth system:

```bash
opencode /connect nvidia
```

Select "Enter NVIDIA NIM API Key" and paste your key.

### 2. Add more keys, build a fallback chain

The TUI covers everything from one terminal:

- **API Key Rotation** — add, rename, delete, toggle keys; reset failures; switch strategy (round-robin / least-failures); export to JSON; import from JSON.
- **Model Fallback Chain** — build an ordered list of NVIDIA NIM models. On a failure, the plugin walks the chain from top to bottom. You can also benchmark any model in the chain to record its TTFB and TPS, and tune the rate-limit threshold (how many consecutive 429s trigger fallback).
- **Themes** — pick a color theme, or sync with `opencode.json`.

### 3. Restart OpenCode

After adding keys, restart opencode. The plugin will rotate keys on every NVIDIA API request and retry failed requests against your fallback chain.

## Model Fallback Chain

In addition to rotating API keys, the plugin can automatically retry failed requests against a chain of alternative NVIDIA NIM models. When the primary model times out, returns a retryable server error, or hits a rate limit, the plugin automatically retries the same prompt with the next model in your chain.

### Benchmarking Models

Each model in the chain can be benchmarked to measure its latency and throughput on your network. The benchmark runs a streaming programming prompt (`max_tokens: 1024`) and records:

- **TTFB** — milliseconds until the first token streams back
- **TPS** — throughput during streaming, estimated from character count (`4 chars/token`)

Results are saved with the model in the key store.

## Configuration

### Environment Variables

| Variable                   | Description                         | Default                                    |
| -------------------------- | ----------------------------------- | ------------------------------------------ |
| `NIM_ROTATOR_STORE_PATH`   | Path to key store JSON file         | `~/.config/opencode/nim-rotator-keys.json` |
| `NIM_ROTATOR_MAX_FAILURES` | Max failures before disabling a key | `5`                                        |
| `NVIDIA_API_KEY`           | Fallback API key (auto-seeded)      | —                                          |

### opencode.json Options

```json
{
  "plugin": [
    [
      "opencode-nim-rotator",
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

## Key Store Format

Keys, fallback chain, and theme are stored in `~/.config/opencode/nim-rotator-keys.json` with file mode `0600`:

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
      "rateLimitCount": 0,
      "enabled": true
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

`rateLimitCount` tracks consecutive 429 errors per key; `maxRateLimitFailures` controls how many trigger a cross-model fallback.

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

To override independently, store the override in the key store's `theme` field. Set it to `""` or remove it to revert to syncing with `opencode.json`.

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
npm uninstall -g opencode-nim-rotator
```

The uninstaller will automatically:

1. Remove `opencode-nim-rotator` from your `~/.config/opencode/opencode.json` plugin list
2. Delete your key store file at `~/.config/opencode/nim-rotator-keys.json`

**Note:** This will permanently delete all stored API keys, so back them up first if needed. After uninstalling, restart opencode to apply the changes.

## License

MIT
