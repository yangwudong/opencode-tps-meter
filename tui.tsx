/** @jsxImportSource @opentui/solid */
import type { TextRenderable, RGBA } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { onCleanup } from "solid-js"
import {
  estimateTokens,
  formatTps,
  formatTtft,
  speedTier,
  calibrationFactor,
  calculateLiveTps,
  type DeltaSample,
  type SpeedTier,
} from "./measure.ts"

const WINDOW_MS = 5_000
const MAX_TRACKED_MESSAGES = 24
const MAX_CALIBRATION_RATIOS = 10

type StepTiming = {
  sessionID: string
  assistantMessageID: string
  stepStartedAt?: number
  firstDeltaAt?: number
  lastDeltaAt?: number
  estimatedTokens: number
}

type SessionStats = {
  totalOutputTokens: number
  totalGenerationMs: number
  totalTtftMs: number
  stepCount: number
  calibrationRatios: number[]
}

type TrackerState = {
  useV2Events: boolean
  samplesBySession: Record<string, DeltaSample[]>
  stepsByMessage: Record<string, StepTiming[]>
  activeStepBySession: Record<string, StepTiming | undefined>
  statsBySession: Record<string, SessionStats>
}

type Listener = () => void

function newSessionStats(): SessionStats {
  return {
    totalOutputTokens: 0,
    totalGenerationMs: 0,
    totalTtftMs: 0,
    stepCount: 0,
    calibrationRatios: [],
  }
}

function appendSample(
  tracker: TrackerState,
  sessionID: string,
  assistantMessageID: string,
  at: number,
  delta: string,
) {
  const rawTokens = estimateTokens(delta)
  const cutoff = at - WINDOW_MS
  const existing = tracker.samplesBySession[sessionID] ?? []
  tracker.samplesBySession[sessionID] = [
    ...existing.filter((s) => s.at >= cutoff),
    { at, rawTokens },
  ]

  const step = tracker.activeStepBySession[sessionID]
  if (step) {
    step.estimatedTokens += rawTokens
    if (step.firstDeltaAt === undefined) step.firstDeltaAt = at
    step.lastDeltaAt = at
  }
}

function clearLiveSamples(tracker: TrackerState, sessionID: string) {
  delete tracker.samplesBySession[sessionID]
}

function getOrCreateStats(tracker: TrackerState, sessionID: string): SessionStats {
  let stats = tracker.statsBySession[sessionID]
  if (!stats) {
    stats = newSessionStats()
    tracker.statsBySession[sessionID] = stats
  }
  return stats
}

function tierColor(tier: SpeedTier, theme: TuiThemeCurrent): RGBA {
  switch (tier) {
    case "slow": return theme.error
    case "normal": return theme.warning
    case "fast": return theme.success
    case "faster": return theme.accent
  }
}

function MeterDisplay(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  tracker: TrackerState
  subscribe: (listener: Listener) => () => void
}) {
  let tpsRef: TextRenderable | undefined
  let avgRef: TextRenderable | undefined
  let ttftRef: TextRenderable | undefined

  const theme = props.api.theme.current

  const sync = () => {
    const stats = props.tracker.statsBySession[props.sessionID]
    const calibration = calibrationFactor(stats?.calibrationRatios ?? [])
    const samples = props.tracker.samplesBySession[props.sessionID] ?? []
    const live = calculateLiveTps(samples, Date.now(), calibration)

    const avg =
      stats && stats.totalGenerationMs > 0
        ? stats.totalOutputTokens / (stats.totalGenerationMs / 1000)
        : undefined
    const ttft =
      stats && stats.stepCount > 0
        ? stats.totalTtftMs / stats.stepCount
        : undefined

    if (tpsRef) {
      tpsRef.content = live !== undefined ? formatTps(live) ?? "--" : "--"
      tpsRef.fg = live !== undefined ? tierColor(speedTier(live), theme) : theme.textMuted
    }
    if (avgRef) avgRef.content = avg !== undefined ? formatTps(avg) ?? "--" : "--"
    if (ttftRef) ttftRef.content = ttft !== undefined ? formatTtft(ttft) ?? "--" : "--"

    props.api.renderer.requestRender()
  }

  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)

  return (
    <box flexDirection="row">
      <text fg={theme.textMuted}>TPS </text>
      <text
        ref={(el: TextRenderable) => { tpsRef = el; sync() }}
        fg={theme.textMuted}
      >
        --
      </text>
      <text fg={theme.textMuted}> | AVG </text>
      <text
        ref={(el: TextRenderable) => { avgRef = el; sync() }}
        fg={theme.textMuted}
      >
        --
      </text>
      <text fg={theme.textMuted}> | TTFT </text>
      <text
        ref={(el: TextRenderable) => { ttftRef = el; sync() }}
        fg={theme.textMuted}
      >
        --
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const tracker: TrackerState = {
    useV2Events: false,
    samplesBySession: {},
    stepsByMessage: {},
    activeStepBySession: {},
    statsBySession: {},
  }
  const listeners = new Set<Listener>()
  const bump = () => { for (const l of listeners) l() }
  const subscribe = (listener: Listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const onStepStarted = api.event.on("session.next.step.started", (evt) => {
    const { sessionID, assistantMessageID, timestamp } = evt.properties
    const step: StepTiming = {
      sessionID,
      assistantMessageID,
      stepStartedAt: timestamp,
      estimatedTokens: 0,
    }
    tracker.activeStepBySession[sessionID] = step
    const steps = tracker.stepsByMessage[assistantMessageID] ?? []
    tracker.stepsByMessage[assistantMessageID] = [...steps, step]
    bump()
  })

  const onTextDelta = api.event.on("session.next.text.delta", (evt) => {
    tracker.useV2Events = true
    const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
    appendSample(tracker, sessionID, assistantMessageID, timestamp, delta)
    bump()
  })

  const onReasoningDelta = api.event.on("session.next.reasoning.delta", (evt) => {
    tracker.useV2Events = true
    const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
    appendSample(tracker, sessionID, assistantMessageID, timestamp, delta)
    bump()
  })

  const onPartDelta = api.event.on("message.part.delta", (evt) => {
    if (tracker.useV2Events) return
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID)
    const part = parts.find((p) => p.id === evt.properties.partID)
    if (!part) return
    if (part.type !== "text" && part.type !== "reasoning") return
    const { sessionID, messageID } = evt.properties
    if (!tracker.activeStepBySession[sessionID]) {
      const step: StepTiming = {
        sessionID,
        assistantMessageID: messageID,
        estimatedTokens: 0,
      }
      tracker.activeStepBySession[sessionID] = step
      const steps = tracker.stepsByMessage[messageID] ?? []
      tracker.stepsByMessage[messageID] = [...steps, step]
    }
    appendSample(tracker, sessionID, messageID, Date.now(), evt.properties.delta)
    bump()
  })

  const onToolInputStarted = api.event.on("session.next.tool.input.started", (evt) => {
    clearLiveSamples(tracker, evt.properties.sessionID)
    bump()
  })

  const onPartUpdated = api.event.on("message.part.updated", (evt) => {
    if (evt.properties.part.type !== "tool") return
    const status = evt.properties.part.state.status
    if (status === "running" || status === "completed" || status === "error") {
      const sessionID = evt.properties.part.sessionID ?? evt.properties.sessionID
      clearLiveSamples(tracker, sessionID)
      bump()
    }
  })

  const onMessageUpdated = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.role !== "assistant") return
    if (!info.time.completed) return

    const sessionID = info.sessionID ?? evt.properties.sessionID
    const stats = getOrCreateStats(tracker, sessionID)
    const steps = tracker.stepsByMessage[info.id] ?? []

    let generationMs = 0
    let totalTtftMs = 0
    let stepCount = 0
    let totalEstimated = 0

    for (const step of steps) {
      if (step.firstDeltaAt !== undefined && step.lastDeltaAt !== undefined) {
        generationMs += step.lastDeltaAt - step.firstDeltaAt
      }
      if (step.stepStartedAt !== undefined && step.firstDeltaAt !== undefined) {
        totalTtftMs += step.firstDeltaAt - step.stepStartedAt
        stepCount++
      }
      totalEstimated += step.estimatedTokens
    }

    const actualTokens = info.tokens.output + info.tokens.reasoning

    if (totalEstimated > 0 && actualTokens > 0) {
      const ratio = Math.min(Math.max(actualTokens / totalEstimated, 0.3), 3.0)
      stats.calibrationRatios = [...stats.calibrationRatios, ratio].slice(-MAX_CALIBRATION_RATIOS)
    }

    if (actualTokens > 0 && generationMs > 0) {
      stats.totalOutputTokens += actualTokens
      stats.totalGenerationMs += generationMs
    }
    if (stepCount > 0) {
      stats.totalTtftMs += totalTtftMs
      stats.stepCount += stepCount
    }

    delete tracker.stepsByMessage[info.id]
    delete tracker.activeStepBySession[sessionID]
    clearLiveSamples(tracker, sessionID)

    const trackedIds = Object.keys(tracker.stepsByMessage)
    if (trackedIds.length > MAX_TRACKED_MESSAGES) {
      for (const id of trackedIds.slice(0, trackedIds.length - MAX_TRACKED_MESSAGES)) {
        delete tracker.stepsByMessage[id]
      }
    }

    bump()
  })

  const timer = setInterval(() => {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    for (const [sessionID, samples] of Object.entries(tracker.samplesBySession)) {
      const pruned = samples.filter((s) => s.at >= cutoff)
      if (pruned.length !== samples.length) {
        if (pruned.length > 0) tracker.samplesBySession[sessionID] = pruned
        else delete tracker.samplesBySession[sessionID]
      }
    }
    bump()
  }, 1000)

  api.lifecycle.onDispose(() => {
    onStepStarted()
    onTextDelta()
    onReasoningDelta()
    onPartDelta()
    onToolInputStarted()
    onPartUpdated()
    onMessageUpdated()
    clearInterval(timer)
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return (
          <MeterDisplay
            api={api}
            sessionID={value.session_id}
            tracker={tracker}
            subscribe={subscribe}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-tps-meter",
  tui,
}

export default plugin
