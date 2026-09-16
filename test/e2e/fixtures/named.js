export const meta = { name: 'e2e-named', description: 'Probe the named-workflow form', phases: [{ title: 'Probe' }] }

await workflow('probe')
return { named: true }