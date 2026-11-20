import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served from https://<owner>.github.io/shroudpit/ on GitHub Pages.
export default defineConfig({
  base: '/shroudpit/',
  plugins: [react()],
})
