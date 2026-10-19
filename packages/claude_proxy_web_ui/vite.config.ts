import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/_proxy/',
  plugins: [react()],
  server: {
    proxy: {
      '/_proxy/api': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: true,
        // claude-proxy rejects requests with a foreign Origin, and the Vite dev server is on another port.
        configure: (httpProxy) => httpProxy.on('proxyReq', (proxyRequest) => proxyRequest.removeHeader('origin')),
      },
    },
  },
});
