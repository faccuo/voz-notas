import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Load vars from .env / .env.local. The trailing '' means "load them ALL,
  // even the ones NOT prefixed with VITE_". This matters for security (below).
  const env = loadEnv(mode, process.cwd(), '')
  const OPENAI_API_KEY = env.OPENAI_API_KEY

  return {
    plugins: [
      {
        name: 'openai-token-endpoint',
        // configureServer = hook something onto Vite's dev server.
        configureServer(server) {
          // Runs whenever the browser hits /token:
          server.middlewares.use('/token', async (_req, res) => {
            try {
              // Server-side (Node): use YOUR real key to mint the ephemeral one.
              const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${OPENAI_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  session: {
                    type: 'realtime',
                    model: 'gpt-realtime-2.1-mini', // the mini: cheap and fast
                    audio: { output: { voice: 'marin' } }, // the voice you'll hear
                  },
                }),
              })
              const data = await r.json()
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify(data)) // the token is in data.value
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: String(e) }))
            }
          })
        },
      },
    ],
  }
})
