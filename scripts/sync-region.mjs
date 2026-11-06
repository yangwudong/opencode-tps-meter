// Copies the PURE MEASURE region from measure.ts into tui.tsx (stripping `export `).
// Usage: npm run sync-region   — test/sync.test.ts fails if the two copies drift.
import { readFileSync, writeFileSync } from "node:fs"

const BEGIN = "// ==== BEGIN PURE MEASURE"
const END = "// ==== END PURE MEASURE ===="

function bounds(src, file) {
  const b = src.indexOf(BEGIN)
  const e = src.indexOf(END)
  if (b < 0 || e < b) throw new Error(`${file}: PURE MEASURE markers not found`)
  return [b, e + END.length]
}

const measure = readFileSync("measure.ts", "utf8")
const [mb, me] = bounds(measure, "measure.ts")
const region = measure.slice(mb, me).replace(/^export /gm, "")

const tui = readFileSync("tui.tsx", "utf8")
const [tb, te] = bounds(tui, "tui.tsx")
writeFileSync("tui.tsx", tui.slice(0, tb) + region + tui.slice(te))
console.log("tui.tsx PURE MEASURE region synced from measure.ts")
