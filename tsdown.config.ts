import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  dts: true,
  sourcemap: false,
  // Emit `.js` (not `.mjs`) so package.json's ./lib/index.js exports resolve.
  fixedExtension: false,
  // Runtime peers/deps are installed in the profile; do NOT bundle them
  // (dsh-llm is a large wire package; cordis is DI). Lazy imports keep the
  // plugin loadable even when an optional dep is missing.
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/schemastery',
    ],
  },
})
