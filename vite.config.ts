import { defineConfig } from 'vite'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), topLevelAwait()],
  server: {
    port: 17532,
    watch: {
      ignored: ['**/data/**', '**/data/**']
    }
  }
})
