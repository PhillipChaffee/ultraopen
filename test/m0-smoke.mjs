#!/usr/bin/env node
/**
 * M0 — provider smoke test for OpenCode V2.
 *
 * Gates every later milestone. Answers the questions that cannot be settled by reading source:
 *
 *   1. Does the configured provider answer at all through V2's async session API?
 *   2. Does the target model expose effort variants, and which one resolves?
 *   3. Can the model run a multi-step tool loop and THEN answer — the provider substrate the
 *      plugin's `StructuredOutput` capture tool depends on?
 *
 * V2.3.2 deleted V1's request-level `format: {type:"json_schema"}` and `info.structured`
 * envelope: structured output is now the plugin's `StructuredOutput` tool, bound per child
 * turn (`src/server/host/v2-hooks.ts`) and validated in-loop. That path is exercised by the
 * live e2e suites; this smoke proves the provider contract underneath it (tool use + real
 * research before the answer) without inventing a V1-shaped API.
 *
 * The API is HTTP Basic Auth protected even when OPENCODE_PASSWORD is unset, so this script
 * always sets a deterministic password and authenticates every request.
 *
 * Designed to be re-run as a health check: upstream has no test coverage for this path, so it
 * can regress in an opencode release with no signal.
 *
 *   node test/m0-smoke.mjs [--model provider/id] [--effort xhigh] [--keep]
 */

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const EFFORT_PREFERENCE = ["xhigh", "max", "high", "medium", "low"],
 BOOT_TIMEOUT_MS = 60_000,
 PROMPT_TIMEOUT_MS = 240_000,
 PASSWORD = `m0-${process.pid}-${Date.now()}`,

 args = process.argv.slice(2),
 flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
 },
 has = (name) => args.includes(`--${name}`),

 wantModel = flag("model"),
 wantEffort = flag("effort") ?? "xhigh",
 keepDir = has("keep"),
 AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`

let pass = 0,
 fail = 0
const check = (ok, label, detail) => {
 if (ok) {
  pass++
  console.log(`  \u001B[32m✓\u001B[0m ${label}${detail ? ` — ${detail}` : ""}`)
  return true
 }
 fail++
 console.log(`  \u001B[31m✗\u001B[0m ${label}${detail ? ` — ${detail}` : ""}`)
 return false
},
 info = (label, detail) => console.log(`  \u001B[90m·\u001B[0m ${label}${detail ? ` — ${detail}` : ""}`)

/** Opencode serve prints its URL to stdout; parse it rather than guessing a port. */
function startServer(cwd) {
 const env = { ...process.env, OPENCODE_PASSWORD: PASSWORD }
 for (const key of [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CLI_CONFIG_CONTENT",
  "OPENCODE_SERVER",
  "OPENCODE_DB",
  "OPENCODE_API_KEY",
  "OPENCODE_PERMISSION",
  "OPENCODE_TUI_CONFIG",
 ]) {delete env[key]}
 return new Promise((resolve, reject) => {
  const proc = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
   cwd,
   env,
   stdio: ["ignore", "pipe", "pipe"],
  })
  let out = "",
   settled = false
  const timer = setTimeout(() => {
   if (settled) {return}
   settled = true
   proc.kill("SIGKILL")
   reject(new Error(`server did not report a URL within ${BOOT_TIMEOUT_MS}ms. stdout:\n${out}`))
  }, BOOT_TIMEOUT_MS),

   scan = (chunk) => {
    out += chunk
    const m = out.match(/https?:\/\/127\.0\.0\.1:(?<port>\d+)/u)
    if (m && !settled) {
     settled = true
     clearTimeout(timer)
     resolve({ proc, url: m[0] })
    }
   }
  proc.stdout.on("data", (d) => scan(d.toString()))
  proc.stderr.on("data", (d) => scan(d.toString()))
  proc.on("exit", (code) => {
   if (settled) {return}
   settled = true
   clearTimeout(timer)
   reject(new Error(`server exited early (code ${code}). output:\n${out}`))
  })
 })
}

async function api(base, path, init = {}, timeoutMs = 30_000) {
 const ctl = new AbortController(),
  t = setTimeout(() => ctl.abort(), timeoutMs)
 try {
  const res = await fetch(`${base}${path}`, {
   ...init,
   signal: ctl.signal,
   headers: { "content-type": "application/json", authorization: AUTH, ...init.headers },
  }),
   text = await res.text()
  let body
  try {
   body = text ? JSON.parse(text) : undefined
  } catch {
   body = text
  }
  return { status: res.status, ok: res.ok, body }
 } finally {
  clearTimeout(t)
 }
}

/** V2 wraps every collection as { data, cursor }; tolerate a bare array too. */
const rows = (body) => (Array.isArray(body) ? body : body?.data ?? []),
 rowsData = (body) => rows(body),
 sessionID = (body) => body?.data?.id

/** Assistant text from one V2 message's inline content array. */
const textOf = (message) =>
 (message?.content ?? [])
  .filter((part) => part?.type === "text")
  .map((part) => part.text ?? "")
  .join("")
  .trim()

/** `provider/model` label for diagnostics and model assertions. */
const modelLabel = (model) => (model ? `${model.providerID}/${model.id}` : "(none)")

/** Every tool part across the whole session transcript. */
const toolParts = (messages) => messages.flatMap((m) => (m?.content ?? []).filter((p) => p?.type === "tool"))

async function waitTurn(url, sid) {
 const waited = await api(url, `/api/experimental/session/${sid}/wait`, { method: "POST" }, PROMPT_TIMEOUT_MS)
 if (!waited.ok) {throw new Error(`wait returned ${waited.status}: ${JSON.stringify(waited.body)}`)}
 const msgs = await api(url, `/api/session/${sid}/message`)
 if (!msgs.ok) {throw new Error(`message listing returned ${msgs.status}: ${JSON.stringify(msgs.body)}`)}
 return rowsData(msgs.body)
}

const NEEDLE_ANSWER = "HALIBUT-5502-VERDIGRIS",
 READY = "M0-READY-7391"

async function main() {
 const dir = await mkdtemp(join(tmpdir(), "ultraopen-m0-"))

 console.log(`\nM0 provider smoke test (OpenCode V2)`)
 console.log(`workdir: ${dir}\n`)

 console.log("booting opencode serve…")
 const { proc, url } = await startServer(dir)
 info("server", url)

 const created = []
 try {
  // ---- resolve the model -------------------------------------------------
  const def = await api(url, "/api/model/default"),
   defaultModel = def.body?.data
  if (!defaultModel) {throw new Error(`no default model in /api/model/default: ${JSON.stringify(def.body)}`)}
  const catalog = await api(url, "/api/model"),
   models = rowsData(catalog.body)

  let target = defaultModel
  if (wantModel) {
   const [providerID, ...rest] = wantModel.split("/"),
    modelID = rest.join("/")
   target = models.find((m) => m.providerID === providerID && (m.modelID === modelID || m.id === modelID))
   if (!target) {throw new Error(`model ${wantModel} not found in /api/model`)}
  }
  const providerID = target.providerID,
   modelID = target.modelID ?? target.id
  info("configured default", defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID ?? defaultModel.id}` : "(none)")
  info("testing model", `${providerID}/${modelID}`)

  // V2 selects the model at the session, not per prompt: carry the requested
  // ref into every session this script creates and assert the assistant
  // message recorded the same ref.
  const modelRef = { providerID, id: modelID },
   requestedModel = (m) => m?.providerID === providerID && m?.id === modelID,
   createSession = (title) =>
    api(url, "/api/session", { method: "POST", body: JSON.stringify({ title, model: modelRef }) })

  // ---- does the requested variant actually exist? ------------------------
  // V2 exposes variants as an ARRAY of { id, settings?, headers?, body? } on Model.Info.
  const variantIds = (target.variants ?? []).map((v) => (typeof v === "string" ? v : v?.id)).filter(Boolean)
  info("variants available", variantIds.length > 0 ? variantIds.join(", ") : "(none reported)")
  const resolved = variantIds.includes(wantEffort)
   ? wantEffort
   : EFFORT_PREFERENCE.find((v) => variantIds.includes(v))
  if (variantIds.length > 0) {
   check(resolved !== undefined, `an effort variant resolves for ${providerID}/${modelID}`, resolved ? `using "${resolved}"` : "NONE of the preference list is supported")
   if (resolved && resolved !== wantEffort) {info("DOWNGRADE", `"${wantEffort}" not supported by this model → "${resolved}"`)}
  }
  info("variant application", "V2 resolves variants per turn in the plugin's experimental.model.resolve hook; a bare prompt has no variant field")

  // ---- (1) the async turn: prompt → wait → message -----------------------
  const created1 = await createSession("ultraopen m0 smoke")
  check(created1.ok, "POST /api/session", `status ${created1.status}`)
  const sid = sessionID(created1.body)
  if (!sid) {throw new Error(`no session id in response: ${JSON.stringify(created1.body)}`)}
  created.push(sid)

  console.log("\nprompting (this makes a real model call, may take a minute)…")
  const started = Date.now(),
   prompted = await api(
    url,
    `/api/session/${sid}/prompt`,
    { method: "POST", body: JSON.stringify({ text: `Reply with exactly ${READY} and nothing else.` }) },
    PROMPT_TIMEOUT_MS,
   ),
   elapsed = ((Date.now() - started) / 1000).toFixed(1)
  check(prompted.ok, "POST /api/session/{id}/prompt admitted the turn", `status ${prompted.status}`)
  if (!prompted.ok) {console.log(`\n  response body:\n${JSON.stringify(prompted.body, null, 2).slice(0, 2000)}\n`)}

  const msgs1 = await waitTurn(url, sid),
   assistants1 = msgs1.filter((m) => m?.type === "assistant"),
   reply = textOf(assistants1.at(-1))
  console.log("")
  check(assistants1.length > 0, "GET /api/session/{id}/message has an assistant message", `${assistants1.length} assistant message(s) in ${elapsed}s`)
  check(
   requestedModel(assistants1.at(-1)?.model),
   "assistant message used the requested model",
   `got ${modelLabel(assistants1.at(-1)?.model)}`,
  )
  check(reply.includes(READY), "the model answered", `got ${JSON.stringify(reply.slice(0, 120))}`)

  // ---- (3) multi-step research: the provider substrate for StructuredOutput ---
  // StructuredOutput is a tool call. If the provider cannot run a multi-step tool loop and
  // answer from what it read, schema capture cannot work no matter what the plugin does.
  const nest = join(dir, "pkg", "deep", "nested")
  await mkdir(nest, { recursive: true })
  for (let i = 0; i < 12; i++) {await writeFile(join(nest, `mod_${i}.txt`), `filler ${i}\n`.repeat(20))}
  await writeFile(join(nest, "mod_7.txt"), `${"filler\n".repeat(9)}NEEDLE_TOKEN\n${NEEDLE_ANSWER}\n${"filler\n".repeat(9)}`)

  const created2 = await createSession("ultraopen m0 multistep"),
   sid2 = sessionID(created2.body)
  if (!sid2) {throw new Error(`no multistep session id in response: ${JSON.stringify(created2.body)}`)}
  created.push(sid2)

  const prompted2 = await api(
   url,
   `/api/session/${sid2}/prompt`,
   {
    method: "POST",
    body: JSON.stringify({
     text:
      "Somewhere under ./pkg there is exactly one file containing the string NEEDLE_TOKEN. " +
      "Find it and answer with the exact text on the line immediately AFTER that token. " +
      "You must actually search the files; the answer cannot be guessed.",
    }),
   },
   PROMPT_TIMEOUT_MS,
  )
  check(prompted2.ok, "POST /api/session/{id}/prompt admitted the multistep turn", `status ${prompted2.status}`)
  if (!prompted2.ok) {console.log(`\n  response body:\n${JSON.stringify(prompted2.body, null, 2).slice(0, 2000)}\n`)}
  const msgs2 = await waitTurn(url, sid2),
   assistants2 = msgs2.filter((m) => m?.type === "assistant"),
   answer2 = textOf(assistants2.at(-1)),
   tools2 = toolParts(assistants2)

  check(
   requestedModel(assistants2.at(-1)?.model),
   "multistep assistant message used the requested model",
   `got ${modelLabel(assistants2.at(-1)?.model)}`,
  )

  info("tools called", [...new Set(tools2.map((p) => p.name))].join(", ") || "none")
  check(tools2.length > 0, "the model called tools before answering", `${tools2.length} tool part(s)`)
  check(
   answer2.includes(NEEDLE_ANSWER),
   "multi-step research reached the unreachable answer (provider substrate for StructuredOutput)",
   `got ${JSON.stringify(answer2.slice(0, 160))}`,
  )
  const finished = tools2.filter((p) => p.state?.status === "completed")
  check(finished.length === tools2.length, "every tool call completed without a provider error", `${finished.length}/${tools2.length}`)

  // The V1 `format` regression probe is gone by construction: V2 has no request-level format,
  // so no session can poison its own history with one. Report that explicitly instead of
  // pretending to test a removed field.
  info("V1 format/history poisoning", "not applicable in V2 — no request-level format; StructuredOutput is a plugin tool")
 } finally {
  for (const sid of created) {await api(url, `/api/session/${sid}`, { method: "DELETE" }).catch(() => {})}
  proc.kill("SIGTERM")
  setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.()
  if (keepDir) {console.log(`\nkept workdir: ${dir}`)}
  else {await rm(dir, { recursive: true, force: true }).catch(() => {})}
 }

 console.log(`\n${fail === 0 ? "\u001B[32mM0 PASS\u001B[0m" : "\u001B[31mM0 FAIL\u001B[0m"}  ${pass} passed, ${fail} failed\n`)
 if (fail > 0) {
  console.log("If the provider rejected the tool loop, record that before building on it. The documented")
  console.log("fallback is to pick a tool-capable model for schema'd agents.\n")
 }
 process.exit(fail === 0 ? 0 : 1)
}

try {
 await main()
} catch (error) {
 console.error(`\n\u001B[31mM0 ERROR\u001B[0m ${error.message}\n`)
 process.exit(2)
}
