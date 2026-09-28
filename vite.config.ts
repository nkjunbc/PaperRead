import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    outDir: 'dist/client',
    // Fonts are never inlined as data: URLs. The entry page's CSP (default-src 'self') refuses
    // data: fonts, and KaTeX ships a few woff2 files small enough to be inlined otherwise.
    assetsInlineLimit: (file) => (/\.(?:woff2?|ttf)$/i.test(file) ? false : undefined),
  },
  server: { host: '127.0.0.1' },
});
