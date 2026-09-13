# Status tool design

Name: `workflow_status`. One new tool, registered next to `workflow`.

Inputs:

- `runId` (string, required).
- `wait` (optional, seconds). When set, the tool polls the run directory and returns only when the run settles or the cap expires. This stops the model from calling in a tight loop.

Output, one flat record:

- `status`: `running`, `completed`, or `failed`.
- `phases`: the phase names seen so far.
- `agents`: total, running, done, failed.
- `outputTokens`: the run total.
- `value`: the final value, present only when the run completed.
- `failure`: the failure text and the run directory, present only when the run failed.
- `logs`: the last log lines, capped.

Design rules:

- The status tool reads from disk only: `progress.json` for live state, `result.json` and `journal.jsonl` for the end state. Disk is the single source of truth, so the tool works after a process restart and never touches live run objects.
- Permission: the tool reads only, so it must be allowed without a prompt. Add it to the permission install in `src/server/ultracode/config.ts` next to the `workflow` default.
- The launch result of `workflow` must tell the model the run id and point it at `workflow_status`. The tool description for both tools carries the polling contract: poll with `wait` while the run is young, then read the final call.
- A resumed run keeps its run id. The status tool needs no special resume path.