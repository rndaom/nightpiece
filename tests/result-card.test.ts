/**
 * The result card, as drawn from the interface's state: what it offers after a ranked game and
 * after a friendly one, and that the engine's graph of the game is on it only when the game may
 * be looked over (`assisted`). The card's function is called as it is and its drawing read, with
 * nothing put on a page: `assisted` is stood in for so that it can be set either way.
 */
import { type Signal, signal } from '@preact/signals';
import type { FunctionComponent, VNode } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/app.ts';

vi.mock('../src/app/store.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/app/store.ts')>();
  return { ...real, assisted: signal(true) };
});

const { ui } = await import('../src/app/store.ts');
const assisted = (await import('../src/app/store.ts')).assisted as unknown as Signal<boolean>;
// The interface is checked by the page's own settings, not these, so its modules are reached by a name the checker does not follow.
const folder = '../src/ui/';
const { Result, Room } = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { Result: (props: { app: App }) => VNode; Room: (props: { app: App }) => VNode | null };
const { Graph } = (await import(/* @vite-ignore */ `${folder}Graph.tsx`)) as { Graph: FunctionComponent };
const { Game } = await import('../src/core/game.ts');

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
const graphed = (node: unknown) => [...parts(node)].some((v) => v.type === Graph || (typeof v.type === 'function' && v.type.name === 'Story'));

/** A finished online game on the board, Void having given it up after four moves. */
function finished(ranked: boolean): void {
  const game = new Game();
  for (const [from, to] of [
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
  ] as const)
    game.move(from, to);
  game.resign('b');
  ui.mode.value = { kind: 'online', room: 'ABCDE' };
  ui.you.value = 'w';
  ui.history.value = game.history();
  ui.status.value = game.status();
  ui.resultVisible.value = true;
  ui.online.value = {
    room: 'ABCDE',
    seat: 'w',
    link: 'open',
    taken: { w: true, b: true },
    present: { w: true, b: true },
    watching: 0,
    again: { w: false, b: false },
    offer: null,
    note: null,
    ranked,
    players: { w: { name: 'Abcdefghijklmnop', rating: 1216 }, b: { name: 'Qrstuvwxyzabcdef', rating: 1184 } },
    clock: null,
    control: null,
    choosable: !ranked,
    ended: null,
    change: ranked ? { w: 16, b: -16 } : null,
    closed: null,
    firstHere: false,
    stuck: false,
  };
}

const app = {} as App;

describe('the result card', () => {
  it('after a ranked game offers another match and a way out, and no game against the same player', () => {
    finished(true);
    const card = Result({ app });
    const said = words(card);
    expect(said).toContain('You win');
    expect(said).toContain('Find another match');
    expect(said).toContain('Leave');
    expect(said).not.toContain('Play again');
    expect(said).not.toContain('would like another game');
    // The rating as it was and as it is.
    const row = [...parts(card)].find((v) => typeof v.type === 'function' && v.type.name === 'RatingRow');
    expect(row?.props).toMatchObject({ before: 1200, after: 1216 });
  });

  it('after a friendly game still offers another in the same room', () => {
    finished(false);
    const said = words(Result({ app }));
    expect(said).toContain('Play again');
    expect(said).not.toContain('Find another match');
    expect([...parts(Result({ app }))].some((v) => typeof v.type === 'function' && v.type.name === 'RatingRow')).toBe(false);
  });

  it('draws the graph of the game only when the game may be looked over', () => {
    finished(true);
    assisted.value = false;
    expect(graphed(Result({ app }))).toBe(false);
    assisted.value = true;
    expect(graphed(Result({ app }))).toBe(true);
  });
});

describe('the clock of a friendly room', () => {
  /** The choice of clock in a drawing, drawn itself (it is a part of its own), or null if it is not there or draws nothing. */
  const pick = (node: unknown): VNode | null => {
    const v = [...parts(node)].find((p) => typeof p.type === 'function' && p.type.name === 'ClockPick');
    return v ? ((v.type as (props: unknown) => VNode | null)(v.props) ?? null) : null;
  };
  const radios = (node: VNode) => [...parts(node)].filter((v) => (v.props as { role?: string }).role === 'radio') as VNode<{ 'aria-checked': boolean; 'aria-label': string; disabled: boolean; onClick: () => void }>[];

  it('is offered after a friendly game for the next one, the chosen one pressed, and choosing it asks the room', () => {
    finished(false);
    ui.online.value = { ...ui.online.value!, control: { base: 300000, increment: 3000 } };
    const setClock = vi.fn();
    const chooser = pick(Result({ app: { setClock } as unknown as App }))!;
    expect(chooser).not.toBeNull();
    expect(words(chooser)).toBe('Off | 3+2 | 5+3 | 10+5 | 15+10 | 30+0');
    const all = radios(chooser);
    expect(all.map((r) => r.props['aria-checked'])).toEqual([false, false, true, false, false, false]);
    expect(all[1]!.props['aria-label']).toBe('3 minutes each and 2 seconds back a move');
    expect(all[5]!.props['aria-label']).toBe('30 minutes each');
    all[0]!.props.onClick();
    expect(setClock).toHaveBeenCalledWith(null);
  });

  it('is not offered after a ranked game, to a watcher, or by a server that cannot keep one; and waits while the line is down', () => {
    finished(true);
    expect(pick(Result({ app }))).toBeNull();
    finished(false);
    ui.you.value = null;
    ui.online.value = { ...ui.online.value!, seat: 'spectator' };
    expect(pick(Result({ app }))).toBeNull();
    finished(false);
    ui.online.value = { ...ui.online.value!, choosable: false };
    expect(pick(Result({ app }))).toBeNull();
    finished(false);
    ui.online.value = { ...ui.online.value!, link: 'lost' };
    expect(radios(pick(Result({ app }))!).every((r) => r.props.disabled)).toBe(true);
  });

  it('stands on the room\'s card before the first move, and not while a game is being played', () => {
    finished(false);
    const game = new Game();
    ui.history.value = [];
    ui.status.value = game.status();
    ui.resultVisible.value = false;
    expect(pick(Room({ app }))).not.toBeNull();
    game.move('e2', 'e4');
    ui.history.value = game.history();
    ui.status.value = game.status();
    expect(pick(Room({ app }))).toBeNull();
  });
});
