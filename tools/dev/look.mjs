/**
 * Development only. Drives the dev build in headless Chromium on the real GPU and saves whole
 * frames: the 3D picture and the interface over it, exactly as a player sees them. Nothing
 * opens on screen.
 *
 * Needs the dev server (npm run dev) and a Chromium or Chrome on this machine. Point
 * CHROMIUM at the binary if it is not one of the usual places.
 *
 *   import { launch } from './look.mjs';
 *   const g = await launch({ out: 'tmp/look' });
 *   await g.hold();                 // time now only moves when told to
 *   await g.ev(`app.startTable();`);
 *   await g.advance(3);
 *   await g.shot('table');          // tmp/look/table.png
 *   await g.close();
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BROWSERS = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
/** The dev handle that src/main.tsx hangs on the window. */
const HANDLE = 'window.__nightpiece';

export async function launch({ width = 1920, height = 1080, scale = 1, url = 'http://127.0.0.1:5173/', out = 'tmp/look', quality = 'high', quiet = false, storage = null, block = [] } = {}) {
  mkdirSync(out, { recursive: true });
  const executablePath = BROWSERS.find((p) => p && existsSync(p));
  if (!executablePath) throw new Error('No Chromium found. Set CHROMIUM to the path of one.');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--no-first-run', '--hide-scrollbars', '--mute-audio', `--window-size=${width},${height}`],
    defaultViewport: { width, height, deviceScaleFactor: scale },
  });
  const page = await browser.newPage();
  if (!quiet) {
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'warn') console.log(`[${t}]`, m.text().slice(0, 400));
    });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 600)));
  }
  // Requests whose address contains one of these are refused: `block: ['.glb']` shows the game as it is when its models cannot be had.
  if (block.length) {
    await page.setRequestInterception(true);
    page.on('request', (r) => (block.some((part) => r.url().includes(part)) ? r.abort() : r.continue()));
  }
  if (storage) {
    await page.evaluateOnNewDocument((s) => {
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, storage);
  }
  await page.goto(url, { waitUntil: 'networkidle2' });
  // Wait for the finished room, not the grey boxes that stand in while it loads.
  await page.waitForFunction(`${HANDLE} && ${HANDLE}.ui && ${HANDLE}.ui.ready.value === true`, { timeout: 60000 });
  /** Run a snippet in the page with `app`, `ui` and `args` in scope. Await inside it freely. */
  const ev = (body, ...args) => page.evaluate(new Function('...args', `const h = ${HANDLE}; const app = h.app; const ui = h.ui; return (async () => { ${body} })();`), ...args);
  if (quality) await ev(`app.setQuality(args[0]);`, quality);
  return {
    browser,
    page,
    ev,
    /** Stop the browser's own frames from advancing time; everything after is stepped exactly. */
    hold: () => ev(`app.held = true;`),
    release: () => ev(`app.held = false;`),
    advance: (seconds, step = 1 / 60) => ev(`await app.advance(args[0], args[1]);`, seconds, step),
    click: (square) => ev(`app.click(args[0]);`, square),
    /** Click a square, then another: one move, and the time it takes to play out. */
    move: async (from, to, seconds = 3.2) => {
      await ev(`app.click(args[0]);`, from);
      await ev(`await app.advance(0.3, 1 / 60);`);
      await ev(`app.click(args[0]);`, to);
      await ev(`await app.advance(args[0], 1 / 60);`, seconds);
    },
    /** Let real time pass (the engine and the server answer in real time). */
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Save the whole page. `clip` ({x, y, width, height}) saves part of it. */
    shot: async (name, opts = {}) => {
      await ev(`app.redraw();`);
      const file = path.join(out, /\.(png|jpg)$/.test(name) ? name : `${name}.png`);
      mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, ...(file.endsWith('.jpg') ? { quality: 92 } : {}), ...opts });
      return file;
    },
    close: () => browser.close(),
  };
}
