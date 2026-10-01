// Server-side entrypoint.
//
// This plugin only renders in the terminal, but a package listed in
// opencode.json(c) is loaded by the OpenCode server as well as by the CLI.
// OpenCode resolves the `./server` export before the package root
// (Host.resolve does `entry(["server", ""])`), so this no-op keeps the package
// loadable on the server. Without it the server falls back to `.` (./tui.tsx)
// and runs the terminal setup against a server context, which has no `theme`
// and throws: TypeError: undefined is not an object (evaluating 'ctx.theme.text').
//
// The terminal UI lives in ./tui.
const plugin = {
  id: "opencode-tps-meter",
  setup() {},
}

export default plugin
