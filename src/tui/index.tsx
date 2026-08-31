import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { activeRuns, dataRoot, formatElapsed, glyph, summarize, type RunView } from "./data.js"

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
 * Progress is READ FROM DISK rather than pushed. `ctx.metadata()` is a no-op for plugin tools, and
 * the transcript renderer only knows about built-in tools, so there is no server→TUI channel for
 * arbitrary data. Polling the run directory also works when the TUI is not the process running the
 * workflow.
 */

const POLL_MS = 1000

function useRuns(api: TuiPluginApi, sessionID: () => string) {
  const [runs, setRuns] = createSignal<RunView[]>([])

  const refresh = async (): Promise<void> => {
    const root = dataRoot(process.env, api.state.path?.state ?? process.env["HOME"] ?? "")
    setRuns(await activeRuns({ root, sessionID: sessionID(), now: Date.now() }))
  }

  const timer = setInterval(() => void refresh(), POLL_MS)
  void refresh()
  onCleanup(() => clearInterval(timer))

  return runs
}

function Sidebar(props: { api: TuiPluginApi; session_id: string }) {
  const runs = useRuns(props.api, () => props.session_id)
  const theme = () => props.api.theme.current

  return (
    <Show when={runs().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>ultracode</b>
        </text>
        <For each={runs()}>
          {(run) => (
            <box>
              <text fg={theme().textMuted}>{summarize(run)}</text>
              <For each={run.agents}>
                {(agent) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={agent.status === "failed" ? theme().error : theme().textMuted}>
                      {glyph(agent.status)}
                    </text>
                    <text fg={theme().textMuted}>{agent.label}</text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

/** One always-visible line per active run, under the transcript. */
function BottomStrip(props: { api: TuiPluginApi }) {
  const current = createMemo(() => {
    const route = props.api.route.current
    return route.name === "session" ? ((route.params?.["sessionID"] as string) ?? "") : ""
  })
  const runs = useRuns(props.api, current)
  const theme = () => props.api.theme.current

  return (
    <Show when={runs().length > 0}>
      <box>
        <For each={runs()}>
          {(run) => (
            <text fg={theme().textMuted}>
              ultracode · {summarize(run)}
              {run.agents.length > 0 && runs().length === 1
                ? `  ${run.agents.map((agent) => `${glyph(agent.status)} ${agent.label}`).join("   ")}`
                : ""}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

/** Compact status beside the prompt, so a run is visible with the sidebar closed. */
function PromptStatus(props: { api: TuiPluginApi; session_id: string }) {
  const runs = useRuns(props.api, () => props.session_id)
  const theme = () => props.api.theme.current

  return (
    <Show when={runs().length > 0}>
      <text fg={theme().textMuted}>
        {runs().length === 1 && runs()[0]
          ? `ultracode ⠋ ${runs()[0]?.done}/${runs()[0]?.total} ${formatElapsed(runs()[0]?.elapsedSeconds ?? 0)}`
          : `ultracode ⠋ ${runs().length} runs`}
      </text>
    </Show>
  )
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
