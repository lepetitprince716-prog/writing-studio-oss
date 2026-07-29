import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function port(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const server = `http://127.0.0.1:${port(env['WRITING_STUDIO_PORT'], 8787)}`;
  return {
    plugins: [react()],
    server: {
      port: port(env['WRITING_STUDIO_WEB_PORT'], 5183),
      strictPort: true,
      proxy: {
        '/api': { target: server, changeOrigin: true },
        '/ws': { target: server, ws: true },
      },
    },
  };
});
