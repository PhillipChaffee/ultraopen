/**
 * Workflow script diagnostics.
 *
 * The threat model for the sandbox is DETERMINISM and GOOD ERROR MESSAGES, not confinement —
 * the model authoring the script already holds bash in the same session. So every rejection
 * carries a line:col and an actionable suggestion.
 */

export interface SourcePosition { line: number; column: number }

export interface Diagnostic {
  kind: "ParseError" | "MetaError" | "DeterminismError" | "LimitError" | "RuntimeError"
  message: string
  // `| undefined` is deliberate under exactOptionalPropertyTypes: callers pass a computed
  // location that may legitimately be absent, rather than conditionally omitting the key.
  location?: SourcePosition | undefined
  suggestions?: string[] | undefined
}

export class WorkflowScriptError extends Error {
  readonly diagnostic: Diagnostic

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message)
    this.name = "WorkflowScriptError"
    this.diagnostic = diagnostic
  }
}

export function fail(diagnostic: Diagnostic): never {
  throw new WorkflowScriptError(diagnostic)
}

/** Renders a diagnostic with a caret line pointing at the offending source. */
export function render(diagnostic: Diagnostic, source?: string): string {
  const lines: string[] = [`${diagnostic.kind}: ${diagnostic.message}`]

  if (diagnostic.location && source) {
    const { line, column } = diagnostic.location,
     src = source.split("\n")[line - 1]
    if (src !== undefined) {
      const gutter = `${line} | `
      lines.push("", `${gutter}${src}`, `${" ".repeat(gutter.length + Math.max(0, column))}^`)
    }
  } else if (diagnostic.location) {
    lines.push(`  at line ${diagnostic.location.line}:${diagnostic.location.column}`)
  }

  if (diagnostic.suggestions?.length) {
    lines.push("", ...diagnostic.suggestions.map((s) => `  → ${s}`))
  }

  return lines.join("\n")
}
