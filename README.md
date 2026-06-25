# opencode-tps-meter

A TUI plugin for [opencode](https://opencode.ai) that displays real-time LLM output speed metrics next to the session prompt.

## Features

- **Live TPS** — current tokens per second, color-coded by speed tier
- **Average TPS** — session-wide average output speed
- **TTFT** — average time-to-first-token across the session

## Color Tiers

| Tier | Range | Color |
|------|-------|-------|
| Slow | < 20 TPS | Red |
| Normal | 20-50 TPS | Yellow |
| Fast | 50-100 TPS | Green |
| Faster | > 100 TPS | Cyan |

## Installation

```bash
opencode plugin add file:/path/to/opencode-tps-meter
```

Or add to your `opencode.json`:

```json
{
  "plugin": {
    "opencode-tps-meter": {
      "source": "file:/path/to/opencode-tps-meter"
    }
  }
}
```

## Development

```bash
npm install
npm test
```

## How It Works

Uses opencode v2 `session.next.*` events (with server-side timestamps) for accurate timing. Falls back to `message.part.delta` with `Date.now()` on older opencode versions. Token estimates are calibrated against actual token counts from completed messages.
