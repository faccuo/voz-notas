import esbuild from 'esbuild'
import process from 'process'
import builtins from 'builtin-modules'

const prod = process.argv[2] === 'production'

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
  process.exit(0)
} else {
  // Dev: rebuild on every save.
  await context.watch()
}
