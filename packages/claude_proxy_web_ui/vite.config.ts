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
        // Remove the Origin only when it is the dev server's own, so other web pages are still rejected.
        configure: (httpProxy) =>
          httpProxy.on('proxyReq', (proxyRequest, clientRequest) => {
            if (clientRequest.headers.origin === `http://${clientRequest.headers.host}`) proxyRequest.removeHeader('origin');
          }),
      },
    },
  },
});
