/**
 * The counts of how far visits go, and of games begun and ended: what is counted, what is not,
 * how they are kept, and how a page says them and asks who is looking for a match.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Running, startServer } from '../server/main.ts';
import { type Connection, Lobby } from '../server/rooms.ts';
import { dayOf, sayCounts, Tally } from '../server/tally.ts';
import type { MoveData, ServerMessage } from '../src/net/protocol.ts';
import { arrived, reached } from '../src/net/visits.ts';
import { apiUrl } from '../src/net/where.ts';

const folders: string[] = [];
const folder = () => {
  const made = mkdtempSync(path.join(tmpdir(), 'nightpiece-tally-'));
  folders.push(made);
  return made;
};
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

class Fake implements Connection {
  inbox: ServerMessage[] = [];
  constructor(readonly address?: string) {}
  send(message: ServerMessage): void {
    this.inbox.push(message);
  }
  close(): void {}
}

const move = (text: string): MoveData => ({ from: text.slice(0, 2) as MoveData['from'], to: text.slice(2, 4) as MoveData['to'] });

describe('the tally', () => {
  it('counts the steps it knows, by day, and nothing else', () => {
    let time = Date.UTC(2026, 10, 17, 12);
    const tally = new Tally(null, () => time);
    expect(tally.count('open', 'a')).toBe(true);
    expect(tally.count('open', 'b')).toBe(true);
    expect(tally.count('drawn', 'a')).toBe(true);
    expect(tally.count('rated')).toBe(true);
    expect(tally.count('anything', 'a')).toBe(false);
    expect(tally.count('__proto__', 'a')).toBe(false);
    expect(tally.on()).toEqual({ open: 2, drawn: 1, rated: 1 });
    time += 24 * 60 * 60 * 1000;
    tally.count('open', 'a');
    expect(tally.on()).toEqual({ open: 1 });
    expect(tally.on('2026-11-17')).toEqual({ open: 2, drawn: 1, rated: 1 });
  });

  it('does not let a page count the steps only the server may, nor one address count without end', () => {
    const tally = new Tally(null);
    expect(tally.count('rated', 'a')).toBe(false);
    expect(tally.count('matched', 'a')).toBe(false);
    let counted = 0;
    for (let i = 0; i < 500; i++) if (tally.count('open', 'a')) counted++;
    expect(counted).toBe(60);
    // Another address is counted all the same, and the first again once the hour is over.
    expect(tally.count('open', 'b')).toBe(true);
    tally.closeHour();
    expect(tally.count('open', 'a')).toBe(true);
  });

  it("says the hour's counts in the order a visit goes, with the day's so far", () => {
    const midnight = Date.UTC(2026, 10, 18, 0, 0, 1);
    let time = midnight - 2 * 60 * 1000;
    const tally = new Tally(null, () => time);
    tally.count('computer', 'a');
    tally.count('open', 'a');
    tally.count('drawn', 'a');
    expect(sayCounts({ computer: 1, open: 3, drawn: 2 })).toBe('open 3, drawn 2, computer 1');
    // Said just after midnight: the day is the one that has just ended.
    time = midnight;
    expect(tally.closeHour()).toBe('Counted in the last hour: open 1, drawn 1, computer 1. On 2026-11-17 (UTC) so far: open 1, drawn 1, computer 1.');
    expect(tally.closeHour()).toBeNull();
  });

  it('keeps the counts in a file, and puts aside one it cannot read', () => {
    const file = path.join(folder(), 'stats.json');
    const tally = new Tally(file);
    tally.count('open', 'a');
    tally.count('matched');
    tally.flush();
    const again = new Tally(file);
    expect(again.on()).toEqual({ open: 1, matched: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ days: { [dayOf(Date.now())]: { open: 1, matched: 1 } } });

    writeFileSync(file, '{ not json');
    const damaged = new Tally(file);
    expect(damaged.on()).toEqual({});
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(path.dirname(file)).some((name) => name.startsWith('stats.json.damaged-'))).toBe(true);
  });

  it('keeps no more than four hundred days', () => {
    let time = Date.UTC(2025, 0, 1);
    const tally = new Tally(null, () => time);
    for (let day = 0; day < 410; day++, time += 24 * 60 * 60 * 1000) tally.count('open');
    expect(tally.on('2025-01-01')).toEqual({});
    expect(tally.on(dayOf(time - 24 * 60 * 60 * 1000))).toEqual({ open: 1 });
  });
});

describe('the lobby', () => {
  it('counts what happens in the queue and in its games', () => {
    const counted: string[] = [];
    const lobby = new Lobby(Date.now, undefined, { count: (step) => counted.push(step) });
    const a = new Fake('1.1.1.1');
    const b = new Fake('2.2.2.2');
    lobby.handle(a, { t: 'hello', id: 'a'.repeat(32) });
    lobby.handle(b, { t: 'hello', id: 'b'.repeat(32) });
    lobby.handle(a, { t: 'queue' });
    expect(lobby.waiting).toBe(1);
    lobby.handle(b, { t: 'queue' });
    expect(counted).toEqual(['queued', 'matched']);
    expect(lobby.playing).toBe(0);

    // Among friends: the first move played in a room is a game between two.
    const f = new Fake('3.3.3.3');
    const g = new Fake('4.4.4.4');
    lobby.handle(f, { t: 'hello', id: 'f'.repeat(32) });
    lobby.handle(g, { t: 'hello', id: 'e'.repeat(32) });
    lobby.handle(f, { t: 'join', room: 'FRIEND' });
    lobby.handle(g, { t: 'join', room: 'FRIEND' });
    expect(lobby.playing).toBe(2);
    const white = (f.inbox.find((m) => m.t === 'joined') as Extract<ServerMessage, { t: 'joined' }>).you === 'w' ? f : g;
    const black = white === f ? g : f;
    lobby.handle(white, { t: 'move', ply: 0, move: move('e2e4') });
    lobby.handle(black, { t: 'move', ply: 1, move: move('e7e5') });
    expect(counted.filter((s) => s === 'friendgame')).toHaveLength(1);
  });
});

describe('the server', () => {
  let running: Running;
  let base: string;
  beforeAll(async () => {
    const root = folder();
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Nightpiece</title>');
    running = await startServer({ port: 0, root });
    base = `http://127.0.0.1:${running.port}`;
  });
  afterAll(() => running.close());

  it('counts a step a page says it has reached', async () => {
    const said = await fetch(`${base}/api/event`, { method: 'POST', body: 'computer', headers: { 'content-type': 'text/plain' } });
    expect(said.status).toBe(204);
    expect(said.headers.get('cache-control')).toBe('no-store');
    expect(said.headers.get('x-frame-options')).toBeTruthy();
    expect(running.tally.on().computer).toBe(1);
    // Nonsense is answered all the same, and not counted.
    expect((await fetch(`${base}/api/event`, { method: 'POST', body: 'nonsense' })).status).toBe(204);
    expect((await fetch(`${base}/api/event`, { method: 'POST', body: 'rated' })).status).toBe(204);
    expect(running.tally.on()).toEqual({ computer: 1 });
  });

  it('turns away a step that is asked for, too long, or from some other site', async () => {
    const asked = await fetch(`${base}/api/event`);
    expect(asked.status).toBe(405);
    expect(asked.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/api/event`, { method: 'POST', body: 'open'.repeat(100) })).status).toBe(413);
    expect((await fetch(`${base}/api/event`, { method: 'POST', body: 'open', headers: { origin: 'https://elsewhere.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/event`, { method: 'POST', body: 'open', headers: { origin: base } })).status).toBe(204);
    expect(running.tally.on().open).toBe(1);
    // Anything else that is not asked for is still not allowed.
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('says how many are looking for a match and playing, and that nothing on the way may keep it', async () => {
    const answer = await fetch(`${base}/api/lobby?x=1`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual({ waiting: 0, playing: 0 });
    expect((await fetch(`${base}/api/lobby`, { method: 'POST' })).status).toBe(405);
  });
});

describe('a page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks the server that served it, by the same address as its game connection', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'playnightpiece.com' });
    expect(apiUrl('/api/lobby')).toBe('https://playnightpiece.com/api/lobby');
    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:5173' });
    expect(apiUrl('/api/event')).toBe('http://127.0.0.1:5173/api/event');
  });

  it('says each step once, and whether the browser is new here or back another day', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 17, 12) });
    const beacons: string[] = [];
    const kept = new Map<string, string>();
    vi.stubGlobal('location', { protocol: 'https:', host: 'playnightpiece.com' });
    vi.stubGlobal('navigator', { sendBeacon: (url: string, step: string) => (beacons.push(`${url} ${step}`), true) });
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v) });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    arrived();
    reached('computer');
    reached('computer');
    expect(beacons).toEqual(['https://playnightpiece.com/api/event open', 'https://playnightpiece.com/api/event new', 'https://playnightpiece.com/api/event computer']);
    expect(kept.get('nightpiece.seen')).toBe('2026-11-17');
    // A minute in sight, then five.
    vi.advanceTimersByTime(60_000);
    expect(beacons.at(-1)).toMatch(/ stay1m$/);
    vi.advanceTimersByTime(4 * 60_000);
    expect(beacons.at(-1)).toMatch(/ stay5m$/);
  });
});
