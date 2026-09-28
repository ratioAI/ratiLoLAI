// Builds the renderer as a standalone web demo (GitHub Pages). In the browser the
// UI falls back to the synthetic demo API in src/renderer/src/lib/mockApi.ts.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(__dirname, 'dist-web'), emptyOutDir: true }
})
