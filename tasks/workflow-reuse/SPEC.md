# Epic: workflow-reuse

Status: done 2026-09-16
Estimate: 1.5 to 2.5 focused days
Depends on: nothing

## Summary

Claude Code saves a workflow run as a slash command and ships a bundled research workflow. ultraopen cannot do either: the named form of `workflow()` always throws, because nothing fills `context.named`. The reuse story today is keeping script files and passing `scriptPath`.

This epic makes saved workflows real. A directory holds script files. The plugin scans it, fills `context.named`, and registers each file as a slash command. A resume command covers reruns of a past run.

From the user experience view: you run a workflow once, save it, and after that a short prompt or a slash command brings the same orchestration back.

## UX acceptance criteria

Positive:

- UX: A saved script in the workflows directory runs by name. The user says "run the deploy-check workflow", and the model calls the tool with the name. Proof: e2e test with a saved file.
- UX: An unknown name gives a clear error that suggests passing the script inline. Proof: integration test. The message exists today in `resolveNamed`.
- UX: The `/workflow-resume` command with a run id asks the model to resume that run. Proof: e2e test.
- UX: A project directory can hold workflows. When the same name exists in the project directory and the user directory, the project one wins. Proof: integration test.

Negative:

- UX: The named form never throws when the name exists. Proof: the e2e probe that asserts the throw today is inverted.
- UX: A saved file that fails to parse produces a clear error at call time. The plugin load never crashes because of a bad file. Proof: integration test with a broken file in the directory.

## Technical acceptance criteria

Positive:

- Unit: the scanner reads the configured directories and maps a file name to its source. The name is the file name without the extension.
- Unit: a saved file must parse and hold a valid meta block. A file that fails is skipped, and the run log or load log names it.
- Unit: `context.named` reaches `resolveNamed` through the tool context in `index.ts`.
- Unit: the project directory wins over the user directory on a name collision. Order test.
- Unit: each installed command keeps a non-empty `$ARGUMENTS` template. Extend the existing config tests.

Negative:

- Unit: the scanner does not read files outside the configured directories. A name with a path separator is rejected.
- Unit: the plugin load does not fail when a configured directory does not exist.
- Unit: a large directory does not slow the tool call. The scan happens per call with a file count cap, and the test proves the call stays cheap.

## Task list

- [x] T1 Scanner and `context.named`. Files: `src/server/tool/named.ts` (new), `src/server/index.ts`, `src/server/options.ts` (a `workflowPaths` option). Estimate 1 day.
- [x] T2 Slash command per saved workflow. Files: `src/server/ultracode/config.ts` (the installCommand pattern). Estimate 0.5 day.
- [x] T3 The `/workflow-resume` command. Files: `src/server/ultracode/config.ts`, the command hook in `src/server/index.ts`. Estimate 0.5 day. (No hook needed beyond registration: the command is a template prompt; the model calls the tool with `resumeFromRunId`.)
- [x] T4 Tests and the README known-gaps rewrite. Files: `test/named.test.ts` (new), `test/index.test.ts`, `test/e2e/technical.sh`, `README.md`. Estimate 0.5 day. (The e2e named-form probe is inverted: T5a saves a workflow in the scratch project and expects a completed run; T5b keeps the unknown-name error probe.)

## Recorded decisions

- Default directories: `<opencode config dir>/ultraopen/workflows` (user) and
  `<project>/.opencode/ultraopen/workflows` (project; wins on collision).
  `workflowPaths` adds custom dirs, relative ones resolved against the project.
  Order, strongest last: user, custom, project.
- The run path scans per tool call. The /workflow-<name> commands are built from
  a synchronous scan at plugin load (the config hook is synchronous by
  contract), so a file saved mid-session runs by name at once but gains its
  command on the next start.
- The named form is a sandbox GLOBAL, not a tool argument — slash commands wrap
  it in a one-line script. Names are bare keys; a path separator is rejected.