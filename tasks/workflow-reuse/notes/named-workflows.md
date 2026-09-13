# Named workflow facts

- `resolveNamed` (`tool/workflow.ts`) already handles the `{ script }` object, a name string, the lookup in `context.named`, and an error with a suggestion. Nothing fills `context.named` today. That is the whole bug.
- The e2e probe asserts that the named form always throws. The README lists it as a known gap. Invert the probe when T1 lands.
- Directory convention, decide in T1 and record here: default directories are the ultraopen folder under the opencode configuration directory, and a project folder such as `.opencode/ultraopen/workflows/`, plus a `workflowPaths` option for custom paths.
- Scan timing: scan per tool call, not once at load. A file saved mid-session is then usable at once, and a stale in-memory map cannot drift from disk.
- Save flow: the opencode TUI has no save key. The model writes the file with its file tools when the user asks to save a run. The README documents the flow. A future epic can add a save command.
- The `$ARGUMENTS` template must stay a non-empty string in every installed command. The command service calls the hint builder eagerly, and a missing template takes down every command in the directory, including `/init` (`ultracode/config.ts`, installCommand comment).
- Claude Code namespaces plugin workflows as `/plugin:name`. Not applicable here. One plugin, one namespace.
- Validation on scan: parse the file, check the meta block. A file that fails validation is skipped with a log line, never a crash.