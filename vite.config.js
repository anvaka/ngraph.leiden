import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'ngraphLeiden',
  fileName: (format) => `ngraph-leiden.${format}.js`,
  formats: ['es', 'cjs', 'umd']
    },
    rollupOptions: {
      external: ['ngraph.graph'],
      output: {
        globals: {
          'ngraph.graph': 'createGraph'
        }
      }
    }
  },
  test: {
    environment: 'node'
  }
})
