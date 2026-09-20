export const meta = { name: 'e2e-idle-hydration', description: 'sleeps past the launch turn, then returns a marker' }
await new Promise((resolve) => {setTimeout(resolve, 30_000)})
return 'HYDRA-VIS-MARKER-7391'