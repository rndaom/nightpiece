/**
 * Plain words for the interface: what a move did, said as a person at the
 * board would say it, and what each stone is and does. Text only; it draws
 * nothing and can be tested by itself.
 */
import { VALUE, type Kind, type MoveEvent, type Side } from '../core/game';
import type { VerdictKind } from '../engine/verdict';

export const SIDE: Record<Side, string> = { w: 'Ivory', b: 'Void' };
export const KIND: Record<Kind, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** How each stone moves, in one line, for someone still learning them. */
export const HOW: Record<Kind, string> = {
  p: 'One square forward (two on its first move). Takes one square diagonally.',
  n: 'An L: two squares one way, then one to the side. The only stone that jumps.',
  b: 'Any distance along a diagonal. It never leaves its colour of square.',
  r: 'Any distance in a straight line, forward, back or sideways.',
  q: 'Any distance in any straight line or diagonal. The strongest stone.',
  k: 'One square in any direction. Lose him and the game is lost.',
};

/** What a stone is worth, in pawns. The king is beyond price. */
export function worth(kind: Kind): string {
  if (kind === 'k') return 'The game itself';
  const pawns = VALUE[kind];
  return pawns === 1 ? 'Worth 1 pawn' : `Worth ${pawns} pawns`;
}

/** A move with its number, as a record writes it: "12. Nf3", "12… Nf6". `ply` counts from 1; `start` is how the game began. */
export function numbered(ply: number, e: MoveEvent, start: { side: Side; moveNumber: number }): string {
  const number = start.moveNumber + Math.floor((ply - 1 + (start.side === 'b' ? 1 : 0)) / 2);
  return `${number}${e.side === 'w' ? '.' : '…'} ${e.san}`;
}

/** One move in plain words: "Ivory knight takes the pawn on e5." */
export function sayMove(e: MoveEvent): string {
  const who = SIDE[e.side];
  let text: string;
  if (e.castle) {
    text = `${who} castles on the ${e.castle === 'k' ? "king's" : "queen's"} side`;
  } else {
    const mover = e.promotion ? 'pawn' : KIND[e.piece.kind];
    if (e.captured) {
      text = `${who} ${mover} takes the ${KIND[e.captured.kind]} on ${e.captured.square}`;
      if (e.enPassant) text += ' in passing';
    } else {
      text = `${who} ${mover} to ${e.piece.to}`;
    }
    if (e.promotion) text += ` and becomes a ${KIND[e.promotion]}`;
  }
  if (e.status.result === 'checkmate') return `${text}. Checkmate.`;
  if (e.status.result === 'draw') return `${text}. A draw.`;
  if (e.status.inCheck) return `${text}. Check.`;
  return `${text}.`;
}

/** The mark a judged move carries in the record, as chess books write it. */
export const VERDICT_MARK: Record<VerdictKind, string> = { strong: '!', sound: '', slip: '?', blunder: '??' };
/** The same, as a word. */
export const VERDICT_WORD: Record<VerdictKind, string> = { strong: 'Strong', sound: '', slip: 'A slip', blunder: 'Blunder' };

/**
 * What stops play for a moment and is called out over the board: the events a beginner should
 * not miss. Null for an ordinary move.
 */
export function callOut(e: MoveEvent): { word: string; tone: 'alert' | 'end' | 'plain' } | null {
  if (e.status.result === 'checkmate') return { word: 'Checkmate', tone: 'end' };
  if (e.status.result === 'draw') return { word: e.status.drawReason === 'stalemate' ? 'Stalemate' : 'Draw', tone: 'end' };
  if (e.status.inCheck) return { word: 'Check', tone: 'alert' };
  if (e.promotion) return { word: `A new ${KIND[e.promotion]}`, tone: 'plain' };
  if (e.castle) return { word: 'Castled', tone: 'plain' };
  if (e.enPassant) return { word: 'Taken in passing', tone: 'plain' };
  return null;
}

/** The material each side has taken, in pawns, and who is ahead by how much. */
export function material(lost: Record<Side, Kind[]>): { taken: Record<Side, number>; lead: Side | null; by: number } {
  const sum = (kinds: Kind[]) => kinds.reduce((total, k) => total + (k === 'k' ? 0 : VALUE[k]), 0);
  // What Ivory has taken is what Void has lost, and the other way about.
  const taken = { w: sum(lost.b), b: sum(lost.w) };
  const by = Math.abs(taken.w - taken.b);
  return { taken, lead: by === 0 ? null : taken.w > taken.b ? 'w' : 'b', by };
}
