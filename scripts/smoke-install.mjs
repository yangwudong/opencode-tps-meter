// Packs the plugin and installs the tarball with npm (arborist, like opencode's plugin installer — not bun,
// which only warns on peer conflicts; AGENTS.md gotcha #5) into an empty project, next to the newest
// @opencode-ai/plugin. Fails on ERESOLVE / unmet engines (--engine-strict), and if any host-provided package
// was installed: opencode gives TUI plugins its own OpenTUI / Solid / plugin SDK, so they are optional peers.
// Usage: npm run smoke-install
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const HOST_PROVIDED = ["@opencode-ai/plugin", "@opentui/core", "@opentui/solid", "solid-js", "effect", "typescript"]
const SHIPPED = ["LICENSE", "README.md", "README.zh-CN.md", "package.json", "tui.tsx"]

function run(cmd, args, cwd) {
  // `npm run` exports npm_config_* (e.g. allow-scripts) that nested project installs reject; drop them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")))
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env })
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr)
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`)
  }
  return r.stdout
}

function findPackages(dir, names, found = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === "ENOENT") return found
    throw e
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const pkgs = entry.name.startsWith("@")
      ? readdirSync(path.join(dir, entry.name)).map((n) => `${entry.name}/${n}`)
      : [entry.name]
    for (const name of pkgs) {
      if (names.includes(name)) found.push(path.join(dir, name))
      findPackages(path.join(dir, name, "node_modules"), names, found)
    }
  }
  return found
}

function du(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? du(p) : statSync(p).size
  }
  return total
}

const repo = process.cwd()
const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"))
const work = mkdtempSync(path.join(tmpdir(), "tps-meter-smoke-"))
try {
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], repo))
  assert.deepEqual(packed.files.map((f) => f.path).sort(), SHIPPED, "unexpected files in the tarball")

  const project = path.join(work, "project")
  run("mkdir", ["-p", project], work)
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }))
  run("npm", ["install", "--engine-strict", "--no-audit", "--no-fund", path.join(work, packed.filename)], project)
  // The real host context: opencode's own plugin SDK is present next to the plugin.
  run("npm", ["install", "--engine-strict", "--no-audit", "--no-fund", "--no-save", "@opencode-ai/plugin@latest"], project)

  const nm = path.join(project, "node_modules")
  const installed = JSON.parse(readFileSync(path.join(nm, pkg.name, "package.json"), "utf8"))
  assert.equal(installed.version, pkg.version)

  // A clean install of only the tarball must not pull any host-provided package.
  const clean = path.join(work, "clean")
  run("mkdir", ["-p", clean], work)
  writeFileSync(path.join(clean, "package.json"), JSON.stringify({ name: "clean", private: true }))
  run("npm", ["install", "--engine-strict", "--no-audit", "--no-fund", path.join(work, packed.filename)], clean)
  const hostProvided = findPackages(path.join(clean, "node_modules"), HOST_PROVIDED)
  assert.deepEqual(hostProvided, [], "host-provided packages must not be installed (optional peers)")
  const size = du(path.join(clean, "node_modules"))
  assert.ok(size < 1024 * 1024, `install too large: ${size} bytes`)

  console.log(`smoke-install OK: ${packed.filename}, ${packed.files.length} files, clean install ${(size / 1024).toFixed(0)} KB, no host-provided packages, no ERESOLVE alongside @opencode-ai/plugin@latest`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
