# ADR 002 — Tool-call arguments are part of the generation window

- Status: accepted
- Date: 2026-11-06 (v1.3.0)

## Context

opencode reports `tokens.output = outputTokens − reasoningTokens`, so `output` **includes tool-call argument
tokens**. Up to v1.2.0 the AVG window (`firstDelta..lastDelta`) only covered text/reasoning deltas, and tool
events cleared the live samples. A step that says 8 tokens and then writes a 2000-token file via a tool call was
recorded as "2008 tokens in 1 s" (duration clamped to `MIN_DURATION_MS`), and its calibration ratio (2008/8,
clamped to 3.0) inflated every later live TPS by up to 3×.

Similarly, models that do not stream reasoning (e.g. o-series) report a large `tokens.reasoning` while the
reasoning time is spent before the first delta (it lands in TTFT, not in the window).

Event availability:

- V1 (opencode ≥ ~1.18, `session.next.*` events): `session.next.tool.input.delta` is published.
- V2: `session.tool.input.delta` (`evt.data`, timestamp `evt.created`); `session.step.ended` carries `finish`.
- Legacy V1 path (`message.part.delta`): **no** delta is emitted for tool input.

## Decision

On completion of a step:

```
generationMs = firstAt/lastAt present ? max(lastAt − firstAt, MIN_DURATION_MS) : 0
actual       = tokens.output + (sawReasoning ? tokens.reasoning : 0)
exclude      = !sawTool && (finish === "tool-calls" || toolPartSeen)   // legacy path / old versions
if !exclude && actual > 0 && generationMs > 0:
    add to AVG; if estimated > 0, push clamp(actual / estimated, 0.3, 3.0) to calibration (keep last 10)
```

- Tool input deltas (`kind: "tool"`) are recorded like text deltas: they count toward live TPS, the window, and the
  estimate.
- Tool events no longer clear live samples. `STALE_MS` makes TPS show `--` during tool execution; a new step
  (`session.step.started` / first `message.updated` of a new assistant message) clears the live state.
- A completion only clears live state if it belongs to the currently streaming message.

## Consequences

- AVG reflects the real decode speed, including tool-argument streaming; live TPS shows a value while the model
  writes large tool inputs.
- On the legacy path or old opencode versions, tool-calling steps are dropped from AVG/calibration rather than
  guessed — AVG may need more steps to appear, but it is never inflated by them.
- Non-streamed reasoning is not counted, so AVG for such models measures visible output speed only.
