import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import plugin from "../server.ts"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const entry = (subpath: string) => pkg.exports?.[subpath]?.import ?? pkg.exports?.[subpath]

describe("server entrypoint", () => {
  it("is a valid no-op plugin definition", () => {
    expect(plugin.id).toBe("opencode-tps-meter")
    expect(typeof plugin.setup).toBe("function")
    expect(() => plugin.setup()).not.toThrow()
  })

  it("is exposed as ./server and kept separate from the TUI entrypoint", () => {
    // OpenCode resolves "./server" before "." for the server entrypoint
    // (Host.resolve), so ./server must exist and must not point at the TUI
    // module, which needs a terminal context.
    expect(entry("./server")).toBeTruthy()
    expect(entry("./server")).not.toMatch(/tui/)
    expect(entry("./server")).not.toBe(entry("./tui"))
  })

  it("is included in the published files", () => {
    expect(pkg.files).toContain("server.ts")
  })
})
