/** @jsxImportSource @opentui/solid */
import { RGBA, StyledText } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { onCleanup } from "solid-js"

// ==== BEGIN PURE MEASURE (keep in sync with measure.ts — test/sync.test.ts enforces) ====
const WINDOW_MS = 5_000
const STALE_MS = 1_500
const THINKING_STALE_MS = 10_000
const MIN_DURATION_MS = 1_000
const MAX_CALIBRATION_RATIOS = 10
const MAX_TRACKED_MESSAGES = 32
const IDLE_TICK_MS = 250
const HUE_PERIOD = 60

type DeltaKind = "text" | "reasoning" | "tool"
type DeltaSample = { at: number; rawTokens: number }
type MessageTrack = {
  createdAt?: number
  firstAt?: number
  lastAt?: number
  estimated: number
  sawReasoning: boolean
  sawTool: boolean
  toolPartSeen: boolean
}
type SessionStats = { totalOutputTokens: number; totalDurationMs: number; calibrationRatios: number[] }
type TrackerState = {
  useV2Events: boolean
  samplesBySession: Record<string, DeltaSample[]>
  messages: Record<string, MessageTrack>
  liveTtftBySession: Record<string, number>
  activeMessageBySession: Record<string, string | undefined>
  statsBySession: Record<string, SessionStats>
  thinkingBySession: Record<string, boolean>
  lastDeltaAtBySession: Record<string, number>
}

function createTracker(): TrackerState {
  return {
    useV2Events: false,
    samplesBySession: {},
    messages: {},
    liveTtftBySession: {},
    activeMessageBySession: {},
    statsBySession: {},
    thinkingBySession: {},
    lastDeltaAtBySession: {},
  }
}

function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(utf8ByteLength(delta) / 4))
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
type TtftTier = "fast" | "ok" | "slow"
type TpsTiers = { slow: number; normal: number; fast: number }
type TtftTiers = { fast: number; ok: number }
const DEFAULT_TPS_TIERS: TpsTiers = { slow: 20, normal: 50, fast: 100 }
const DEFAULT_TTFT_TIERS: TtftTiers = { fast: 10_000, ok: 20_000 }

function speedTier(tps: number, tiers: TpsTiers = DEFAULT_TPS_TIERS): SpeedTier {
  if (tps < tiers.slow) return "slow"
  if (tps < tiers.normal) return "normal"
  if (tps < tiers.fast) return "fast"
  return "faster"
}

function ttftTier(ms: number, tiers: TtftTiers = DEFAULT_TTFT_TIERS): TtftTier {
  if (ms < tiers.fast) return "fast"
  if (ms < tiers.ok) return "ok"
  return "slow"
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

function liveTps(tracker: TrackerState, sessionID: string, now: number): number | undefined {
  const samples = tracker.samplesBySession[sessionID]
  if (!samples) return undefined
  const calibration = calibrationFactor(tracker.statsBySession[sessionID]?.calibrationRatios ?? [])
  return calculateLiveTps(samples, now, calibration)
}

function avgTps(tracker: TrackerState, sessionID: string): number | undefined {
  const stats = tracker.statsBySession[sessionID]
  if (!stats || stats.totalDurationMs <= 0) return undefined
  return stats.totalOutputTokens / (stats.totalDurationMs / 1000)
}

function trackMessage(tracker: TrackerState, messageID: string): MessageTrack {
  let track = tracker.messages[messageID]
  if (track) return track
  track = { estimated: 0, sawReasoning: false, sawTool: false, toolPartSeen: false }
  tracker.messages[messageID] = track
  const ids = Object.keys(tracker.messages)
  for (let i = 0; i < ids.length - MAX_TRACKED_MESSAGES; i++) delete tracker.messages[ids[i]]
  return track
}

/** Returns true if this is the first time the message is seen (i.e. a new step started). */
function recordMessageStart(tracker: TrackerState, messageID: string, createdAt: number | undefined): boolean {
  const isNew = tracker.messages[messageID] === undefined
  const track = trackMessage(tracker, messageID)
  if (track.createdAt === undefined && typeof createdAt === "number") track.createdAt = createdAt
  return isNew
}

function setThinking(tracker: TrackerState, sessionID: string, value: boolean): void {
  if (value) tracker.thinkingBySession[sessionID] = true
  else delete tracker.thinkingBySession[sessionID]
}

function anyThinking(tracker: TrackerState): boolean {
  for (const id in tracker.thinkingBySession) if (tracker.thinkingBySession[id]) return true
  return false
}

type DeltaInput = {
  sessionID: string
  messageID: string
  kind: DeltaKind
  delta: string
  /** Local receive time (Date.now()) — used for windows/staleness, immune to server clock skew. */
  at: number
  /** Server timestamp of the delta — used only for TTFT (createdAt is server time too). */
  serverAt?: number
}

/** Returns true when this delta was the first output token of its message (TTFT just became known). */
function recordDelta(tracker: TrackerState, d: DeltaInput): boolean {
  const rawTokens = estimateTokens(d.delta)
  let samples = tracker.samplesBySession[d.sessionID]
  if (!samples) samples = tracker.samplesBySession[d.sessionID] = []
  samples.push({ at: d.at, rawTokens })
  const cutoff = d.at - WINDOW_MS
  let drop = 0
  while (drop < samples.length && samples[drop].at < cutoff) drop++
  if (drop > 0) samples.splice(0, drop)

  const track = trackMessage(tracker, d.messageID)
  let first = false
  if (track.firstAt === undefined) {
    track.firstAt = d.at
    first = true
    if (track.createdAt !== undefined) {
      tracker.liveTtftBySession[d.sessionID] = Math.max(0, (d.serverAt ?? d.at) - track.createdAt)
    }
  }
  track.lastAt = d.at
  track.estimated += rawTokens
  if (d.kind === "reasoning") track.sawReasoning = true
  if (d.kind === "tool") track.sawTool = true

  tracker.activeMessageBySession[d.sessionID] = d.messageID
  tracker.lastDeltaAtBySession[d.sessionID] = d.at
  setThinking(tracker, d.sessionID, d.kind === "reasoning")
  return first
}

/** Legacy path marker: a tool part of this message started running (no tool input deltas are emitted there). */
function recordToolBoundary(tracker: TrackerState, messageID: string): void {
  trackMessage(tracker, messageID).toolPartSeen = true
}

function clearSessionLive(tracker: TrackerState, sessionID: string): void {
  delete tracker.samplesBySession[sessionID]
  setThinking(tracker, sessionID, false)
}

function discardMessage(tracker: TrackerState, messageID: string): void {
  delete tracker.messages[messageID]
  for (const sid in tracker.activeMessageBySession) {
    if (tracker.activeMessageBySession[sid] === messageID) delete tracker.activeMessageBySession[sid]
  }
}

type CompletedMessage = {
  id: string
  sessionID: string
  tokens: { output: number; reasoning: number }
  finish?: string
}

function recordMessageCompleted(tracker: TrackerState, info: CompletedMessage): void {
  const sessionID = info.sessionID
  const track = tracker.messages[info.id]
  if (track) {
    let stats = tracker.statsBySession[sessionID]
    if (!stats) stats = tracker.statsBySession[sessionID] = { totalOutputTokens: 0, totalDurationMs: 0, calibrationRatios: [] }
    const generationMs = track.firstAt !== undefined && track.lastAt !== undefined
      ? Math.max(track.lastAt - track.firstAt, MIN_DURATION_MS) : 0
    const output = Number(info.tokens?.output) || 0
    const reasoning = Number(info.tokens?.reasoning) || 0
    const actual = output + (track.sawReasoning ? reasoning : 0)
    const excludeForTools = !track.sawTool && (info.finish === "tool-calls" || track.toolPartSeen)
    if (!excludeForTools && actual > 0 && generationMs > 0) {
      stats.totalOutputTokens += actual
      stats.totalDurationMs += generationMs
      if (track.estimated > 0) {
        stats.calibrationRatios.push(Math.min(Math.max(actual / track.estimated, 0.3), 3.0))
        if (stats.calibrationRatios.length > MAX_CALIBRATION_RATIOS) {
          stats.calibrationRatios.splice(0, stats.calibrationRatios.length - MAX_CALIBRATION_RATIOS)
        }
      }
    }
    delete tracker.messages[info.id]
  }
  const active = tracker.activeMessageBySession[sessionID]
  if (active === undefined || active === info.id) {
    delete tracker.activeMessageBySession[sessionID]
    clearSessionLive(tracker, sessionID)
  }
}

/** Trims stale samples and stale thinking flags. Returns whether anything is still live. */
function prune(tracker: TrackerState, now: number): boolean {
  const cutoff = now - WINDOW_MS
  let live = false
  for (const sid in tracker.samplesBySession) {
    const samples = tracker.samplesBySession[sid]
    let drop = 0
    while (drop < samples.length && samples[drop].at < cutoff) drop++
    if (drop === samples.length) delete tracker.samplesBySession[sid]
    else {
      if (drop > 0) samples.splice(0, drop)
      live = true
    }
  }
  for (const sid in tracker.thinkingBySession) {
    const last = tracker.lastDeltaAtBySession[sid]
    if (last === undefined || now - last > THINKING_STALE_MS) setThinking(tracker, sid, false)
    else live = true
  }
  return live
}

type SpinnerOptions = { colors: string[]; intervalMs: number; enabled: boolean; cells: number }
type ResolvedOptions = { spinner: SpinnerOptions; tps: TpsTiers; ttft: TtftTiers; slot: string }

const THEME_PRESETS: Record<string, string[]> = {
  tech: ["#00e5ff", "#2979ff", "#651fff"],
  red: ["#ff1744", "#ff5252", "#ff8a80"],
}
const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveOptions(raw: unknown): ResolvedOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as {
    spinner?: { theme?: unknown; colors?: unknown; intervalMs?: unknown; enabled?: unknown; cells?: unknown }
    tiers?: { tps?: Partial<Record<keyof TpsTiers, unknown>>; ttft?: Partial<Record<keyof TtftTiers, unknown>> }
    slot?: unknown
  }
  const sp = o.spinner && typeof o.spinner === "object" ? o.spinner : {}
  const theme = typeof sp.theme === "string" && (sp.theme === "none" || THEME_PRESETS[sp.theme]) ? sp.theme : "tech"
  const custom = Array.isArray(sp.colors) ? sp.colors.filter((c): c is string => typeof c === "string" && HEX_COLOR.test(c)) : []
  const colors = custom.length > 0 ? custom : THEME_PRESETS[theme] ?? THEME_PRESETS.tech
  const spinner: SpinnerOptions = {
    colors,
    intervalMs: clampNumber(sp.intervalMs, 40, 1000, 100),
    enabled: sp.enabled !== false && theme !== "none",
    cells: Math.floor(clampNumber(sp.cells, 2, 16, 6)),
  }
  const tiers = o.tiers && typeof o.tiers === "object" ? o.tiers : {}
  const tp = tiers.tps ?? {}
  const tt = tiers.ttft ?? {}
  let tps: TpsTiers = {
    slow: positive(tp.slow, DEFAULT_TPS_TIERS.slow),
    normal: positive(tp.normal, DEFAULT_TPS_TIERS.normal),
    fast: positive(tp.fast, DEFAULT_TPS_TIERS.fast),
  }
  if (!(tps.slow < tps.normal && tps.normal < tps.fast)) tps = { ...DEFAULT_TPS_TIERS }
  let ttft: TtftTiers = { fast: positive(tt.fast, DEFAULT_TTFT_TIERS.fast), ok: positive(tt.ok, DEFAULT_TTFT_TIERS.ok) }
  if (!(ttft.fast < ttft.ok)) ttft = { ...DEFAULT_TTFT_TIERS }
  const slot = typeof o.slot === "string" && o.slot.trim() ? o.slot : "prompt.footer.status"
  return { spinner, tps, ttft, slot }
}

const DOT_GLYPHS = ["⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "⠒", "⠑", "⠡", "⠢", "⠤", "⠨", "⠰", "⠸", "⠘", "⠔", "⠖", "⠦"]

type Spinner = { cells: number; glyphs: string[]; frame: number; reset(): void; step(): void }

function createSpinner(cells: number, random: () => number = Math.random): Spinner {
  const spawn = () => (random() < 0.18 ? " " : DOT_GLYPHS[Math.floor(random() * DOT_GLYPHS.length)])
  const s: Spinner = {
    cells,
    glyphs: [],
    frame: 0,
    reset() {
      s.glyphs = Array.from({ length: cells }, spawn)
      s.frame = 0
    },
    step() {
      s.glyphs.unshift(spawn())
      if (s.glyphs.length > cells) s.glyphs.pop()
      s.frame++
    },
  }
  s.reset()
  return s
}

type PaletteKey = "muted" | "error" | "warning" | "success" | "accent"
/** A color reference resolved to a host color by the adapter. `cell` = particle index, `hue` = gradient phase (0..HUE_PERIOD-1). */
type ColorToken = PaletteKey | { cell: number; hue: number }
type Segment = { text: string; color: ColorToken }

const IDLE_TEXT = "TPS -- | AVG -- | TTFT --"

function speedToken(tier: SpeedTier): PaletteKey {
  return tier === "slow" ? "error" : tier === "normal" ? "warning" : tier === "fast" ? "success" : "accent"
}

function ttftToken(tier: TtftTier): PaletteKey {
  return tier === "fast" ? "success" : tier === "ok" ? "warning" : "error"
}

function colorKey(color: ColorToken): string {
  return typeof color === "string" ? color : `c${color.cell}.${color.hue}`
}

function segmentsKey(segments: Segment[]): string {
  return segments.map((s) => s.text + "\u0000" + colorKey(s.color)).join("\u0001")
}

function buildSegments(
  tracker: TrackerState,
  sessionID: string | undefined,
  now: number,
  options: { spinner: { enabled: boolean }; tps: TpsTiers; ttft: TtftTiers },
  spinner?: Spinner,
): Segment[] {
  const out: Segment[] = []
  const push = (text: string, color: ColorToken) => {
    const prev = out[out.length - 1]
    if (prev && typeof color === "string" && prev.color === color) prev.text += text
    else out.push({ text, color })
  }
  const live = sessionID !== undefined ? liveTps(tracker, sessionID, now) : undefined
  const avg = sessionID !== undefined ? avgTps(tracker, sessionID) : undefined
  const ttft = sessionID !== undefined ? tracker.liveTtftBySession[sessionID] : undefined
  const liveText = live !== undefined ? formatTps(live) : undefined
  const avgText = avg !== undefined ? formatTps(avg) : undefined
  const ttftText = ttft !== undefined ? formatTtft(ttft) : undefined
  push("TPS ", "muted")
  if (liveText) push(liveText, speedToken(speedTier(live!, options.tps)))
  else push("--", "muted")
  push(" | AVG ", "muted")
  if (avgText) push(avgText, speedToken(speedTier(avg!, options.tps)))
  else push("--", "muted")
  push(" | TTFT ", "muted")
  if (ttftText) push(ttftText, ttftToken(ttftTier(ttft!, options.ttft)))
  else push("--", "muted")
  if (sessionID !== undefined && spinner && options.spinner.enabled && tracker.thinkingBySession[sessionID]) {
    push(" ", "muted")
    const hue = spinner.frame % HUE_PERIOD
    for (let i = 0; i < spinner.cells; i++) {
      const glyph = spinner.glyphs[i] ?? " "
      if (glyph === " ") push(" ", "muted")
      else push(glyph, { cell: i, hue })
    }
  }
  return out
}

type Scheduler = {
  addView(view: () => void): () => void
  /** Call after any tracker mutation. `urgent` flushes views synchronously (e.g. first token → TTFT). */
  markDirty(urgent?: boolean): void
  flush(): void
  dispose(): void
  /** Current tick period in ms, or undefined when the timer is stopped (idle). */
  timerPeriod(): number | undefined
  viewCount(): number
}

function createScheduler(
  tracker: TrackerState,
  options: { spinner: { enabled: boolean; intervalMs: number } },
  spinner: Spinner,
): Scheduler {
  const views = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let period: number | undefined
  let spinning = false
  let disposed = false

  const flush = () => {
    for (const view of Array.from(views)) {
      try {
        view()
      } catch {
        views.delete(view)
      }
    }
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    period = undefined
  }
  const updateSpinner = (advance: boolean) => {
    const want = options.spinner.enabled && anyThinking(tracker)
    if (want && !spinning) spinner.reset()
    else if (want && advance) spinner.step()
    spinning = want
  }
  const reschedule = (live: boolean) => {
    if (disposed || !live) {
      stop()
      return
    }
    const want = spinning ? options.spinner.intervalMs : IDLE_TICK_MS
    if (timer !== undefined && period === want) return
    stop()
    period = want
    timer = setInterval(tick, want)
  }
  const tick = () => {
    const live = prune(tracker, Date.now())
    updateSpinner(true)
    flush()
    reschedule(live)
  }

  return {
    addView(view) {
      views.add(view)
      return () => {
        views.delete(view)
      }
    },
    markDirty(urgent = false) {
      if (disposed) return
      const live = prune(tracker, Date.now())
      updateSpinner(false)
      if (urgent || !live) flush()
      reschedule(live)
    },
    flush,
    dispose() {
      disposed = true
      stop()
      views.clear()
    },
    timerPeriod: () => period,
    viewCount: () => views.size,
  }
}
// ==== END PURE MEASURE ====

// ---- RGBA helpers (host-dependent, outside the pure region) ----

type Palette = { muted: RGBA; error: RGBA; warning: RGBA; success: RGBA; accent: RGBA }

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
  return lerpColor(colors[i], colors[i + 1], seg - i)
}

type V2Event = { type: string; created: number; data: Record<string, any> }
type V2Theme = {
  text: {
    muted: RGBA
    feedback: Record<"error" | "warning" | "success" | "info", { base: RGBA; muted: RGBA }>
  }
  hue: Record<string, Partial<Record<number, RGBA>>>
}
type V2SlotInput = { readonly sessionID?: string }
type V2Context = {
  options: Record<string, unknown> | undefined
  renderer: { requestRender(): void }
  theme: V2Theme
  data: { on(type: string, handler: (event: V2Event) => void): () => void }
  ui: {
    slot(claim: { append: string; render: (input: V2SlotInput) => unknown }): () => void
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

// ---- Core: tracker + scheduler shared by every view of one host ----

type MeterCore = {
  tracker: TrackerState
  options: ResolvedOptions
  spinner: Spinner
  scheduler: Scheduler
  gradient: RGBA[]
}

function createMeterCore(rawOptions: unknown): MeterCore {
  const options = resolveOptions(rawOptions)
  const tracker = createTracker()
  const spinner = createSpinner(options.spinner.cells)
  const scheduler = createScheduler(tracker, options, spinner)
  const gradient = options.spinner.colors.map((c) => RGBA.fromHex(c))
  return { tracker, options, spinner, scheduler, gradient }
}

function resolveColor(token: ColorToken, palette: Palette, core: MeterCore): RGBA {
  if (typeof token === "string") return palette[token]
  const bright = gradientColor(core.gradient, token.hue / HUE_PERIOD)
  return lerpColor(bright, palette.muted, token.cell / Math.max(1, core.spinner.cells - 1))
}

/** Wraps an event handler so a malformed payload never throws into the host. */
function guard<E>(fn: (evt: E) => void): (evt: E) => void {
  return (evt) => {
    try {
      fn(evt)
    } catch {}
  }
}

// ---- View: one <text>, StyledText content, imperative + diffed (AGENTS.md gotchas #2/#3) ----

function MeterDisplay(props: {
  core: MeterCore
  palette: Palette
  sessionID: () => string | undefined
  requestRender: () => void
}) {
  const { core, palette } = props
  let ref: TextRenderable | undefined
  let lastKey = ""
  let unsubscribe = () => {}

  const flush = () => {
    if (!ref) return
    if (ref.isDestroyed) {
      unsubscribe()
      return
    }
    const segments = buildSegments(core.tracker, props.sessionID(), Date.now(), core.options, core.spinner)
    const key = segmentsKey(segments)
    if (key === lastKey) return
    lastKey = key
    ref.content = new StyledText(
      segments.map((s) => ({ __isChunk: true as const, text: s.text, fg: resolveColor(s.color, palette, core) })),
    )
    props.requestRender()
  }

  unsubscribe = core.scheduler.addView(flush)
  onCleanup(() => unsubscribe())

  return (
    <text
      ref={(el: TextRenderable) => {
        ref = el
        lastKey = ""
        flush()
      }}
      fg={palette.muted}
      wrapMode="none"
    />
  )
}

// ---- V1 host (opencode 1.x): `tui` entrypoint ----

const tui: TuiPlugin = async (api, options) => {
  const core = createMeterCore(options)
  const { tracker, scheduler } = core
  const dirty = (urgent = false) => scheduler.markDirty(urgent)

  const offs = [
    api.event.on("session.next.text.delta", guard((evt) => {
      tracker.useV2Events = true
      const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
      dirty(recordDelta(tracker, { sessionID, messageID: assistantMessageID, kind: "text", delta, at: Date.now(), serverAt: timestamp }))
    })),
    api.event.on("session.next.reasoning.delta", guard((evt) => {
      tracker.useV2Events = true
      const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
      dirty(recordDelta(tracker, { sessionID, messageID: assistantMessageID, kind: "reasoning", delta, at: Date.now(), serverAt: timestamp }))
    })),
    api.event.on("session.next.tool.input.delta", guard((evt) => {
      tracker.useV2Events = true
      const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
      dirty(recordDelta(tracker, { sessionID, messageID: assistantMessageID, kind: "tool", delta, at: Date.now(), serverAt: timestamp }))
    })),
    api.event.on("message.part.delta", guard((evt) => {
      if (tracker.useV2Events) return
      if (evt.properties.field !== "text") return
      const { sessionID, messageID, partID, delta } = evt.properties
      const part = api.state.part(messageID).find((p) => p.id === partID)
      if (!part || (part.type !== "text" && part.type !== "reasoning")) return
      dirty(recordDelta(tracker, { sessionID, messageID, kind: part.type, delta, at: Date.now() }))
    })),
    api.event.on("message.updated", guard((evt) => {
      const info = evt.properties.info
      if (info.role !== "assistant") return
      const sessionID = info.sessionID ?? evt.properties.sessionID
      if (!info.time.completed) {
        if (recordMessageStart(tracker, info.id, info.time.created)) {
          clearSessionLive(tracker, sessionID)
          dirty()
        }
        return
      }
      recordMessageCompleted(tracker, { id: info.id, sessionID, tokens: info.tokens, finish: info.finish })
      dirty()
    })),
    api.event.on("session.next.tool.input.started", guard((evt) => {
      setThinking(tracker, evt.properties.sessionID, false)
      dirty()
    })),
    api.event.on("message.part.updated", guard((evt) => {
      const part = evt.properties.part
      if (part.type !== "tool") return
      if (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error") {
        recordToolBoundary(tracker, part.messageID)
        setThinking(tracker, part.sessionID ?? evt.properties.sessionID, false)
        dirty()
      }
    })),
    api.event.on("session.idle", guard((evt) => {
      clearSessionLive(tracker, evt.properties.sessionID)
      dirty()
    })),
    api.event.on("session.error", guard((evt) => {
      if (!evt.properties.sessionID) return
      clearSessionLive(tracker, evt.properties.sessionID)
      dirty()
    })),
  ]

  api.lifecycle.onDispose(() => {
    for (const off of offs) off()
    scheduler.dispose()
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return (
          <MeterDisplay
            core={core}
            palette={v1Palette(api.theme.current)}
            sessionID={() => value.session_id}
            requestRender={() => api.renderer.requestRender()}
          />
        )
      },
    },
  })
}

// ---- V2 host (opencode 2.x): `setup` entrypoint ----

const setup = async (ctx: V2Context): Promise<() => void> => {
  const core = createMeterCore(ctx.options)
  const { tracker, scheduler } = core
  const dirty = (urgent = false) => scheduler.markDirty(urgent)

  const offs: (() => void)[] = []
  const on = (type: string, handler: (event: V2Event) => void) => {
    offs.push(ctx.data.on(type, guard(handler)))
  }

  on("session.step.started", (evt) => {
    const { sessionID, assistantMessageID, started } = evt.data
    recordMessageStart(tracker, assistantMessageID, started)
    clearSessionLive(tracker, sessionID)
    dirty()
  })

  const onDelta = (kind: DeltaKind) => (evt: V2Event) => {
    const { sessionID, assistantMessageID, delta } = evt.data
    dirty(recordDelta(tracker, { sessionID, messageID: assistantMessageID, kind, delta, at: Date.now(), serverAt: evt.created }))
  }
  on("session.text.delta", onDelta("text"))
  on("session.reasoning.delta", onDelta("reasoning"))
  on("session.tool.input.delta", onDelta("tool"))

  on("session.step.ended", (evt) => {
    const { sessionID, assistantMessageID, tokens, finish } = evt.data
    if (tokens) recordMessageCompleted(tracker, { id: assistantMessageID, sessionID, tokens, finish })
    else discardMessage(tracker, assistantMessageID)
    dirty()
  })

  on("session.step.failed", (evt) => {
    const { sessionID, assistantMessageID } = evt.data
    discardMessage(tracker, assistantMessageID)
    clearSessionLive(tracker, sessionID)
    dirty()
  })

  on("session.tool.input.started", (evt) => {
    setThinking(tracker, evt.data.sessionID, false)
    dirty()
  })

  for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    on(type, (evt) => {
      clearSessionLive(tracker, evt.data.sessionID)
      dirty()
    })
  }

  const routeSessionID = () => {
    const r = ctx.ui.router.current()
    return r.type === "session" ? r.sessionID : undefined
  }

  const unregisterSlot = ctx.ui.slot({
    append: core.options.slot,
    render(input) {
      return (
        <MeterDisplay
          core={core}
          palette={v2Palette(ctx.theme)}
          sessionID={() => input.sessionID ?? routeSessionID()}
          requestRender={() => ctx.renderer.requestRender()}
        />
      )
    },
  })

  return () => {
    for (const off of offs) off()
    if (typeof unregisterSlot === "function") unregisterSlot()
    scheduler.dispose()
  }
}

const plugin: TuiPluginModule & { id: string; setup: typeof setup } = {
  id: "opencode-tps-meter",
  tui,
  setup,
}
export default plugin
