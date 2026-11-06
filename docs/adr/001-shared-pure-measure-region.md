# ADR 001 — Shared pure measurement region (copy + markers + sync test)

- Status: accepted
- Date: 2026-11-06 (v1.3.0)

## Context

`tui.tsx` is the entire plugin and must stay a **single self-contained file**:

- users can install it with `curl -o ~/.config/opencode/tps-meter.tsx …/tui.tsx` and load it as a local file;
- `package.json` `files` ships only `tui.tsx` (+ README/LICENSE);
- opencode's runtime-plugin rewrites/redirects module specifiers for `@opentui/*` and `solid-js`; relying on a
  relative import (`./measure.ts`) from a plugin file in `node_modules` or in the config dir adds a loading path
  we have not validated on every opencode version.

Until v1.2.0 the unit-tested `measure.ts` was a hand-maintained *copy* of some functions in `tui.tsx`, and it had
already drifted (`speedTier` hardcoded 20/50/100 while `tui.tsx` made tiers configurable). The most important
logic (tracker updates, AVG/calibration, the scheduler) was not tested at all.

## Decision

- All host-independent logic lives in one region delimited by
  `// ==== BEGIN PURE MEASURE …` and `// ==== END PURE MEASURE ====`.
- `measure.ts` is the source of truth (declarations `export`ed); `tui.tsx` contains the identical text without
  the leading `export `. `npm run sync-region` (`scripts/sync-region.mjs`) regenerates the `tui.tsx` copy.
- `test/sync.test.ts` fails if the two regions differ, and if the region contains an `import`, `Buffer` or `RGBA`.
- The region is host-agnostic: colors are tokens (`"muted"`, `{ cell, hue }`) that the adapter maps to RGBA;
  token estimation counts UTF-8 bytes by hand instead of `Buffer`.

## Consequences

- `tui.tsx` stays single-file and loadable everywhere it was before; no new runtime import paths.
- The tracker, AVG/calibration rules, option validation, segment building and scheduler are unit-tested in
  Node/vitest without opentui.
- Contributors must edit `measure.ts` and run `npm run sync-region`; forgetting is caught by CI.
- `tui.tsx` is ~2× longer to read; the marker comments make the shared part obvious.
