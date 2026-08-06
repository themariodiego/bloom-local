import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  // Relative asset URLs so the built bundle works from file:// or any port.
  base: './',
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5319,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? 4317}`,
        changeOrigin: true,
      },
    },
  },
});
