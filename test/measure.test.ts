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
