/**
 * Development only. Lets the game's own page, running on the dev server, save a
 * rendered frame under docs/screenshots, so each milestone's camera checks are
 * kept at full resolution and can be compared with the style bible.
 *
 * It is not part of the build. The dev server listens on loopback only, and
 * this route additionally refuses anything that is not a same-origin request
 * for a plainly named JPEG or PNG.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const ROUTE = '/__capture/';
/** Lower-case names in folders, no dots but the extension: nothing that can climb out of the folder. */
const NAME = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.(jpg|png)$/;
const LIMIT = 32 * 1024 * 1024;

function looksLikeImage(bytes: Buffer, name: string): boolean {
  if (name.endsWith('.png')) return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function capturePlugin(folder = 'docs/screenshots'): Plugin {
  return {
    name: 'nightpiece-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(ROUTE)) return next();
        const refuse = (status: number, why: string) => {
          res.statusCode = status;
          res.end(why);
        };
        if (req.method !== 'POST') return refuse(405, 'POST only');

        // A custom header cannot be sent across origins without a preflight, which the dev server does not grant.
        const origin = req.headers.origin;
        const sameOrigin = origin === undefined || origin === `http://${req.headers.host}`;
        if (req.headers['x-nightpiece-capture'] !== '1' || !sameOrigin) return refuse(403, 'same-origin captures only');

        let name: string;
        try {
          name = decodeURIComponent(req.url.slice(ROUTE.length).split('?')[0] ?? '');
        } catch {
          return refuse(400, 'bad name');
        }
        if (!NAME.test(name)) return refuse(400, 'bad name');

        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > LIMIT) {
            refuse(413, 'too large');
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (res.writableEnded) return;
          const bytes = Buffer.concat(chunks);
          if (!looksLikeImage(bytes, name)) return refuse(415, 'not an image');
          const file = path.resolve(server.config.root, folder, name);
          mkdir(path.dirname(file), { recursive: true })
            .then(() => writeFile(file, bytes))
            .then(
              () => refuse(200, `${bytes.length}`),
              (error: unknown) => refuse(500, String(error)),
            );
        });
      });
    },
  };
}
