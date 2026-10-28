import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5188,
  },
  build: {
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'vendor-x', test: /node_modules[\\/]+@antdv-next[\\/]+x[\\/]/ },
            {
              name: 'vendor-antdv',
              test: /node_modules[\\/]+(@antdv-next[\\/]+(?:cssinjs|icons)|antdv-next)[\\/]/,
            },
            { name: 'vendor', test: /node_modules[\\/]+/ },
          ],
        },
      },
    },
  },
})
