/**
 * Reading a move for what it does beyond going from one square to another:
 * does it fork, pin, uncover an attack, or offer a piece? The room reacts to
 * these (style bible, 7.3), and the beginner aids name them.
 *
 * These are simple, strict tests on the position after the move. They are
 * meant to be right when they speak rather than to catch everything.
 */
import type { Chess, Color, PieceSymbol, Square } from 'chess.js';

export type Motif =
  /** The moved piece attacks two or more things that matter at once. */
  | { kind: 'fork'; by: Square; targets: Square[] }
  /** The moved piece holds `pinned` in place: if it moved, `behind` would be taken. */
  | { kind: 'pin'; by: Square; pinned: Square; behind: Square }
  /** Moving out of the way let the piece on `by` attack `target`. */
  | { kind: 'discovered'; by: Square; target: Square }
  /** The moved piece can be taken at a loss, and that looks deliberate. */
  | { kind: 'sacrifice'; piece: Square };

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const FILES = 'abcdefgh';
const ORTHOGONAL: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAGONAL: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const fileOf = (s: Square) => s.charCodeAt(0) - 97;
const rankOf = (s: Square) => s.charCodeAt(1) - 49;
const at = (file: number, rank: number): Square | null =>
  file < 0 || file > 7 || rank < 0 || rank > 7 ? null : ((FILES.charAt(file) + String(rank + 1)) as Square);

/** The first occupied square from `from` in a direction, or null if the edge comes first. */
function firstAlong(chess: Chess, from: Square, [df, dr]: [number, number]): Square | null {
  let f = fileOf(from) + df;
  let r = rankOf(from) + dr;
  for (let s = at(f, r); s; s = at((f += df), (r += dr))) if (chess.get(s)) return s;
  return null;
}

/** The directions a piece slides in. Empty for pieces that do not slide. */
function rays(type: PieceSymbol): [number, number][] {
  return type === 'r' ? ORTHOGONAL : type === 'b' ? DIAGONAL : type === 'q' ? [...ORTHOGONAL, ...DIAGONAL] : [];
}

export interface MoveFacts {
  from: Square;
  to: Square;
  /** What the move took, if anything. */
  captured: PieceSymbol | null;
  /** What the opponent stands to win, net, by taking on the square moved to. */
  exposure: number;
  inCheck: boolean;
}

/**
 * What the move just played did. `chess` is the position after it, with the other side to move.
 */
export function motifsOf(chess: Chess, move: MoveFacts): Motif[] {
  const motifs: Motif[] = [];
  const mover = chess.get(move.to);
  if (!mover) return motifs;
  const side: Color = mover.color;
  const other: Color = side === 'w' ? 'b' : 'w';
  const gained = move.captured ? VALUE[move.captured] : 0;
  const hanging = move.exposure > gained;

  // Fork: at least two targets, each a king, a piece worth more than the forker, or a loose piece.
  if (!hanging) {
    const targets: Square[] = [];
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const s = at(f, r)!;
        const p = chess.get(s);
        if (!p || p.color !== other || p.type === 'p') continue;
        if (!chess.attackers(s, side).includes(move.to)) continue;
        const loose = chess.attackers(s, other).length === 0;
        if (p.type === 'k' || VALUE[p.type] > VALUE[mover.type] || loose) targets.push(s);
      }
    }
    if (targets.length >= 2) motifs.push({ kind: 'fork', by: move.to, targets });
  }

  // Pin: along one of the mover's lines, an enemy piece with its king, or something dearer than both, behind it.
  for (const direction of rays(mover.type)) {
    const first = firstAlong(chess, move.to, direction);
    if (!first) continue;
    const front = chess.get(first)!;
    if (front.color !== other || front.type === 'k') continue;
    const second = firstAlong(chess, first, direction);
    if (!second) continue;
    const back = chess.get(second)!;
    if (back.color !== other) continue;
    const absolute = back.type === 'k';
    const relative = VALUE[back.type] > VALUE[front.type] && VALUE[back.type] > VALUE[mover.type];
    if ((absolute || relative) && !hanging) motifs.push({ kind: 'pin', by: move.to, pinned: first, behind: second });
  }

  // Discovered attack: a friendly slider that was looking at the square just left now sees through it.
  for (const direction of [...ORTHOGONAL, ...DIAGONAL]) {
    const behind = firstAlong(chess, move.from, [-direction[0], -direction[1]]);
    if (!behind || behind === move.to) continue;
    const slider = chess.get(behind)!;
    if (slider.color !== side || !rays(slider.type).some(([f, r]) => f === direction[0] && r === direction[1])) continue;
    const ahead = firstAlong(chess, move.from, direction);
    if (!ahead || ahead === move.to) continue;
    const target = chess.get(ahead)!;
    if (target.color !== other) continue;
    const worthIt = target.type === 'k' || VALUE[target.type] > VALUE[slider.type] || chess.attackers(ahead, other).length === 0;
    if (worthIt && target.type !== 'p') motifs.push({ kind: 'discovered', by: behind, target: ahead });
  }

  // Sacrifice: the piece can be taken at a real loss, and the move does something forcing in return.
  if (move.exposure - gained >= 2 && (move.inCheck || motifs.length > 0)) motifs.push({ kind: 'sacrifice', piece: move.to });

  return motifs;
}
