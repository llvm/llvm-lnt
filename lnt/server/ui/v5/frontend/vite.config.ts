import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: resolve(__dirname, '../static/v5'),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'LNTv5',
      fileName: () => 'v5.js',
    },
    rollupOptions: {
      external: ['plotly.js-dist'],
      output: {
        globals: {
          'plotly.js-dist': 'Plotly',
        },
        assetFileNames: 'v5[extname]',
      },
    },
  },
});
