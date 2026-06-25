import { describe, it, expect } from "vitest"
import { estimateTokens, formatTps, formatTtft } from "../measure.ts"

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
