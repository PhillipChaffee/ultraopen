export const meta = {
  name: 'e2e-spike',
  description: 'One plain and one schema-forced agent, distinct markers, for the child-transcript navigation spike',
  phases: [{ title: 'Spike' }],
}

await parallel([
  () => agent('Reply with exactly SPIKE-PLAIN-MARK-7391. Do not use any tools.', {
    label: 'plain:one',
    phase: 'Spike',
  }),
  () => agent('Reply with exactly SPIKE-SCHEMA-MARK-7391. Do not use any tools.', {
    label: 'schema:two',
    phase: 'Spike',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  }),
])

return 'spoke'
