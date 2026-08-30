/**
 * Workflow script diagnostics.
 *
 * The threat model for the sandbox is DETERMINISM and GOOD ERROR MESSAGES, not confinement —
 * the model authoring the script already holds bash in the same session. So every rejection
 * carries a line:col and an actionable suggestion.
 */

export type Diagnostic = {
  kind: "ParseError" | "MetaError" | "DeterminismError" | "LimitError" | "RuntimeError"
  message: string
  location?: { line: number; column: number }
  suggestions?: string[]
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
    const { line, column } = diagnostic.location
    const src = source.split("\n")[line - 1]
    if (src !== undefined) {
      const gutter = `${line} | `
      lines.push("")
      lines.push(`${gutter}${src}`)
      lines.push(`${" ".repeat(gutter.length + Math.max(0, column))}^`)
    }
  } else if (diagnostic.location) {
    lines.push(`  at line ${diagnostic.location.line}:${diagnostic.location.column}`)
  }

  if (diagnostic.suggestions?.length) {
    lines.push("")
    for (const s of diagnostic.suggestions) lines.push(`  → ${s}`)
  }

  return lines.join("\n")
}
