/**
 * The course of a game: how it stood after each move, and the move that
 * cost the most.
 */
import { describe, expect, it } from 'vitest';
import { Game, type MoveEvent } from '../src/core/game.ts';
import type { Verdict, VerdictKind } from '../src/engine/verdict.ts';
import { costliest, course } from '../src/learn/story.ts';

function played(list: string, fen?: string): { start: ReturnType<Game['pieces']>; history: MoveEvent[] } {
  const game = new Game(fen);
  const start = game.pieces();
  for (const text of list.split(' ').filter(Boolean)) game.move(text.slice(0, 2) as 'e2', text.slice(2, 4) as 'e4', (text[4] as 'q' | undefined) ?? undefined);
  return { start, history: game.history() };
}

const verdict = (kind: VerdictKind, after: number, loss = 0): Verdict => ({ kind, before: after + loss, after, loss, margin: null, best: { from: 'e2', to: 'e4' }, wasBest: loss === 0 });
const none = () => null;

describe('how a game stood', () => {
  it('starts level, and counts the stones where the engine has said nothing', () => {
    // Ivory takes a pawn, and Void takes one back.
    const { start, history } = played('e2e4 d7d5 e4d5 d8d5 b1c3 d5a5');
    const points = course(start, history, none);
    expect(points.map((p) => p.ply)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(points.map((p) => p.cp)).toEqual([0, 0, 0, 100, 0, 0, 0]);
    expect(points.every((p) => !p.judged && p.kind === null)).toBe(true);
  });

  it('counts a pawn that becomes a queen as eight pawns gained', () => {
    const { start, history } = played('a7a8q', '7k/P7/8/8/8/8/7p/K7 w - - 0 1');
    const points = course(start, history, none);
    expect(points.map((p) => p.cp)).toEqual([0, 800]);
  });

  it('counts for Void as it does for Ivory, the other way', () => {
    const { start, history } = played('h2h1r', '7k/P7/8/8/8/8/7p/K7 b - - 0 1');
    expect(course(start, history, none).map((p) => p.cp)).toEqual([0, -400]);
  });

  it('starts from the stones a set position began with', () => {
    const { start, history } = played('e1e2', '4k3/8/8/8/8/8/8/3QK3 w - - 0 1');
    expect(course(start, history, none).map((p) => p.cp)).toEqual([900, 900]);
  });

  it("takes the engine's word where it has one, turned to Ivory's side of it", () => {
    const { start, history } = played('e2e4 e7e5 g1f3');
    const said = new Map<MoveEvent, Verdict>([
      [history[0]!, verdict('sound', 30)],
      // Void's move left Void 80 behind: Ivory 80 ahead.
      [history[1]!, verdict('slip', -80, 110)],
    ]);
    const points = course(start, history, (e) => said.get(e));
    expect(points.map((p) => [p.cp, p.judged, p.kind])).toEqual([
      [0, false, null],
      [30, true, 'sound'],
      [80, true, 'slip'],
      [0, false, null],
    ]);
  });
});

describe('the move that cost the most', () => {
  const { history } = played('e2e4 e7e5 g1f3 b8c6 f1c4 f8c5');
  const said = new Map<MoveEvent, Verdict>([
    [history[0]!, verdict('strong', 40)],
    [history[1]!, verdict('slip', -120, 100)],
    [history[2]!, verdict('blunder', -300, 420)],
    [history[3]!, verdict('blunder', -100, 400)],
    [history[4]!, verdict('sound', 90)],
    [history[5]!, verdict('slip', -200, 420)],
  ]);
  const of = (e: MoveEvent) => said.get(e);

  it('is nothing when the engine faulted no move', () => {
    expect(costliest(history, none, null)).toBeNull();
    expect(costliest(history, (e) => (e === history[0] ? verdict('strong', 40) : verdict('sound', 0)), null)).toBeNull();
  });

  it('is the worst of either side, and the earlier of two as bad', () => {
    expect(costliest(history, of, null)).toMatchObject({ ply: 3, move: { san: 'Nf3' } });
  });

  it('can be asked of one side', () => {
    expect(costliest(history, of, 'w')).toMatchObject({ ply: 3 });
    // Void's two worst cost 400 and 420.
    expect(costliest(history, of, 'b')).toMatchObject({ ply: 6, move: { san: 'Bc5' } });
  });

  it('does not count a strong or sound move however much it is said to have lost', () => {
    const odd = (e: MoveEvent) => (e === history[0] ? verdict('sound', 0, 999) : null);
    expect(costliest(history, odd, null)).toBeNull();
  });
});
