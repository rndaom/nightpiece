/**
 * Development only. One of the films' sound, whole: the game's own sound (sound.mjs) with the music laid beside it.
 *
 *   node tools/promo/mix.mjs --cut game [--game tmp/promo/sound/game/game.wav] [--music assets/src/sound/cache/promo/spy-glass.mp3] [--out tmp/promo/sound/game/film.wav]
 *
 * The music is a recording (tools/promo/sources.json says whose, and `python assets/src/sound/fetch.py
 * --list tools/promo/sources.json` fetches it). Each film says which bar of it falls on the film's
 * own first bar, how long before that it is begun, and whether it jumps to a later bar part of
 * the way through (film/src/timeline.ts); a jump is made a hundredth of a second before the beat.
 * It runs out to its own end. The two are then brought together to the loudness films are played
 * at online (-14 LUFS, peaks under -1 dB). `--music-gain` and `--game-gain` (dB) set one against the other.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { FPS, MUSIC, REELS } from './film/src/timeline.ts';

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const reel = REELS[arg('cut', 'game')];
if (!reel) throw new Error(`No such film. There are: ${Object.keys(REELS).join(', ')}`);
const game = arg('game', `tmp/promo/sound/${reel.id}/game.wav`);
const music = arg('music', 'assets/src/sound/cache/promo/spy-glass.mp3');
const out = arg('out', `tmp/promo/sound/${reel.id}/film.wav`);
const musicGain = Number(arg('music-gain', '-2'));
const gameGain = Number(arg('game-gain', '-4'));
const TARGET = -14;

const length = reel.length / FPS;
const at = (b) => MUSIC.lead + b * MUSIC.bar;
// The second of the recording it is begun at (its very start, where the film has it from its first bar), and the second of the film that is.
const first = reel.music.from - reel.music.pre;
const start = first <= 0 ? 0 : at(first);
const begins = reel.f0 / FPS - (at(reel.music.from) - start);
if (begins < 0) throw new Error('The music would begin before the film does.');
const JOIN = 0.02;
const splice = reel.music.splice;
const fadeIn = start > 0 ? ',afade=t=in:st=0:d=0.03' : '';
const played = splice
  ? [
      `[1:a]aresample=48000,atrim=${start.toFixed(4)}:${(at(reel.music.from + splice.at) - 0.002).toFixed(4)},asetpts=PTS-STARTPTS${fadeIn}[a]`,
      `[1:a]aresample=48000,atrim=start=${(at(splice.to) - 0.002 - JOIN).toFixed(4)},asetpts=PTS-STARTPTS[b]`,
      `[a][b]acrossfade=d=${JOIN}:c1=qsin:c2=qsin[p]`,
    ]
  : [`[1:a]aresample=48000,atrim=start=${start.toFixed(4)},asetpts=PTS-STARTPTS${fadeIn}[p]`];
const graph = (gain, more = '') =>
  [
    ...played,
    `[p]adelay=${Math.round(begins * 1000)}:all=1,volume=${musicGain}dB[m]`,
    `[0:a]aresample=48000,volume=${gameGain}dB[g]`,
    `[g][m]amix=inputs=2:normalize=0:duration=longest,atrim=0:${length.toFixed(4)},afade=t=out:st=${(length - 0.4).toFixed(3)}:d=0.4${gain}${more}[o]`,
  ].join(';');

function ffmpeg(args) {
  const done = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg could not mix the sound.\n${done.stderr.slice(-2000)}`);
  return done.stderr;
}

// Once to measure how loud it comes out, once more with the peaks held down (which takes a little
// of the loudness away again), and then made at the loudness wanted.
const measure = (text) => {
  const loud = Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(text.slice(text.lastIndexOf('Summary:')))?.[1]);
  if (!Number.isFinite(loud)) throw new Error('The loudness could not be measured.');
  return loud;
};
const held = (lift) => `,volume=${lift.toFixed(2)}dB,alimiter=limit=0.8:attack=2:release=60:level=false`;
const inputs = ['-i', game, '-i', music, '-filter_complex'];
const loud = measure(ffmpeg([...inputs, graph('', ',ebur128=peak=true'), '-map', '[o]', '-f', 'null', '-']));
let lift = TARGET - loud;
lift += TARGET - measure(ffmpeg([...inputs, graph(held(lift), ',ebur128=peak=true'), '-map', '[o]', '-f', 'null', '-']));
mkdirSync(path.dirname(out), { recursive: true });
const made = ffmpeg(['-y', ...inputs, graph(held(lift), ',ebur128=peak=true'), '-map', '[o]', '-c:a', 'pcm_s24le', '-ar', '48000', out]);
const summary = made.slice(made.lastIndexOf('Summary:'));
console.log(`${out}: was ${loud} LUFS, lifted ${lift.toFixed(1)} dB`);
console.log(summary.replace(/\n\s*\n/g, '\n').trim());
