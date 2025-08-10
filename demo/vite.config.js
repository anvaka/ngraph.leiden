import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  server: { port: 5174, open: false },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  resolve: {
    alias: {
      // point demo code to use local library source during dev
      'ngraph.leiden': new URL('../src/index.js', import.meta.url).pathname
    }
  }
})
