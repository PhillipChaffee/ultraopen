export const meta = {
  name: 'e2e-parallel',
  description: 'Three schema-forced agents through the parallel barrier',
  phases: [{ title: 'Fanout' }],
}

const results = await parallel([1, 2, 3].map((n) => () =>
  agent(`Reply with exactly the word DONE${n}. Do not use any tools.`, {
    label: `fanout:${n}`,
    phase: 'Fanout',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  }),
))

return { answers: results.filter(Boolean).map((r) => r.answer) }