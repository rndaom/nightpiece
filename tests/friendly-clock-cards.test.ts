/**
 * What the cards say of a friendly clock that waits for a player who is away, to the other player
 * and to a watcher; and that a card put out of sight (the board looked at alone, or the choice of
 * game up) no longer keeps the board framed above it. The cards' functions are called as they are
 * and their drawings read, with nothing put on a page.
 */
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import type { App } from '../src/app/app.ts';

const { ui } = await import('../src/app/store.ts');
const { Game } = await import('../src/core/game.ts');
// The interface is checked by the page's own settings, not these, so its modules are reached by a name the checker does not follow.
const folder = '../src/ui/';
const { Room, cardSeen } = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { Room: (props: { app: App }) => VNode | null; cardSeen: (shown: boolean) => boolean };

/** Every part of a drawing, depth first. */
function* parts(node: unknown): Generator<VNode> {
  if (Array.isArray(node)) {
    for (const n of node) yield* parts(n);
    return;
  }
  if (!node || typeof node !== 'object' || !('type' in node)) return;
  const v = node as VNode<{ children?: unknown }>;
  yield v;
  yield* parts(v.props.children);
}
const words = (node: unknown) =>
  [...parts(node)]
    .flatMap((v) => (Array.isArray(v.props.children) ? v.props.children : [v.props.children]))
    .filter((c) => typeof c === 'string')
    .join(' | ');
const waiting = (node: unknown) => [...parts(node)].find((v) => typeof v.type === 'function' && v.type.name === 'Waiting') as VNode<{ who: string; left: number }> | undefined;

const app = {} as App;

/** A timed friendly game, Ivory having moved and Void, to move, away; seen from `seat`. */
function away(seat: 'w' | 'spectator', held: { side: 'b'; left: number } | null): void {
  const game = new Game();
  game.move('e2', 'e4');
  ui.mode.value = { kind: 'online', room: 'ABCDEF' };
  ui.you.value = seat === 'w' ? 'w' : null;
  ui.history.value = game.history();
  ui.status.value = game.status();
  ui.resultVisible.value = false;
  ui.online.value = {
    room: 'ABCDEF',
    seat,
    link: 'open',
    taken: { w: true, b: true },
    present: { w: true, b: false },
    watching: 0,
    again: { w: false, b: false },
    offer: null,
    note: null,
    ranked: false,
    players: { w: null, b: null },
    clock: { left: { w: 180000, b: 170000 }, running: held ? null : 'b', ...(held ? { held } : {}), at: 0 },
    control: { base: 180000, increment: 2000 },
    choosable: true,
    ended: null,
    change: null,
    closed: null,
    firstHere: false,
    stuck: false,
  };
}

describe('a friendly clock waiting for a player who is away', () => {
  it('is said to the other player with how long it will wait', () => {
    away('w', { side: 'b', left: 95000 });
    expect(waiting(Room({ app }))?.props).toMatchObject({ who: 'Opponent', left: 95000 });
  });

  it('is said to a watcher by the side\'s name', () => {
    away('spectator', { side: 'b', left: 95000 });
    expect(waiting(Room({ app }))?.props).toMatchObject({ who: 'Void is', left: 95000 });
  });

  it('once the wait is spent, says that the clock is running', () => {
    away('w', null);
    const card = Room({ app });
    expect(waiting(card)).toBeUndefined();
    expect(words(card)).toContain('Opponent away. Their clock is running.');
  });
});

describe('a card out of sight', () => {
  it('lets the board have the picture while the interface is put away or the choice of game is up, and frames for it again after', () => {
    ui.bare.value = false;
    ui.menuOpen.value = false;
    expect(cardSeen(true)).toBe(true);
    ui.bare.value = true;
    expect(cardSeen(true)).toBe(false);
    ui.bare.value = false;
    ui.menuOpen.value = true;
    expect(cardSeen(true)).toBe(false);
    ui.menuOpen.value = false;
    expect(cardSeen(true)).toBe(true);
    expect(cardSeen(false)).toBe(false);
  });

  it('is what the framing is keyed on', () => {
    const cards = readFileSync('src/ui/Cards.tsx', 'utf8');
    expect(cards).toMatch(/const seen = cardSeen\(shown\);\s*useEffect\(\(\) => \{\s*const rail = seen \?/);
    expect(cards).toMatch(/\}, \[app, seen, state\]\);/);
  });
});
