import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
      '/health': 'http://localhost:3001',
      '/api': 'http://localhost:3001',
    },
  },
});
