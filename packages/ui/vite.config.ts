import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@assets': path.resolve(__dirname, '../../assets'),
    },
  },
  server: {
    port: 2703,
    proxy: {
      '/api': {
        target: 'http://localhost:2704',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:2704',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-codemirror': [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/lang-json',
            '@codemirror/lang-markdown',
            '@codemirror/theme-one-dark',
            'codemirror',
            '@uiw/react-codemirror',
          ],
          'vendor-markdown': [
            'react-markdown',
            'remark-gfm',
            'rehype-slug',
            'rehype-autolink-headings',
          ],
          'vendor-radix': [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-context-menu',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-label',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toggle',
            '@radix-ui/react-tooltip',
          ],
        },
      },
    },
  },
});
