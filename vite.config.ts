import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { BRAND } from './src/app/brand.ts';
import { capturePlugin } from './tools/dev/capture.ts';
import { creditsPlugin } from './tools/dev/credits.ts';

/**
 * Online play goes to the game's own server (npm run server), which the dev server passes it on to.
 * A second pair can be run beside the usual one: DEV_PORT for this server, GAME_PORT for the game's
 * (which `npm run server` reads as PORT).
 */
const proxy = { '/ws': { target: `ws://127.0.0.1:${Number(process.env.GAME_PORT) || 8787}`, ws: true } };

export default defineConfig({
  plugins: [preact(), capturePlugin(), creditsPlugin(BRAND.name)],
  server: { host: '127.0.0.1', port: Number(process.env.DEV_PORT) || 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
    // The libraries change far less often than the game does: kept in files of their own, a browser that has them does not fetch them again.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'libs', test: /node_modules/ },
          ],
        },
      },
    },
  },
  test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts'], environment: 'node' },
});
