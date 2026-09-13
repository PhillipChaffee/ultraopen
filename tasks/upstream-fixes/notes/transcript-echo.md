# Transcript echo facts

- The README lists the echo under cosmetic limitations: the transcript renderer echoes a tool call's raw arguments, so a `workflow` call displays its full script.
- The script is also part of the message history. An inline script uses context window space until compaction. Claude Code has the same property. Only the display differs: Claude Code collapses the display of tool calls.
- Mitigation today: keep the script in a file and pass `scriptPath`. The tool schema supports it. The async-runs epic makes `scriptPath` even more natural, because the persisted script of a past run can be passed back by path.
- Upstream repository: github.com/anomalyco/opencode. The render code lives in the TUI host. Look at how the transcript renders tool-call parts, and add a collapse above a size threshold with an expand action.
- Second upstream item, from the approval epic: check whether the permission dialog renders the `metadata` that the ask call passes. If it does not, add that finding here as a second upstream item.
- What the fix must not do: remove the text. The user and the model may need to copy the script. Collapse with an expand action, not deletion.