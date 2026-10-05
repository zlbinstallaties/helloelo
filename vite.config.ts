import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Standalone build: TanStack Start SSR on Node, no platform-specific runtime.
// Dev: `vite dev` (also used by DIG Builder previews, which reach it as
// localhost:5173). Production: `vite build`, then `node scripts/serve.mjs`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { host: true, port: 5173, strictPort: true },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
