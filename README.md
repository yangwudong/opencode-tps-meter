# opencode-tps-meter

English | [中文](./README.zh-CN.md)

A TUI plugin for [opencode](https://opencode.ai) that displays real-time LLM output speed metrics next to the session prompt.

[![npm version](https://img.shields.io/npm/v/@jack-yang/opencode-tps-meter)](https://www.npmjs.com/package/@jack-yang/opencode-tps-meter) [![license](https://img.shields.io/npm/l/@jack-yang/opencode-tps-meter)](https://www.npmjs.com/package/@jack-yang/opencode-tps-meter) [![stars](https://img.shields.io/github/stars/yangwudong/opencode-tps-meter)](https://github.com/yangwudong/opencode-tps-meter) ![opencode](https://img.shields.io/badge/opencode-1.17.20-tested-blue)

## Display

Idle:
```
TPS 42.5 | AVG 38.2 | TTFT 0.8s
```

While the model is reasoning (a flowing particle stream appears to the right of TTFT):
```
TPS 42.5 | AVG 38.2 | TTFT 0.8s ⠒⠑⠂
```

- **TPS** — current tokens per second (live, color-coded)
- **AVG** — session-wide cumulative average from completed messages (color-coded)
- **TTFT** — time to first token, shown immediately on first token, persists until next generation (color-coded)
- **Thinking stream** — while reasoning streams, a FIFO particle stream (newest dot on the left, fading right, color shifts over time) appears to the right of TTFT. Only rendered while thinking — no space is reserved when idle.

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
| Fast | < 10s | Green |
| OK | 10–20s | Yellow |
| Slow | > 20s | Red |

## Installation

> **Important:** This plugin must be configured in `tui.json`, **not** `opencode.json`.

### One command (recommended)

```bash
opencode plugin @jack-yang/opencode-tps-meter -g
```

Installs the plugin and updates your config. Restart opencode — done. (Applies default options; to customize, use the tuple form in [Configuration](#configuration).)

### Manual: npm

Add `@jack-yang/opencode-tps-meter` to the `plugin` array in `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "@jack-yang/opencode-tps-meter"
  ]
}
```

### GitHub

```json
{
  "plugin": [
    "git+https://github.com/yangwudong/opencode-tps-meter.git"
  ]
}
```

### Local file

1. Download [`tui.tsx`](./tui.tsx) to your opencode config directory:

```bash
curl -o ~/.config/opencode/tps-meter.tsx https://raw.githubusercontent.com/yangwudong/opencode-tps-meter/main/tui.tsx
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

## Configuration

All options are optional — defaults are sane. Pass them via the tuple form in `tui.json`:

```json
{
  "plugin": [
    ["@jack-yang/opencode-tps-meter", {
      "spinner": {
        "theme": "tech",
        "colors": ["#00e5ff", "#2979ff", "#651fff"],
        "intervalMs": 100,
        "cells": 6
      },
      "tiers": {
        "tps":  { "slow": 20, "normal": 50, "fast": 100 },
        "ttft": { "fast": 10000, "ok": 20000 }
      }
    }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `spinner.theme` | `"tech"` | Color preset: `"tech"` (cyan→blue→purple) or `"red"` (KITT-style red). `"none"` disables the thinking stream. |
| `spinner.colors` | _from theme_ | Custom gradient (hex strings); overrides `theme`. |
| `spinner.intervalMs` | `100` | Particle stream frame interval (ms). |
| `spinner.cells` | `6` | Number of cells (width) of the thinking stream. |
| `tiers.tps` | `{20,50,100}` | TPS/AVG thresholds (slow/normal/fast, in TPS); above `fast` is "faster". |
| `tiers.ttft` | `{10000,20000}` | TTFT thresholds in ms (fast/ok); above `ok` is "slow". |

## How It Works

### Live TPS

Tracks text/reasoning delta events in a rolling 5-second window. Uses wall-clock duration (`now - oldest sample`) instead of inter-arrival time sums to avoid inflation from network buffering.

Token estimation uses `ceil(byteLength / 4)` with a **calibration factor**: when a message completes, the estimated token count is compared against actual `tokens.output + tokens.reasoning` from the message metadata, and a running median ratio corrects future estimates.

### AVG

Session-wide cumulative average from all completed messages: `sum(actual tokens) / sum(generation durations)`. Updates when a message completes. Generation duration = `last delta - first delta` per message (excludes tool execution time and TTFT).

### TTFT

Time from message creation (`info.time.created`) to the first text/reasoning delta. Displayed immediately when the first token arrives, and persists until the next generation starts.

## Development

```bash
git clone https://github.com/yangwudong/opencode-tps-meter.git
cd opencode-tps-meter
npm install
npm test
```

Pure measurement functions (`measure.ts`) have 29 unit tests. The TUI plugin (`tui.tsx`) is a standalone single file (all functions inline) for direct deployment.

## Requirements

- opencode >= 1.4.3 (tested on 1.17.20)

## License

MIT
