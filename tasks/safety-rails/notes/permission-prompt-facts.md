# Permission prompt facts

Correction to the review: the review ranked the approval prompt as a blind approval risk. The code says the prompt carries more than the review assumed.

- `src/server/index.ts` parses the script before the ask, then calls `context.ask` with permission `workflow`, `patterns: [meta.name]`, `always: [meta.name]`, and `metadata` that holds `runId`, `name`, `description`, the phase titles, and the dry-run flag.
- The always-allow is scoped to the workflow name on purpose. The comment in `index.ts` says an always grant on the wildcard would disable the prompt for every workflow in the directory.
- The permission default comes from `installPermission` in `src/server/ultracode/config.ts`. It sets `config.permission["workflow"] ??= "ask"`. Without it, the built-in agents' wildcard allow rule would auto-approve every run.

Open question, resolve first:

- Does the opencode permission dialog render `metadata`? Approve a run with phases in the metadata and look at the dialog. If opencode ignores `metadata`, the gap is upstream. Record the finding here and in the upstream-fixes epic if it is a gap.

Planned change (task T5):

- Write the script source to `runDir(runId)/script.js` before the ask. `prepare()` already returns the source. Then the user can open the file before approving.
- Document in the README what the prompt shows and how the user can read the script first.