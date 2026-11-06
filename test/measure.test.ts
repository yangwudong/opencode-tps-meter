import { describe, it, expect } from "vitest"
import {
  estimateTokens,
  formatTps,
  formatTtft,
  speedTier,
  median,
  calibrationFactor,
  calculateLiveTps,
  type SpeedTier,
  type DeltaSample,
} from "../measure.ts"

describe("estimateTokens", () => {
  it("returns at least 1 for any input", () => {
    expect(estimateTokens("")).toBe(1)
    expect(estimateTokens("a")).toBe(1)
  })

  it("estimates from UTF-8 byte length / 4", () => {
    // "hello" = 5 bytes → ceil(5/4) = 2
    expect(estimateTokens("hello")).toBe(2)
    // "hello world" = 11 bytes → ceil(11/4) = 3
    expect(estimateTokens("hello world")).toBe(3)
  })

  it("handles multi-byte UTF-8 characters", () => {
    // "日本語" = 9 bytes → ceil(9/4) = 3
    expect(estimateTokens("日本語")).toBe(3)
  })
})

describe("formatTps", () => {
  it("returns undefined for non-finite or non-positive values", () => {
    expect(formatTps(0)).toBeUndefined()
    expect(formatTps(-1)).toBeUndefined()
    expect(formatTps(NaN)).toBeUndefined()
    expect(formatTps(Infinity)).toBeUndefined()
  })

  it("formats values < 10 with two decimals", () => {
    expect(formatTps(5.678)).toBe("5.68")
    expect(formatTps(0.5)).toBe("0.50")
  })

  it("formats values 10–99 with one decimal", () => {
    expect(formatTps(42.56)).toBe("42.6")
    expect(formatTps(10)).toBe("10.0")
  })

  it("formats values >= 100 as rounded integer", () => {
    expect(formatTps(127.8)).toBe("128")
    expect(formatTps(100)).toBe("100")
  })
})

describe("formatTtft", () => {
  it("returns undefined for non-finite or negative values", () => {
    expect(formatTtft(-1)).toBeUndefined()
    expect(formatTtft(NaN)).toBeUndefined()
  })

  it("formats milliseconds as seconds with one decimal", () => {
    expect(formatTtft(800)).toBe("0.8s")
    expect(formatTtft(1500)).toBe("1.5s")
    expect(formatTtft(0)).toBe("0.0s")
  })
})

describe("speedTier", () => {
  it("returns 'slow' for TPS below 20", () => {
    expect(speedTier(0)).toBe("slow")
    expect(speedTier(5)).toBe("slow")
    expect(speedTier(19.9)).toBe("slow")
  })

  it("returns 'normal' for TPS 20 to below 50", () => {
    expect(speedTier(20)).toBe("normal")
    expect(speedTier(35)).toBe("normal")
    expect(speedTier(49.9)).toBe("normal")
  })

  it("returns 'fast' for TPS 50 to below 100", () => {
    expect(speedTier(50)).toBe("fast")
    expect(speedTier(75)).toBe("fast")
    expect(speedTier(99.9)).toBe("fast")
  })

  it("returns 'faster' for TPS >= 100", () => {
    expect(speedTier(100)).toBe("faster")
    expect(speedTier(250)).toBe("faster")
  })
})

describe("median", () => {
  it("returns the middle value for odd-length arrays", () => {
    expect(median([1, 3, 5])).toBe(3)
    expect(median([5, 1, 3])).toBe(3)
  })

  it("returns the average of two middle values for even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it("returns 1.0 for empty array", () => {
    expect(median([])).toBe(1.0)
  })

  it("handles single-element array", () => {
    expect(median([42])).toBe(42)
  })
})

describe("calibrationFactor", () => {
  it("returns 1.0 for empty ratios", () => {
    expect(calibrationFactor([])).toBe(1.0)
  })

  it("returns the median of ratios", () => {
    expect(calibrationFactor([1.1, 1.3, 1.5])).toBe(1.3)
  })

  it("returns the average of two middle values for even count", () => {
    expect(calibrationFactor([1.0, 1.2, 1.4, 1.6])).toBe(1.3)
  })
})

describe("calculateLiveTps", () => {
  const now = 10_000

  it("returns undefined for empty samples", () => {
    expect(calculateLiveTps([], now, 1.0)).toBeUndefined()
  })

  it("returns undefined when all samples are outside the window", () => {
    const samples: DeltaSample[] = [
      { at: now - 6_000, rawTokens: 10 },
    ]
    expect(calculateLiveTps(samples, now, 1.0)).toBeUndefined()
  })

  it("returns undefined when the latest sample is stale (>1.5s old)", () => {
    const samples: DeltaSample[] = [
      { at: now - 2_000, rawTokens: 10 },
    ]
    expect(calculateLiveTps(samples, now, 1.0)).toBeUndefined()
  })

  it("calculates TPS from wall-clock duration (now - oldest)", () => {
    // 3 samples, oldest 2s ago, latest at now
    // duration = now - oldest = 2s → TPS = 50/2 = 25
    const samples: DeltaSample[] = [
      { at: now - 2_000, rawTokens: 10 },
      { at: now - 1_000, rawTokens: 20 },
      { at: now, rawTokens: 20 },
    ]
    expect(calculateLiveTps(samples, now, 1.0)).toBeCloseTo(25, 1)
  })

  it("uses now-oldest not last-oldest when latest sample is not at now", () => {
    // Samples at now-3s and now-1s, now is current time
    // duration = now - (now-3s) = 3s (not last-oldest = 2s)
    // TPS = 30/3 = 10
    const samples: DeltaSample[] = [
      { at: now - 3_000, rawTokens: 10 },
      { at: now - 1_000, rawTokens: 20 },
    ]
    expect(calculateLiveTps(samples, now, 1.0)).toBeCloseTo(10, 1)
  })

  it("applies calibration factor to raw tokens", () => {
    // Same samples, calibration 2.0 → TPS = 50*2/2 = 50
    const samples: DeltaSample[] = [
      { at: now - 2_000, rawTokens: 10 },
      { at: now - 1_000, rawTokens: 20 },
      { at: now, rawTokens: 20 },
    ]
    expect(calculateLiveTps(samples, now, 2.0)).toBeCloseTo(50, 1)
  })

  it("uses minimum 1000ms duration for single sample to avoid inflation", () => {
    // Single sample 500ms ago, 10 raw tokens
    // duration = max(500, 1000) = 1000ms → TPS = 10/1.0 = 10
    const samples: DeltaSample[] = [
      { at: now - 500, rawTokens: 10 },
    ]
    expect(calculateLiveTps(samples, now, 1.0)).toBeCloseTo(10, 1)
  })

  it("uses actual elapsed time when above minimum for single sample", () => {
    // Single sample 1200ms ago: within window (5s), not stale (<1.5s)
    // duration = max(1200, 1000) = 1200ms → TPS = 5/1.2 ≈ 4.17
    const samples: DeltaSample[] = [
      { at: now - 1_200, rawTokens: 5 },
    ]
    expect(calculateLiveTps(samples, now, 1.0)).toBeCloseTo(4.2, 0)
  })

  it("filters to only samples within the 5-second window", () => {
    // Mix of old and recent samples
    const samples: DeltaSample[] = [
      { at: now - 6_000, rawTokens: 100 },  // outside window, ignored
      { at: now - 2_000, rawTokens: 10 },   // inside window
      { at: now, rawTokens: 20 },           // inside window
    ]
    // 30 tokens over 2 seconds → TPS = 15
    expect(calculateLiveTps(samples, now, 1.0)).toBeCloseTo(15, 1)
  })
})

// ---------------------------------------------------------------------------
// v1.3.0: tracker semantics, options, rendering segments, scheduler
// ---------------------------------------------------------------------------
import { vi, beforeEach, afterEach } from "vitest"
import * as M from "../measure.ts"

const S = "ses_1"
const delta = (t: M.TrackerState, messageID: string, kind: M.DeltaKind, at: number, text = "abcd", serverAt?: number) =>
  M.recordDelta(t, { sessionID: S, messageID, kind, delta: text, at, serverAt })

describe("speedTier / ttftTier (configurable)", () => {
  it("accepts custom tiers", () => {
    expect(M.speedTier(30, { slow: 10, normal: 20, fast: 40 })).toBe("fast")
    expect(M.ttftTier(500, { fast: 1000, ok: 2000 })).toBe("fast")
    expect(M.ttftTier(1500, { fast: 1000, ok: 2000 })).toBe("ok")
    expect(M.ttftTier(15_000)).toBe("ok")
    expect(M.ttftTier(25_000)).toBe("slow")
  })
})

describe("estimateTokens without Buffer", () => {
  it("counts surrogate pairs as 4 UTF-8 bytes", () => {
    expect(M.utf8ByteLength("😀")).toBe(4)
    expect(M.utf8ByteLength("é")).toBe(2)
    expect(M.utf8ByteLength("日本語")).toBe(9)
  })
})

describe("recordDelta", () => {
  it("trims old samples in place (no copy) and keeps the window", () => {
    const t = M.createTracker()
    delta(t, "m1", "text", 0)
    const arr = t.samplesBySession[S]
    delta(t, "m1", "text", 3_000)
    delta(t, "m1", "text", 6_000)
    expect(t.samplesBySession[S]).toBe(arr)
    expect(arr.map((s) => s.at)).toEqual([3_000, 6_000])
  })

  it("first delta sets TTFT from server time; later deltas do not overwrite it", () => {
    const t = M.createTracker()
    M.recordMessageStart(t, "m1", 1_000)
    expect(delta(t, "m1", "text", 99_999, "a", 1_800)).toBe(true)
    expect(t.liveTtftBySession[S]).toBe(800)
    expect(delta(t, "m1", "text", 100_500, "a", 5_000)).toBe(false)
    expect(t.liveTtftBySession[S]).toBe(800)
  })

  it("falls back to local time for TTFT when no serverAt (legacy path)", () => {
    const t = M.createTracker()
    M.recordMessageStart(t, "m1", 1_000)
    delta(t, "m1", "text", 1_250)
    expect(t.liveTtftBySession[S]).toBe(250)
  })

  it("sets thinking only for reasoning deltas", () => {
    const t = M.createTracker()
    delta(t, "m1", "reasoning", 0)
    expect(t.thinkingBySession[S]).toBe(true)
    delta(t, "m1", "tool", 10)
    expect(t.thinkingBySession[S]).toBeUndefined()
    delta(t, "m1", "reasoning", 20)
    delta(t, "m1", "text", 30)
    expect(M.anyThinking(t)).toBe(false)
  })

  it("recordMessageStart is idempotent and reports new steps", () => {
    const t = M.createTracker()
    expect(M.recordMessageStart(t, "m1", 100)).toBe(true)
    delta(t, "m1", "text", 500)
    expect(M.recordMessageStart(t, "m1", 200)).toBe(false)
    expect(t.messages.m1.createdAt).toBe(100)
    expect(t.messages.m1.firstAt).toBe(500)
  })
})

describe("recordMessageCompleted — AVG / calibration rules", () => {
  it("tool input deltas count toward the generation window (no AVG inflation)", () => {
    const t = M.createTracker()
    M.recordMessageStart(t, "m1", 0)
    delta(t, "m1", "text", 0, "x".repeat(32)) // ~8 tok
    for (let i = 0; i < 40; i++) delta(t, "m1", "tool", 100 + i * 97.5, "x".repeat(200)) // ~2000 tok, until ~3.9s
    delta(t, "m1", "tool", 4_000, "x".repeat(4))
    M.recordMessageCompleted(t, { id: "m1", sessionID: S, tokens: { output: 2008, reasoning: 0 }, finish: "tool-calls" })
    expect(M.avgTps(t, S)).toBeCloseTo(2008 / 4, 0)
    const ratio = t.statsBySession[S].calibrationRatios[0]
    expect(ratio).toBeGreaterThan(0.9)
    expect(ratio).toBeLessThan(1.1)
  })

  it("legacy fallback: tool-calls step with no tool deltas is excluded from AVG and calibration", () => {
    const t = M.createTracker()
    delta(t, "m1", "text", 0, "x".repeat(32))
    M.recordMessageCompleted(t, { id: "m1", sessionID: S, tokens: { output: 2008, reasoning: 0 }, finish: "tool-calls" })
    expect(M.avgTps(t, S)).toBeUndefined()
    expect(t.statsBySession[S].calibrationRatios).toEqual([])
  })

  it("legacy fallback: a running tool part (toolPartSeen) also excludes the step", () => {
    const t = M.createTracker()
    delta(t, "m1", "text", 0, "x".repeat(32))
    M.recordToolBoundary(t, "m1")
    M.recordMessageCompleted(t, { id: "m1", sessionID: S, tokens: { output: 500, reasoning: 0 } })
    expect(M.avgTps(t, S)).toBeUndefined()
  })

  it("reasoning tokens are excluded when no reasoning delta was streamed", () => {
    const t = M.createTracker()
    delta(t, "m1", "text", 0, "x".repeat(400))
    delta(t, "m1", "text", 2_000, "x".repeat(400))
    M.recordMessageCompleted(t, { id: "m1", sessionID: S, tokens: { output: 200, reasoning: 5000 }, finish: "stop" })
    expect(M.avgTps(t, S)).toBeCloseTo(100, 5)
  })

  it("reasoning tokens are included when reasoning was streamed", () => {
    const t = M.createTracker()
    delta(t, "m1", "reasoning", 0)
    delta(t, "m1", "text", 2_000)
    M.recordMessageCompleted(t, { id: "m1", sessionID: S, tokens: { output: 100, reasoning: 100 } })
    expect(M.avgTps(t, S)).toBeCloseTo(100, 5)
  })

  it("clamps the duration to MIN_DURATION_MS and caps calibration history", () => {
    const t = M.createTracker()
    for (let i = 0; i < 12; i++) {
      delta(t, `m${i}`, "text", i * 10_000, "abcd")
      M.recordMessageCompleted(t, { id: `m${i}`, sessionID: S, tokens: { output: 10, reasoning: 0 } })
    }
    expect(t.statsBySession[S].totalDurationMs).toBe(12 * M.MIN_DURATION_MS)
    expect(t.statsBySession[S].calibrationRatios).toHaveLength(M.MAX_CALIBRATION_RATIOS)
    expect(t.statsBySession[S].calibrationRatios.every((r) => r === 3.0)).toBe(true)
  })

  it("only clears live state when the completing message is the active one", () => {
    const t = M.createTracker()
    delta(t, "old", "text", 0)
    delta(t, "new", "reasoning", 100)
    M.recordMessageCompleted(t, { id: "old", sessionID: S, tokens: { output: 5, reasoning: 0 } })
    expect(t.samplesBySession[S]).toHaveLength(2)
    expect(t.thinkingBySession[S]).toBe(true)
    M.recordMessageCompleted(t, { id: "new", sessionID: S, tokens: { output: 5, reasoning: 5 } })
    expect(t.samplesBySession[S]).toBeUndefined()
    expect(t.thinkingBySession[S]).toBeUndefined()
    expect(t.messages).toEqual({})
  })

  it("discardMessage drops a failed step without touching stats", () => {
    const t = M.createTracker()
    delta(t, "m1", "text", 0)
    M.discardMessage(t, "m1")
    expect(t.messages.m1).toBeUndefined()
    expect(t.activeMessageBySession[S]).toBeUndefined()
    expect(t.statsBySession[S]).toBeUndefined()
  })
})

describe("prune", () => {
  it("drops samples outside the window and reports liveness", () => {
    const t = M.createTracker()
    delta(t, "m1", "text", 0)
    delta(t, "m1", "text", 1_000)
    expect(M.prune(t, 5_500)).toBe(true)
    expect(t.samplesBySession[S]).toHaveLength(1)
    M.clearSessionLive(t, S)
    expect(M.prune(t, 7_000)).toBe(false)
    expect(t.samplesBySession[S]).toBeUndefined()
  })

  it("turns off stale thinking (interrupted stream fallback)", () => {
    const t = M.createTracker()
    delta(t, "m1", "reasoning", 0)
    expect(M.prune(t, 1_000)).toBe(true)
    expect(t.thinkingBySession[S]).toBe(true)
    expect(M.prune(t, M.THINKING_STALE_MS + 1)).toBe(false)
    expect(t.thinkingBySession[S]).toBeUndefined()
  })
})

describe("message tracking cap", () => {
  it("evicts the oldest message past MAX_TRACKED_MESSAGES", () => {
    const t = M.createTracker()
    for (let i = 0; i <= M.MAX_TRACKED_MESSAGES; i++) M.recordMessageStart(t, `m${i}`, i)
    expect(Object.keys(t.messages)).toHaveLength(M.MAX_TRACKED_MESSAGES)
    expect(t.messages.m0).toBeUndefined()
    expect(t.messages[`m${M.MAX_TRACKED_MESSAGES}`]).toBeDefined()
  })
})

describe("resolveOptions", () => {
  it("returns sane defaults", () => {
    const o = M.resolveOptions(undefined)
    expect(o.spinner).toEqual({ colors: M.THEME_PRESETS.tech, intervalMs: 100, enabled: true, cells: 6 })
    expect(o.tps).toEqual(M.DEFAULT_TPS_TIERS)
    expect(o.ttft).toEqual(M.DEFAULT_TTFT_TIERS)
    expect(o.slot).toBe("prompt.footer.status")
  })

  it("clamps intervalMs to [40, 1000] and cells to [2, 16] integers", () => {
    expect(M.resolveOptions({ spinner: { intervalMs: 1 } }).spinner.intervalMs).toBe(40)
    expect(M.resolveOptions({ spinner: { intervalMs: 99_999 } }).spinner.intervalMs).toBe(1000)
    expect(M.resolveOptions({ spinner: { intervalMs: "fast" } }).spinner.intervalMs).toBe(100)
    expect(M.resolveOptions({ spinner: { cells: 1 } }).spinner.cells).toBe(2)
    expect(M.resolveOptions({ spinner: { cells: 500 } }).spinner.cells).toBe(16)
    expect(M.resolveOptions({ spinner: { cells: 7.9 } }).spinner.cells).toBe(7)
  })

  it("filters invalid hex colors and falls back to the theme preset", () => {
    expect(M.resolveOptions({ spinner: { colors: ["#fff", "nope", "#12345678", 3] } }).spinner.colors).toEqual(["#fff", "#12345678"])
    expect(M.resolveOptions({ spinner: { theme: "red", colors: ["zzz", "#12"] } }).spinner.colors).toEqual(M.THEME_PRESETS.red)
  })

  it("handles themes: unknown → tech, none → disabled", () => {
    expect(M.resolveOptions({ spinner: { theme: "weird" } }).spinner.colors).toEqual(M.THEME_PRESETS.tech)
    expect(M.resolveOptions({ spinner: { theme: "none" } }).spinner.enabled).toBe(false)
    expect(M.resolveOptions({ spinner: { enabled: false } }).spinner.enabled).toBe(false)
  })

  it("accepts valid tiers, rejects non-ascending or non-positive ones", () => {
    expect(M.resolveOptions({ tiers: { tps: { slow: 5, normal: 10, fast: 15 } } }).tps).toEqual({ slow: 5, normal: 10, fast: 15 })
    expect(M.resolveOptions({ tiers: { tps: { slow: 50, normal: 10 } } }).tps).toEqual(M.DEFAULT_TPS_TIERS)
    expect(M.resolveOptions({ tiers: { tps: { slow: -1 } } }).tps).toEqual(M.DEFAULT_TPS_TIERS)
    expect(M.resolveOptions({ tiers: { ttft: { fast: 3000, ok: 1000 } } }).ttft).toEqual(M.DEFAULT_TTFT_TIERS)
    expect(M.resolveOptions({ tiers: { ttft: { fast: 500 } } }).ttft).toEqual({ fast: 500, ok: 20_000 })
  })

  it("validates slot", () => {
    expect(M.resolveOptions({ slot: "  " }).slot).toBe("prompt.footer.status")
    expect(M.resolveOptions({ slot: "home.footer" }).slot).toBe("home.footer")
  })
})

describe("buildSegments", () => {
  const opts = M.resolveOptions(undefined)
  const text = (segs: M.Segment[]) => segs.map((s) => s.text).join("")

  it("renders the idle line exactly (no trailing space)", () => {
    const t = M.createTracker()
    expect(text(M.buildSegments(t, undefined, 0, opts))).toBe(M.IDLE_TEXT)
    expect(text(M.buildSegments(t, S, 0, opts, M.createSpinner(6)))).toBe(M.IDLE_TEXT)
  })

  it("colors values by tier", () => {
    const t = M.createTracker()
    M.recordMessageStart(t, "m1", 0)
    delta(t, "m1", "text", 0, "x".repeat(400), 500) // 100 tok/s, TTFT 0.5s
    const segs = M.buildSegments(t, S, 1_000, opts)
    expect(text(segs)).toBe("TPS 100 | AVG -- | TTFT 0.5s")
    expect(segs.find((s) => s.text === "100")?.color).toBe("accent")
    expect(segs.find((s) => s.text === "0.5s")?.color).toBe("success")
  })

  it("appends per-cell colored particles while thinking", () => {
    const t = M.createTracker()
    delta(t, "m1", "reasoning", 0)
    const sp = M.createSpinner(6, () => 0.5)
    const segs = M.buildSegments(t, S, 100, opts, sp)
    const cells = segs.filter((s) => typeof s.color !== "string")
    expect(cells).toHaveLength(6)
    expect(new Set(cells.map((c) => M.colorKey(c.color))).size).toBe(6)
    expect(text(segs).startsWith("TPS ")).toBe(true)
    expect(text(segs)).toBe("TPS 1.00 | AVG -- | TTFT -- " + sp.glyphs.join(""))
  })

  it("hides particles when the spinner is disabled", () => {
    const t = M.createTracker()
    delta(t, "m1", "reasoning", 0)
    const segs = M.buildSegments(t, S, 100, M.resolveOptions({ spinner: { theme: "none" } }), M.createSpinner(6))
    expect(segs.every((s) => typeof s.color === "string")).toBe(true)
  })

  it("segmentsKey is stable for identical content", () => {
    const t = M.createTracker()
    expect(M.segmentsKey(M.buildSegments(t, S, 0, opts))).toBe(M.segmentsKey(M.buildSegments(t, S, 0, opts)))
  })
})

describe("createScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  const setup = (raw?: unknown) => {
    const opts = M.resolveOptions(raw)
    const t = M.createTracker()
    const sp = M.createSpinner(opts.spinner.cells)
    return { t, sp, s: M.createScheduler(t, opts, sp) }
  }

  it("has no timer when idle and stops after the stream goes quiet", () => {
    const { t, s } = setup()
    let flushes = 0
    s.addView(() => flushes++)
    s.markDirty()
    expect(s.timerPeriod()).toBeUndefined()

    delta(t, "m1", "text", Date.now())
    s.markDirty()
    expect(s.timerPeriod()).toBe(M.IDLE_TICK_MS)
    vi.advanceTimersByTime(M.WINDOW_MS + 2 * M.IDLE_TICK_MS)
    expect(s.timerPeriod()).toBeUndefined()
    expect(flushes).toBeGreaterThan(0)
    const settled = flushes
    vi.advanceTimersByTime(10_000)
    expect(flushes).toBe(settled)
  })

  it("throttles bursts: many deltas do not flush synchronously", () => {
    const { t, s } = setup()
    let flushes = 0
    s.addView(() => flushes++)
    for (let i = 0; i < 500; i++) {
      delta(t, "m1", "text", Date.now())
      s.markDirty()
    }
    expect(flushes).toBe(0)
    vi.advanceTimersByTime(M.IDLE_TICK_MS)
    expect(flushes).toBe(1)
  })

  it("urgent markDirty flushes immediately", () => {
    const { t, s } = setup()
    let flushes = 0
    s.addView(() => flushes++)
    s.markDirty(delta(t, "m1", "text", Date.now()))
    expect(flushes).toBe(1)
  })

  it("runs at the spinner interval while thinking and advances frames", () => {
    const { t, sp, s } = setup({ spinner: { intervalMs: 50 } })
    s.addView(() => {})
    delta(t, "m1", "reasoning", Date.now())
    s.markDirty()
    expect(s.timerPeriod()).toBe(50)
    vi.advanceTimersByTime(500)
    expect(sp.frame).toBe(10)
    delta(t, "m1", "text", Date.now())
    s.markDirty()
    expect(s.timerPeriod()).toBe(M.IDLE_TICK_MS)
  })

  it("does not spin when the spinner is disabled", () => {
    const { t, s } = setup({ spinner: { theme: "none" } })
    delta(t, "m1", "reasoning", Date.now())
    s.markDirty()
    expect(s.timerPeriod()).toBe(M.IDLE_TICK_MS)
  })

  it("removes a throwing view without affecting the others", () => {
    const { t, s } = setup()
    let good = 0
    s.addView(() => {
      throw new Error("TextBuffer is destroyed")
    })
    s.addView(() => good++)
    expect(s.viewCount()).toBe(2)
    s.markDirty(delta(t, "m1", "text", Date.now()))
    expect(good).toBe(1)
    expect(s.viewCount()).toBe(1)
    expect(() => vi.advanceTimersByTime(M.IDLE_TICK_MS)).not.toThrow()
    expect(good).toBe(2)
  })

  it("dispose stops the timer and ignores later events", () => {
    const { t, s } = setup()
    let flushes = 0
    s.addView(() => flushes++)
    delta(t, "m1", "text", Date.now())
    s.markDirty()
    s.dispose()
    expect(s.timerPeriod()).toBeUndefined()
    expect(s.viewCount()).toBe(0)
    s.markDirty(true)
    vi.advanceTimersByTime(10_000)
    expect(flushes).toBe(0)
  })
})
