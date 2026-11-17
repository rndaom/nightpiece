import type React from 'react';
import { useCurrentFrame } from 'remotion';
import { STONES } from '../../../../src/ui/stones';
import { curveOf, hash, random, useBoil, wobble, type Point } from './boil';
import { clamp } from './motion';
import { C, display } from './theme';
import { interpolate } from 'remotion';

/** The game's emblem, a pawn whose head is a crescent moon, as the game draws it (src/ui/glyphs.tsx). */
export const EMBLEM = 'M31.9 16.1A8.8 8.8 0 1 1 23.2 4.4A7.1 7.1 0 1 0 31.9 16.1z M17.2 22.6h13.6v2.8H17.2z M20.4 26.4h7.2l3.8 10.8H16.6z M12.6 38.4h22.8v4.2H12.6z';

/** The game's line icons that the film uses (src/ui/glyphs.tsx), each in a 24 by 24 box. */
export const ICONS = {
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2 M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  match: 'M5 4.5l13.5 13.5 M19 4.5L5.5 18 M3.5 15l5.5 5.5 M20.5 15L15 20.5',
  engine: 'M7 7h10v10H7z M10 10h4v4h-4z M9.5 3.5V7 M14.5 3.5V7 M9.5 17v3.5 M14.5 17v3.5 M3.5 9.5H7 M3.5 14.5H7 M17 9.5h3.5 M17 14.5h3.5',
  book: 'M12 6.5C10 5 7 4.5 4 5v13.5c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z M12 6.5V20',
  eye: 'M2.5 12c2.6-4 5.8-6 9.5-6s6.9 2 9.5 6c-2.6 4-5.8 6-9.5 6s-6.9-2-9.5-6z M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 0 0-5 0z',
} as const;

export function Icon({ name, size, color = C.ink }: { name: keyof typeof ICONS; size: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ filter: 'url(#boil-fine)', overflow: 'visible' }}>
      <path d={ICONS[name]} fill="none" stroke={color} strokeWidth={2.1} strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

/** One of the game's stones, as its interface draws them. */
export function Stone({ kind, size, color = C.ink }: { kind: keyof typeof STONES; size: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ filter: 'url(#boil-fine)', overflow: 'visible' }}>
      <path d={STONES[kind]} fill={color} fillRule="evenodd" />
    </svg>
  );
}

/** A circle drawn by hand: not round, not closed quite where it began, and not the same twice. */
function ring(r: number, rough: number, seed: number): string {
  const rand = random(seed);
  const points: Point[] = [];
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.08;
    const rr = r + (rand() * 2 - 1) * rough;
    points.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return curveOf(points, true);
}

/** The seal: the emblem struck on a coin of paper, with an inked ring. `face` is the coin's colour. */
export function Seal({ size, face = C.paper, ink = C.ink, shadow = C.ink, id = 'seal' }: { size: number; face?: string; ink?: string; shadow?: string | null; id?: string }) {
  const step = useBoil(hash(id) % 6);
  const r = size / 2;
  const seed = hash(id);
  return (
    <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} style={{ overflow: 'visible' }}>
      {shadow ? <path d={ring(r * 0.98, r * 0.012, seed)} fill={shadow} transform={`translate(${size * 0.045} ${size * 0.055})`} /> : null}
      <path d={ring(r * 0.98, r * 0.012, seed)} fill={face} />
      <path d={ring(r * 0.98, r * 0.014, seed + step + 1)} fill="none" stroke={ink} strokeWidth={size * 0.022} />
      <path d={ring(r * 0.83, r * 0.014, seed + step + 50)} fill="none" stroke={ink} strokeWidth={size * 0.026} />
      <g transform={`translate(${-r * 0.78} ${-r * 0.8}) scale(${(size * 0.78) / 48})`} style={{ filter: 'url(#boil-fine)' }}>
        <path d={EMBLEM} fill={ink} />
      </g>
    </svg>
  );
}

/** The game's name as its title screen sets it: two words, one over the other, the second set in, heavy and a little askew, with two hard shadows. */
export function Wordmark({ size, color = C.ink, first = C.spirit, second = C.spiritDeep }: { size: number; color?: string; first?: string; second?: string }) {
  const a = size * 0.035;
  const b = size * 0.085;
  return (
    <div
      style={{
        ...display(144),
        fontSize: size,
        lineHeight: 0.8,
        letterSpacing: '-0.04em',
        color,
        textShadow: `${a}px ${a * 1.25}px 0 ${first}, ${b}px ${b * 1.2}px 0 ${second}`,
        display: 'grid',
        width: 'max-content',
        filter: 'url(#boil)',
        paddingBottom: size * 0.16,
        paddingRight: size * 0.12,
      }}
    >
      <span>Night</span>
      <span style={{ marginLeft: '0.66em' }}>piece</span>
    </div>
  );
}

/**
 * Short strokes thrown out from where something has just landed, for a few frames after frame
 * `at`: `points` are where they start, each with the way it points.
 */
export function Burst({ at, marks, color = C.ink, width = 5, length = 46, life = 14 }: { at: number; marks: { at: Point; angle: number; long?: number }[]; color?: string; width?: number; length?: number; life?: number }) {
  const frame = useCurrentFrame();
  const step = useBoil();
  if (frame < at || frame > at + life) return null;
  const u = (frame - at) / life;
  const out = interpolate(u, [0, 1], [0.15, 1], clamp) ** 0.5;
  const tail = interpolate(u, [0.25, 1], [0, 1], clamp);
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      {marks.map((m, i) => {
        const r = random(hash(`burst${i}`) + step);
        const len = length * (m.long ?? 1) * (0.8 + r() * 0.4);
        const rad = ((m.angle + (r() - 0.5) * 6) * Math.PI) / 180;
        const [dx, dy] = [Math.cos(rad), Math.sin(rad)];
        const from = 18 + len * 1.5 * tail;
        const to = 18 + len * 1.5 * out;
        if (to - from < 1) return null;
        return <line key={i} x1={m.at[0] + dx * from} y1={m.at[1] + dy * from} x2={m.at[0] + dx * to} y2={m.at[1] + dy * to} stroke={color} strokeWidth={width * (1 - u * 0.5)} strokeLinecap="round" />;
      })}
    </svg>
  );
}

/** Marks for a burst all round a rectangle lying at `x`, `y`: at its corners and along its sides, pointing away from its middle. */
export function around(x: number, y: number, w: number, h: number, each = 5): { at: Point; angle: number; long?: number }[] {
  const marks: { at: Point; angle: number; long?: number }[] = [];
  const [cx, cy] = [x + w / 2, y + h / 2];
  const push = (px: number, py: number, long = 1) => marks.push({ at: [px, py], angle: (Math.atan2((py - cy) / h, (px - cx) / w) * 180) / Math.PI, long });
  for (let i = 0; i <= each; i++) {
    push(x + (w * i) / each, y, i % 2 ? 0.7 : 1);
    push(x + (w * i) / each, y + h, i % 2 ? 0.7 : 1);
  }
  for (let i = 1; i < 3; i++) {
    push(x, y + (h * i) / 3, 0.8);
    push(x + w, y + (h * i) / 3, 0.8);
  }
  return marks;
}

/**
 * An arrow drawn by hand from `from` to `to`, bowing to one side, drawn on over `over` frames
 * from frame `at` and boiling after. For pointing at something in the picture.
 */
export function Arrow({ at, until, from, to, bow = 0.22, color = C.paper, width = 6, over = 12, shade = C.ink }: { at: number; until: number; from: Point; to: Point; bow?: number; color?: string; width?: number; over?: number; shade?: string | null }) {
  const frame = useCurrentFrame();
  const step = useBoil(3);
  if (frame < at || frame >= until) return null;
  const drawn = interpolate(frame, [at, at + over], [0, 1], clamp);
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const len = Math.hypot(dx, dy);
  const mid: Point = [from[0] + dx / 2 - dy * bow, from[1] + dy / 2 + dx * bow];
  const line = wobble([from, mid, to], 2.2, hash('arrow') + step, 40);
  line[0] = from;
  line[line.length - 1] = to;
  const d = curveOf(line);
  // The head: two strokes back from the point, along the way the line comes in.
  const back = Math.atan2(to[1] - mid[1], to[0] - mid[0]);
  const head = (turn: number): string => {
    const a = back + Math.PI + turn;
    const r = random(hash(`head${turn}`) + step);
    const l = Math.min(44, len * 0.3) * (0.9 + r() * 0.2);
    return `M${to[0]} ${to[1]}L${(to[0] + Math.cos(a) * l).toFixed(1)} ${(to[1] + Math.sin(a) * l).toFixed(1)}`;
  };
  const total = len * 1.25;
  const lines = (stroke: string, w: number, shift: number) => (
    <g transform={`translate(${shift} ${shift})`} fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} strokeDasharray={total} strokeDashoffset={total * (1 - drawn)} />
      {drawn >= 1 ? <path d={`${head(0.5)}${head(-0.5)}`} /> : null}
    </g>
  );
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
      {shade ? lines(shade, width + 5, 3) : null}
      {lines(color, width, 0)}
    </svg>
  );
}

/** A word written by hand beside an arrow: the display face, pale, with a dark edge so it reads over anything. */
export function Scrawl({ at, until, x, y, size = 54, tilt = -6, children }: { at: number; until: number; x: number; y: number; size?: number; tilt?: number; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  if (frame < at || frame >= until) return null;
  const k = interpolate(frame, [at, at + 6], [0, 1], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        ...display(72),
        fontStyle: 'italic',
        fontSize: size,
        color: C.paper,
        WebkitTextStroke: `${size * 0.16}px ${C.ink}`,
        paintOrder: 'stroke fill',
        transform: `rotate(${tilt}deg) scale(${0.8 + 0.2 * k})`,
        transformOrigin: '0 50%',
        opacity: k,
        filter: 'url(#boil)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}
