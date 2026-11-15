/**
 * Development only. The film's own sound, as the game makes it: every call the game's sound
 * engine was given while a shot was filmed (the shot's events.json) is put where the cut puts
 * that frame, and the whole is played through the engine with nobody listening (tools/dev/hear.mjs).
 *
 *   node tools/promo/sound.mjs --shots tmp/promo/shots [--out tmp/promo/sound]
 *
 * Writes game.wav, and cues.json: when each shot begins, when the check, the capture, the mate, the
 * card and its seal fall, when each line and each piece's name comes up and each letter of the
 * name is typed, for score.py.
 * Needs the dev server (npm run dev).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '../dev/hear.mjs';
import { CAPTIONS, CARD, FPS, LABELS, LENGTH, TITLE, timeline } from './edit.mjs';
import { MENU } from './shots.mjs';

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const shots = arg('shots', 'tmp/promo/shots').split(',');
const out = arg('out', 'tmp/promo/sound');

/** The one place the film is heard from: over the near edge of the board, looking down at its middle. */
const SEAT = { position: [0, 5.2, 6.8], forward: [0, -0.6, -0.8], up: [0, 1, 0] };
/** Calls the engine makes of itself as time passes (`play` is every sound it starts, the heart's among them); it will make them again here. */
const OWN = new Set(['heartbeat', 'update', 'listen', 'startRoom', 'setVolumes', 'use', 'play']);

const events = [{ t: 0.02, room: true }];
const cues = {
  length: LENGTH / FPS,
  title: TITLE.at / FPS,
  seal: TITLE.at / FPS + CARD.seal,
  cuts: [],
  shots: {},
  sets: [],
  lines: CAPTIONS.map((c) => c.at),
  names: LABELS.names.map((m) => m.at),
  keys: [],
};
/** The pencil's stroke as the pointer comes onto something: where the pointer crosses several things at a run, they are one stroke. */
let stroke = -1;
for (const c of timeline()) {
  const dir = shots.map((d) => path.join(d, c.shot)).find((d) => existsSync(path.join(d, 'events.json')));
  if (!dir) throw new Error(`No events for the shot ${c.shot}.`);
  const shot = JSON.parse(readFileSync(path.join(dir, 'events.json'), 'utf8'));
  cues.cuts.push(c.at / FPS);
  cues.shots[c.shot] = c.at / FPS;
  // The name is typed in the shot of the opening screen, whose scene begins as the cut to it is made.
  if (c.shot === 'menu') cues.keys = MENU.typing.map((t) => c.at / FPS + t);
  for (const e of shot.events) {
    if (e.frame < c.from || e.frame >= c.from + c.frames) continue;
    if (OWN.has(e.method) || c.without?.includes(e.method)) continue;
    const t = (c.at + e.frame - c.from) / FPS;
    if (e.method === 'ui' && e.args[0] === 'hover') {
      if (t - stroke < 0.125) continue;
      stroke = t;
    }
    if (e.method === 'glass') cues.match ??= t;
    events.push({ t, call: e.method, args: e.args });
    if (e.method === 'stinger') cues.check = t;
    // The rook that takes the queen: the one strong move between the check and the mate.
    if (e.method === 'lift') cues.capture = t;
    if (e.method === 'choir') cues.mate = t;
    if (e.method === 'stoneSet') cues.sets.push(t);
  }
}
// The seal is struck onto the card: a stone set down, as near as the film can put it.
events.push({ t: cues.seal, call: 'stoneSet', args: [[0, 0, 3.5], true, 1.3] });
events.sort((a, b) => a.t - b.t);

mkdirSync(out, { recursive: true });
for (const key of ['check', 'capture', 'mate']) if (!(cues[key] > 0)) throw new Error(`The film has no ${key}: the shots are not the ones edit.mjs cuts.`);
writeFileSync(path.join(out, 'cues.json'), JSON.stringify(cues, null, 1));
writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 1));
// A little longer than the film, so that nothing is cut off before score.py has faded it.
console.log(await render({ events, seconds: LENGTH / FPS + 1, out: path.join(out, 'game.wav'), listener: SEAT }));
for (const e of events) if (e.call) console.log(e.t.toFixed(3).padStart(7), e.call);
