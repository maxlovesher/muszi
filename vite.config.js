import { defineConfig } from 'vite';

// Spotify rejects "localhost" redirect URIs, so serve on the loopback IP.
export default defineConfig({
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
