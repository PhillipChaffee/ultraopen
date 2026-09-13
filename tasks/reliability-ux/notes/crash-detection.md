# Crash detection facts

- The manifest records `bootId` and `status`. `beginRun` writes status `running` with the boot id of the live process (`resume/persist.ts`).
- The reaper runs at plugin load (`server/index.ts`). A run with status `running` under a different boot id belonged to a dead process. The reaper aborts its children and marks the run interrupted.
- Today the reaper result is swallowed. `index.ts` calls it with `void` and no handler. To show a hint, the reaper must write the interrupted run ids somewhere the TUI reads. Candidates: an `interrupted` marker in each run directory, or one shared index file under the ultraopen output directory. Decide in task T3 and record the decision here.
- `pruneRuns` runs after the reaper so a fresh orphan is not deleted mid-sweep. Keep that order when you touch the load sequence.
- The hint must survive restarts until the user acts. A marker file per run drives the once-only behavior. Retention pruning removes old runs, and the hint dies with them.
- What the reaper does not do: it does not resume anything. The resume stays a model action with `resumeFromRunId`. The hint only points at it.