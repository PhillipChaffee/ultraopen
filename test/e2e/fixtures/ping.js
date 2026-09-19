export const meta = { name: 'e2e-ping', description: 'One agent whose value can only arrive via workflow_status', phases: [{ title: 'Probe' }] }

const out = await agent('Reply with exactly the word PING. Do not use any tools.', { label: 'probe', phase: 'Probe' })
// Keep the run live ~6s after its agent settles: T10 proves the concurrency gate by
// overlapping two of these runs, and Flash settles a bare ping in ~1.3s — faster than
// the engine's launch-to-launch gap, which would lose the overlap race by design.
await new Promise((resolve) => {setTimeout(resolve, 6000)})
return { answer: out }