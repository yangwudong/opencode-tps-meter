/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { PluginOptions } from "@opencode-ai/plugin"
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
  thinkingBySession: Record<string, boolean>
}

type Listener = () => void

type TpsTiers = { slow: number; normal: number; fast: number }
type TtftTiers = { fast: number; ok: number }
type SpinnerCfg = { colors: RGBA[]; intervalMs: number; enabled: boolean; cells: number }
type ResolvedConfig = { spinner: SpinnerCfg; tps: TpsTiers; ttft: TtftTiers }

const THEME_PRESETS: Record<string, string[]> = {
  tech: ["#00e5ff", "#2979ff", "#651fff"],
  red: ["#ff1744", "#ff5252", "#ff8a80"],
}

function resolveConfig(options: PluginOptions | undefined): ResolvedConfig {
  const o = (options ?? {}) as {
    spinner?: { theme?: string; colors?: string[]; intervalMs?: number; enabled?: boolean; cells?: number }
    tiers?: { tps?: Partial<TpsTiers>; ttft?: Partial<TtftTiers> }
  }
  const sp = o.spinner ?? {}
  let colors: RGBA[]
  if (Array.isArray(sp.colors) && sp.colors.length > 0) {
    colors = sp.colors.map((c) => RGBA.fromHex(c))
  } else {
    const preset = THEME_PRESETS[sp.theme ?? "tech"] ?? THEME_PRESETS.tech
    colors = preset.map((c) => RGBA.fromHex(c))
  }
  const cells = typeof sp.cells === "number" && sp.cells >= 2 ? Math.floor(sp.cells) : 6
  const spinner: SpinnerCfg = {
    colors,
    intervalMs: typeof sp.intervalMs === "number" && sp.intervalMs > 0 ? sp.intervalMs : 100,
    enabled: sp.enabled !== false && (sp.theme ?? "tech") !== "none",
    cells,
  }
  const tiers = o.tiers ?? {}
  const tp = tiers.tps ?? {}
  const tt = tiers.ttft ?? {}
  return {
    spinner,
    tps: { slow: tp.slow ?? 20, normal: tp.normal ?? 50, fast: tp.fast ?? 100 },
    ttft: { fast: tt.fast ?? 10000, ok: tt.ok ?? 20000 },
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t), 1)
}
function gradientColor(colors: RGBA[], t: number): RGBA {
  if (colors.length === 0) return RGBA.fromHex("#888888")
  if (colors.length === 1) return colors[0]
  const c = Math.max(0, Math.min(1, t))
  const seg = c * (colors.length - 1)
  const i = Math.min(Math.floor(seg), colors.length - 2)
  const f = seg - i
  return lerpColor(colors[i], colors[i + 1], f)
}

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
type Palette = { muted: RGBA; error: RGBA; warning: RGBA; success: RGBA; accent: RGBA }

type V2Event = { type: string; created: number; data: Record<string, any> }
type V2Theme = {
  text: {
    muted: RGBA
    feedback: Record<"error" | "warning" | "success" | "info", { base: RGBA; muted: RGBA }>
  }
  hue: Record<string, Partial<Record<number, RGBA>>>
}
type V2Context = {
  options: Record<string, unknown> | undefined
  renderer: { requestRender(): void }
  theme: V2Theme
  data: { on(type: string, handler: (event: V2Event) => void): () => void }
  ui: {
    slot(claim: { append: string; render: (input: { sessionID?: string }) => unknown }): () => void
    router: { current(): { type: string; sessionID?: string } }
  }
}

function v1Palette(t: TuiThemeCurrent): Palette {
  return { muted: t.textMuted, error: t.error, warning: t.warning, success: t.success, accent: t.accent }
}
function v2Palette(t: V2Theme): Palette {
  return {
    muted: t.text.muted,
    error: t.text.feedback.error.base,
    warning: t.text.feedback.warning.base,
    success: t.text.feedback.success.base,
    accent: t.hue.accent?.[500] ?? t.text.feedback.info.base,
  }
}

function speedTier(tps: number, c: TpsTiers): SpeedTier {
  if (tps < c.slow) return "slow"
  if (tps < c.normal) return "normal"
  if (tps < c.fast) return "fast"
  return "faster"
}
function tierColor(tier: SpeedTier, p: Palette): RGBA {
  switch (tier) {
    case "slow": return p.error
    case "normal": return p.warning
    case "fast": return p.success
    case "faster": return p.accent
  }
}
function tpsColor(tps: number, c: TpsTiers, p: Palette): RGBA {
  return tierColor(speedTier(tps, c), p)
}

type TtftTier = "fast" | "ok" | "slow"
function ttftTier(ms: number, c: TtftTiers): TtftTier {
  if (ms < c.fast) return "fast"
  if (ms < c.ok) return "ok"
  return "slow"
}
function ttftColor(ms: number, c: TtftTiers, p: Palette): RGBA {
  switch (ttftTier(ms, c)) {
    case "fast": return p.success
    case "ok": return p.warning
    case "slow": return p.error
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
  return ratios.length === 0 ? 1.0 : median(ratios)
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

const DOT_GLYPHS = ["⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "⠒", "⠑", "⠡", "⠢", "⠤", "⠨", "⠰", "⠸", "⠘", "⠔", "⠖", "⠦"]

type MeterCore = {
  tracker: TrackerState
  bump: () => void
  subscribe: (listener: Listener) => () => void
  spinnerCells: () => { glyph: string; color: RGBA }[]
  setThinking: (sessionID: string, value: boolean) => void
  clearSessionLive: (sessionID: string) => void
  dispose: () => void
}

function createMeterCore(config: ResolvedConfig, muted: RGBA): MeterCore {
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
    thinkingBySession: {},
  }
  const listeners = new Set<Listener>()
  const bump = () => { for (const l of listeners) l() }
  const subscribe = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }

  const N = config.spinner.cells
  const randomDot = () => DOT_GLYPHS[Math.floor(Math.random() * DOT_GLYPHS.length)]
  const spawnGlyph = () => (Math.random() < 0.18 ? " " : randomDot())
  let stream: string[] = []
  let hueFrame = 0
  let spinnerTimer: ReturnType<typeof setInterval> | undefined

  const initStream = () => {
    stream = Array.from({ length: N }, () => spawnGlyph())
    hueFrame = 0
  }
  const tickStream = () => {
    stream.unshift(spawnGlyph())
    if (stream.length > N) stream.pop()
    hueFrame++
  }
  initStream()

  const spinnerCells = () => {
    const bright = gradientColor(config.spinner.colors, (hueFrame % 60) / 60)
    const out: { glyph: string; color: RGBA }[] = []
    for (let i = 0; i < N; i++) {
      const g = stream[i] ?? " "
      out.push({ glyph: g, color: g === " " ? muted : lerpColor(bright, muted, i / (N - 1)) })
    }
    return out
  }

  const anyThinking = () => {
    for (const v of Object.values(tracker.thinkingBySession)) if (v) return true
    return false
  }
  const syncSpinnerTimer = () => {
    if (config.spinner.enabled && anyThinking() && !spinnerTimer) {
      spinnerTimer = setInterval(() => {
        tickStream()
        bump()
      }, config.spinner.intervalMs)
    } else if ((!anyThinking() || !config.spinner.enabled) && spinnerTimer) {
      clearInterval(spinnerTimer)
      spinnerTimer = undefined
    }
  }
  const setThinking = (sessionID: string, value: boolean) => {
    if (tracker.thinkingBySession[sessionID] === value) return
    tracker.thinkingBySession[sessionID] = value
    if (value) initStream()
    syncSpinnerTimer()
  }
  const clearSessionLive = (sessionID: string) => {
    delete tracker.samplesBySession[sessionID]
    setThinking(sessionID, false)
  }

  return {
    tracker,
    bump,
    subscribe,
    spinnerCells,
    setThinking,
    clearSessionLive,
    dispose: () => {
      if (spinnerTimer) clearInterval(spinnerTimer)
    },
  }
}

function recordMessageCompleted(core: MeterCore, info: {
  id: string
  sessionID: string
  tokens: { output: number; reasoning: number }
}) {
  const tracker = core.tracker
  const sessionID = info.sessionID
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
  core.setThinking(sessionID, false)
}

function MeterDisplay(props: {
  requestRender: () => void
  sessionID: string | undefined
  tracker: TrackerState
  config: ResolvedConfig
  palette: Palette
  spinnerCells: () => { glyph: string; color: RGBA }[]
  subscribe: (listener: Listener) => () => void
}) {
  let particleRef: TextRenderable | undefined
  let tpsRef: TextRenderable | undefined
  let avgRef: TextRenderable | undefined
  let ttftRef: TextRenderable | undefined
  const p = props.palette

  const sync = () => {
    const stats = props.tracker.statsBySession[props.sessionID]
    const calibration = calibrationFactor(stats?.calibrationRatios ?? [])
    const samples = props.tracker.samplesBySession[props.sessionID] ?? []
    const now = Date.now()
    const live = calculateLiveTps(samples, now, calibration)
    const avg = stats && stats.totalDurationMs > 0 ? stats.totalOutputTokens / (stats.totalDurationMs / 1000) : undefined
    const ttft = props.tracker.liveTtftBySession[props.sessionID]
    const thinkingNow = props.tracker.thinkingBySession[props.sessionID] === true && props.config.spinner.enabled
    if (particleRef) {
      if (thinkingNow) {
        const cells = props.spinnerCells()
        particleRef.content = " " + cells.map((c) => c.glyph).join("")
        particleRef.fg = cells[0]?.color ?? p.muted
      } else {
        particleRef.content = ""
      }
    }
    if (tpsRef) {
      tpsRef.content = live !== undefined ? formatTps(live) ?? "--" : "--"
      tpsRef.fg = live !== undefined ? tpsColor(live, props.config.tps, p) : p.muted
    }
    if (avgRef) {
      avgRef.content = avg !== undefined ? formatTps(avg) ?? "--" : "--"
      avgRef.fg = avg !== undefined ? tpsColor(avg, props.config.tps, p) : p.muted
    }
    if (ttftRef) {
      ttftRef.content = ttft !== undefined ? formatTtft(ttft) ?? "--" : "--"
      ttftRef.fg = ttft !== undefined ? ttftColor(ttft, props.config.ttft, p) : p.muted
    }
    props.requestRender()
  }

  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)

  return (
    <box flexDirection="row" alignItems="center">
      <text fg={p.muted}>TPS </text>
      <text ref={(el: TextRenderable) => { tpsRef = el; sync() }} fg={p.muted}>--</text>
      <text fg={p.muted}> | AVG </text>
      <text ref={(el: TextRenderable) => { avgRef = el; sync() }} fg={p.muted}>--</text>
      <text fg={p.muted}> | TTFT </text>
      <text ref={(el: TextRenderable) => { ttftRef = el; sync() }} fg={p.muted}>--</text>
      <text ref={(el: TextRenderable) => { particleRef = el; sync() }} fg={p.muted}></text>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const config = resolveConfig(options)
  const core = createMeterCore(config, api.theme.current.textMuted)
  const { tracker, bump, subscribe, spinnerCells, setThinking, clearSessionLive } = core

  const onTextDelta = api.event.on("session.next.text.delta", (evt) => {
    tracker.useV2Events = true
    const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
    recordDelta(tracker, sessionID, assistantMessageID, timestamp, delta)
    setThinking(sessionID, false)
    bump()
  })

  const onReasoningDelta = api.event.on("session.next.reasoning.delta", (evt) => {
    tracker.useV2Events = true
    const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
    recordDelta(tracker, sessionID, assistantMessageID, timestamp, delta)
    setThinking(sessionID, true)
    bump()
  })

  const onPartDelta = api.event.on("message.part.delta", (evt) => {
    if (tracker.useV2Events) return
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID)
    const part = parts.find((p) => p.id === evt.properties.partID)
    if (!part || (part.type !== "text" && part.type !== "reasoning")) return
    const { sessionID, messageID } = evt.properties
    recordDelta(tracker, sessionID, messageID, Date.now(), evt.properties.delta)
    setThinking(sessionID, part.type === "reasoning")
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
    recordMessageCompleted(core, { id: info.id, sessionID, tokens: info.tokens })
    bump()
  })

  const onToolInputStarted = api.event.on("session.next.tool.input.started", (evt) => {
    clearSessionLive(evt.properties.sessionID)
    bump()
  })

  const onPartUpdated = api.event.on("message.part.updated", (evt) => {
    if (evt.properties.part.type !== "tool") return
    if (["running", "completed", "error"].includes(evt.properties.part.state.status)) {
      clearSessionLive(evt.properties.part.sessionID ?? evt.properties.sessionID)
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
    core.dispose()
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return (
          <MeterDisplay
            requestRender={() => api.renderer.requestRender()}
            sessionID={value.session_id}
            tracker={tracker}
            config={config}
            palette={v1Palette(api.theme.current)}
            spinnerCells={spinnerCells}
            subscribe={subscribe}
          />
        )
      },
    },
  })
}

const setup = async (ctx: V2Context): Promise<() => void> => {
  const config = resolveConfig(ctx.options as PluginOptions | undefined)
  const core = createMeterCore(config, ctx.theme.text.muted)
  const { tracker, bump, subscribe, spinnerCells, setThinking, clearSessionLive } = core

  const unsubs: (() => void)[] = []
  const on = (type: string, handler: (event: V2Event) => void) => {
    unsubs.push(ctx.data.on(type, handler))
  }

  on("session.step.started", (evt) => {
    tracker.messageCreatedAt[evt.data.assistantMessageID] = evt.data.started
  })

  const onDelta = (thinking: boolean) => (evt: V2Event) => {
    const { sessionID, assistantMessageID, delta } = evt.data
    recordDelta(tracker, sessionID, assistantMessageID, evt.created, delta)
    setThinking(sessionID, thinking)
    bump()
  }
  on("session.text.delta", onDelta(false))
  on("session.reasoning.delta", onDelta(true))

  on("session.step.ended", (evt) => {
    const { sessionID, assistantMessageID, tokens } = evt.data
    if (tokens) recordMessageCompleted(core, { id: assistantMessageID, sessionID, tokens })
    bump()
  })

  on("session.step.failed", (evt) => {
    const { sessionID, assistantMessageID } = evt.data
    delete tracker.messageCreatedAt[assistantMessageID]
    delete tracker.estimatedTokensByMessage[assistantMessageID]
    delete tracker.firstDeltaByMessage[assistantMessageID]
    delete tracker.lastDeltaByMessage[assistantMessageID]
    clearSessionLive(sessionID)
    bump()
  })

  on("session.tool.input.started", (evt) => {
    clearSessionLive(evt.data.sessionID)
    bump()
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

  const opts = (ctx.options ?? {}) as { slot?: string }
  const slotPath = typeof opts.slot === "string" && opts.slot ? opts.slot : "prompt.footer.status"

  ctx.ui.slot({
    append: slotPath,
    render(input) {
      const sessionID = input.sessionID ?? (() => {
        const r = ctx.ui.router.current()
        return r.type === "session" ? r.sessionID : undefined
      })()
      return (
        <MeterDisplay
          requestRender={() => ctx.renderer.requestRender()}
          sessionID={sessionID}
          tracker={tracker}
          config={config}
          palette={v2Palette(ctx.theme)}
          spinnerCells={spinnerCells}
          subscribe={subscribe}
        />
      )
    },
  })

  return () => {
    for (const u of unsubs) u()
    clearInterval(timer)
    core.dispose()
  }
}

const plugin: TuiPluginModule & { id: string; setup: typeof setup } = {
  id: "opencode-tps-meter",
  tui,
  setup,
}
export default plugin
