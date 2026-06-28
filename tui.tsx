/** @jsxImportSource @opentui/solid */
import type { TextRenderable, RGBA } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { onCleanup } from "solid-js"

type DeltaSample = { at: number; rawTokens: number }

type SessionStats = {
  totalOutputTokens: number
  totalDurationMs: number
  calibrationRatios: number[]
}

type TrackerState = {
  useV2Events: boolean
  samplesBySession: Record<string, DeltaSample[]>
  messageCreatedAt: Record<string, number>
  firstDeltaByMessage: Record<string, number>
  lastDeltaByMessage: Record<string, number>
  estimatedTokensByMessage: Record<string, number>
  liveTtftBySession: Record<string, number>
  activeMessageBySession: Record<string, string | undefined>
  statsBySession: Record<string, SessionStats>
}

type Listener = () => void

const WINDOW_MS = 5_000
const STALE_MS = 1_500
const MIN_DURATION_MS = 1_000
const MAX_CALIBRATION_RATIOS = 10

function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 4))
}

function formatTps(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formatTtft(valueMs: number): string | undefined {
  if (!Number.isFinite(valueMs) || valueMs < 0) return undefined
  return `${(valueMs / 1000).toFixed(1)}s`
}

type SpeedTier = "slow" | "normal" | "fast" | "faster"
function speedTier(tps: number): SpeedTier {
  if (tps < 20) return "slow"
  if (tps < 50) return "normal"
  if (tps < 100) return "fast"
  return "faster"
}
function tierColor(tier: SpeedTier, theme: TuiThemeCurrent): RGBA {
  switch (tier) {
    case "slow": return theme.error
    case "normal": return theme.warning
    case "fast": return theme.success
    case "faster": return theme.accent
  }
}
function tpsColor(tps: number, theme: TuiThemeCurrent): RGBA {
  return tierColor(speedTier(tps), theme)
}

type TtftTier = "fast" | "ok" | "slow"
function ttftTier(ms: number): TtftTier {
  if (ms < 500) return "fast"
  if (ms < 2000) return "ok"
  return "slow"
}
function ttftColor(ms: number, theme: TuiThemeCurrent): RGBA {
  switch (ttftTier(ms)) {
    case "fast": return theme.success
    case "ok": return theme.warning
    case "slow": return theme.error
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 1.0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) return sorted[mid]
  return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 1e10) / 1e10
}
function calibrationFactor(ratios: number[]): number {
  if (ratios.length === 0) return 1.0
  return median(ratios)
}

function calculateLiveTps(samples: DeltaSample[], now: number, calibration: number): number | undefined {
  if (samples.length === 0) return undefined
  const cutoff = now - WINDOW_MS
  const relevant = samples.filter((s) => s.at >= cutoff)
  if (relevant.length === 0) return undefined
  const last = relevant[relevant.length - 1]
  if (now - last.at > STALE_MS) return undefined
  const oldest = relevant[0]
  const durationMs = Math.max(now - oldest.at, MIN_DURATION_MS)
  const totalRaw = relevant.reduce((sum, s) => sum + s.rawTokens, 0)
  return (totalRaw * calibration) / (durationMs / 1000)
}

function recordDelta(tracker: TrackerState, sessionID: string, messageID: string, at: number, delta: string) {
  const rawTokens = estimateTokens(delta)
  const cutoff = at - WINDOW_MS
  const existing = tracker.samplesBySession[sessionID] ?? []
  tracker.samplesBySession[sessionID] = [...existing.filter((s) => s.at >= cutoff), { at, rawTokens }]
  if (tracker.firstDeltaByMessage[messageID] === undefined) {
    tracker.firstDeltaByMessage[messageID] = at
    const created = tracker.messageCreatedAt[messageID]
    if (created !== undefined) {
      tracker.liveTtftBySession[sessionID] = Math.max(0, at - created)
    }
  }
  tracker.lastDeltaByMessage[messageID] = at
  tracker.estimatedTokensByMessage[messageID] = (tracker.estimatedTokensByMessage[messageID] ?? 0) + rawTokens
  tracker.activeMessageBySession[sessionID] = messageID
}

function MeterDisplay(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  tracker: TrackerState
  subscribe: (listener: Listener) => () => void
}) {
  let tpsRef: TextRenderable | undefined
  let avgRef: TextRenderable | undefined
  let ttftRef: TextRenderable | undefined
  const theme = props.api.theme.current
  const muted = theme.textMuted

  const sync = () => {
    const stats = props.tracker.statsBySession[props.sessionID]
    const calibration = calibrationFactor(stats?.calibrationRatios ?? [])
    const samples = props.tracker.samplesBySession[props.sessionID] ?? []
    const now = Date.now()
    const live = calculateLiveTps(samples, now, calibration)
    const avg = stats && stats.totalDurationMs > 0 ? stats.totalOutputTokens / (stats.totalDurationMs / 1000) : undefined
    const ttft = props.tracker.liveTtftBySession[props.sessionID]

    if (tpsRef) {
      tpsRef.content = live !== undefined ? formatTps(live) ?? "--" : "--"
      tpsRef.fg = live !== undefined ? tpsColor(live, theme) : muted
    }
    if (avgRef) {
      avgRef.content = avg !== undefined ? formatTps(avg) ?? "--" : "--"
      avgRef.fg = avg !== undefined ? tpsColor(avg, theme) : muted
    }
    if (ttftRef) {
      ttftRef.content = ttft !== undefined ? formatTtft(ttft) ?? "--" : "--"
      ttftRef.fg = ttft !== undefined ? ttftColor(ttft, theme) : muted
    }
    props.api.renderer.requestRender()
  }

  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)

  return (
    <box flexDirection="row">
      <text fg={muted}>TPS </text>
      <text ref={(el: TextRenderable) => { tpsRef = el; sync() }} fg={muted}>--</text>
      <text fg={muted}> | AVG </text>
      <text ref={(el: TextRenderable) => { avgRef = el; sync() }} fg={muted}>--</text>
      <text fg={muted}> | TTFT </text>
      <text ref={(el: TextRenderable) => { ttftRef = el; sync() }} fg={muted}>--</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const tracker: TrackerState = {
    useV2Events: false,
    samplesBySession: {},
    messageCreatedAt: {},
    firstDeltaByMessage: {},
    lastDeltaByMessage: {},
    estimatedTokensByMessage: {},
    liveTtftBySession: {},
    activeMessageBySession: {},
    statsBySession: {},
  }
  const listeners = new Set<Listener>()
  const bump = () => { for (const l of listeners) l() }
  const subscribe = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }

  const onTextDelta = api.event.on("session.next.text.delta", (evt) => {
    tracker.useV2Events = true
    recordDelta(tracker, evt.properties.sessionID, evt.properties.assistantMessageID, evt.properties.timestamp, evt.properties.delta)
    bump()
  })

  const onReasoningDelta = api.event.on("session.next.reasoning.delta", (evt) => {
    tracker.useV2Events = true
    recordDelta(tracker, evt.properties.sessionID, evt.properties.assistantMessageID, evt.properties.timestamp, evt.properties.delta)
    bump()
  })

  const onPartDelta = api.event.on("message.part.delta", (evt) => {
    if (tracker.useV2Events) return
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID)
    const part = parts.find((p) => p.id === evt.properties.partID)
    if (!part || (part.type !== "text" && part.type !== "reasoning")) return
    recordDelta(tracker, evt.properties.sessionID, evt.properties.messageID, Date.now(), evt.properties.delta)
    bump()
  })

  const onMessageUpdated = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.role !== "assistant") return

    if (!info.time.completed) {
      tracker.messageCreatedAt[info.id] = info.time.created
      return
    }

    const sessionID = info.sessionID ?? evt.properties.sessionID
    if (!tracker.statsBySession[sessionID]) {
      tracker.statsBySession[sessionID] = { totalOutputTokens: 0, totalDurationMs: 0, calibrationRatios: [] }
    }
    const stats = tracker.statsBySession[sessionID]!

    const actualTokens = info.tokens.output + info.tokens.reasoning
    const firstDelta = tracker.firstDeltaByMessage[info.id]
    const lastDelta = tracker.lastDeltaByMessage[info.id]
    const generationMs = firstDelta !== undefined && lastDelta !== undefined
      ? Math.max(lastDelta - firstDelta, MIN_DURATION_MS) : 0

    if (actualTokens > 0 && generationMs > 0) {
      stats.totalOutputTokens += actualTokens
      stats.totalDurationMs += generationMs

      const estimated = tracker.estimatedTokensByMessage[info.id] ?? 0
      if (estimated > 0) {
        const ratio = Math.min(Math.max(actualTokens / estimated, 0.3), 3.0)
        stats.calibrationRatios = [...stats.calibrationRatios, ratio].slice(-MAX_CALIBRATION_RATIOS)
      }
    }

    delete tracker.estimatedTokensByMessage[info.id]
    delete tracker.firstDeltaByMessage[info.id]
    delete tracker.lastDeltaByMessage[info.id]
    delete tracker.messageCreatedAt[info.id]
    delete tracker.activeMessageBySession[sessionID]
    delete tracker.samplesBySession[sessionID]
    bump()
  })

  const onToolInputStarted = api.event.on("session.next.tool.input.started", (evt) => {
    delete tracker.samplesBySession[evt.properties.sessionID]
    bump()
  })

  const onPartUpdated = api.event.on("message.part.updated", (evt) => {
    if (evt.properties.part.type !== "tool") return
    if (["running", "completed", "error"].includes(evt.properties.part.state.status)) {
      delete tracker.samplesBySession[evt.properties.part.sessionID ?? evt.properties.sessionID]
      bump()
    }
  })

  const timer = setInterval(() => {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    for (const [sid, samples] of Object.entries(tracker.samplesBySession)) {
      const pruned = samples.filter((s) => s.at >= cutoff)
      if (pruned.length > 0) tracker.samplesBySession[sid] = pruned
      else delete tracker.samplesBySession[sid]
    }
    bump()
  }, 1000)

  api.lifecycle.onDispose(() => {
    onTextDelta(); onReasoningDelta(); onPartDelta()
    onMessageUpdated(); onToolInputStarted(); onPartUpdated()
    clearInterval(timer)
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return <MeterDisplay api={api} sessionID={value.session_id} tracker={tracker} subscribe={subscribe} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "opencode-tps-meter", tui }
export default plugin
