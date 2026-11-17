/**
 * Development only. Draws one of the films: the shots (shots.mjs) laid end to end as its cut has
 * them (src/timeline.ts), with the paper titles over them.
 *
 *   node tools/promo/film/render.mjs --cut game --shots tmp/promo/shots --out tmp/promo/game.mov   the whole film, 3840 x 2160, ProRes
 *   node tools/promo/film/render.mjs --cut tour --shots <dir> --scale 0.5 --out draft.mp4          a small one, H.264
 *   node tools/promo/film/render.mjs --cut short --shots <dir> --stills 510,900 --out tmp/stills   single frames, as PNG
 *   node tools/promo/film/render.mjs --cut game --shots <dir> --frames 2000-2600 --out end.mov     a part of it
 *
 * The shots are served to the page that draws the film from this script itself, so nothing else
 * need be running. `--address` is what the last card gives as the game's address. The film has
 * no sound here: sound.mjs and mix.mjs make it, and cut.mjs puts the two together.
 *
 * Needs its own packages (`npm install` in this folder, once), a Chromium, and ImageMagick for
 * the paper's grain. The typefaces are the game's own, taken from its packages.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const reel = arg('cut', 'game');
const shots = path.resolve(arg('shots', 'tmp/promo/shots'));
const out = path.resolve(arg('out', `tmp/promo/${reel}.mov`));
const scale = Number(arg('scale', '2'));
const address = arg('address', 'playnightpiece.com');
const stills = arg('stills', null);
const frames = arg('frames', null);
const concurrency = Number(arg('concurrency', '6'));
// A film at its full size is kept beside where it is going until it is whole: it is too much for a temporary folder
// held in memory. (The folder's name is short because the browser keeps a socket in it, and a socket's path may not be long.)
const work = !stills && out.endsWith('.mov') ? path.join(path.dirname(out), `rw-${reel}`) : null;
if (work) {
  mkdirSync(work, { recursive: true });
  process.env.TMPDIR = work;
}
const BROWSERS = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
const browserExecutable = BROWSERS.find((p) => p && existsSync(p)) ?? null;

/** What the titles are drawn with that is not kept here: the game's typefaces, from its packages, and the paper's grain, made by grain.sh. */
const FONTS = [
  '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2',
  '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2',
  '@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2',
  '@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2',
  '@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff2',
];
mkdirSync(path.join(here, 'public/fonts'), { recursive: true });
mkdirSync(path.join(here, 'public/tex'), { recursive: true });
for (const f of FONTS) {
  const to = path.join(here, 'public/fonts', path.basename(f));
  if (!existsSync(to)) copyFileSync(path.join(here, '../../../node_modules', f), to);
}
const grain = path.join(here, 'public/tex/grain.png');
if (!existsSync(grain) && spawnSync('sh', [path.join(here, 'grain.sh'), grain], { stdio: 'inherit' }).status !== 0) throw new Error('The paper\'s grain could not be made (grain.sh needs ImageMagick).');

if (!existsSync(shots)) throw new Error(`No shots at ${shots}.`);
// The kind of picture the shots are: a draft's are JPEG, the film's own PNG.
const some = readdirSync(shots).map((d) => path.join(shots, d)).find((d) => statSync(d).isDirectory() && existsSync(path.join(d, 'events.json')));
if (!some) throw new Error(`No shots in ${shots}.`);
const ext = existsSync(path.join(some, 'frame_00000.png')) ? 'png' : 'jpg';

/** The shots, served to the page that draws the film. */
const server = createServer((req, res) => {
  const file = path.join(shots, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(shots) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const serveUrl = await bundle({ entryPoint: path.join(here, 'src/index.ts'), publicDir: path.join(here, 'public') });
  const inputProps = { reel, base, ext, address };
  const chromiumOptions = { gl: 'angle-egl' };
  const common = { serveUrl, inputProps, browserExecutable, chromiumOptions, chromeMode: 'chrome-for-testing', scale, timeoutInMilliseconds: 120000 };
  const composition = await selectComposition({ ...common, id: reel });
  if (stills) {
    mkdirSync(out, { recursive: true });
    for (const f of stills.split(',').map(Number)) {
      const output = path.join(out, `${reel}_${String(f).padStart(5, '0')}.png`);
      await renderStill({ ...common, composition, frame: f, output, imageFormat: 'png' });
      console.log(output);
    }
  } else {
    mkdirSync(path.dirname(out), { recursive: true });
    const master = out.endsWith('.mov');
    const began = Date.now();
    await renderMedia({
      ...common,
      composition,
      outputLocation: out,
      ...(master ? { codec: 'prores', proResProfile: 'standard', imageFormat: 'png', colorSpace: 'bt709' } : { codec: 'h264', crf: 14, imageFormat: 'jpeg', jpegQuality: 95, colorSpace: 'bt709' }),
      frameRange: frames ? frames.split('-').map(Number) : null,
      concurrency,
      muted: true,
      onProgress: ({ renderedFrames, encodedFrames }) => {
        if (renderedFrames % 60 === 0) process.stdout.write(`\r${renderedFrames} drawn, ${encodedFrames} encoded, ${((Date.now() - began) / 1000).toFixed(0)} s`);
      },
    });
    console.log(`\n${out}`);
  }
} finally {
  server.close();
  if (work) rmSync(work, { recursive: true, force: true });
}
