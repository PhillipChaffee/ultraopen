export const meta = { name: 'e2e-worktree', description: 'Probe the isolation option', phases: [{ title: 'Probe' }] }

const out = await agent('Reply with exactly the word TREE. Do not use any tools.', {
  label: 'isolated',
  phase: 'Probe',
  isolation: 'worktree',
})

return { answer: out }