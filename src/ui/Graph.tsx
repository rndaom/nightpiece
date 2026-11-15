/**
 * How the game went, drawn: who was ahead after each move. Ivory's lead
 * rises above the middle line in cream and Void's falls below it in spirit
 * green; a dot marks each move the engine thought strong, a slip or a
 * blunder. Any point can be pressed to look at the board as it stood then.
 */
import { useMemo } from 'preact/hooks';
import type { App } from '../app/app';
import { ui } from '../app/store';
import { Game } from '../core/game';
import { course } from '../learn/story';
import { numbered, VERDICT_WORD } from './words';

/** The same curve as the scales at the top of the screen: a pawn or two shows, a rout fills the height. */
const share = (cp: number) => Math.tanh(cp / 420);

export function Graph({ app, width = 300, height = 60 }: { app: App; width?: number; height?: number }) {
  const history = ui.history.value;
  // Read so that the graph is drawn again when the engine's opinion of a move arrives.
  const appraised = ui.appraised.value;
  const viewing = ui.viewing.value;
  const begin = ui.start.value;
  const startFen = app.game.startFen();
  const start = useMemo(() => new Game(startFen).pieces(), [startFen]);
  const points = useMemo(() => course(start, history, (e) => app.verdicts.get(e)), [start, history, appraised]);
  const n = history.length;
  if (n < 2) return null;

  const mid = height / 2;
  const reach = mid - 4;
  const x = (ply: number) => (ply / n) * width;
  const y = (cp: number) => mid - share(cp) * reach;

  // The line, with a point added wherever it crosses the middle, so that each side's part of it can be filled by itself.
  const outline: [number, number][] = [];
  for (const p of points) {
    const here: [number, number] = [x(p.ply), y(p.cp)];
    const last = outline[outline.length - 1];
    if (last && (last[1] - mid) * (here[1] - mid) < 0) {
      const t = (mid - last[1]) / (here[1] - last[1]);
      outline.push([last[0] + t * (here[0] - last[0]), mid]);
    }
    outline.push(here);
  }
  const filled = (keep: (v: number) => number) => `${outline.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${keep(py).toFixed(1)}`).join('')}L${width} ${mid}L0 ${mid}Z`;

  return (
    <svg class="graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Who was ahead after each move: Ivory above the line, Void below it.">
      <path class="graph-w" d={filled((v) => Math.min(v, mid))} />
      <path class="graph-b" d={filled((v) => Math.max(v, mid))} />
      <line class="graph-mid" x1="0" y1={mid} x2={width} y2={mid} />
      {points.map((p) =>
        p.kind && p.kind !== 'sound' ? <circle key={p.ply} class={`dot dot-${p.kind}`} cx={x(p.ply).toFixed(1)} cy={y(p.cp).toFixed(1)} r={p.kind === 'blunder' ? 3.4 : 2.8} /> : null,
      )}
      {viewing === null ? null : <line class="graph-at" x1={x(viewing)} y1="0" x2={x(viewing)} y2={height} />}
      {points.map((p) => {
        const e = history[p.ply - 1];
        const left = Math.max(0, x(p.ply - 0.5));
        const word = p.kind ? VERDICT_WORD[p.kind] : '';
        return (
          <rect key={p.ply} x={left.toFixed(1)} y="0" width={(Math.min(width, x(p.ply + 0.5)) - left).toFixed(1)} height={height} onClick={() => app.view(p.ply)}>
            <title>{e ? `${numbered(p.ply, e, begin)}${word ? ` · ${word}` : ''}` : 'Before the first move'}</title>
          </rect>
        );
      })}
    </svg>
  );
}
