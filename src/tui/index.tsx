import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { homedir } from "node:os"
import { RunPoller, dataRoot, formatElapsed, glyph, summarize, type RunView } from "./data.js"

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
 * createEffect writes imperatively (node.content + requestRender), which does repaint. Two
 * visible consequences of the single-node model: the failed-agent glyph shares the muted color
 * of its line instead of the error color, and an open sidebar shows one blank line when the
 * session has no active runs. test/e2e/visual.sh asserts all of this against the live TUI; the
 * bisect that established the constraint is in the repo's session history for 2026-09-07.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextNode = any

// The run-data root must resolve exactly like the server half's (src/server/resume/store.ts).
function runRoot(): string {
  return dataRoot(process.env, homedir())
}

/** One poller per plugin instance, shared by every slot the plugin registers. */
const poller = new RunPoller({ root: runRoot })

function useRuns(sessionID: () => string) {
  const [runs, setRuns] = createSignal<RunView[]>([])
  onCleanup(poller.subscribe(sessionID, setRuns))
  return runs
}

/** Mount one <text> and hand its renderable to an imperative writer. */
function sidebarLines(rs: RunView[]): string {
  if (rs.length === 0) return ""
  const lines: string[] = ["ultracode"]
  for (const run of rs) {
    lines.push(summarize(run))
    for (const agent of run.agents) lines.push(`${glyph(agent.status)} ${agent.label}`)
  }
  return lines.join("\n")
}

function Sidebar(props: { api: TuiPluginApi; session_id: string }) {
  const runs = useRuns(() => props.session_id)
  const theme = () => props.api.theme.current
  let node: TextNode

  createEffect(() => {
    if (!node) return
    node.content = sidebarLines(runs())
    node.requestRender?.()
    props.api.renderer.requestRender?.()
  })

  return <text fg={theme().textMuted} ref={(r: TextNode) => (node = r)} />
}

/** One always-visible line per active run, under the transcript. */
function BottomStrip(props: { api: TuiPluginApi }) {
  const current = () => {
    const route = props.api.route.current
    return route.name === "session" ? ((route.params?.["sessionID"] as string) ?? "") : ""
  }
  const runs = useRuns(current)
  const theme = () => props.api.theme.current
  let node: TextNode

  createEffect(() => {
    const rs = runs()
    if (!node) return
    let content = ""
    if (rs.length === 1) {
      const run = rs[0]
      const agents =
        run.agents.length > 0
          ? `  ${run.agents.map((agent) => `${glyph(agent.status)} ${agent.label}`).join("   ")}`
          : ""
      content = `ultracode · ${summarize(run)}${agents}`
    } else if (rs.length > 1) {
      content = rs.map((run) => `ultracode · ${summarize(run)}`).join("\n")
    }
    node.content = content
    node.requestRender?.()
    props.api.renderer.requestRender?.()
  })

  return <text fg={theme().textMuted} ref={(r: TextNode) => (node = r)} />
}

/** Compact status beside the prompt, so a run is visible with the sidebar closed. */
function PromptStatus(props: { api: TuiPluginApi; session_id: string }) {
  const runs = useRuns(() => props.session_id)
  const theme = () => props.api.theme.current
  let node: TextNode

  createEffect(() => {
    const rs = runs()
    if (!node) return
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

export default { id: "ultraopen", tui }