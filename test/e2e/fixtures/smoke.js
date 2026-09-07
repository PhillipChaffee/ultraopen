export const meta = {
  name: 'e2e-smoke',
  description: 'One schema-forced agent; the e2e smoke shape',
  phases: [{ title: 'Probe' }],
}

const out = await agent('Reply with exactly the word READY. Do not use any tools.', {
  label: 'probe',
  phase: 'Probe',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
})

return { answer: out.answer }