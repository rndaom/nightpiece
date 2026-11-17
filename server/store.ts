/**
 * The games being played, written down as they go, so that a restart of the server (a new
 * version put up, or a crash) ends none of them.
 *
 * Two files, side by side:
 * - `rooms.json`: every room worth keeping as it stood at one moment, a checkpoint. It is written
 *   beside itself and moved over the old one, so that it is always whole.
 * - `rooms.journal`: a line for each change since that checkpoint, added to the end before anyone
 *   is told of the change. Its first line names the checkpoint it follows, so a journal left over
 *   from before the checkpoint now on the disk is known for what it is and not read.
 *
 * A change to a room is written as the whole room, except a move (or a few) played on, which is
 * written as the moves and the few things beside them that changed: a long game is not written out
 * again with every move. Such a line names how many moves it follows, and is taken up only if the
 * room it is laid over has that many.
 *
 * To read them back is to take the checkpoint and lay each line of the journal over it, the last
 * word on each room winning. A line cut short by a crash is passed over. A checkpoint is written
 * every so often (and when the server stops), and the journal starts again empty after it.
 */
import { closeSync, fdatasync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { MoveData } from '../src/net/protocol.ts';
import type { RoomChange, SavedGone, SavedRoom, SavedRooms } from './rooms.ts';

/** A line of the journal (each also carries `at`, when it was written): a room played on by some moves, with whatever else of it changed. */
interface Step {
  at: number;
  step: string;
  ply: number;
  add: MoveData[];
  set: Partial<SavedRoom>;
}

/** Say to whoever runs the server that the rooms could not be written or read: each kind of trouble at once the first time, and then not more than once a minute. */
const reportedAt = new Map<string, number>();
function report(what: string, error: unknown): void {
  const now = Date.now();
  if (now - (reportedAt.get(what) ?? Number.NEGATIVE_INFINITY) < 60000) return;
  reportedAt.set(what, now);
  console.error(`${what}: ${error instanceof Error ? error.message : 'unknown error'}. Games being played may not survive a restart until this is put right.`.replace(/\s+/g, ' ').slice(0, 400));
}

const sameMove = (a: MoveData, b: MoveData) => a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);

export class RoomStore {
  readonly journalFile: string;
  /** Which checkpoint is on the disk. */
  private epoch = 0;
  /** The journal, open to be added to, once a checkpoint has been written. */
  private fd: number | null = null;
  /**
   * Each room written down, as it was last written: so that one touched but not changed is not
   * written again, and a move played on is written as only the move. Null for a room on the disk
   * whose last word is not known for certain (a write failed part of the way): it is written whole.
   */
  private written = new Map<string, SavedRoom | null>();
  /** How much the journal holds of changes since the checkpoint (not counting words that the server is still running). */
  private size = 0;
  private unsynced = false;
  /** A write has failed: the journal may end in part of a line, and should be begun again as soon as it can be. */
  private damaged = false;
  private closed = false;

  constructor(readonly file: string) {
    this.journalFile = path.join(path.dirname(file), `${path.basename(file, '.json')}.journal`);
  }

  /** How many bytes of changes the journal holds since the last checkpoint. */
  get bytes(): number {
    return this.size;
  }

  /** Whether changes cannot be written as they are made just now (no journal open, or a write has failed), so that a checkpoint is wanted as soon as one can be made. */
  get wanting(): boolean {
    return !this.closed && (this.fd === null || this.damaged);
  }

  /**
   * The rooms as the last server left them: its checkpoint with its journal laid over it. Null if
   * there is nothing to read. `savedAt` is the last moment that server is known to have been running.
   */
  load(): SavedRooms | null {
    let saved: SavedRooms | null = null;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as SavedRooms;
      if (data?.version === 1 && Array.isArray(data.rooms)) saved = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') report('The saved rooms could not be read', error);
    }
    const epoch = typeof saved?.epoch === 'number' ? saved.epoch : 0;
    this.epoch = epoch;
    let text = '';
    try {
      text = readFileSync(this.journalFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') report('The journal of the rooms could not be read', error);
    }
    const lines = text.split('\n');
    let head: { epoch?: unknown } | null = null;
    try {
      head = lines[0] ? (JSON.parse(lines[0]) as { epoch?: unknown }) : null;
    } catch {
      // Not even its first line was written whole: there is nothing in it.
    }
    // A journal that follows another checkpoint (one written before the checkpoint on the disk, the
    // server stopping before the journal could be begun again) holds nothing that is not in it.
    if (head?.epoch !== epoch) return saved;
    const rooms = new Map<string, SavedRoom>((saved?.rooms ?? []).map((r) => [r.name, r]));
    const gone = new Map<string, SavedGone>(saved?.gone ?? []);
    const pairs = new Map<string, number[]>(saved?.pairs ?? []);
    const strikes = new Map<string, number[]>(saved?.strikes ?? []);
    const banned = new Map<string, number>(saved?.banned ?? []);
    /** Rooms whose moves did not follow on: what is said of them after, move by move, cannot be laid over them either. */
    const broken = new Set<string>();
    let at = Number(saved?.savedAt) || 0;
    for (const raw of lines.slice(1)) {
      if (!raw) continue;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Cut short by a crash as it was being written: it was never acted on.
        continue;
      }
      if (!line || typeof line !== 'object' || typeof line.at !== 'number') continue;
      at = Math.max(at, line.at);
      if (typeof line.put === 'object' && line.put && typeof (line.put as SavedRoom).name === 'string') {
        const put = line.put as SavedRoom;
        rooms.set(put.name, put);
        gone.delete(put.name);
        broken.delete(put.name);
      } else if (typeof line.step === 'string') {
        const step = line as unknown as Step;
        const room = rooms.get(step.step);
        if (!room || broken.has(step.step) || room.moves.length !== step.ply || !Array.isArray(step.add)) {
          broken.add(step.step);
          report('A move written down did not follow on from the game it was for, and was passed over', new Error(`room ${step.step}`));
          continue;
        }
        rooms.set(step.step, { ...room, ...step.set, moves: [...room.moves, ...step.add] });
      } else if (typeof line.drop === 'string') {
        rooms.delete(line.drop);
        broken.delete(line.drop);
        if (line.gone) gone.set(line.drop, line.gone as SavedGone);
      } else if (typeof line.pair === 'string' && Array.isArray(line.times)) {
        pairs.set(line.pair, line.times as number[]);
      } else if (typeof line.strike === 'string' && Array.isArray(line.times)) {
        strikes.set(line.strike, line.times as number[]);
        if (typeof line.until === 'number') banned.set(line.strike, line.until);
        else banned.delete(line.strike);
      }
    }
    return { ...(saved ?? {}), version: 1, savedAt: at, rooms: [...rooms.values()], gone: [...gone], pairs: [...pairs], strikes: [...strikes], banned: [...banned], epoch };
  }

  /**
   * Write down what has changed, before anyone is told of it. A room that has not really changed
   * since it was last written is left out, and one only played on is written as its new moves.
   * Written to the system at once: a crash of the server after this loses nothing, and what the
   * machine has not yet put on its disk follows within a couple of seconds (`sync`).
   */
  write(changes: RoomChange[], at: number): void {
    if (this.fd === null || this.closed || changes.length === 0) return;
    let out = '';
    const now = new Map<string, SavedRoom | null>();
    const forgotten = new Set<string>();
    const last = (name: string) => (now.has(name) ? now.get(name) : forgotten.has(name) ? undefined : this.written.get(name));
    for (const change of changes) {
      if ('put' in change) {
        const room = change.put;
        const was = last(room.name);
        const line = was ? this.step(was, room, at) : `{"at":${at},"put":${JSON.stringify(room)}}\n`;
        if (line) out += line;
        now.set(room.name, room);
        forgotten.delete(room.name);
      } else if ('drop' in change) {
        if (last(change.drop) === undefined && !change.gone) continue;
        out += `${JSON.stringify({ at, drop: change.drop, ...(change.gone ? { gone: change.gone } : {}) })}\n`;
        now.delete(change.drop);
        forgotten.add(change.drop);
      } else {
        out += `${JSON.stringify({ at, ...change })}\n`;
      }
    }
    if (!out) return;
    if (!this.append(out)) return;
    this.size += Buffer.byteLength(out);
    // Only once it is written is it what was last written.
    for (const name of forgotten) this.written.delete(name);
    for (const [name, room] of now) this.written.set(name, room);
  }

  /** The line that takes a room from how it was last written to how it is: nothing if it has not changed, its new moves if it has been played on, or the whole room. */
  private step(was: SavedRoom, room: SavedRoom, at: number): string | null {
    const ply = was.moves.length;
    const on = room.moves.length >= ply && room.startFen === was.startFen && was.moves.every((m, i) => sameMove(m, room.moves[i]!));
    if (!on) return `{"at":${at},"put":${JSON.stringify(room)}}\n`;
    const set: Record<string, unknown> = {};
    for (const key of Object.keys(room) as (keyof SavedRoom)[]) {
      if (key === 'moves' || key === 'name') continue;
      const text = JSON.stringify(room[key]);
      if (text !== JSON.stringify(was[key])) set[key] = room[key] ?? null;
    }
    // A field the room no longer has at all, written as nothing.
    for (const key of Object.keys(was) as (keyof SavedRoom)[]) if (!(key in room)) set[key] = null;
    const add = room.moves.slice(ply);
    if (add.length === 0 && Object.keys(set).length === 0) return null;
    return `${JSON.stringify({ at, step: room.name, ply, add, set })}\n`;
  }

  /** Say that the server is still running, so that a clock left running at a crash is charged up to about then and no further. */
  alive(at: number): void {
    if (this.fd === null || this.closed) return;
    // Not a change: it does not bring on a checkpoint.
    this.append(`{"at":${at}}\n`);
  }

  /** Have the machine put what has been written on its disk, without waiting for it. */
  sync(): void {
    if (this.fd === null || !this.unsynced) return;
    this.unsynced = false;
    fdatasync(this.fd, () => {});
  }

  /**
   * Write every room down afresh, and begin the journal again empty. Both are written beside their
   * files and forced to the disk first, the checkpoint is moved over the old one, then the new
   * journal over the old: a stop at any point leaves a checkpoint whole and either its own journal
   * or one the checkpoint is known not to follow. If anything fails, the old checkpoint and its
   * journal stand, and changes go on being added to that journal. Returns whether it was written.
   */
  checkpoint(saved: SavedRooms): boolean {
    if (this.closed) return false;
    const epoch = this.epoch + 1;
    const beside = `${this.file}.tmp`;
    const journalBeside = `${this.journalFile}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeWhole(beside, JSON.stringify({ ...saved, epoch }));
      writeWhole(journalBeside, `${JSON.stringify({ epoch })}\n`);
      renameSync(beside, this.file);
    } catch (error) {
      report('The rooms could not be written', error);
      return false;
    }
    // The checkpoint stands from here, whatever happens to the journal.
    this.epoch = epoch;
    this.written = new Map(saved.rooms.map((r) => [r.name, r]));
    this.size = 0;
    this.damaged = false;
    try {
      renameSync(journalBeside, this.journalFile);
      syncFolder(this.file);
      if (this.fd !== null) closeSync(this.fd);
      this.fd = null;
      this.fd = openSync(this.journalFile, 'a');
    } catch (error) {
      // No journal: nothing more is written until the next checkpoint, which is tried again soon (`wanting`).
      if (this.fd !== null) closeSync(this.fd);
      this.fd = null;
      report('The journal of the rooms could not be begun', error);
    }
    return true;
  }

  /** Stop writing. Whatever is said of the rooms after this (players' connections closing as the server stops) is not written. */
  close(): void {
    this.closed = true;
    if (this.fd === null) return;
    try {
      fsyncSync(this.fd);
      closeSync(this.fd);
    } catch {
      // Closed already.
    }
    this.fd = null;
  }

  /**
   * Add to the end of the journal, all of it. A write that stops part of the way (a full disk) is
   * reported; the next line begins on a line of its own, so that the part is passed over when the
   * journal is read, and every room is written whole from then on until the next checkpoint.
   */
  private append(text: string): boolean {
    const bytes = Buffer.from(this.damaged ? `\n${text}` : text);
    let done = 0;
    try {
      while (done < bytes.length) done += writeSync(this.fd!, bytes, done, bytes.length - done);
      this.unsynced = true;
      return true;
    } catch (error) {
      this.damaged = true;
      for (const name of this.written.keys()) this.written.set(name, null);
      report('A change to the rooms could not be written', error);
      return false;
    }
  }
}

/** Write a file and have it on the disk before going on. */
export function writeWhole(file: string, text: string): void {
  const fd = openSync(file, 'w');
  try {
    const bytes = Buffer.from(text);
    let done = 0;
    while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Make the moves of files into a folder last on the disk too. Not every system allows it; where it does not, the moves stand as well as the system makes them. */
function syncFolder(file: string): void {
  try {
    const fd = openSync(path.dirname(file), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // As above.
  }
}
