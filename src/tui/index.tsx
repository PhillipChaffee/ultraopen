import { Plugin } from "@opencode/plugin/tui"
import { batch, For, Show, createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js"
import { UltraopenRpc, isRecord, parseListRunsOutput, parseRunUpdatedData, parseStopRunOutput } from "../rpc.js"
import type { RpcInterruptedHint, StopRunOutput } from "../rpc.js"
import { agentRowText, combineRuns, formatElapsed, fromRpcRunView, hintLine, isActiveRunStatus, mergeRecentRuns, mergeRunUpdate, recordSettledRun, stopHint, stripLine, summarize, transcriptHint } from "./data.js"
import type { RunView } from "./data.js"

/**
 * The TUI half of ultraopen for OpenCode V2.3.2.
 *
 * Everything the slots render comes from the `UltraopenRpc` channel: `listRuns` on mount and on
 * every reconnect, `runUpdated` events pushed by the server half, and `stopRun` for a direct
 * stop. The server merges disk manifests into `listRuns`, so synthetic and remote-host runs
 * appear on the same surfaces without the TUI reading the run directory itself.
 *
 * V2 slots re-render reactively, so each surface is plain Solid JSX reading live theme getters.
 * Two hard rules the V2 host enforces: every string is wrapped in <text> (a bare text node
 * throws), and the plugin never bundles its own copy of the host's Solid/OpenTUI/plugin modules
 * (script/build.ts externalizes them).
 *
 * This file is deliberately thin. Every decision lives in ./data.ts, which is tested without a
 * terminal; JSX cannot be unit-tested here and so contains as little logic as possible.
 */

const WORKFLOWS_PANEL = "ultraopen.workflows"
const TICK_MS = 1000

/** How many settled runs the `/workflows` panel keeps behind the live ones. */
const RECENT_RUN_LIMIT = 20

/** The server's outcome wording for a direct stop. */
function outcomeMessage(outcome: StopRunOutput["outcome"], runId: string): string {
  if (outcome === "stopped") {return `stopping ${runId}`}
  return outcome === "already_completed" ? `${runId} already completed` : `${runId} already stopped`
}

/** Re-derives elapsed against a fresh clock without mutating the stored snapshot. */
function withElapsed(run: RunView, at: number): RunView {
  if (run.startedAt === undefined) {return run}
  return { ...run, elapsedSeconds: Math.max(0, Math.round((at - run.startedAt) / 1000)) }
}

export default Plugin.define({
  id: "ultraopen",
  setup(context) {
    const rpc = context.client.rpc(UltraopenRpc),
       location = () => context.location ?? context.data.location.default(),
       [runs, setRuns] = createSignal<RunView[]>([]),
       [recent, setRecent] = createSignal<RunView[]>([]),
       [hints, setHints] = createSignal<RpcInterruptedHint[]>([]),
       [now, setNow] = createSignal(Date.now())
      let closed = false
      let hintsRequested = false
      let refreshing = false

      /**
       * The single hydration path: mount, reconnect, and after a stop.
       *
       * A failed call keeps the previous snapshot rather than blanking the surfaces — the server
       * half may simply not be loaded in this process yet. A slow poll never overlaps the next
       * one: the ticker and the reconnect hook would otherwise stack requests on a busy host.
       */
      const refresh = async (): Promise<void> => {
        if (refreshing) {return}
        refreshing = true
        try {
          const wantsHints = !hintsRequested
          const output = parseListRunsOutput(
            await rpc.listRuns({ includeHints: wantsHints }, { location: location() }),
          )
          if (closed) {return}
          const at = Date.now(),
           active = output.runs
             .filter((run) => isActiveRunStatus(run.status))
             .map((run) => fromRpcRunView(run, at))
          // One batch: every surface reads the same clock and the same snapshot. Setters apart,
          // each one would re-render the other surfaces against a half-updated store.
          batch(() => {
            setNow(at)
            setRuns(active.toSorted((a, b) => a.runId.localeCompare(b.runId)))
            // The panel is active/recent, so keep a capped history of settled runs. An elapsed time
            // is frozen at the first refresh that sees the run settle — a finished run's clock must
            // not keep growing while it waits in the history list.
            setRecent((current) => mergeRecentRuns(current, output.runs, at, RECENT_RUN_LIMIT))
            // Hints are a one-shot ask: the first successful call that requested them retires the
            // ask, whether or not the server had any to report. A hint pushed later still lands.
            if (wantsHints) {hintsRequested = true}
            if (output.hints !== undefined) {setHints(output.hints)}
          })
        } catch {
          // Keep the last snapshot; the event stream and the next reconnect will repair it.
        } finally {
          refreshing = false
        }
      }

      const stopRun = async (runId: string): Promise<void> => {
        try {
          const output = parseStopRunOutput(await rpc.stopRun({ runId }, { location: location() }))
          if (closed) {return}
          context.ui.toast.show({
            message: outcomeMessage(output.outcome, output.runId),
            variant: output.outcome === "stopped" ? "success" : "info",
          })
          await refresh()
        } catch {
          if (closed) {return}
          context.ui.toast.show({ message: `could not stop ${runId}`, variant: "error" })
        }
      }

      /** Stops one run by id, or asks which run when several are live. No confirmation step (#175). */
      const requestStop = async (input?: string): Promise<void> => {
        const requested = (input ?? "").trim(),
         active = runs()
        if (requested !== "") {
          await stopRun(requested)
          return
        }
        const only = active[0]
        if (only === undefined) {
          context.ui.toast.show({ message: "no active workflow runs", variant: "info" })
          return
        }
        if (active.length === 1) {
          await stopRun(only.runId)
          return
        }
        const picked = await context.ui.dialog.select<string>({
          title: "Stop which workflow run?",
          options: active.map((run) => ({ title: summarize(run), value: run.runId, description: run.runId })),
        })
        if (picked !== undefined) {await stopRun(picked)}
      }

      // A child session is reachable by click (#150): V2 has no composer picker for ultraopen
      // children (it filters on `parentID`), so the row itself carries the jump.
      const navigateTo = (sessionID: string | undefined): void => {
        if (sessionID === undefined || sessionID === "") {return}
        context.ui.router.navigate({ type: "session", sessionID })
      }

      // The V2 child is unparented; the jump-back link lives in its ultraopen metadata, with the
      // native parent id as the fallback for sessions opencode itself created.
      const parentOf = (sessionID: string): string | undefined => {
        const session = context.data.session.get(sessionID)
        if (session === undefined) {return undefined}
        const ultraopen = session.metadata?.["ultraopen"]
        if (isRecord(ultraopen)) {
          const parent = ultraopen["parentSessionID"]
          if (typeof parent === "string" && parent !== "") {return parent}
        }
        return session.parentID
      }

      const jumpToParent = (): void => {
        const route = context.ui.router.current()
        if (route.type !== "session") {
          context.ui.toast.show({ message: "open a session to jump to its parent", variant: "info" })
          return
        }
        const parent = parentOf(route.sessionID)
        if (parent === undefined) {
          context.ui.toast.show({ message: "this session has no ultraopen parent", variant: "info" })
          return
        }
        context.ui.router.navigate({ type: "session", sessionID: parent })
      }

      const openWorkflows = (): void => {
        if (!context.ui.panel.open(WORKFLOWS_PANEL)) {
          context.ui.toast.show({ message: "open a session to inspect its workflows", variant: "info" })
        }
      }

    // Register the keymap layer OUTSIDE our own createRoot: `keymap.layer` falls back to the
    // plugin host's owner (captured inside Keymap.Provider) only when the caller has no owner.
    // A fresh root here would carry an owner without the Keymap context and fail setup.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "ultraopen.workflows",
          title: "Workflows",
          description: "Inspect ultraopen workflow runs and their agent sessions",
          group: "ultraopen",
          palette: true,
          slash: { name: "workflows" },
          run: openWorkflows,
        },
        {
          id: "ultraopen.workflow-stop",
          title: "Stop workflow run",
          description: "Stop a background workflow run immediately",
          group: "ultraopen",
          palette: true,
          slash: { name: "workflow-stop", arguments: true },
          run: (input) => requestStop(input),
        },
        {
          id: "ultraopen.workflow-parent",
          title: "Go to parent session",
          description: "Jump back from a workflow child session to its parent",
          group: "ultraopen",
          palette: true,
          slash: { name: "workflow-parent" },
          run: jumpToParent,
        },
      ],
    }))

    return createRoot((dispose) => {
      // The live clock: one tick drives every elapsed label, and it only runs while a run is
      // actually live. `hasActive` is the memo gate: an event that keeps a run active recomputes
      // it to the same `true`, so the effect never re-runs and the interval is not churned under
      // a frequent `runUpdated` stream.
      const hasActive = createMemo(() => runs().some((run) => isActiveRunStatus(run.status)))
      createEffect(() => {
        if (!hasActive()) {return}
        const timer = setInterval(() => setNow(Date.now()), TICK_MS)
        onCleanup(() => clearInterval(timer))
      })

      // The store holds the last RPC snapshot; the memo re-derives elapsed against the tick so
      // every surface reads the same value on one tick.
      const views = createMemo(() => {
        const at = now()
        return runs().map((run) => withElapsed(run, at))
      })
      const runsFor = (sessionID: string): RunView[] => views().filter((run) => run.sessionID === sessionID)

      /** The prompt-adjacent indicator: one run's progress, or a count when several share the session. */
      const footerLine = (sessionID: string | undefined): string | undefined => {
        if (sessionID === undefined) {return undefined}
        const live = runsFor(sessionID),
         first = live[0]
        if (first === undefined) {return undefined}
        if (live.length > 1) {return `ultracode ⠋ ${live.length} runs`}
        return `ultracode ⠋ ${first.phase ? `${first.phase} · ` : ""}${first.done}/${first.total} ${formatElapsed(first.elapsedSeconds)}`
      }

      const claims = [
        context.ui.slot({
          append: "sidebar.content",
          render: (input) => {
            const live = () => runsFor(input.sessionID)
            return (
              <Show when={live().length > 0}>
                <box flexDirection="column">
                  <text fg={context.theme.text.base}>ultracode</text>
                  <For each={live()}>
                    {(run) => (
                      <box flexDirection="column">
                        <text fg={context.theme.text.muted}>{summarize(run)}</text>
                        <For each={run.agents}>
                          {(agent) => (
                            <text
                              fg={agent.status === "failed" ? context.theme.text.feedback.error.base : context.theme.text.muted}
                              onMouseUp={() => navigateTo(agent.sessionID)}
                            >
                              {agentRowText(agent)}
                            </text>
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                  <text fg={context.theme.text.muted}>{transcriptHint()}</text>
                  <Show when={stopHint(live())}>
                    {(hint) => <text fg={context.theme.text.feedback.warning.base}>{hint()}</text>}
                  </Show>
                </box>
              </Show>
            )
          },
        }),
        context.ui.slot({
          append: "session.composer.top",
          render: (input) => {
            const live = () => runsFor(input.sessionID)
            return (
              <Show when={live().length > 0 || hints().length > 0}>
                <box width="100%" flexDirection="column">
                  <For each={hints()}>{(hint) => <text fg={context.theme.text.feedback.warning.base}>{hintLine(hint)}</text>}</For>
                  <For each={live()}>{(run) => <text wrapMode="none" fg={context.theme.text.muted}>{stripLine(run)}</text>}</For>
                </box>
              </Show>
            )
          },
        }),
        context.ui.slot({
          append: "prompt.footer",
          render: (input) => (
            <Show when={footerLine(input.sessionID)}>
              {(line) => <text fg={context.theme.text.muted}>{line()}</text>}
            </Show>
          ),
        }),
        context.ui.slot({
          append: "home.footer.status",
          render: () => (
            <Show when={hints().length > 0}>
              <box flexDirection="column">
                <For each={hints()}>{(hint) => <text fg={context.theme.text.feedback.warning.base}>{hintLine(hint)}</text>}</For>
                <text fg={context.theme.text.muted}>/workflows inspects a run; /workflow-stop stops one directly</text>
              </box>
            </Show>
          ),
        }),
        context.ui.slot({
          replace: "session.panel",
          render: (panel) => {
            if (panel.name !== WORKFLOWS_PANEL) {return null}
            const live = () => runsFor(panel.sessionID),
             combined = () => combineRuns(live(), recent().filter((run) => run.sessionID === panel.sessionID)),
             parent = () => parentOf(panel.sessionID)
            return (
              <box flexDirection="column">
                <text fg={context.theme.text.base}>ultracode workflows</text>
                <Show
                  when={combined().length > 0}
                  fallback={<text fg={context.theme.text.muted}>no workflow runs</text>}
                >
                  <For each={combined()}>
                    {(run) => (
                      <box flexDirection="column">
                        <box flexDirection="row">
                          <text fg={context.theme.text.muted}>{summarize(run)}</text>
                          <Show when={isActiveRunStatus(run.status)}>
                            <text fg={context.theme.text.feedback.warning.base} onMouseUp={() => void stopRun(run.runId)}>
                              {"  ⏹ stop"}
                            </text>
                          </Show>
                        </box>
                        <For each={run.agents}>
                          {(agent) => (
                            <text
                              fg={agent.status === "failed" ? context.theme.text.feedback.error.base : context.theme.text.muted}
                              onMouseUp={() => navigateTo(agent.sessionID)}
                            >
                              {agentRowText(agent)}
                            </text>
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                </Show>
                <text fg={context.theme.text.muted}>{transcriptHint()}</text>
                <Show when={parent()}>
                  {(sessionID) => (
                    <text
                      fg={context.theme.text.feedback.info.base}
                      onMouseUp={() => context.ui.router.navigate({ type: "session", sessionID: sessionID() })}
                    >
                      {"↑ parent session"}
                    </text>
                  )}
                </Show>
                <text fg={context.theme.text.faint} onMouseUp={() => panel.close()}>{"close panel"}</text>
              </box>
            )
          },
        }),
      ]

      const offConnected = context.data.on("server.connected", () => void refresh()),
       offUpdated = rpc.events.on("runUpdated", (event) => {
         const parsed = parseRunUpdatedData(event.data)
         if (parsed === undefined) {return}
         const at = Date.now()
         batch(() => {
           setRuns((current) => mergeRunUpdate(current, parsed.run, at))
           // The store is live-only, so a settling event also lands in the panel's history. Without
           // this, a run that finishes while `/workflows` is open would blink out of the panel until
           // the next full poll repopulated it.
           if (!isActiveRunStatus(parsed.run.status)) {
             setRecent((current) => recordSettledRun(current, parsed.run, at, RECENT_RUN_LIMIT))
           }
         })
       })
      void refresh()

      // Disk-only runs (synthetic fixtures, runs launched by another process) never emit
      // `runUpdated`, and the first refresh can race the server plugin's activation. A cheap
      // 1s RPC poll restores the V1 disk-polling visibility while live events still update
      // immediately. Elapsed labels stay local (the tick above), so this is one small call/s.
      const pollTimer = setInterval(() => void refresh(), TICK_MS)

      return () => {
        closed = true
        offConnected()
        offUpdated()
        clearInterval(pollTimer)
        for (const claim of claims) {claim()}
        dispose()
      }
    })
  },
})
