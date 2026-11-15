/**
 * The hands' manners are the same on every screen at the board (docs/manners.md, section 3): a
 * screen that comes to a game part of the way through, after a sitting of its own, sets the stones
 * down from then on just as the screen that saw the whole game does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Square } from '../src/core/game.ts';
import { CHANCE, draw } from '../src/hands/manners.ts';
import { DT, handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

/** Pawns stepped one square each, by both players, and then a knight out each. */
const GAME: [Square, Square][] = [
  ['e2', 'e3'],
  ['e7', 'e6'],
  ['d2', 'd3'],
  ['d7', 'd6'],
  ['c2', 'c3'],
  ['c7', 'c6'],
  ['g1', 'f3'],
  ['g8', 'f6'],
];
/** The game is come to after this many plies. */
const LATE = 2;

/** A screen at the board: every manner it chooses, by the moment, the ply and the side. */
function screen() {
  const rig = handsRig();
  const chosen: string[] = [];
  const table = rig.stage.manners;
  const asked = table.choose.bind(table);
  table.choose = (at, facts) => {
    const name = asked(at, facts);
    if (at === 'set' || at === 'after') chosen.push(`${facts.ply} ${at} ${facts.side} ${name ?? '-'}`);
    return name;
  };
  return { ...rig, chosen };
}

async function play(rig: ReturnType<typeof screen>, from: Square, to: Square) {
  const e = rig.game.move(from, to);
  let done = false;
  void rig.stage.playMove(e).then(() => (done = true));
  for (let t = 0; t < 12 && !done; t += DT) await rig.run(DT);
  expect(done).toBe(true);
  await rig.run(0.2);
}

describe('the same on every screen', { timeout: 120000 }, () => {
  it('sets the stones down from ply N on as the screen that saw the whole game does, on a screen that came to it at ply N after a sitting of its own', async () => {
    // A board at which a pawn's first step is pushed, and its third would be if nothing had been played since.
    let seed = '';
    for (let i = 0; i < 100000 && !seed; i++) if (draw(`room-${i}`, 1, 'push') < CHANCE.often && draw(`room-${i}`, 3, 'push') < CHANCE.often) seed = `room-${i}`;
    const whole = screen();
    whole.stage.setSeed(seed);
    whole.stage.reset();
    for (const [from, to] of GAME) await play(whole, from, to);

    // The other has played a game of its own first, in which it saw the push.
    const late = screen();
    let before = '';
    for (let i = 0; i < 100000 && !before; i++) if (draw(`sitting-${i}`, 1, 'push') < CHANCE.often) before = `sitting-${i}`;
    late.stage.setSeed(before);
    late.stage.reset();
    await play(late, 'e2', 'e3');
    expect(late.chosen).toContain('1 set w push');
    // And comes to this game as it stands after the first plies.
    late.stage.setSeed(seed);
    late.game.load();
    for (const [from, to] of GAME.slice(0, LATE)) late.game.move(from, to);
    late.layer.reset(late.game.pieces());
    late.stage.reset();
    late.stage.seatTaken(late.game.history());
    late.chosen.length = 0;
    for (const [from, to] of GAME.slice(LATE)) await play(late, from, to);

    const fromThen = whole.chosen.filter((line) => Number(line.split(' ')[0]) > LATE);
    expect(fromThen.some((line) => line.endsWith('push'))).toBe(false);
    expect(late.chosen).toEqual(fromThen);
  });
});
