export const meta = { name: 'e2e-smoke', description: 'Tiny live-run probe', phases: [{ title: 'Probe' }] }

const out = await agent('Reply with exactly the word READY. Do not use any tools.', { label: 'probe', phase: 'Probe' })
return { answer: out }