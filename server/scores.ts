/**
 * Who has played ranked games, and how they stand.
 *
 * There are no accounts. A browser makes a secret for itself and says it at
 * the door; the server knows a player only by a hash of that secret, so
 * nothing kept here would let anyone else sit down as them.
 *
 * The whole table is one small JSON file, written a moment after it changes.
 * Without a file to write to, it lasts as long as the server does.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { PlayerCard } from '../src/net/protocol.ts';
import { writeWhole } from './store.ts';

/** Where everyone starts. */
export const START_RATING = 1200;
/** How far one game can move a rating. */
const K = 32;
/** How many players are remembered. Past this, those who have played least and longest ago are forgotten. */
const MAX_PLAYERS = 20000;
/**
 * How many visitors who have said hello but never finished a ranked game are remembered (their
 * names, while they look for or play their first game). Past this, the one not seen longest is
 * forgotten first. Saying hello is free, so this has to have an end.
 */
const MAX_VISITORS = 5000;
/**
 * How long, and how many, finished ranked games are remembered by their own names, so that one
 * written down with its room before the scores were written is counted when the server starts
 * again, and never twice. Rooms are long gone well within this.
 */
const COUNTED_FOR = 2 * 24 * 60 * 60 * 1000;
const MOST_COUNTED = 20000;
/** Written under this name in the file, beside the players (whose names are all hexadecimal, so an older server passes it over). */
const COUNTED = 'counted';
/** How long after a write that failed (a full disk, say) it is tried again. */
const RETRY_WRITE = 5000;
/** How many ranked games a player must have finished to be listed among the best. */
export const LISTED_AFTER = 3;

interface Entry extends PlayerCard {
  /** When they last played or said hello, in milliseconds. */
  seen: number;
}

/** The name the server knows a browser by: a hash of its secret. */
export function playerKey(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

const ADJECTIVES = ['Quiet', 'Pale', 'Hollow', 'Gilded', 'Ashen', 'Patient', 'Sleepless', 'Velvet', 'Crooked', 'Solemn', 'Wandering', 'Lantern'];
const NOUNS = ['Rook', 'Bishop', 'Knight', 'Pawn', 'Moth', 'Candle', 'Hand', 'Raven', 'Bell', 'Thread', 'Ember', 'Vigil'];

/** A name for someone who has not given one, the same every time for the same player. */
export function nameFor(key: string): string {
  const a = Number.parseInt(key.slice(0, 4), 16);
  const b = Number.parseInt(key.slice(4, 8), 16);
  return `${ADJECTIVES[a % ADJECTIVES.length]} ${NOUNS[b % NOUNS.length]}`;
}

export class Scores {
  /** Those who have finished at least one ranked game. These are kept, and written to the file. */
  private players = new Map<string, Entry>();
  /** Those who have only said hello, the one seen longest ago first. */
  private visitors = new Map<string, Entry>();
  /** The best players as last worked out, and whether a game counted since has made that stale. */
  private best: PlayerCard[] = [];
  private bestStale = true;
  private writing: ReturnType<typeof setTimeout> | null = null;
  /** Finished ranked games by their own names, and when they were counted. */
  private counted = new Map<string, number>();

  /** `file` is where the table is kept. Left out, nothing is written. */
  constructor(
    private file: string | null = null,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // No file yet: the table starts empty.
      return;
    }
    try {
      const data: unknown = JSON.parse(text);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not a table of players');
      const counted = (data as Record<string, unknown>)[COUNTED];
      if (typeof counted === 'object' && counted !== null) {
        for (const [game, at] of Object.entries(counted)) if (typeof at === 'number') this.counted.set(game, at);
      }
      for (const [key, value] of Object.entries(data as Record<string, Partial<Entry>>)) {
        if (!/^[0-9a-f]{32}$/.test(key) || typeof value !== 'object' || value === null) continue;
        const n = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
        // Only those who have played are kept (a file from an older server may hold others too).
        if (n(value.wins, 0) + n(value.losses, 0) + n(value.draws, 0) <= 0) continue;
        this.players.set(key, {
          name: typeof value.name === 'string' && value.name ? value.name : nameFor(key),
          rating: n(value.rating, START_RATING),
          wins: n(value.wins, 0),
          losses: n(value.losses, 0),
          draws: n(value.draws, 0),
          seen: n(value.seen, 0),
        });
      }
    } catch (error) {
      // A file that is there and cannot be understood is put aside, not written over: the table
      // starts empty, and what was in the file can still be looked at and mended by hand.
      this.players.clear();
      this.counted.clear();
      const aside = `${file}.damaged-${this.now()}`;
      try {
        renameSync(file, aside);
        console.error(`The scores in ${file} could not be read, and have been put aside as ${aside}:`, error);
      } catch (moving) {
        console.error(`The scores in ${file} could not be read, nor put aside; they will be written over:`, error, moving);
      }
    }
  }

  /** The player with this key, made if they are new. A name given replaces the one they had. */
  greet(key: string, name?: string): PlayerCard {
    let entry = this.players.get(key);
    if (entry) {
      if (name && name !== entry.name) {
        entry.name = name;
        // A changed name of someone who has played is worth a write, and may change the list of the best.
        this.bestStale = true;
        this.saveSoon();
      }
      entry.seen = this.now();
      return card(entry);
    }
    entry = this.visitors.get(key);
    if (entry) {
      // Seen again: to the back of the line, furthest from being forgotten.
      this.visitors.delete(key);
      if (name) entry.name = name;
      entry.seen = this.now();
    } else {
      entry = { name: name || nameFor(key), rating: START_RATING, wins: 0, losses: 0, draws: 0, seen: this.now() };
    }
    this.visitors.set(key, entry);
    // Someone who has only said hello is not worth a write, nor worth keeping for ever.
    for (const oldest of this.visitors.keys()) {
      if (this.visitors.size <= MAX_VISITORS) break;
      this.visitors.delete(oldest);
    }
    return card(entry);
  }

  get(key: string): PlayerCard | null {
    const entry = this.players.get(key) ?? this.visitors.get(key);
    return entry ? card(entry) : null;
  }

  /** How many are remembered: those who have played, and visitors who have not yet. */
  get size(): { players: number; visitors: number } {
    return { players: this.players.size, visitors: this.visitors.size };
  }

  /**
   * Record a finished game between two players. Returns what it did to each rating. A player
   * forgotten since they sat down (a visitor pushed out by many others) is counted from the start.
   * `game`, the game's own name, is remembered, so that it is never counted again (see `settle`).
   */
  record(white: string, black: string, winner: 'w' | 'b' | null, game?: string): { w: number; b: number } {
    if (white === black) return { w: 0, b: 0 };
    const w = this.keep(white);
    const b = this.keep(black);
    const expected = 1 / (1 + 10 ** ((b.rating - w.rating) / 400));
    const scored = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
    const delta = Math.round(K * (scored - expected));
    this.count(w, b, winner, { w: delta, b: 0 - delta }, game);
    return { w: delta, b: 0 - delta };
  }

  /**
   * A game counted by the server that ran before, whose count may not have reached the file before
   * it stopped: counted now, by the change it was given then, unless it is already. Returns whether it was.
   */
  settle(game: string, white: string, black: string, winner: 'w' | 'b' | null, change: { w: number; b: number }): boolean {
    if (white === black || this.counted.has(game)) return false;
    this.count(this.keep(white), this.keep(black), winner, change, game);
    return true;
  }

  private count(w: Entry, b: Entry, winner: 'w' | 'b' | null, change: { w: number; b: number }, game?: string): void {
    w.rating += change.w;
    b.rating += change.b;
    if (game) {
      const now = this.now();
      this.counted.set(game, now);
      for (const [old, at] of this.counted) {
        if (this.counted.size <= MOST_COUNTED && now - at < COUNTED_FOR) break;
        this.counted.delete(old);
      }
    }
    if (winner === null) {
      w.draws++;
      b.draws++;
    } else {
      (winner === 'w' ? w : b).wins++;
      (winner === 'w' ? b : w).losses++;
    }
    w.seen = b.seen = this.now();
    this.bestStale = true;
    this.forgetSome(w, b);
    this.saveSoon();
  }

  /** A player about to have a game counted: among those kept from now on, and made if they had been forgotten. */
  private keep(key: string): Entry {
    let entry = this.players.get(key);
    if (entry) return entry;
    entry = this.visitors.get(key) ?? { name: nameFor(key), rating: START_RATING, wins: 0, losses: 0, draws: 0, seen: this.now() };
    this.visitors.delete(key);
    this.players.set(key, entry);
    return entry;
  }

  /**
   * The best players who have finished at least `LISTED_AFTER` ranked games (fewer is not enough to
   * say how good anyone is). Worked out again only after a game has been counted, not for every asking.
   */
  top(count: number): PlayerCard[] {
    if (this.bestStale || this.best.length < count) {
      this.best = [...this.players.values()]
        .filter((p) => p.wins + p.losses + p.draws >= LISTED_AFTER)
        .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
        .slice(0, Math.max(count, 20))
        .map(card);
      this.bestStale = false;
    }
    return this.best.slice(0, count);
  }

  /** Write the table now, if there is anything waiting to be written. */
  flush(): void {
    if (this.writing === null) return;
    clearTimeout(this.writing);
    this.writing = null;
    this.write();
  }

  private saveSoon(): void {
    if (!this.file || this.writing !== null) return;
    this.writing = setTimeout(() => {
      this.writing = null;
      this.write();
    }, 2000);
    // A write that is waiting must not keep the server from stopping.
    this.writing.unref?.();
  }

  private write(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      // Only those who have played are kept: a visitor who never finished a game leaves nothing behind.
      const kept = [...this.players].filter(([, p]) => p.wins + p.losses + p.draws > 0);
      // Written beside the file and then moved over it, so that a stop part of the way through leaves the old one whole.
      const beside = `${this.file}.tmp`;
      writeWhole(beside, JSON.stringify({ ...Object.fromEntries(kept), [COUNTED]: Object.fromEntries(this.counted) }));
      renameSync(beside, this.file);
    } catch (error) {
      console.error('The scores could not be written; they will be tried again:', error);
      // Tried again a little later, until it works; a stop in the meantime tries once more (`flush`).
      if (this.writing === null) {
        this.writing = setTimeout(() => {
          this.writing = null;
          this.write();
        }, RETRY_WRITE);
        this.writing.unref?.();
      }
    }
  }

  /**
   * Past the most that are kept, forget those who have played least, and longest ago. Only players
   * are here: a visitor never pushes out someone who has played. The two whose game has just been
   * counted stay, however few games they have.
   */
  private forgetSome(...staying: Entry[]): void {
    if (this.players.size <= MAX_PLAYERS) return;
    const idle = [...this.players].filter(([, p]) => !staying.includes(p)).sort(([, a], [, b]) => a.wins + a.losses + a.draws - (b.wins + b.losses + b.draws) || a.seen - b.seen);
    for (const [key] of idle.slice(0, MAX_PLAYERS / 10)) this.players.delete(key);
    this.bestStale = true;
  }
}

function card(entry: Entry): PlayerCard {
  return { name: entry.name, rating: entry.rating, wins: entry.wins, losses: entry.losses, draws: entry.draws };
}
