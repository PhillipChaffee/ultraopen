#!/usr/bin/env node
/**
 * Isolate: does using `format` poison GET /session/:id/message?
 * Control = same prompt without format. Variant = with format. Third = format + explicit retryCount.
 */
import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = await mkdtemp(join(tmpdir(), "ultraopen-fmt-"))
const proc = spawn("opencode", ["serve", "--port", "0"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
const url = await new Promise((res) => {
  let out = ""
  const scan = (d) => {
    out += d.toString()
    const m = out.match(/https?:\/\/127\.0\.0\.1:\d+/)
    if (m) res(m[0])
  }
  proc.stdout.on("data", scan)
  proc.stderr.on("data", scan)
})

const api = async (p, init) => {
  const r = await fetch(url + p, { ...init, headers: { "content-type": "application/json" } })
  const t = await r.text()
  let body
  try {
    body = t ? JSON.parse(t) : undefined
  } catch {
    body = t
  }
  return { status: r.status, body }
}

const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } }

async function trial(label, format) {
  const s = await api("/session", { method: "POST", body: JSON.stringify({ title: label }) })
  const body = { parts: [{ type: "text", text: "Reply with the single word: ok" }] }
  if (format) body.format = format
  const p = await api(`/session/${s.body.id}/message`, { method: "POST", body: JSON.stringify(body) })
  const structured = p.body?.info?.structured
  const hist = await api(`/session/${s.body.id}/message`)
  const ok = Array.isArray(hist.body)
  console.log(
    `${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label.padEnd(34)} ` +
      `prompt=${p.status} structured=${structured !== undefined ? "yes" : "no"}  ` +
      `GET message=${hist.status} ${ok ? `array(${hist.body.length})` : `\x1b[31m${hist.body?.name ?? "?"}\x1b[0m`}`,
  )
  if (!ok) console.log(`     ${String(hist.body?.data?.message ?? "").split("\n")[0].slice(0, 150)}`)
  return ok
}

console.log("\nDoes `format` poison GET /session/:id/message?\n")
await trial("control: no format", undefined)
await trial("with format", { type: "json_schema", schema: SCHEMA })
await trial("format + explicit retryCount:2", { type: "json_schema", schema: SCHEMA, retryCount: 2 })
await trial("format + explicit retryCount:0", { type: "json_schema", schema: SCHEMA, retryCount: 0 })
await trial('format type:"text"', { type: "text" })

console.log("")
proc.kill("SIGTERM")
process.exit(0)
