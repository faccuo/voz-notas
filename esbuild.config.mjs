import esbuild from 'esbuild'
import process from 'process'
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules as builtins } from 'node:module'

const prod = process.argv[2] === 'production'

// Optional dev convenience: copy each build into extra vaults (e.g. a fresh
// UX-testing vault, which can't symlink the repo without also sharing
// data.json). List absolute plugin-folder paths in .dev-sync.json
// (gitignored); no file, no copies. The primary dev vault uses a symlink
// and needs nothing.
function syncDevVaults() {
  let targets = []
  try {
    targets = JSON.parse(fs.readFileSync('.dev-sync.json', 'utf8'))
  } catch {
    return
  }
  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const f of ['main.js', 'manifest.json', 'styles.css']) {
        fs.copyFileSync(f, path.join(dir, f))
      }
      console.log(`synced build → ${dir}`)
    } catch (e) {
      console.error(`could not sync ${dir}:`, e.message)
    }
  }
}

// Bundle src/main.ts -> main.js (CommonJS, what Obsidian loads).
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Obsidian ships these at runtime, so don't bundle them in.
  external: ['obsidian', 'electron', ...builtins],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
})

if (prod) {
  await context.rebuild()
  syncDevVaults()
  process.exit(0)
} else {
  // Dev: rebuild on every save.
  await context.watch()
}
