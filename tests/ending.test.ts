/**
 * The end of a game said large over the scene (the verdict, in Match.tsx): the words it says for
 * every way a game can end, to a player, a table and a watcher; and when it is said. Once for each
 * ending this page sees happen, as the result card would first come up, and the card waiting for
 * it; never for a game already over when the page was opened, and never again when the card comes
 * back. Read from the interface's state, with nothing put on a page.
 */
import type { Signal } from '@preact/signals';
import type { VNode } from 'preact';
import { beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/app.ts';
import type { Cause, Outcome } from '../src/app/store.ts';

const { ui } = await import('../src/app/store.ts');
const { Game } = await import('../src/core/game.ts');
// Reached by a name made at run time, as tests/result-card.test.ts reaches the cards: the tests are type-checked without JSX.
const folder = '../src/ui/';
type Said = { word: string; tone: string; reason: string; note: string };
const match = (await import(/* @vite-ignore */ `${folder}Match.tsx`)) as {
  verdictOf: (o: Outcome, you: 'w' | 'b' | null) => Said;
  verdict: Signal<{ id: number; going: boolean } | null>;
  handed: Signal<boolean>;
  settle: (id: number) => void;
};
const { Result } = (await import(/* @vite-ignore */ `${folder}Cards.tsx`)) as { Result: (props: { app: App }) => VNode<{ class?: string }> | null };
const { verdictOf, verdict, handed, settle } = match;
const app = {} as App;

const ended = (cause: Cause, winner: 'w' | 'b' | null, extra: Partial<Outcome> = {}): Outcome => ({
  result: cause === 'checkmate' ? 'checkmate' : winner ? 'resigned' : 'draw',
  winner,
  cause,
  move: 23,
  duration: 252000,
  rating: null,
  flagged: null,
  ...extra,
});

describe('what the verdict says', () => {
  it('to a player: victory or defeat, and why, from their side of the board', () => {
    expect(verdictOf(ended('checkmate', 'w'), 'w')).toEqual({ word: 'Victory', tone: 'won', reason: 'Checkmate', note: 'Move 23 · 4 min 12 s' });
    expect(verdictOf(ended('checkmate', 'w'), 'b')).toMatchObject({ word: 'Defeat', tone: 'lost', reason: 'Checkmate' });
    expect(verdictOf(ended('resigned', 'b'), 'w')).toMatchObject({ word: 'Defeat', reason: 'You resigned' });
    expect(verdictOf(ended('resigned', 'w'), 'w')).toMatchObject({ word: 'Victory', reason: 'Void resigned' });
    expect(verdictOf(ended('time', 'w', { flagged: 'b' }), 'w')).toMatchObject({ word: 'Victory', reason: 'Void ran out of time' });
    expect(verdictOf(ended('time', 'b', { flagged: 'w' }), 'w')).toMatchObject({ word: 'Defeat', reason: 'You ran out of time' });
    expect(verdictOf(ended('left', 'w'), 'w')).toMatchObject({ word: 'Victory', reason: 'Void left the game' });
  });

  it('to a table or a watcher: which side won, in that side colour', () => {
    expect(verdictOf(ended('checkmate', 'b'), null)).toMatchObject({ word: 'Void wins', tone: 'b', reason: 'Checkmate' });
    expect(verdictOf(ended('resigned', 'w'), null)).toMatchObject({ word: 'Ivory wins', tone: 'w', reason: 'Void resigned' });
  });

  it('a draw, by every way there is to draw, to anyone', () => {
    const reasons: [Cause, string][] = [
      ['stalemate', 'Stalemate'],
      ['agreement', 'Agreed'],
      ['repetition', 'Threefold repetition'],
      ['fivefold', 'Fivefold repetition'],
      ['fifty', 'Fifty-move rule'],
      ['seventy-five', 'Seventy-five-move rule'],
      ['material', 'Not enough to mate'],
    ];
    for (const [cause, reason] of reasons)
      for (const you of ['w', 'b', null] as const) expect(verdictOf(ended(cause, null), you)).toMatchObject({ word: 'Draw', tone: 'drew', reason });
    // On time, against a side that could not have mated: the plate says time, and the line under it why it is not lost.
    expect(verdictOf(ended('time', null, { flagged: 'b' }), 'b')).toMatchObject({ word: 'Draw', reason: 'Out of time', note: 'You ran out of time, but Ivory could not have mated · Move 23 · 4 min 12 s' });
    expect(verdictOf(ended('time', null, { flagged: 'w' }), null).note).toBe('Ivory ran out of time, but Void could not have mated · Move 23 · 4 min 12 s');
  });

  it('leaves out what it does not know: no move made, or a game not seen from its start', () => {
    expect(verdictOf(ended('resigned', 'w', { move: null, duration: null }), 'w').note).toBe('');
    expect(verdictOf(ended('checkmate', 'w', { duration: null }), null).note).toBe('Move 23');
  });
});

describe('when the verdict is said', () => {
  /** Fool's mate, played on the board the interface reads. */
  function mate(): void {
    const game = new Game();
    for (const [from, to] of [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ] as const)
      game.move(from, to);
    ui.history.value = game.history();
    ui.status.value = game.status();
  }
  /** The board as it stands before the last move, as a move taken back leaves it. */
  function takenBack(): void {
    ui.resultVisible.value = false;
    ui.status.value = { ...ui.status.value, over: false, result: null, winner: null };
  }

  beforeEach(() => {
    ui.mode.value = { kind: 'computer', level: 'casual', side: 'w' };
    ui.you.value = 'w';
    takenBack();
    ui.ready.value = true;
  });

  it('once, as the card would come up, with the card waiting for it until it goes into it', () => {
    mate();
    // Over, and the final move still landing: nothing yet.
    expect(verdict.value).toBeNull();
    expect(Result({ app })).toBeNull();
    ui.resultVisible.value = true;
    const said = verdict.value;
    expect(said).toMatchObject({ going: false });
    expect(Result({ app })).toBeNull();
    // Going into the card: the card is drawn, and knows its seal is brought to it.
    settle(said!.id);
    expect(verdict.value).toMatchObject({ id: said!.id, going: true });
    expect(handed.value).toBe(true);
    const card = Result({ app });
    expect(card?.props.class).toContain('result-handed');
    // A second word to settle the same verdict changes nothing.
    settle(said!.id);
    expect(verdict.value).toMatchObject({ id: said!.id, going: true });
  });

  it('not again when the card comes back after the board was looked at', () => {
    mate();
    ui.resultVisible.value = true;
    settle(verdict.value!.id);
    verdict.value = null;
    // View board, then back.
    ui.resultVisible.value = false;
    expect(handed.value).toBe(false);
    ui.resultVisible.value = true;
    expect(verdict.value).toBeNull();
    // And the card comes in as a card always has, turning its own seal.
    expect(Result({ app })?.props.class).not.toContain('result-handed');
  });

  it('goes at once if the card is put away, or the game taken back, while it is said', () => {
    mate();
    ui.resultVisible.value = true;
    expect(verdict.value).not.toBeNull();
    ui.resultVisible.value = false;
    expect(verdict.value).toBeNull();
    takenBack();
    mate();
    ui.resultVisible.value = true;
    expect(verdict.value).not.toBeNull();
    takenBack();
    expect(verdict.value).toBeNull();
  });

  it('again for a game taken back and ended once more, which is a new ending', () => {
    mate();
    ui.resultVisible.value = true;
    const first = verdict.value!.id;
    takenBack();
    mate();
    ui.resultVisible.value = true;
    expect(verdict.value?.id).toBeGreaterThan(first);
  });

  it('not for a game that was already over when the page was opened', () => {
    ui.ready.value = false;
    mate();
    ui.ready.value = true;
    ui.resultVisible.value = true;
    expect(verdict.value).toBeNull();
    expect(Result({ app })).not.toBeNull();
  });

  it('never in a lesson, which has no result card', () => {
    ui.mode.value = { kind: 'lessons' };
    mate();
    ui.resultVisible.value = true;
    expect(verdict.value).toBeNull();
  });
});
