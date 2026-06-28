# opencode-tps-meter

A TUI plugin for [opencode](https://opencode.ai) that displays real-time LLM output speed metrics next to the session prompt.

## Display

```
TPS 42.5 | AVG 38.2 | TTFT 0.8s
```

- **TPS** — current tokens per second (live, color-coded)
- **AVG** — session-wide cumulative average from completed messages (color-coded)
- **TTFT** — time to first token, shown immediately on first token, persists until next generation (color-coded)

## Color Tiers

**TPS & AVG** (higher is better):

| Tier | Range | Color |
|------|-------|-------|
| Slow | < 20 TPS | Red |
| Normal | 20–50 TPS | Yellow |
| Fast | 50–100 TPS | Green |
| Faster | > 100 TPS | Cyan |

**TTFT** (lower is better):

| Tier | Range | Color |
|------|-------|-------|
| Fast | < 0.5s | Green |
| OK | 0.5–2s | Yellow |
| Slow | > 2s | Red |

## Installation

This plugin must be configured in `tui.json` (not `opencode.json`).

### Option 1: Local file

1. Copy `tui.tsx` to your opencode config directory:

```bash
cp tui.tsx ~/.config/opencode/tps-meter.tsx
```

2. Add to `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "./tps-meter.tsx"
  ]
}
```

3. Restart opencode.

### Option 2: Project-local

Add a `.opencode/tui.json` in your project root with the same plugin path (relative to the config file location).

## How It Works

### Live TPS

Tracks text/reasoning delta events in a rolling 5-second window. Uses wall-clock duration (`now - oldest sample`) instead of inter-arrival time sums to avoid inflation from network buffering.

Token estimation uses `ceil(byteLength / 4)` with a **calibration factor**: when a message completes, the estimated token count is compared against actual `tokens.output + tokens.reasoning` from the message metadata, and a running median ratio corrects future estimates.

### AVG

Session-wide cumulative average from all completed messages: `sum(actual tokens) / sum(generation durations)`. Updates only when a message completes. Generation duration = `last delta - first delta` per message (excludes tool execution time and TTFT).

### TTFT

Time from message creation (`info.time.created`) to the first text/reasoning delta. Displayed immediately when the first token arrives, and persists until the next generation starts.

## Development

```bash
npm install
npm test
```

Pure measurement functions (`measure.ts`) have 29 unit tests. The TUI plugin (`tui.tsx`) is a standalone single file (all functions inline) for direct deployment — copy it to your config directory.

## Requirements

- opencode >= 1.4.3
- The plugin file must be placed where `tui.json` can reference it via relative path

## License

MIT
