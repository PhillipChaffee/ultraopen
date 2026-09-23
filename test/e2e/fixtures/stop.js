export const meta = { name: 'e2e-stop', description: 'ten sequential agents so the stop lands mid-run' }
let ok = 0
for (let i = 0; i < 10; i++) {
  const answer = await agent(`Step ${i + 1} of 10. Reply with the single word DONE and nothing else.`)
  if (answer) {ok++}
}
return { ok }