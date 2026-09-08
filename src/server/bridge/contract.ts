import type { AgentOptions } from "../runtime/run.js"

/**
 * The subagent contract, appended to a child's system prompt.
 *
 * Delivered via `PromptInput.system`, which APPENDS to the provider base prompt. The other
 * available channel — an agent's own `prompt` field — REPLACES that base prompt, which would
 * lobotomise the agent, so it is never used for this.
 *
 * The contract exists because a workflow subagent is not talking to a human. Its final text is a
 * return value that lands in a script variable. Without being told, models write conversational
 * wrappers ("Sure! Here's what I found...") that the calling script then has to parse around.
 *
 * Four variants, selected by whether a schema was requested and whether the caller pinned a
 * specific agent type. The agentType cases are phrased as an additive NOTE, because that agent
 * already has its own instructions and this must not read as a replacement for them.
 */

const RETURN_VALUE_CONTRACT = `You are running as a step inside an automated workflow, not in a conversation.

Your final message IS the return value. It is captured verbatim into a variable in a script — no
human will read it directly, and nothing will parse prose out of it.

- Return the result itself. No preamble, no sign-off, no "Here's what I found".
- No markdown headings or bullet scaffolding unless the result genuinely is a document.
- Do the work before answering. Read files, run searches, verify claims — you have tools, and a
  confident guess is worse than a slower correct answer.
- If you cannot complete the task, say exactly what blocked you. That is a useful return value;
  a plausible fabrication is not.`,

 SCHEMA_CONTRACT = `You are running as a step inside an automated workflow, not in a conversation.

Your answer must be delivered by calling the StructuredOutput tool with a value matching the
required schema. That value is captured directly into a variable in a script.

- Do the work FIRST. Read files, run searches, verify claims — you are free to use every other
  tool before producing the final value, and you should.
- Then call StructuredOutput exactly once with the complete result.
- Populate every required field. If something could not be determined, say so in the field itself
  rather than inventing a value or omitting the key.
- Any prose you write alongside the tool call is discarded, so put everything into the value.`,

 AGENT_TYPE_NOTE = `

---

NOTE: you have been invoked as a step inside an automated workflow. Follow your own instructions
above, with one change: your final message is a return value captured into a script variable, not
a reply to a person. Omit conversational framing and return the result itself.`,

 AGENT_TYPE_SCHEMA_NOTE = `

---

NOTE: you have been invoked as a step inside an automated workflow. Follow your own instructions
above, with one change: deliver your answer by calling the StructuredOutput tool with a value
matching the required schema. Do your normal work first, then call it exactly once. Prose written
alongside the tool call is discarded.`

/**
 * Selects the contract for a call.
 *
 * Returns undefined only when a caller has explicitly opted out, so that every workflow subagent
 * gets told what its output is for.
 */
export function subagentContract(options: AgentOptions): string | undefined {
  const wantsSchema = options.schema !== undefined,
   pinnedAgent = options.agentType !== undefined && options.agentType !== ""

  if (pinnedAgent) {return wantsSchema ? AGENT_TYPE_SCHEMA_NOTE : AGENT_TYPE_NOTE}
  return wantsSchema ? SCHEMA_CONTRACT : RETURN_VALUE_CONTRACT
}

export const CONTRACTS = {
  returnValue: RETURN_VALUE_CONTRACT,
  schema: SCHEMA_CONTRACT,
  agentTypeNote: AGENT_TYPE_NOTE,
  agentTypeSchemaNote: AGENT_TYPE_SCHEMA_NOTE,
} as const
