import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/client',
  publicDir: resolve(process.cwd(), 'public'),
  build: {
    outDir: resolve(process.cwd(), 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});
