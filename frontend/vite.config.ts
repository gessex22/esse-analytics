import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function getAppVersion() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '../electron/package.json'), 'utf-8')).version
  } catch {
    return JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(getAppVersion()),
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['esse-analytics.com', '.esse-analytics.com'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
})
