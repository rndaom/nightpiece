/**
 * Development only. Photographs what the film writes over its picture (overlay.html): one picture
 * for each frame of the film, over nothing, so that it can be laid over the film.
 *
 *   node tools/promo/overlay.mjs [--shots tmp/promo/shots] [--out tmp/promo/overlay] [--size 3840x2160] [--still 8.4]
 *
 * The names of the pieces are tied to the stones they name: where each stone's top is in the
 * picture at each frame is worked out here, from where the camera was when that frame was filmed
 * (the shot's camera.json), which is why the shots are asked for. `--still s` saves the one picture
 * at second `s` of the film, to look at. Needs the dev server (npm run dev) and a Chromium; nothing
 * opens on screen.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { FPS, LABELS, LENGTH, timeline } from './edit.mjs';

const BROWSERS = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);

const shots = arg('shots', 'tmp/promo/shots').split(',');
const out = arg('out', 'tmp/promo/overlay');
const [width, height] = arg('size', '3840x2160').split('x').map(Number);
const still = arg('still', null);
const url = arg('url', 'http://127.0.0.1:5173/');
const pages = Number(arg('pages', 3));

// -- where the named stones are, frame by frame ------------------------------------------------
const cut = timeline().find((c) => c.shot === LABELS.shot);
const file = shots.map((d) => path.join(d, LABELS.shot, 'camera.json')).find((f) => existsSync(f));
if (!cut || !file) throw new Error(`The shot ${LABELS.shot} has not been filmed whole: its camera.json is wanted for the names of the pieces.`);
const poses = JSON.parse(readFileSync(file, 'utf8')).frames;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((v) => v / Math.hypot(...a));
/** Where the names' stones are in the picture at a frame of the film, as fractions of it; nothing outside the shot. */
function where(frame) {
  if (frame < cut.at || frame >= cut.at + cut.frames) return [];
  const pose = poses[cut.from + frame - cut.at];
  const forward = unit(pose.forward);
  const right = unit(cross(forward, pose.up));
  const up = cross(right, forward);
  const tan = Math.tan((pose.fov * Math.PI) / 360);
  return LABELS.names.map((m) => {
    const d = sub(m.top, pose.position);
    const z = dot(d, forward);
    if (z <= 0.1) return null;
    return [0.5 + dot(d, right) / (z * tan * (width / height)) / 2, 0.5 - dot(d, up) / (z * tan) / 2];
  });
}

const executablePath = BROWSERS.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('No Chromium found. Set CHROMIUM to the path of one.');
mkdirSync(out, { recursive: true });
// A browser photographs one page at a time, and a page that is not in front waits to be: each page has a browser of its own.
const browsers = [];
const ready = async () => {
  const browser = await puppeteer.launch({ executablePath, headless: 'new', protocolTimeout: 600000, args: ['--no-first-run', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb'] });
  browsers.push(browser);
  const page = await browser.newPage();
  // It is laid out for a screen 1080 high and photographed at whatever size is asked for.
  await page.setViewport({ width: Math.round((1080 * width) / height), height: 1080, deviceScaleFactor: height / 1080 });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  await page.goto(`${url}tools/promo/overlay.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.overlayReady === true', { timeout: 30000 });
  return page;
};
try {
  const shoot = async (page, frame, target) => {
    const any = await page.evaluate((s, w) => window.setFilm(s, w), frame / FPS, where(frame));
    if (any || target.includes('still')) await page.screenshot({ path: target, omitBackground: true, type: 'png' });
    return any;
  };
  if (still !== null) {
    await shoot(await ready(), Math.round(Number(still) * FPS), path.join(out, `still_${still}.png`));
  } else {
    // A frame with nothing written on it is the same empty picture every time: it is photographed once and copied.
    const first = await ready();
    const empty = path.join(out, 'empty.png');
    await first.evaluate(() => window.setFilm(-1));
    await first.screenshot({ path: empty, omitBackground: true, type: 'png' });
    let next = 0;
    let written = 0;
    const started = Date.now();
    const work = async (page) => {
      while (next < LENGTH) {
        const frame = next++;
        const target = path.join(out, `o_${String(frame).padStart(5, '0')}.png`);
        if (await shoot(page, frame, target)) written++;
        else copyFileSync(empty, target);
        if (frame % 300 === 299) process.stdout.write(`\r[overlay] ${frame + 1}/${LENGTH}`);
      }
    };
    await Promise.all([work(first), ...(await Promise.all(Array.from({ length: pages - 1 }, ready))).map(work)]);
    process.stdout.write(`\r[overlay] ${LENGTH} frames, ${written} with something written on them, in ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
  }
  console.log(out);
} finally {
  for (const browser of browsers) await browser.close();
}
