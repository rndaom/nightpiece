/**
 * Development only. Makes the film's picture from the shots, as edit.mjs lists them: the cuts
 * laid end to end, what the film writes over them (overlay.mjs) laid over that, up from black and
 * back to it; and, given the sound, the finished file.
 *
 *   node tools/promo/cut.mjs --shots tmp/promo/shots --overlay tmp/promo/overlay --sound tmp/promo/sound/film.wav --out tmp/promo/nightpiece.mp4 [--size 3840x2160] [--crf 15]
 *
 * `--shots` may name several folders, separated by commas; a shot is taken from the first that has it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { FADE, FPS, LENGTH, timeline } from './edit.mjs';

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const shots = arg('shots', 'tmp/promo/shots').split(',');
const overlay = arg('overlay', 'tmp/promo/overlay');
const sound = arg('sound', null);
const out = arg('out', 'tmp/promo/nightpiece.mp4');
const [width, height] = arg('size', '3840x2160').split('x').map(Number);
const crf = arg('crf', '15');

/** The folder a shot is in and the kind of picture its frames are. */
function find(shot, frame) {
  for (const dir of shots) {
    for (const ext of ['png', 'jpg']) if (existsSync(path.join(dir, shot, `frame_${String(frame).padStart(5, '0')}.${ext}`))) return { dir: path.join(dir, shot), ext };
  }
  throw new Error(`No frames for the shot ${shot} in ${shots.join(', ')}.`);
}

const cuts = timeline();
const inputs = [];
const graph = [];
cuts.forEach((c, i) => {
  const { dir, ext } = find(c.shot, c.from);
  const last = path.join(dir, `frame_${String(c.from + c.frames - 1).padStart(5, '0')}.${ext}`);
  if (!existsSync(last)) throw new Error(`${c.shot} has no frame ${c.from + c.frames - 1}.`);
  inputs.push('-framerate', String(FPS), '-start_number', String(c.from), '-t', String(c.frames / FPS), '-i', path.join(dir, `frame_%05d.${ext}`));
  graph.push(`[${i}:v]scale=${width}:${height}:flags=lanczos,setsar=1,format=gbrp,trim=end_frame=${c.frames},setpts=PTS-STARTPTS[s${i}]`);
});
graph.push(`${cuts.map((_, i) => `[s${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0,fps=${FPS}[film]`);
// What is written over the film has a picture for every frame of it.
inputs.push('-framerate', String(FPS), '-t', String(LENGTH / FPS), '-i', path.join(overlay, 'o_%05d.png'));
graph.push(`[${cuts.length}:v]scale=${width}:${height}:flags=lanczos,format=rgba[words]`);
graph.push(`[film][words]overlay=0:0:format=gbrp:eof_action=pass[over]`);
const end = LENGTH / FPS;
graph.push(
  `[over]fade=t=in:st=0:d=${FADE.in / FPS},fade=t=out:st=${(LENGTH - FADE.out) / FPS}:d=${FADE.out / FPS},trim=end_frame=${LENGTH},` +
    `scale=in_range=pc:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p[v]`,
);
if (sound) inputs.push('-i', sound);

mkdirSync(path.dirname(out), { recursive: true });
const args = [
  '-v', 'error', '-stats', '-y', ...inputs, '-filter_complex', graph.join(';'), '-map', '[v]',
  ...(sound ? ['-map', `${cuts.length + 1}:a`, '-c:a', 'aac', '-b:a', '320k', '-ar', '48000'] : []),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-bf', '2',
  '-x264-params', 'aq-mode=3:aq-strength=0.9:deblock=-1,-1', '-r', String(FPS),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-t', String(end), '-movflags', '+faststart', out,
];
const done = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (done.status !== 0) throw new Error('ffmpeg could not make the film.');
console.log(out);
