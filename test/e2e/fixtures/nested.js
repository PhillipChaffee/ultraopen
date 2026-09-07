export const meta = {
  name: 'e2e-nested',
  description: 'Nested workflow() via the inline script form',
  phases: [{ title: 'Outer' }],
}

const inner = await workflow({
  script: `
export const meta = { name: 'e2e-nested-inner', description: 'inner', phases: [{ title: 'Inner' }] }
const r = await agent('Reply with exactly the word INNER. Do not use any tools.', { label: 'inner', phase: 'Inner' })
return { word: r }
`,
})

return { inner }