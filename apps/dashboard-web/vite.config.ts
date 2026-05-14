import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4400',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:4400',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Bump above the default 500 kB. The main app chunk is still well under
    // 300 kB gzip with the splits below — this is just to silence the warning
    // for the larger split chunks (reactflow, recharts) which are loaded on
    // demand, not on initial paint.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Functional manualChunks: walks every module id at bundle time and
        // assigns heavy / cohesive vendor groups to their own chunk so the
        // main app bundle stays small and route-lazy chunks are clean.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('reactflow') || id.includes('@reactflow') || id.includes('/dagre/')) {
            return 'react-flow';
          }
          if (id.includes('/recharts/') || id.includes('/d3-')) {
            return 'charts';
          }
          if (id.includes('@radix-ui/')) {
            return 'radix';
          }
          if (id.includes('@dnd-kit/')) {
            return 'dnd-kit';
          }
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor';
          }
          if (id.includes('/i18next') || id.includes('/react-i18next')) {
            return 'i18n';
          }
          if (id.includes('lucide-react')) {
            return 'icons';
          }
          return undefined;
        },
      },
    },
  },
});
