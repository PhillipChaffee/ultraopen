export const meta = { name: 'e2e-kill-resume', description: 'killed mid-run' }
const a = await agent('Reply with the single word alpha.')
const b = await agent('Reply with the single word bravo.')
const c = await agent('Reply with the single word charlie.')
const d = await agent('Reply with the single word delta.')
const e = await agent('Reply with the single word echo.')
const f = await agent('Reply with the single word foxtrot.')
return a + b + c + d + e + f