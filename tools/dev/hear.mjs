/**
 * Development only. Plays the game's sound through its own engine with no speakers: a list of
 * what is to be heard and when is rendered, faster than real time, to a WAV file that can be
 * measured or laid under a film of the game.
 *
 * Needs the dev server (npm run dev) and a Chromium or Chrome on this machine, as look.mjs does.
 *
 *   node tools/dev/hear.mjs [out.wav]            the standard scene: every sound the game has, in turn
 *
 *   import { render } from './hear.mjs';
 *   await render({ out: 'tmp/hear/move.wav', seconds: 6, events: [
 *     { t: 1.0, call: 'stoneLift', args: ['e2', true] },     // a square's name stands for its centre
 *     { t: 1.7, call: 'stoneSet', args: ['e4', true, 0.5] },
 *   ] });
 *
 * An event may also be { t, listen: { position, forward, up } } to move the listener (each a
 * [x, y, z]), or { t, room: true } to start the room's own sound.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const BROWSERS = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
/** Where a player sits by default: behind White, looking down at the middle of the board. */
const SEAT = { position: [0, 7.4, 9.6], forward: [0, -0.62, -0.78], up: [0, 1, 0] };

export async function render({ events, seconds, out, url = 'http://127.0.0.1:5173/', volumes = { master: 0.8, music: 0.7, effects: 0.9 }, listener = SEAT, rate = 48000 }) {
  const executablePath = BROWSERS.find((p) => p && existsSync(p));
  if (!executablePath) throw new Error('No Chromium found. Set CHROMIUM to the path of one.');
  const browser = await puppeteer.launch({ executablePath, headless: 'new', protocolTimeout: 600000, args: ['--no-first-run', '--mute-audio', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 600)));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warn') console.log(`[${m.type()}]`, m.text().slice(0, 300));
    });
    // Not the game's own page: its picture would be drawn all the while. A source file is as good
    // an address as any on the dev server, and the sound engine is fetched from there by itself.
    await page.goto(`${url}src/audio/bank.ts`, { waitUntil: 'domcontentloaded' });
    const base64 = await page.evaluate(
      async (events, seconds, volumes, listener, rate) => {
        const { squareCenter } = await import('/src/scene/layout.ts');
        const { Sound } = await import('/src/audio/sound.ts');
        const { fetchBank, decodeBank } = await import('/src/audio/bank.ts');
        const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
        const bank = await decodeBank(ctx, await fetchBank());
        const sound = new Sound(ctx, volumes, bank);
        const vec = (a) => ({ x: a[0], y: a[1], z: a[2] });
        const place = (a) => (typeof a === 'string' && /^[a-h][1-8]$/.test(a) ? squareCenter(a) : Array.isArray(a) && a.length === 3 && a.every((v) => typeof v === 'number') ? vec(a) : a);
        const hear = (l) => {
          // At once, not eased: there are no frames here to ease across.
          const L = ctx.listener;
          const set = (p, v) => p.setValueAtTime(v, ctx.currentTime);
          set(L.positionX, l.position[0]), set(L.positionY, l.position[1]), set(L.positionZ, l.position[2]);
          set(L.forwardX, l.forward[0]), set(L.forwardY, l.forward[1]), set(L.forwardZ, l.forward[2]);
          set(L.upX, l.up[0]), set(L.upY, l.up[1]), set(L.upZ, l.up[2]);
        };
        hear(listener);
        // The engine acts "now", so the render is stopped at each moment something happens.
        const quantum = 128 / rate;
        const slots = new Map();
        for (const e of events) {
          const at = Math.max(quantum, Math.round(e.t / quantum) * quantum);
          if (!slots.has(at)) slots.set(at, []);
          slots.get(at).push(e);
        }
        // The heartbeat is kept going by the game's frames; here, thirty times a second.
        let last = 0;
        for (let t = quantum; t < seconds; t += Math.round(1 / 30 / quantum) * quantum) {
          const at = Math.round(t / quantum) * quantum;
          if (!slots.has(at)) slots.set(at, []);
        }
        for (const [at, list] of slots) {
          if (at >= seconds) continue;
          void ctx.suspend(at).then(() => {
            sound.update(at - last);
            last = at;
            for (const e of list) {
              if (e.listen) hear(e.listen);
              else if (e.room) sound.startRoom();
              else sound[e.call](...(e.args ?? []).map(place));
            }
            return ctx.resume();
          });
        }
        const buffer = await ctx.startRendering();
        // 24-bit PCM.
        const frames = buffer.length;
        const bytes = new Uint8Array(44 + frames * 6);
        const view = new DataView(bytes.buffer);
        const text = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
        text(0, 'RIFF'), view.setUint32(4, 36 + frames * 6, true), text(8, 'WAVEfmt '), view.setUint32(16, 16, true), view.setUint16(20, 1, true), view.setUint16(22, 2, true);
        view.setUint32(24, rate, true), view.setUint32(28, rate * 6, true), view.setUint16(32, 6, true), view.setUint16(34, 24, true), text(36, 'data'), view.setUint32(40, frames * 6, true);
        const l = buffer.getChannelData(0);
        const r = buffer.getChannelData(1);
        let o = 44;
        for (let i = 0; i < frames; i++) {
          for (const s of [l[i], r[i]]) {
            const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
            bytes[o++] = v & 255;
            bytes[o++] = (v >> 8) & 255;
            bytes[o++] = (v >> 16) & 255;
          }
        }
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return btoa(binary);
      },
      events,
      seconds,
      volumes,
      listener,
      rate,
    );
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(base64, 'base64'));
    return out;
  } finally {
    await browser.close();
  }
}

/** Every sound the game has, one after another, as a game would call for them. Used to set their levels against each other. */
export const SCENE = [
  { t: 0.1, room: true },
  // A pawn is thought about, chosen, and played.
  { t: 6.0, call: 'glass', args: ['e2', 1, 0.16] },
  { t: 6.6, call: 'select', args: ['e2'] },
  { t: 7.2, call: 'whoosh', args: ['e2', 0.5, 0.2] },
  { t: 7.6, call: 'touch', args: ['e2'] },
  { t: 7.8, call: 'stoneLift', args: ['e2', true] },
  { t: 7.8, call: 'whoosh', args: ['e4', 0.7, 0.28] },
  { t: 8.5, call: 'stoneSet', args: ['e4', true, 0.5] },
  // A knight for the other side.
  { t: 10.2, call: 'whoosh', args: ['g8', 0.5, 0.2] },
  { t: 10.6, call: 'touch', args: ['g8'] },
  { t: 10.8, call: 'stoneLift', args: ['g8', false] },
  { t: 10.8, call: 'whoosh', args: ['f6', 0.7, 0.28] },
  { t: 11.5, call: 'stoneSet', args: ['f6', false, 0.85] },
  // A queen takes.
  { t: 13.2, call: 'stoneLift', args: ['d1', true] },
  { t: 13.9, call: 'crack', args: ['d7'] },
  { t: 14.2, call: 'stoneSet', args: ['d7', true, 1.3] },
  { t: 14.6, call: 'stoneSet', args: [[5.2, 0.4, -2], false, 0.5] },
  // Check: the crack runs to the king, the stinger, the heart and the uneasy strings.
  { t: 17.0, call: 'stoneSet', args: ['h5', true, 1.3] },
  { t: 17.1, call: 'fracture', args: ['h5', 'e8', 0.35, 1] },
  { t: 17.1, call: 'stinger', args: ['e8'] },
  { t: 17.2, call: 'setHeartbeat', args: [true] },
  { t: 17.2, call: 'setTension', args: [1] },
  { t: 25.0, call: 'setHeartbeat', args: [false] },
  { t: 25.0, call: 'setTension', args: [0] },
  // A sacrifice, a fork, a discovered attack, a strong move, a blunder, a pin.
  { t: 28.0, call: 'bell', args: ['f7'] },
  { t: 33.0, call: 'stab', args: ['c7'] },
  { t: 35.5, call: 'reveal', args: ['d5'] },
  { t: 38.0, call: 'lift', args: ['e5'] },
  { t: 42.0, call: 'fall', args: ['b4'] },
  { t: 45.0, call: 'seal', args: ['c6'] },
  // A run of glasses, the clock, the interface.
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((s) => ({ t: 47.0 + 0.22 * s, call: 'glass', args: ['d4', s, 0.22] })),
  { t: 50.0, call: 'tick', args: [] },
  { t: 51.5, call: 'tick', args: [] },
  { t: 53.0, call: 'ui', args: ['hover'] },
  { t: 53.4, call: 'ui', args: ['press'] },
  { t: 53.9, call: 'ui', args: ['open'] },
  { t: 54.8, call: 'ui', args: ['hover'] },
  { t: 55.2, call: 'ui', args: ['close'] },
  // Mate.
  { t: 57.0, call: 'stoneSet', args: ['f7', true, 1.3] },
  { t: 57.1, call: 'fracture', args: ['f7', 'e8', 0.5, 1.7] },
  { t: 57.6, call: 'choir', args: [] },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2] ?? 'tmp/hear/scene.wav';
  console.log(await render({ events: SCENE, seconds: 66, out }));
}
