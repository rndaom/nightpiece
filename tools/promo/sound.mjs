/**
 * Development only. One of the films' own sound, as the game makes it: every call the game's
 * sound engine was given while a shot was filmed (the shot's events.json) is put where the cut
 * puts that frame, and the whole is played through the engine with nobody listening
 * (tools/dev/hear.mjs). The paper titles are given the game's sounds too: a card laid down for
 * each, and a stone set down for the large ones and the seal.
 *
 *   node tools/promo/sound.mjs --cut game --shots tmp/promo/shots [--out tmp/promo/sound/game]
 *
 * Writes game.wav, and events.json (what was played, and when). mix.mjs lays the music beside it.
 * Needs the dev server (npm run dev).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from '../dev/hear.mjs';
import { END_STEPS, FPS, REELS } from './film/src/timeline.ts';

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const reel = REELS[arg('cut', 'game')];
if (!reel) throw new Error(`No such film. There are: ${Object.keys(REELS).join(', ')}`);
const shots = arg('shots', 'tmp/promo/shots').split(',');
const out = arg('out', `tmp/promo/sound/${reel.id}`);

/** The one place the film is heard from: over the near edge of the board, looking down at its middle. */
const SEAT = { position: [0, 5.2, 6.8], forward: [0, -0.6, -0.8], up: [0, 1, 0] };
/** Calls the engine makes of itself as time passes (`play` is every sound it starts, the heart's among them); it will make them again here. */
const OWN = new Set(['heartbeat', 'update', 'listen', 'startRoom', 'setVolumes', 'use', 'play']);
/** What the room is left in from one moment to the next: each shot begins as its own scene had it, not as the shot before left it. */
const STATE = { setHeartbeat: [false], setTension: [0] };
/** Each shot is filmed with this many frames before its cut begins (shots.mjs, `span` and `take`). */
const HANDLE = 12;

const events = [{ t: 0.02, room: true }];
for (const c of reel.cuts) {
  const dir = shots.map((d) => path.join(d, c.shot)).find((d) => existsSync(path.join(d, 'events.json')));
  if (!dir) throw new Error(`No events for the shot ${c.shot}.`);
  const shot = JSON.parse(readFileSync(path.join(dir, 'events.json'), 'utf8'));
  const first = HANDLE + (c.skip ?? 0);
  const state = structuredClone(STATE);
  for (const e of shot.events) if (e.frame < first && e.method in state) state[e.method] = e.args;
  for (const [call, args] of Object.entries(state)) events.push({ t: c.from / FPS, call, args });
  for (const e of shot.events) {
    if (e.frame < first || e.frame >= first + (c.to - c.from)) continue;
    if (OWN.has(e.method) || c.without?.includes(e.method)) continue;
    events.push({ t: (c.from + e.frame - first) / FPS, call: e.method, args: e.args });
  }
}
// The titles. A sheet lands two frames after it is first seen.
const land = (frame) => (frame + 2) / FPS;
const laid = (frame) => events.push({ t: land(frame), call: 'ui', args: ['close'] });
const struck = (frame, heavy = true) => events.push({ t: land(frame), call: 'stoneSet', args: heavy ? [[0, 0, 3.5], true, 1.5] : [[2, 0, 3.5], false, 1.1] });
for (const c of reel.captions) laid(c.from);
for (const c of [...reel.cards, ...reel.slams]) {
  struck(c.from);
  laid(c.from);
}
for (const at of [reel.title.from, reel.end.from]) {
  struck(at);
  laid(at);
}
struck(reel.title.from + 9, false);
struck(reel.end.from + END_STEPS.seal, false);
laid(reel.end.from + END_STEPS.line);
for (let i = 0; i < 3; i++) laid(reel.end.from + END_STEPS.chips + i * 8);
events.push({ t: land(reel.end.from + END_STEPS.address), call: 'ui', args: ['press'] });
events.sort((a, b) => a.t - b.t);

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 1));
// A little longer than the film, so that nothing is cut off before it has died away.
console.log(await render({ events, seconds: reel.length / FPS + 1, out: path.join(out, 'game.wav'), listener: SEAT }));
for (const e of events) if (e.call && !(e.call in STATE)) console.log(e.t.toFixed(3).padStart(7), e.call, e.call === 'manner' ? e.args[0] : '');
