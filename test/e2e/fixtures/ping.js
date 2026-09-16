export const meta = { name: 'e2e-ping', description: 'One agent whose value can only arrive via workflow_status', phases: [{ title: 'Probe' }] }

const out = await agent('Reply with exactly the word PING. Do not use any tools.', { label: 'probe', phase: 'Probe' })
return { answer: out }
