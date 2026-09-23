import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { homedir } from "node:os"
import { RunPoller, agentRowText, consumeInterruptedMarker, dataRoot, formatElapsed, glyph, hintLine, loadInterruptedRuns, stopHint, summarize } from "./data.js"
import type { InterruptedHint, RunView } from "./data.js"

/**
 * The TUI half of ultraopen.
 *
 * A SEPARATE entry from ./server: opencode throws when one module default-exports both a server()
 * and a tui(), and TUI plugins are read only from tui.json — opencode.json's `plugin` array never
 * reaches the TUI runtime. Both halves ship in one package and are installed with the same spec.
 *
 * This file is deliberately thin. Every decision lives in ./data.ts, which is tested without a
 * terminal; a JSX component cannot be unit-tested here and so should contain as little as possible.
 *
 * RENDERING MODEL (opencode 1.18.x / @opentui 0.4.5): external TUI plugin slots render their
 * initial state and then NEVER re-render — reactive expressions keep their mount-time value and
 * Show/For insertion silently no-ops. Solid reactivity is therefore unusable for live progress;
 * every surface below is a single statically-mounted <text> whose content the poller-driven
 * createEffect writes imperatively (node.content + requestRender), which does repaint. One
 * visible consequence of the single-node model: the failed-agent glyph shares the muted color of
 * its line instead of the error color — the strong ✗ marker, the per-row failure reason, and the
 * summary's failed count carry the signal instead (the spec's documented fallback; the per-child
 * color path is recorded in the run-control render-limit notes for a live spike). An open sidebar
 * shows one blank line when the session has no active runs.
 * test/e2e/visual.sh asserts all of this against the live TUI.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextNode = any

// The run-data root must resolve exactly like the server half's (src/server/resume/store.ts).
function runRoot(): string {
  return dataRoot(process.env, homedir())
}

/** One poller per plugin instance, shared by every slot the plugin registers. */
const poller = new RunPoller({ root: runRoot })

/**
 * Interrupted-run hints, read ONCE per boot.
 *
 * The reaper writes a marker per orphaned run; the first read walks the run
 * directory once and caches the result, so startup cost is one pass no matter
 * how many old runs exist. Only orphaning writes the marker, so completed and
 * failed runs never hint. The hint line stays on the strip for this boot, and
 * the marker is consumed after its first display — so a second start shows no
 * hint for a run the user has already seen (once-only per run, not per boot).
 */
let hintsPromise: Promise<void> | undefined,
 hintsLoaded: InterruptedHint[] | undefined = undefined
const consumedHintIds = new Set<string>()

function loadHintsOnce(): void {
  hintsPromise ??= loadInterruptedRuns(runRoot())
    .then((hints: InterruptedHint[]) => (hintsLoaded = hints))
    .catch(() => (hintsLoaded = []))
}

/** The hints loaded this boot, with their markers consumed after first display. */
function hintLines(): string[] {
  const hints = bootHints()
  for (const hint of hints) {
    if (!consumedHintIds.has(hint.runId)) {
      consumedHintIds.add(hint.runId)
      // Best-effort: a failed delete only means the hint shows one more boot.
      void consumeInterruptedMarker(runRoot(), hint.runId)
    }
  }
  return hints.map((hint) => hintLine(hint))
}

function bootHints(): InterruptedHint[] {
  return hintsLoaded ?? []
}

function useRuns(sessionID: () => string) {
  const [runs, setRuns] = createSignal<RunView[]>([])
  onCleanup(poller.subscribe(sessionID, setRuns))
  return runs
}

/** Mount one <text> and hand its renderable to an imperative writer. */
function sidebarLines(rs: RunView[]): string {
  const lines: string[] = ["ultracode"]
  for (const run of rs) {
    lines.push(summarize(run))
    for (const agent of run.agents) {lines.push(agentRowText(agent))}
  }
  const stop = stopHint(rs)
  if (stop !== undefined) {lines.push(stop)}
  return lines.join("\n")
}

function Sidebar(props: { api: TuiPluginApi; session_id: string }) {
  const runs = useRuns(() => props.session_id),
   theme = () => props.api.theme.current
  let node: TextNode

  createEffect(() => {
    if (!node) {return}
    node.content = sidebarLines(runs())
    node.requestRender?.()
    props.api.renderer.requestRender?.()
  })

  return <text fg={theme().textMuted} ref={(r: TextNode) => (node = r)} />
}

// The input box's border sits at column 2 and its right edge at width-2 (measured from live
// Frames at 200 and 60 columns). The strip pads to the box's left edge and clips at its right
// Edge so it cannot spill past either. Width comes from stdout.columns — the plugin runs in the
// TUI host process, where stdout is the pane — read per update, so resizes are picked up.
const STRIP_INSET = 2,
 alignStrip = (content: string): string => {
  const width = process.stdout.columns ?? 0
  return content
    .split("\n")
    .map((line) => {
      const padded = " ".repeat(STRIP_INSET) + line
      return width > STRIP_INSET ? padded.slice(0, width - STRIP_INSET) : padded
    })
    .join("\n")
}

/** One always-visible line per active run, under the transcript, plus resume hints. */
function BottomStrip(props: { api: TuiPluginApi }) {
  const current = () => {
    const route = props.api.route.current
    return route.name === "session" ? ((route.params?.["sessionID"] as string) ?? "") : ""
  },
   runs = useRuns(current),
   theme = () => props.api.theme.current
  let node: TextNode

  createEffect(() => {
    const rs = runs()
    if (!node) {return}
    // Hints stay on the strip for this boot, above the live lines; loading
    // starts at plugin init and resolves async, so a later poll paints them.
    // After the first display each marker is consumed, so the NEXT start shows
    // nothing for a run the user has already seen.
    // Hints stay on the strip for this boot, above the live lines.
    const hints = hintLines()
    let content = ""
    if (rs.length === 1) {
      const run = rs[0],
       agents =
        run.agents.length > 0
          ? `  ${run.agents.map((agent) => `${glyph(agent.status)} ${agent.label}`).join("   ")}`
          : ""
      content = `ultracode · ${summarize(run)}${agents}`
    } else if (rs.length > 1) {
      content = rs.map((run) => `ultracode · ${summarize(run)}`).join("\n")
    }
    node.content = alignStrip([...hints, content].join("\n"))
    node.requestRender?.()
    props.api.renderer.requestRender?.()
  })

  return <text fg={theme().textMuted} ref={(r: TextNode) => (node = r)} />
}

/** Compact status beside the prompt, so a run is visible with the sidebar closed. */
function PromptStatus(props: { api: TuiPluginApi; session_id: string }) {
  const runs = useRuns(() => props.session_id),
   theme = () => props.api.theme.current
  let node: TextNode

  createEffect(() => {
    const rs = runs()
    if (!node) {return}
    let content = ""
    const run = rs[0]
    if (rs.length === 1 && run) {
      content = `ultracode ⠋ ${run.phase ? `${run.phase} · ` : ""}${run.done}/${run.total} ${formatElapsed(run.elapsedSeconds ?? 0)}`
    } else if (rs.length > 1) {
      content = `ultracode ⠋ ${rs.length} runs`
    }
    node.content = content
    node.requestRender?.()
    props.api.renderer.requestRender?.()
  })

  return <text fg={theme().textMuted} ref={(r: TextNode) => (node = r)} />
}

// eslint-disable-next-line require-await -- TuiPlugin is declared async by the host contract.
const tui: TuiPlugin = async (api) => {
  loadHintsOnce()
  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_ctx, props) {
        return <Sidebar api={api} session_id={props.session_id} />
      },
      app_bottom() {
        return <BottomStrip api={api} />
      },
      session_prompt_right(_ctx, props) {
        return <PromptStatus api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin = { id: "ultraopen", tui }

export default plugin