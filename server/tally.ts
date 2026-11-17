/**
 * How many visits reached each step of the game, by day (see src/net/visits.ts), and how many
 * ranked and friendly games the server saw begin and end.
 *
 * Only counts are kept: no address, no name, nothing that tells one visitor from another. The
 * addresses steps come from are held in memory for an hour, only to stop one from counting
 * without end, and never written down. The counts are written to one small JSON file now and
 * then, and said in the server's log once an hour.
 */
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { PAGE_STEPS, SERVER_STEPS } from '../src/net/visits.ts';
import { writeWhole } from './store.ts';

/** How many days are kept. */
const DAYS_KEPT = 400;
/** How many steps one address may count in an hour. A page load says a dozen at most. */
const PER_ADDRESS_HOURLY = 60;
/** How often what has changed is written, at most. */
const WRITE_EVERY = 5 * 60 * 1000;

const STEPS: ReadonlySet<string> = new Set([...PAGE_STEPS, ...SERVER_STEPS]);
const PAGE: ReadonlySet<string> = new Set(PAGE_STEPS);
/** The order steps are said in, the way a visit goes. */
const ORDER = [...PAGE_STEPS, ...SERVER_STEPS] as string[];

type Counts = Record<string, number>;

/** The day a moment falls on, in universal time: '2026-11-17'. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Counts in the order a visit goes: 'open 12, drawn 11, computer 5'. */
export function sayCounts(counts: Counts): string {
  const names = Object.keys(counts).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return names.map((name) => `${name} ${counts[name]}`).join(', ') || 'nothing';
}

export class Tally {
  private days = new Map<string, Counts>();
  /** What has been counted since the hour was last said. */
  private hour: Counts = {};
  private from = new Map<string, number>();
  private changed = false;
  private writing: ReturnType<typeof setTimeout> | null = null;

  /** `file` is where the counts are kept. Left out, they last as long as the server does. */
  constructor(
    private file: string | null = null,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const data: unknown = JSON.parse(text);
      const days = typeof data === 'object' && data !== null ? (data as { days?: unknown }).days : null;
      if (typeof days !== 'object' || days === null || Array.isArray(days)) throw new Error('not a table of days');
      for (const [day, counts] of Object.entries(days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof counts !== 'object' || counts === null) continue;
        const kept: Counts = {};
        for (const [name, n] of Object.entries(counts)) if (STEPS.has(name) && typeof n === 'number' && Number.isFinite(n) && n > 0) kept[name] = Math.floor(n);
        this.days.set(day, kept);
      }
    } catch (error) {
      // Put aside, not written over, as the scores are.
      this.days.clear();
      const aside = `${file}.damaged-${this.now()}`;
      try {
        renameSync(file, aside);
        console.error(`The counts in ${file} could not be read, and have been put aside as ${aside}:`, error);
      } catch (moving) {
        console.error(`The counts in ${file} could not be read, nor put aside; they will be written over:`, error, moving);
      }
    }
  }

  /**
   * Count a step. One from a page carries the address it came from, and is not counted if the
   * address has counted too many this hour. Returns whether it was counted.
   */
  count(step: string, address?: string): boolean {
    if (!STEPS.has(step)) return false;
    if (address !== undefined) {
      if (!PAGE.has(step)) return false;
      const n = this.from.get(address) ?? 0;
      if (n >= PER_ADDRESS_HOURLY) return false;
      this.from.set(address, n + 1);
    }
    const day = dayOf(this.now());
    let counts = this.days.get(day);
    if (!counts) {
      this.days.set(day, (counts = {}));
      // The oldest day goes once there are too many.
      for (const old of [...this.days.keys()].sort().slice(0, Math.max(0, this.days.size - DAYS_KEPT))) this.days.delete(old);
    }
    counts[step] = (counts[step] ?? 0) + 1;
    this.hour[step] = (this.hour[step] ?? 0) + 1;
    this.changed = true;
    this.saveSoon();
    return true;
  }

  /** The counts for a day (today, left out). */
  on(day = dayOf(this.now())): Counts {
    return { ...(this.days.get(day) ?? {}) };
  }

  /**
   * What was counted in the hour just gone, and today so far, as a line for the log; or null if
   * nothing was. The addresses are forgotten, and the next hour begins.
   */
  closeHour(): string | null {
    this.from.clear();
    const hour = this.hour;
    this.hour = {};
    if (Object.keys(hour).length === 0) return null;
    // Said just after the hour turns: the day is the one the hour belonged to, which at midnight is yesterday.
    const day = dayOf(this.now() - 60 * 1000);
    return `Counted in the last hour: ${sayCounts(hour)}. On ${day} (UTC) so far: ${sayCounts(this.on(day))}.`;
  }

  /** Write the counts now, if they have changed. */
  flush(): void {
    if (this.writing !== null) clearTimeout(this.writing);
    this.writing = null;
    this.write();
  }

  private saveSoon(): void {
    if (!this.file || this.writing !== null) return;
    this.writing = setTimeout(() => {
      this.writing = null;
      this.write();
    }, WRITE_EVERY);
    this.writing.unref?.();
  }

  private write(): void {
    if (!this.file || !this.changed) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const beside = `${this.file}.tmp`;
      writeWhole(beside, JSON.stringify({ days: Object.fromEntries([...this.days].sort(([a], [b]) => (a < b ? -1 : 1))) }));
      renameSync(beside, this.file);
      this.changed = false;
    } catch (error) {
      // Tried again with the next write; nothing else depends on it.
      console.error('The counts could not be written; they will be tried again:', error);
      this.saveSoon();
    }
  }
}
