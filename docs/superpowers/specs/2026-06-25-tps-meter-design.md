# opencode-tps-meter Design

## Goal

An opencode TUI plugin that displays real-time LLM output speed (tokens per second), session average TPS, and time-to-first-token (TTFT) next to the session prompt. The live TPS value is color-coded by speed tier.

## Problem in Existing Implementations

Three reference plugins were analyzed:

1. **oc-tps** (Tarquinen/oc-tps) — shows TPS/AVG/TTFT but values are wrong due to:
   - **Duration bug**: `activeDurationMs` sums inter-arrival times between delta events. When the network batches multiple tokens into one packet, deltas arrive near-simultaneously, making total duration appear much shorter than reality. This inflates TPS dramatically.
   - **Uncalibrated token estimation**: `bytes / 5` heuristic with no correction against actual token counts.
   - **Wrong TTFT start point**: Uses `message.time.created` (record creation time) instead of when the LLM call actually starts.

2. **williamcr01/opencode-tps** — shows only live TPS, same duration bug and uncalibrated estimation.

3. **floze-the-genius/opencode-tps-meter** — patches opencode source directly (not a plugin). Uses `bytes / 4`, same inter-arrival duration approach. Fragile and version-specific.

## Approach

Single-file TUI plugin using a hybrid event strategy:

- **Primary events**: `session.next.text.delta` and `session.next.reasoning.delta` (v2 events with server-side timestamps). These are confirmed available through the TUI plugin's `api.event.on()` event bus — the bus receives all non-sync events from the server (`packages/tui/src/context/event.ts` filters only `type === "sync"`).
- **Fallback events**: `message.part.delta` with `Date.now()` if v2 events are not received within a startup grace period.
- **Completion data**: `message.updated` with `info.time.completed` for actual token counts (`tokens.output + tokens.reasoning`).
- **Step timing**: `session.next.step.started` for TTFT start point. Fallback: session status transition idle→busy.
- **Tool-call boundaries**: `session.next.tool.input.started` and `message.part.updated` (tool status changes) to clear live samples.

### V2 Event Detection and Fallback

The plugin subscribes to both v2 (`session.next.text.delta`, `session.next.reasoning.delta`) and legacy (`message.part.delta`) events simultaneously. A boolean flag `useV2Events` starts as `false`. The first time a v2 delta event is received, the flag is set to `true` and legacy `message.part.delta` events are ignored for sample collection from that point forward. This prevents double-counting and gracefully degrades on opencode versions that don't emit v2 events.

When `useV2Events` is `false`, timestamps come from `Date.now()`. When `true`, timestamps come from the server-side `timestamp` property in the v2 event.

## Metrics

### Live TPS (current output speed)

Rolling 5-second window of delta samples. Each sample stores a server timestamp (or `Date.now()` fallback) and an estimated token count.

**Token estimation**: `ceil(byteLength(delta) / 4)` per delta, multiplied by a live calibration factor.

**Duration**: Wall-clock span of the window = `latest_timestamp - oldest_timestamp`. Minimum 250ms floor to avoid division instability on the first sample. This replaces the broken inter-arrival sum approach.

**Formula**: `liveTPS = sum(calibrated_tokens_in_window) / wall_clock_seconds`

**Stale display**: If no delta received in 1.5 seconds, show `--`.

### Average TPS (session-wide)

Accumulated across completed assistant messages.

When a message completes (`message.updated` with `info.time.completed`):
- `actualTokens = info.tokens.output + info.tokens.reasoning`
- `generationMs` = sum of per-step generation durations for that message. Each step's generation duration = `step.lastDeltaAt - step.firstDeltaAt`. This naturally excludes tool execution gaps between steps.
- Accumulate: `totalTokens += actualTokens`, `totalGenerationMs += generationMs`

**Formula**: `avgTPS = totalTokens / (totalGenerationMs / 1000)`

### TTFT (time to first token, session average)

Per step (a message may contain multiple steps):
- **Start**: `session.next.step.started.timestamp` (when the LLM call begins). Fallback: timestamp of session status idle→busy transition.
- **End**: First `session.next.text.delta.timestamp` or `session.next.reasoning.delta.timestamp`. Fallback: first `message.part.delta` timestamp.
- `ttft = end - start`

**Formula**: `avgTTFT = sum(all_ttft) / ttft_count`, where `ttft_count` is the number of steps measured (one TTFT per step, not per message — a multi-step message contributes multiple TTFT values). Displayed in seconds with one decimal.

### Token Calibration

When a message completes:
- `estimatedTokens` = sum of raw byte-based estimates from all deltas in that message
- `actualTokens` = `tokens.output + tokens.reasoning` from `message.updated`
- `ratio = clamp(actualTokens / estimatedTokens, 0.3, 3.0)`
- Store ratio in a rolling array (last 10 completed messages)
- Calibration factor = median of stored ratios
- Applied to live TPS: `calibratedTokens = rawEstimate * calibrationFactor`

This self-corrects the byte heuristic to match the actual tokenizer. Initial factor is 1.0 (uncalibrated) until the first message completes.

## Color Coding

Applied **only** to the live TPS numeric value. Field labels (`TPS`, `AVG`, `TTFT`) and all other values use `theme.textMuted`.

| Tier | Range | Theme Color |
|------|-------|-------------|
| Slow | < 20 TPS | `theme.error` (red) |
| Normal | 20–50 TPS | `theme.warning` (yellow) |
| Fast | 50–100 TPS | `theme.success` (green) |
| Faster | > 100 TPS | `theme.accent` (cyan) |

Boundary handling: the lower bound is inclusive (e.g., 20.0 TPS → Normal).

## Display Format

```
TPS 42.5 | AVG 38.2 | TTFT 0.8s
```

- `TPS` label: `theme.textMuted`
- `42.5` value: colored by speed tier
- ` | AVG ` separator and label: `theme.textMuted`
- `38.2` value: `theme.textMuted`
- ` | TTFT ` separator and label: `theme.textMuted`
- `0.8s` value: `theme.textMuted`

When idle: `TPS -- | AVG 38.2 | TTFT 0.8s` (live shows `--`, averages persist from last session activity).

Formatting rules:
- TPS < 10: two decimals (`42.53`)
- TPS 10–99: one decimal (`42.5`)
- TPS >= 100: rounded (`127`)
- TTFT: one decimal in seconds (`0.8s`)

Rendered as a row of `<text>` elements inside a `<box flexDirection="row">` to allow per-element foreground colors.

## Edge Cases

- **Tool calls**: When a tool starts (`session.next.tool.input.started` or `message.part.updated` with tool status running/completed/error), clear live samples. Tool execution time is excluded from generation duration.
- **Reasoning models** (o1/o3/etc.): Reasoning deltas count toward live TPS and total tokens. They are output tokens. TTFT end point is the first reasoning delta if it arrives before text.
- **Multiple steps per message**: A single assistant message can have multiple LLM calls (text → tool → text). Each step gets independent timing. TTFT is measured per-step and averaged.
- **Session switching**: All stats are keyed by `sessionID`. Each session has independent tracking.
- **Memory management**: Prune delta samples older than 5 seconds every 1 second via interval timer. Cap tracked messages at 24. Cap samples per message at 4096.
- **First message (no calibration)**: Use raw byte estimate until the first message completes and provides a calibration ratio.

## File Structure

```
opencode-tps-meter/
├── package.json          # Plugin manifest, peer deps on @opencode-ai/plugin, @opentui/core, @opentui/solid, solid-js
├── tui.tsx               # Single file: event tracking + measurement + display + slot registration
└── README.md             # Installation and usage
```

## Data Structures

```typescript
type DeltaSample = {
  at: number              // server timestamp (v2 event) or Date.now() (fallback)
  rawTokens: number       // ceil(byteLength / 4), pre-calibration
}

type StepTiming = {
  sessionID: string
  assistantMessageID: string
  stepStartedAt?: number       // session.next.step.started timestamp
  firstDeltaAt?: number        // first text/reasoning delta timestamp
  lastDeltaAt?: number         // last delta timestamp
  estimatedTokens: number      // sum of rawTokens for calibration
}

type SessionStats = {
  totalOutputTokens: number    // actual tokens from message.updated
  totalGenerationMs: number    // sum of generation durations
  totalTtftMs: number          // sum of TTFT values
  stepCount: number            // number of steps measured (for TTFT average)
  calibrationRatios: number[]  // last 10 ratios
}
```

## Event Subscriptions

| Event | Purpose |
|-------|---------|
| `session.next.step.started` | TTFT start point, step tracking |
| `session.next.text.delta` | Live TPS samples (text) |
| `session.next.reasoning.delta` | Live TPS samples (reasoning) |
| `session.next.tool.input.started` | Clear live samples (tool begins) |
| `message.part.delta` | Fallback live TPS (if v2 events not received) |
| `message.updated` | Actual token counts on completion, average TPS |
| `message.part.updated` | Tool status changes (clear live samples) |

All subscriptions are cleaned up via `api.lifecycle.onDispose()`.

## Plugin Manifest

```json
{
  "name": "opencode-tps-meter",
  "type": "module",
  "exports": { "./tui": { "import": "./tui.tsx" } },
  "engines": { "opencode": ">=1.4.3" },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.4.3",
    "@opentui/core": "^0.4.2",
    "@opentui/solid": "^0.4.2",
    "solid-js": "^1.9.12"
  }
}
```

Plugin entry:
```typescript
const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-tps-meter",
  tui,
}
export default plugin
```

Registered via `opencode.json` plugin config or `opencode plugin add`.
