import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

const BEGIN = "// ==== BEGIN PURE MEASURE"
const END = "// ==== END PURE MEASURE ===="

function region(file: string): string {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const b = src.indexOf(BEGIN)
  const e = src.indexOf(END)
  expect(b, `${file}: BEGIN marker`).toBeGreaterThanOrEqual(0)
  expect(e, `${file}: END marker`).toBeGreaterThan(b)
  return src
    .slice(b, e + END.length)
    .replace(/^export /gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
}

describe("PURE MEASURE region", () => {
  it("is identical in measure.ts and tui.tsx (run `npm run sync-region` to fix)", () => {
    expect(region("tui.tsx")).toBe(region("measure.ts"))
  })

  it("has no imports or host-specific globals", () => {
    const r = region("measure.ts")
    expect(r).not.toMatch(/^\s*import\s/m)
    expect(r).not.toMatch(/\bBuffer\b/)
    expect(r).not.toMatch(/\bRGBA\b/)
  })
})
