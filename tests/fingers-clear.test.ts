/**
 * No finger goes into a stone it is not holding. Moves are played with the real hand and the real
 * stones, and at every frame every point of the skin of the mover's two hands is measured against
 * every stone standing near it, but the one that hand has hold of at some time in the move: by the
 * shape the hands feel stones by, level from the side or up from the top. The near cases are the
 * crowded ones: taking in passing, castling with stones still on the back rank, a capture beside
 * a knight, a castle taken back, a knight lifted from beside its rook.
 */
import { type SkinnedMesh, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PromotionKind, Square } from '../src/core/game.ts';
import { Girth } from '../src/hands/girth.ts';
import type { Arm } from '../src/hands/puppeteer.ts';
import type { Puppet } from '../src/scene/pieces.ts';
import { handsRig, loadHands } from './helpers/hands-rig.ts';

beforeAll(loadHands);

/** How far clear of every other stone each point of a hand must stay. */
const MARGIN = 0.005;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLACK = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const MIDDLE = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP1B2/2N1PN2/PP2BPPP/R2Q1RK1 w - - 0 8';
const CASTLE = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
const LONG = 'r3kbnr/ppp1pppp/2nqb3/3p4/3P4/2NQB3/PPP1PPPP/R3KBNR w KQkq - 0 5';
const CROWDED = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/4P3/5NP1/PPPPQPBP/RNB1K2R w KQkq - 0 6';
const PASSANT = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
const PASSANT_LEFT = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
const PASSANT_VOID = 'rnbqkbnr/pp1ppppp/8/8/2pPP3/8/PPP2PPP/RNBQKBNR b KQkq d3 0 3';
const PROMOTION = '4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1';

type Case = [name: string, fen: string, from: Square, to: Square, promotion?: PromotionKind];

const MOVES: Case[] = [
  ['a pawn from the middle', START, 'e2', 'e4'],
  ['a pawn from beside the queen-side rook', START, 'a2', 'a4'],
  ['a pawn from beside the king-side rook', START, 'h2', 'h3'],
  ['a knight from beside its rook', START, 'g1', 'f3'],
  ['the other knight', START, 'b1', 'c3'],
  ['a knight of Void', BLACK, 'g8', 'f6'],
  ['a pawn of Void', BLACK, 'd7', 'd5'],
  ['a bishop to the square below a pawn', MIDDLE, 'f4', 'e5'],
  ['a pawn takes beside a knight', MIDDLE, 'd4', 'c5'],
  ['a pawn takes in the middle', MIDDLE, 'c4', 'd5'],
  ['a knight takes in the middle', MIDDLE, 'c3', 'd5'],
  ['the queen across', MIDDLE, 'd1', 'b3'],
  ['a rook along the back rank', MIDDLE, 'a1', 'c1'],
  ['castling', CASTLE, 'e1', 'g1'],
  ['castling long', LONG, 'e1', 'c1'],
  ['castling, Void', CASTLE.replace(' w ', ' b '), 'e8', 'g8'],
  ['castling long, Void', LONG.replace(' w ', ' b '), 'e8', 'c8'],
  ['castling on a crowded back rank', CROWDED, 'e1', 'g1'],
  ['taking in passing', PASSANT, 'e5', 'f6'],
  ['taking in passing the other way', PASSANT_LEFT, 'e5', 'd6'],
  ['taking in passing, Void', PASSANT_VOID, 'c4', 'd3'],
  ['a pawn made a queen', PROMOTION, 'b7', 'b8', 'q'],
];

const BACK: Case[] = [
  ['castling', CASTLE, 'e1', 'g1'],
  ['castling long', LONG, 'e1', 'c1'],
  ['castling, Void', CASTLE.replace(' w ', ' b '), 'e8', 'g8'],
  ['taking in passing', PASSANT, 'e5', 'f6'],
  ['a pawn that took beside a knight', MIDDLE, 'd4', 'c5'],
];

const point = new Vector3();
const local = new Vector3();
const skins = new WeakMap<Arm, SkinnedMesh>();

function skinOf(arm: Arm): SkinnedMesh {
  let skin = skins.get(arm);
  if (!skin) {
    arm.hand.root.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) skin ??= o as SkinnedMesh;
    });
    skins.set(arm, skin!);
  }
  return skin!;
}

/**
 * Watches two arms: for each, how near its skin has come to each of `puppets`, the nearest it has
 * been over every frame it was looked at, and which of them it took hold of.
 */
function watch(arms: Arm[], puppets: Puppet[]) {
  const nearest = new Map<Arm, Map<Puppet, number>>(arms.map((arm) => [arm, new Map()]));
  const held = new Map<Arm, Set<Puppet>>(arms.map((arm) => [arm, new Set()]));
  const look = () => {
    const stones = puppets.map((puppet) => {
      puppet.group.updateWorldMatrix(true, true);
      const stone = Girth.of(puppet.group)!;
      return { puppet, stone, height: stone.girth.over(0, 0), at: puppet.group.position };
    });
    for (const arm of arms) {
      if (arm.held) held.get(arm)!.add(arm.held.puppet);
      const skin = skinOf(arm);
      arm.hand.root.updateMatrixWorld(true);
      skin.skeleton.update();
      const near = nearest.get(arm)!;
      const count = skin.geometry.getAttribute('position').count;
      for (let i = 0; i < count; i++) {
        skin.localToWorld(skin.getVertexPosition(i, point));
        // Nothing stands this high.
        if (point.y > 2) continue;
        for (const { puppet, stone, height, at } of stones) {
          if (arm.held?.puppet === puppet) continue;
          if (Math.abs(point.x - at.x) > 1 || Math.abs(point.z - at.z) > 1) continue;
          stone.mesh.worldToLocal(local.copy(point));
          const beside = Math.hypot(local.x, local.z) - stone.girth.at(Math.min(local.y, height - 0.01), local.x, local.z);
          const clear = Math.max(beside, local.y - height);
          if (clear < (near.get(puppet) ?? Infinity)) near.set(puppet, clear);
        }
      }
    }
  };
  /** The nearest each arm came to any stone it never had hold of, and which stone that was. */
  const least = () => {
    let clear = Infinity;
    let what = '';
    for (const arm of arms) {
      for (const [puppet, d] of nearest.get(arm)!) {
        if (held.get(arm)!.has(puppet) || d >= clear) continue;
        clear = d;
        what = `${puppet.side}${puppet.kind} at (${puppet.group.position.x}, ${puppet.group.position.z})`;
      }
    }
    return { clear, what };
  };
  return { look, least };
}

describe('the hands keep their fingers out of the stones they are not holding', () => {
  it.each(MOVES)('%s', { timeout: 60000 }, async (_name, fen, from, to, promotion) => {
    const { game, layer, stage, run } = handsRig(fen);
    stage.setTurn(game.turn());
    await run(1.5);
    const e = game.move(from, to, promotion);
    const player = stage.hands[e.side];
    const { look, least } = watch([player.right, player.left], [...layer.standing()]);
    let done = false;
    let after = 0;
    void stage.playMove(e).then(() => (done = true));
    // Until the hands are well on their way home.
    await run(7, () => {
      if (done) after++;
      if (after <= 90) look();
    });
    expect(done).toBe(true);
    const { clear, what } = least();
    expect(clear, `within ${clear.toFixed(3)} of the ${what}`).toBeGreaterThan(MARGIN);
  });

  it.each(BACK)('%s, taken back', { timeout: 60000 }, async (_name, fen, from, to) => {
    const { game, layer, stage, run } = handsRig(fen);
    stage.setTurn(game.turn());
    await run(1.5);
    const e = game.move(from, to);
    void stage.playMove(e);
    await run(7);
    game.undo();
    const player = stage.hands[e.side];
    const { look, least } = watch([player.right, player.left], [...layer.standing()]);
    let done = false;
    let after = 0;
    void stage.playUndo(e).then(() => (done = true));
    await run(7, () => {
      if (done) after++;
      if (after <= 90) look();
    });
    expect(done).toBe(true);
    const { clear, what } = least();
    expect(clear, `within ${clear.toFixed(3)} of the ${what}`).toBeGreaterThan(MARGIN);
  });

  it.each([
    ['a pawn', START, 'e2'],
    ['a knight beside its rook', START, 'g1'],
    ['the king, on a crowded back rank', CROWDED, 'e1'],
    ['a pawn that may take in passing', PASSANT, 'e5'],
  ] as [string, string, Square][])('a hand in thought over %s', async (_name, fen, square) => {
    const { game, layer, stage, run } = handsRig(fen);
    const side = game.turn();
    stage.setTurn(side);
    await run(1.5);
    const player = stage.hands[side];
    const { look, least } = watch([player.right, player.left], [...layer.standing()]);
    stage.consider(side, square);
    await run(1.5, look);
    const { clear, what } = least();
    expect(clear, `within ${clear.toFixed(3)} of the ${what}`).toBeGreaterThan(MARGIN);
  });
});
