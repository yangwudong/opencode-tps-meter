// Pure measurement functions — no JSX, no runtime deps.
// Tested via test/measure.test.ts

export function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 4))
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

export function speedTier(tps: number): SpeedTier {
  if (tps < 20) return "slow"
  if (tps < 50) return "normal"
  if (tps < 100) return "fast"
  return "faster"
}

export function median(values: number[]): number {
  if (values.length === 0) return 1.0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) return sorted[mid]
  return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 1e10) / 1e10
}

export function calibrationFactor(ratios: number[]): number {
  if (ratios.length === 0) return 1.0
  return median(ratios)
}
