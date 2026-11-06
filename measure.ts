// Pure measurement functions — no JSX, no imports, no runtime deps.
// The region below is duplicated verbatim (minus `export`) in tui.tsx; test/sync.test.ts enforces it.
// See docs/adr/001-shared-pure-measure-region.md.

// ==== BEGIN PURE MEASURE (keep in sync with measure.ts — test/sync.test.ts enforces) ====
export const WINDOW_MS = 5_000
export const STALE_MS = 1_500
export const THINKING_STALE_MS = 10_000
export const MIN_DURATION_MS = 1_000
export const MAX_CALIBRATION_RATIOS = 10
export const MAX_TRACKED_MESSAGES = 32
export const IDLE_TICK_MS = 250
export const HUE_PERIOD = 60

export type DeltaKind = "text" | "reasoning" | "tool"
export type DeltaSample = { at: number; rawTokens: number }
export type MessageTrack = {
  createdAt?: number
  firstAt?: number
  lastAt?: number
  estimated: number
  sawReasoning: boolean
  sawTool: boolean
  toolPartSeen: boolean
}
export type SessionStats = { totalOutputTokens: number; totalDurationMs: number; calibrationRatios: number[] }
export type TrackerState = {
  useV2Events: boolean
  samplesBySession: Record<string, DeltaSample[]>
  messages: Record<string, MessageTrack>
  liveTtftBySession: Record<string, number>
  activeMessageBySession: Record<string, string | undefined>
  statsBySession: Record<string, SessionStats>
  thinkingBySession: Record<string, boolean>
  lastDeltaAtBySession: Record<string, number>
}

export function createTracker(): TrackerState {
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

export function utf8ByteLength(s: string): number {
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

export function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(utf8ByteLength(delta) / 4))
}

export function formatTps(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function formatTtft(valueMs: number): string | undefined {
  if (!Number.isFinite(valueMs) || valueMs < 0) return undefined
  return `${(valueMs / 1000).toFixed(1)}s`
}

export type SpeedTier = "slow" | "normal" | "fast" | "faster"
export type TtftTier = "fast" | "ok" | "slow"
export type TpsTiers = { slow: number; normal: number; fast: number }
export type TtftTiers = { fast: number; ok: number }
export const DEFAULT_TPS_TIERS: TpsTiers = { slow: 20, normal: 50, fast: 100 }
export const DEFAULT_TTFT_TIERS: TtftTiers = { fast: 10_000, ok: 20_000 }

export function speedTier(tps: number, tiers: TpsTiers = DEFAULT_TPS_TIERS): SpeedTier {
  if (tps < tiers.slow) return "slow"
  if (tps < tiers.normal) return "normal"
  if (tps < tiers.fast) return "fast"
  return "faster"
}

export function ttftTier(ms: number, tiers: TtftTiers = DEFAULT_TTFT_TIERS): TtftTier {
  if (ms < tiers.fast) return "fast"
  if (ms < tiers.ok) return "ok"
  return "slow"
}

export function median(values: number[]): number {
  if (values.length === 0) return 1.0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) return sorted[mid]
  return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 1e10) / 1e10
}

export function calibrationFactor(ratios: number[]): number {
  return ratios.length === 0 ? 1.0 : median(ratios)
}

export function calculateLiveTps(samples: DeltaSample[], now: number, calibration: number): number | undefined {
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

export function liveTps(tracker: TrackerState, sessionID: string, now: number): number | undefined {
  const samples = tracker.samplesBySession[sessionID]
  if (!samples) return undefined
  const calibration = calibrationFactor(tracker.statsBySession[sessionID]?.calibrationRatios ?? [])
  return calculateLiveTps(samples, now, calibration)
}

export function avgTps(tracker: TrackerState, sessionID: string): number | undefined {
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
export function recordMessageStart(tracker: TrackerState, messageID: string, createdAt: number | undefined): boolean {
  const isNew = tracker.messages[messageID] === undefined
  const track = trackMessage(tracker, messageID)
  if (track.createdAt === undefined && typeof createdAt === "number") track.createdAt = createdAt
  return isNew
}

export function setThinking(tracker: TrackerState, sessionID: string, value: boolean): void {
  if (value) tracker.thinkingBySession[sessionID] = true
  else delete tracker.thinkingBySession[sessionID]
}

export function anyThinking(tracker: TrackerState): boolean {
  for (const id in tracker.thinkingBySession) if (tracker.thinkingBySession[id]) return true
  return false
}

export type DeltaInput = {
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
export function recordDelta(tracker: TrackerState, d: DeltaInput): boolean {
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
export function recordToolBoundary(tracker: TrackerState, messageID: string): void {
  trackMessage(tracker, messageID).toolPartSeen = true
}

export function clearSessionLive(tracker: TrackerState, sessionID: string): void {
  delete tracker.samplesBySession[sessionID]
  setThinking(tracker, sessionID, false)
}

export function discardMessage(tracker: TrackerState, messageID: string): void {
  delete tracker.messages[messageID]
  for (const sid in tracker.activeMessageBySession) {
    if (tracker.activeMessageBySession[sid] === messageID) delete tracker.activeMessageBySession[sid]
  }
}

export type CompletedMessage = {
  id: string
  sessionID: string
  tokens: { output: number; reasoning: number }
  finish?: string
}

export function recordMessageCompleted(tracker: TrackerState, info: CompletedMessage): void {
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
export function prune(tracker: TrackerState, now: number): boolean {
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

export type SpinnerOptions = { colors: string[]; intervalMs: number; enabled: boolean; cells: number }
export type ResolvedOptions = { spinner: SpinnerOptions; tps: TpsTiers; ttft: TtftTiers; slot: string }

export const THEME_PRESETS: Record<string, string[]> = {
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

export function resolveOptions(raw: unknown): ResolvedOptions {
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

export type Spinner = { cells: number; glyphs: string[]; frame: number; reset(): void; step(): void }

export function createSpinner(cells: number, random: () => number = Math.random): Spinner {
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

export type PaletteKey = "muted" | "error" | "warning" | "success" | "accent"
/** A color reference resolved to a host color by the adapter. `cell` = particle index, `hue` = gradient phase (0..HUE_PERIOD-1). */
export type ColorToken = PaletteKey | { cell: number; hue: number }
export type Segment = { text: string; color: ColorToken }

export const IDLE_TEXT = "TPS -- | AVG -- | TTFT --"

function speedToken(tier: SpeedTier): PaletteKey {
  return tier === "slow" ? "error" : tier === "normal" ? "warning" : tier === "fast" ? "success" : "accent"
}

function ttftToken(tier: TtftTier): PaletteKey {
  return tier === "fast" ? "success" : tier === "ok" ? "warning" : "error"
}

export function colorKey(color: ColorToken): string {
  return typeof color === "string" ? color : `c${color.cell}.${color.hue}`
}

export function segmentsKey(segments: Segment[]): string {
  return segments.map((s) => s.text + "\u0000" + colorKey(s.color)).join("\u0001")
}

export function buildSegments(
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

export type Scheduler = {
  addView(view: () => void): () => void
  /** Call after any tracker mutation. `urgent` flushes views synchronously (e.g. first token → TTFT). */
  markDirty(urgent?: boolean): void
  flush(): void
  dispose(): void
  /** Current tick period in ms, or undefined when the timer is stopped (idle). */
  timerPeriod(): number | undefined
  viewCount(): number
}

export function createScheduler(
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
