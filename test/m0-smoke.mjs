#!/usr/bin/env node
/**
 * M0 — provider smoke test.
 *
 * Gates every later milestone. Answers three questions that cannot be settled by reading source:
 *
 *   1. Does `format: {type:"json_schema"}` actually land a validated object on `info.structured`?
 *   2. Does it still work when combined with a high reasoning `variant` — i.e. does
 *      `toolChoice:"required"` survive adaptive thinking, or does the provider reject it?
 *   3. Does the requested variant actually EXIST for the target model? An unknown variant id
 *      resolves to `undefined` -> `{}` with no error and no log, so "ultracode" would silently
 *      do nothing at all.
 *
 * Designed to be re-run as a health check: upstream has zero test coverage for the `format`
 * path, so it can regress in an opencode release with no signal.
 *
 *   node test/m0-smoke.mjs [--model opencode/claude-opus-5] [--effort xhigh] [--keep]
 */

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const EFFORT_PREFERENCE = ["xhigh", "max", "high", "medium", "low"],
 BOOT_TIMEOUT_MS = 60_000,
 PROMPT_TIMEOUT_MS = 240_000,

 args = process.argv.slice(2),
 flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
},
 has = (name) => args.includes(`--${name}`),

 wantModel = flag("model"),
 wantEffort = flag("effort") ?? "xhigh",
 keepDir = has("keep")

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
  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd,
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
      headers: { "content-type": "application/json", ...init.headers },
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

/**
 * The marker must be UNGUESSABLE. An earlier version of this test used a hello-world sample and
 * the model produced the exactly-correct answer with zero tool calls — indistinguishable from
 * having read it, because the content was inferable from the filename. If the model can satisfy
 * the schema without reading, the test proves nothing about whether toolChoice:"required" leaves
 * room to do research first, which is the whole question.
 */
const MARKER = "QX7F2M-PLUM-4419-KESTREL",
 SECRET_LINE_COUNT = 11,
 NEEDLE_ANSWER = "HALIBUT-5502-VERDIGRIS",

 SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["marker", "lineCount", "summary"],
  properties: {
    marker: { type: "string", description: "the exact MARKER token found inside the file" },
    lineCount: { type: "number", description: "how many lines the file has" },
    summary: { type: "string", description: "one sentence describing what the file does" },
  },
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "ultraopen-m0-")),
  // Content deliberately NOT inferable from the filename: an arbitrary marker token and an
  // odd line count. The only way to report these is to actually read the file.
   lines = [
    "# fixture for the ultraopen M0 smoke test",
    `MARKER = "${MARKER}"`,
    "",
    "def compute(seed):",
    "    total = 0",
    "    for i in range(seed):",
    "        total += (i * 31) % 7",
    "    return total",
    "",
    "if __name__ == '__main__':",
    "    print(MARKER, compute(19))",
  ]
  if (lines.length !== SECRET_LINE_COUNT) {throw new Error(`fixture drift: ${lines.length} lines, expected ${SECRET_LINE_COUNT}`)}
  await writeFile(join(dir, "sample.py"), `${lines.join("\n")  }\n`)

  console.log(`\nM0 provider smoke test`)
  console.log(`workdir: ${dir}\n`)

  console.log("booting opencode serve…")
  const { proc, url } = await startServer(dir)
  info("server", url)

  let sessionID
  try {
    // ---- resolve the model -------------------------------------------------
    const cfg = await api(url, "/config"),
     defaultModel = cfg.body?.model,
     target = wantModel ?? defaultModel
    if (!target) {throw new Error("no model configured and none passed via --model")}
    const [providerID, ...rest] = target.split("/"),
     modelID = rest.join("/")
    info("configured default", defaultModel ?? "(none)")
    info("testing model", target)

    // ---- does the requested variant actually exist? ------------------------
    const providers = await api(url, "/config/providers"),
     list = providers.body?.providers ?? providers.body ?? [],
     provider = Array.isArray(list) ? list.find((p) => p.id === providerID) : undefined,
     model = provider?.models?.[modelID]
    if (!model) {
      info("variants", `could not introspect ${target} from /config/providers — skipping variant assertions`)
    }
    const variantIds = model?.variants ? Object.keys(model.variants) : []
    info("variants available", variantIds.length > 0 ? variantIds.join(", ") : "(none reported)")

    const resolved = variantIds.includes(wantEffort)
      ? wantEffort
      : EFFORT_PREFERENCE.find((v) => variantIds.includes(v))

    if (variantIds.length > 0) {
      check(
        resolved !== undefined,
        `an effort variant resolves for ${target}`,
        resolved ? `using "${resolved}"` : "NONE of the preference list is supported",
      )
      if (resolved && resolved !== wantEffort) {
        info("DOWNGRADE", `"${wantEffort}" not supported by this model → "${resolved}"`)
      }
    }

    // ---- the real test: format + variant together --------------------------
    const created = await api(url, "/session", {
      method: "POST",
      body: JSON.stringify({ title: "ultraopen m0 smoke" }),
    })
    check(created.ok, "POST /session", `status ${created.status}`)
    sessionID = created.body?.id
    if (!sessionID) {throw new Error(`no session id in response: ${JSON.stringify(created.body)}`)}

    const body = {
      parts: [
        {
          type: "text",
          text:
            "Read the file sample.py in the current directory, then report the exact MARKER token " +
            "defined inside it, its exact line count, and a one sentence summary. " +
            "You must actually read the file — the marker cannot be guessed.",
        },
      ],
      model: { providerID, modelID },
      format: { type: "json_schema", schema: SCHEMA },
    }
    if (resolved) {body.variant = resolved}

    console.log("\nprompting (this makes a real model call, may take a minute)…")
    const started = Date.now(),
     res = await api(url, `/session/${sessionID}/message`, { method: "POST", body: JSON.stringify(body) }, PROMPT_TIMEOUT_MS),
     elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.log("")

    check(res.ok, "prompt returned 2xx", `status ${res.status} in ${elapsed}s`)
    if (!res.ok) {
      console.log(`\n  response body:\n${JSON.stringify(res.body, null, 2).slice(0, 2000)}\n`)
    }

    const msgInfo = res.body?.info,
     parts = res.body?.parts ?? []

    if (msgInfo?.error) {
      check(false, "no assistant error", `${msgInfo.error.name}: ${msgInfo.error.message ?? ""}`)
    } else {
      check(true, "no assistant error")
    }

    // (1) the load-bearing assertion
    const structured = msgInfo?.structured
    check(structured !== undefined, "info.structured is populated (NOT info.structured_output)")
    if (structured !== undefined) {
      const keys = Object.keys(structured ?? {})
      check(
        ["marker", "lineCount", "summary"].every((k) => keys.includes(k)),
        "structured output satisfies the schema",
        JSON.stringify(structured).slice(0, 160),
      )
    }

    // `agent()` extracts its result from THIS envelope, so its shape is load-bearing.
    info("response part types", JSON.stringify(parts.map((p) => p.type)) || "[]")
    const toolParts = parts.filter((p) => p.type === "tool")
    info("tools called", [...new Set(toolParts.map((p) => p.tool))].join(", ") || "none")

    // (2) THE decisive assertion: research actually happened BEFORE the structured emit.
    // The marker is unguessable, so a correct value proves the agent read the file; a wrong
    // value would prove it fabricated, invalidating the whole subagent design.
    check(
      structured?.marker === MARKER,
      "agent did REAL WORK before emitting (unguessable marker is correct)",
      `got ${JSON.stringify(structured?.marker)}`,
    )
    check(
      structured?.lineCount === SECRET_LINE_COUNT,
      "agent reported the true line count",
      `got ${JSON.stringify(structured?.lineCount)}, expected ${SECRET_LINE_COUNT}`,
    )

    // (3) UPSTREAM BUG REGRESSION PROBE.
    // Any session that has used `format` (json_schema OR text) permanently 400s on
    // GET /session/:id/message: "Expected OutputFormatJsonSchema, got {…}". Root cause is a
    // Schema.Class encode/decode identity problem in the `Format` union
    // (packages/schema/src/v1/session.ts:65-78), NOT the retryCount decoding default — a bare
    // {type:"text"} fails identically. Present in every release through v1.18.25.
    // Consequence for ultraopen: results MUST come from the prompt envelope (they do), the
    // journal MUST copy values rather than point at child sessions, and child sessions are not
    // re-readable via the message API.
    const poisoned = await api(url, `/session/${sessionID}/message`),
     stillBroken = poisoned.status === 400
    info(
      "upstream format/history bug",
      stillBroken ? "STILL PRESENT (expected) — GET message 400s on format sessions" : `\u001B[33mFIXED upstream! status ${poisoned.status} — revisit the journal design\u001B[0m`,
    )

    // (3b) MULTI-STEP probe — the shape every workflow subagent actually takes.
    // Probe (2) proved the agent had the file's contents, but it emitted in a single step with
    // only a StructuredOutput call, which means opencode fed it that context for free. That does
    // NOT prove an agent can run a multi-step tool loop and THEN emit structured output. Here the
    // answer is unreachable without real tool calls: the needle lives in one of many files in a
    // nested tree, and the required value is on the line AFTER the match.
    {
      const nest = join(dir, "pkg", "deep", "nested")
      await mkdir(nest, { recursive: true })
      for (let i = 0; i < 12; i++) {
        await writeFile(join(nest, `mod_${i}.txt`), `filler ${i}\n`.repeat(20))
      }
      await writeFile(join(nest, "mod_7.txt"), `${`filler\n`.repeat(9)  }NEEDLE_TOKEN\n${NEEDLE_ANSWER}\n${  `filler\n`.repeat(9)}`)

      const s3 = await api(url, "/session", { method: "POST", body: JSON.stringify({ title: "ultraopen m0 multistep" }) }),
       id3 = s3.body?.id,
       body3 = {
        parts: [
          {
            type: "text",
            text:
              "Somewhere under ./pkg there is exactly one file containing the string NEEDLE_TOKEN. " +
              "Find it and report the filename, plus the exact text on the line immediately AFTER that token.",
          },
        ],
        model: { providerID, modelID },
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["filename", "lineAfter"],
            properties: { filename: { type: "string" }, lineAfter: { type: "string" } },
          },
        },
      }
      if (resolved) {body3.variant = resolved}
      const r3 = await api(url, `/session/${id3}/message`, { method: "POST", body: JSON.stringify(body3) }, PROMPT_TIMEOUT_MS),
       p3 = r3.body?.parts ?? [],
       tools3 = p3.filter((p) => p.type === "tool"),
       research = tools3.filter((p) => p.tool !== "StructuredOutput"),
       steps = p3.filter((p) => p.type === "step-start").length,
       st3 = r3.body?.info?.structured

      // NOTE: the POST envelope carries only the FINAL assistant message of the turn, not the
      // whole turn — verified by running this same task without `format` and reading history,
      // which showed grep(...) then read(...) then the answer across three assistant messages
      // while the envelope reported one step and zero tools. So envelope tool counts are
      // diagnostics only; the real proof that research happened is answer correctness below,
      // since NEEDLE_ANSWER is unreachable without tools. (This is also why `agent()` extracting
      // its result from the envelope is correct: the envelope IS the final message.)
      info("envelope tools (final message only)", [...new Set(tools3.map((p) => p.tool))].join(", ") || "none")
      info("envelope steps", String(steps))
      if (research.length > 0) {info("research visible in envelope", `${research.length} call(s)`)}
      check(
        st3?.lineAfter?.trim() === NEEDLE_ANSWER,
        'multi-step research ran under toolChoice:"required" (unreachable without grep+read)',
        `got ${JSON.stringify(st3?.lineAfter)}`,
      )
      check(String(st3?.filename ?? "").includes("mod_7"), "multi-step agent identified the right file", `got ${JSON.stringify(st3?.filename)}`)
      await api(url, `/session/${id3}`, { method: "DELETE" }).catch(() => {})
    }

    // (4) Variant persistence, checked on a SEPARATE format-free session so history is readable.
    if (resolved) {
      const s2 = await api(url, "/session", { method: "POST", body: JSON.stringify({ title: "ultraopen m0 variant" }) }),
       id2 = s2.body?.id
      await api(
        url,
        `/session/${id2}/message`,
        {
          method: "POST",
          body: JSON.stringify({
            parts: [{ type: "text", text: "Reply with the single word: ok" }],
            model: { providerID, modelID },
            variant: resolved,
          }),
        },
        PROMPT_TIMEOUT_MS,
      )
      const msgs = await api(url, `/session/${id2}/message`),
       arr = Array.isArray(msgs.body) ? msgs.body : [],
       last = arr.findLast((m) => (m.info ?? m).role === "user"),
       persisted = (last?.info ?? last)?.model?.variant
      check(persisted === resolved, "requested variant persists on the user message", `got ${JSON.stringify(persisted)}`)
      await api(url, `/session/${id2}`, { method: "DELETE" }).catch(() => {})
    }
  } finally {
    if (sessionID) {await api(url, `/session/${sessionID}`, { method: "DELETE" }).catch(() => {})}
    proc.kill("SIGTERM")
    setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.()
    if (keepDir) {console.log(`\nkept workdir: ${dir}`)}
    else {await rm(dir, { recursive: true, force: true }).catch(() => {})}
  }

  console.log(`\n${fail === 0 ? "\u001B[32mM0 PASS\u001B[0m" : "\u001B[31mM0 FAIL\u001B[0m"}  ${pass} passed, ${fail} failed\n`)
  if (fail > 0) {
    console.log("If format+variant was rejected by the provider, the documented fallback is to drop")
    console.log("the variant on schema'd calls only. Record that before building on it.\n")
  }
  process.exit(fail === 0 ? 0 : 1)
}

try {
  await main()
} catch (error) {
  console.error(`\n\u001B[31mM0 ERROR\u001B[0m ${error.message}\n`)
  process.exit(2)
}
