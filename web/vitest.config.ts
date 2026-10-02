import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // The automatic JSX runtime, as Next compiles the app. Without it esbuild
  // emits `React.createElement` and any source .tsx that does not import React
  // (every modernhaus page body) fails under test with "React is not defined".
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
