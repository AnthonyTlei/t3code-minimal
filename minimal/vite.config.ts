import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [tailwindcss()],
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      onwarn(warning, fallback) {
        // This is a client-only bundle; React server component directives do not apply.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        fallback(warning);
      },
    },
  },
});
