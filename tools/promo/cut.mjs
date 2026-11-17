/**
 * Development only. Makes the finished files from one of the films as it was drawn (film/render.mjs)
 * and its sound (mix.mjs): the film at its full size, a smaller copy for sharing, and a still.
 *
 *   node tools/promo/cut.mjs --cut game [--film tmp/promo/game.mov] [--sound tmp/promo/sound/game/film.wav] [--out promo/nightpiece-game] [--still 2600]
 *
 * Writes <out>-2160p60.mp4, <out>-1080p60.mp4 and <out>-poster.jpg (the frame `--still` names).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { FPS, REELS } from './film/src/timeline.ts';

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const reel = REELS[arg('cut', 'game')];
if (!reel) throw new Error(`No such film. There are: ${Object.keys(REELS).join(', ')}`);
const film = arg('film', `tmp/promo/${reel.id}.mov`);
const sound = arg('sound', `tmp/promo/sound/${reel.id}/film.wav`);
const out = arg('out', `promo/nightpiece-${reel.id}`);
const still = Number(arg('still', String(reel.end.to - 30)));

function ffmpeg(args) {
  const done = spawnSync('ffmpeg', ['-v', 'error', '-stats', '-y', ...args], { stdio: 'inherit' });
  if (done.status !== 0) throw new Error('ffmpeg could not make the file.');
}

mkdirSync(path.dirname(out), { recursive: true });
const picture = (height, crf) => [
  '-vf', `scale=-2:${height}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709,format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-bf', '2',
  '-x264-params', 'aq-mode=3:aq-strength=0.9:deblock=-1,-1', '-r', String(FPS),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
];
for (const [height, crf] of [[2160, 15], [1080, 17]]) {
  const file = `${out}-${height}p60.mp4`;
  ffmpeg(['-i', film, '-i', sound, '-map', '0:v', '-map', '1:a', ...picture(height, crf), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-shortest', '-movflags', '+faststart', file]);
  console.log(file);
}
ffmpeg(['-ss', (still / FPS).toFixed(4), '-i', film, '-frames:v', '1', '-vf', 'scale=in_color_matrix=bt709:out_range=pc,format=yuvj444p', '-q:v', '2', `${out}-poster.jpg`]);
console.log(`${out}-poster.jpg`);
