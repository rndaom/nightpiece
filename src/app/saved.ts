/**
 * The game being played, kept in the browser so that closing the page does
 * not lose it. One game is kept: the last one at this screen (two players,
 * or one against the computer) in which a move has been made and which has
 * not ended. Online games are kept by the server, and lessons start over.
 */
import { Game, type Side } from '../core/game';
import { LEVELS } from '../engine/uci';
import type { MoveData } from '../net/protocol';
import { readStored, storageKey } from './brand';

const SLOT = 'game.v1';
/** More moves than any real game has. A record longer than this is not one of ours. */
const LONGEST = 1200;

export interface SavedGame {
  kind: 'table' | 'computer';
  /** Against the computer: how strongly it plays, which side the player has, and how they asked for it (a side, or by lot). */
  level?: string;
  side?: Side;
  asked?: Side | 'either';
  /** The position the game began from, and every move since. */
  startFen: string;
  moves: MoveData[];
  /** Which side of the board the player was sitting at. */
  seat: Side;
  /** When it was last played: milliseconds since 1970. */
  at: number;
}

/** What the choice of game says about a kept game. */
export interface SavedSummary {
  kind: 'table' | 'computer';
  level?: string;
  side?: Side;
  /** How many moves each side has made, counting one still to be answered. */
  moves: number;
  at: number;
}

const isSide = (x: unknown): x is Side => x === 'w' || x === 'b';

function isMove(m: unknown): m is MoveData {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  const square = (x: unknown) => typeof x === 'string' && /^[a-h][1-8]$/.test(x);
  return square(o.from) && square(o.to) && (o.promotion === undefined || (typeof o.promotion === 'string' && /^[qrbn]$/.test(o.promotion)));
}

/**
 * The kept game, if there is one that can be carried on. Whatever is stored is checked by
 * playing it through: a record that cannot be read, has no moves or has already ended is not
 * a game to go back to, and is thrown away.
 */
export function readSavedGame(storage: Storage): SavedGame | null {
  let raw: string | null;
  try {
    raw = readStored(storage, SLOT);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<SavedGame>;
    if (o.kind !== 'table' && o.kind !== 'computer') throw new Error('kind');
    if (typeof o.startFen !== 'string' || !Array.isArray(o.moves) || o.moves.length === 0 || o.moves.length > LONGEST || !o.moves.every(isMove)) throw new Error('record');
    const game = new Game(o.startFen);
    for (const m of o.moves) game.move(m.from, m.to, m.promotion);
    if (game.status().over) throw new Error('over');
    const saved: SavedGame = {
      kind: o.kind,
      startFen: game.startFen(),
      moves: o.moves.map((m) => ({ from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}) })),
      seat: isSide(o.seat) ? o.seat : 'w',
      at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
    };
    if (o.kind === 'computer') {
      saved.level = LEVELS.some((l) => l.id === o.level) ? o.level! : 'casual';
      saved.side = isSide(o.side) ? o.side : 'w';
      saved.asked = isSide(o.asked) || o.asked === 'either' ? o.asked : saved.side;
    }
    return saved;
  } catch {
    clearSavedGame(storage);
    return null;
  }
}

export function writeSavedGame(storage: Storage, game: SavedGame): void {
  try {
    storage.setItem(storageKey(SLOT), JSON.stringify(game));
  } catch {
    // Storage can be unavailable (private windows, blocked site data). The game is then simply not kept.
  }
}

export function clearSavedGame(storage: Storage): void {
  try {
    storage.removeItem(storageKey(SLOT));
  } catch {
    // See writeSavedGame.
  }
}

export function summarise(game: SavedGame | null): SavedSummary | null {
  if (!game) return null;
  return {
    kind: game.kind,
    ...(game.level ? { level: game.level } : {}),
    ...(game.side ? { side: game.side } : {}),
    moves: Math.ceil(game.moves.length / 2),
    at: game.at,
  };
}
