import { describe, it, expect } from "vitest"
import {
  estimateTokens,
  formatTps,
  formatTtft,
  speedTier,
  median,
  calibrationFactor,
  type SpeedTier,
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
