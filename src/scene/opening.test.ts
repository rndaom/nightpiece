import type { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Game } from '../core/game';
import { claspAt, drawerAt, lidAt, Opening, type OpeningCues, SHUT } from './opening';
import { PieceLayer, type Puppet } from './pieces';
import { Tweens } from './tween';

const DT = 1 / 60;

function setup(fen?: string) {
  const layer = new PieceLayer(new Tweens());
  layer.reset(new Game(fen).pieces());
  const heard: string[] = [];
  const knocks: string[] = [];
  const cues: OpeningCues = {
    clasp: () => heard.push('clasp'),
    swing: () => heard.push('swing'),
    lands: (strength) => heard.push(strength >= 1 ? 'lands' : 'bounce'),
    drawer: (name) => heard.push(`drawer ${name}`),
    knock: (_at, _pale, weight) => knocks.push(String(weight)),
    hands: () => heard.push('hands'),
  };
  const opening = new Opening(layer, cues);
  // Where the position stands each stone, before the opening takes them up.
  for (const p of layer.standing()) home.set(p, p.group.position.clone());
  return { layer, opening, heard, knocks };
}
const home = new Map<Puppet, Vector3>();

/** Every stone on its square, upright, whole and in sight. */
function expectSetOut(layer: PieceLayer) {
  expect(layer.root.visible).toBe(true);
  for (const p of layer.standing()) {
    const g = p.group;
    expect(g.visible, `${p.id}`).toBe(true);
    expect(g.position.distanceTo(home.get(p)!), `${p.id}`).toBeLessThan(1e-9);
    expect(g.scale.x).toBe(1);
    expect(g.rotation.y).toBeCloseTo(p.side === 'w' ? 0 : Math.PI, 9);
  }
}

function expectOpen(opening: Opening) {
  expect(opening.pose.lid).toBe(0);
  expect(opening.pose.clasp).toBe(0);
  expect(Object.values(opening.pose.drawers)).toEqual([1, 1, 1, 1]);
}

/** Run the opening under way to its end by the frame, and say how long it took. */
function play(opening: Opening, each?: (t: number) => void): number {
  let t = 0;
  while (opening.running && t < 20) {
    opening.update(DT);
    t += DT;
    each?.(t);
  }
  return t;
}

describe('the opening of the case', () => {
  it('packs the case shut and the stones out of sight', () => {
    const { layer, opening } = setup();
    opening.pack();
    expect(opening.packed).toBe(true);
    expect(opening.pose.lid).toBe(SHUT);
    expect(opening.pose.clasp).toBe(SHUT);
    expect(Object.values(opening.pose.drawers)).toEqual([0, 0, 0, 0]);
    expect(layer.root.visible).toBe(false);
    expect(layer.contact.mesh.visible).toBe(false);
    expect(opening.running).toBe(false);
  });

  it('opens from shut in four to five seconds, the lid first, then the drawers, the stones, and last the kings', async () => {
    const { layer, opening, heard, knocks } = setup();
    opening.pack();
    let resolved = false;
    void opening.start('full')!.then(() => (resolved = true));
    expect(opening.running).toBe(true);
    expect(layer.root.visible).toBe(true);
    // At the start the case is still shut and no stone is to be seen.
    expect(opening.pose.lid).toBe(SHUT);
    for (const p of layer.standing()) expect(p.group.visible).toBe(false);
    const duration = opening.duration;
    expect(duration).toBeGreaterThan(4);
    expect(duration).toBeLessThan(5);

    let lowest = SHUT;
    let firstStone = Infinity;
    let firstDrawer = Infinity;
    const took = play(opening, (t) => {
      lowest = Math.min(lowest, opening.pose.lid);
      if (firstDrawer === Infinity && opening.pose.drawers.void_w > 0) firstDrawer = t;
      if (firstStone === Infinity && [...layer.standing()].some((p) => p.group.visible)) firstStone = t;
    });
    expect(took).toBeCloseTo(duration, 1);
    // The lid comes all the way over, and the drawers open only once it is down.
    expect(lowest).toBeLessThan(0.01);
    expect(firstDrawer).toBeGreaterThan(1.5);
    expect(firstStone).toBeGreaterThan(firstDrawer);
    expect(heard.slice(0, 4)).toEqual(['clasp', 'swing', 'lands', 'bounce']);
    expect(heard.filter((h) => h.startsWith('drawer'))).toHaveLength(4);
    expect(heard.at(-1)).toBe('hands');
    // A knock for every stone, and the two kings, the heaviest, are the last two down.
    expect(knocks).toHaveLength(32);
    expect(knocks.slice(-2)).toEqual(['1.5', '1.5']);
    expect(knocks.slice(0, 16).every((w) => w === '0.55')).toBe(true);
    await Promise.resolve();
    expect(resolved).toBe(true);
    expectOpen(opening);
    expectSetOut(layer);
  });

  it('sets the stones out alone, in about a second and a half, from a case already open', () => {
    const { layer, opening, heard, knocks } = setup();
    const done = opening.start('short');
    expect(done).not.toBeNull();
    expect(opening.duration).toBeGreaterThan(1.1);
    expect(opening.duration).toBeLessThan(1.9);
    play(opening, () => expectOpen(opening));
    expect(heard).toEqual([]);
    expect(knocks).toHaveLength(32);
    expectSetOut(layer);
  });

  it('opens fully only from shut: asked for the whole opening with the case open, it sets out the stones alone', () => {
    const { opening } = setup();
    opening.start('full');
    expect(opening.duration).toBeLessThan(2);
    expectOpen(opening);
  });

  it('can be finished at any moment, with everything where it would have ended', () => {
    for (const at of [0, 0.3, 1, 1.6, 2.4, 3.5]) {
      const { layer, opening } = setup();
      opening.pack();
      opening.start('full');
      for (let t = 0; t < at; t += DT) opening.update(DT);
      opening.finish();
      expect(opening.running, `at ${at}`).toBe(false);
      expect(opening.packed).toBe(false);
      expectOpen(opening);
      expectSetOut(layer);
    }
  });

  it('keeps its promise when it is finished early, and once only', async () => {
    const { opening } = setup();
    opening.pack();
    let kept = 0;
    void opening.start('full')!.then(() => kept++);
    opening.update(0.5);
    opening.finish();
    opening.finish();
    opening.update(1);
    await Promise.resolve();
    expect(kept).toBe(1);
  });

  it('sets the board at once, with no promise, when there is to be no opening', () => {
    const { layer, opening, knocks } = setup();
    opening.pack();
    expect(opening.start('none')).toBeNull();
    expect(opening.running).toBe(false);
    expect(opening.packed).toBe(false);
    expect(knocks).toEqual([]);
    expectOpen(opening);
    expect(layer.root.visible).toBe(true);
  });

  it('finishes the opening under way when another begins', async () => {
    const { layer, opening } = setup();
    opening.pack();
    let first = false;
    void opening.start('full')!.then(() => (first = true));
    opening.update(1);
    const second = opening.start('short');
    await Promise.resolve();
    expect(first).toBe(true);
    expect(second).not.toBeNull();
    play(opening);
    expectSetOut(layer);
  });

  it('brings the taken stones out with their drawers and leaves them where they stood', () => {
    // White has taken a black knight; it stands at the ledge of a drawer on the far side.
    const { layer, opening } = setup();
    const knight = layer.puppetAt('g8')!;
    layer.retire(knight.id);
    knight.group.position.set(5.23, -0.67, -1.5);
    const at = knight.group.position.clone();
    opening.pack();
    opening.start('full');
    let seen = false;
    play(opening, () => {
      const out = opening.pose.drawers.void_e;
      if (out < 0.75) expect(knight.group.visible).toBe(false);
      // It rides the drawer: as far in from where it stood as the drawer is from open.
      expect(knight.group.position.x).toBeCloseTo(at.x - (1 - out), 9);
      seen ||= knight.group.visible;
    });
    expect(seen).toBe(true);
    expect(knight.group.visible).toBe(true);
    expect(knight.group.position.distanceTo(at)).toBeLessThan(1e-9);
    expect(knight.group.scale.x).toBe(1);
  });

  it('puts the stones of the game before back into the drawers, quickly, before the new game comes out', () => {
    const { layer, opening } = setup();
    opening.start('none');
    // The game before: Ivory's e-pawn has gone to e5, and a black knight stands taken in a drawer.
    const pawn = layer.puppetAt('e2')!;
    pawn.group.position.set(0.5, 0, -0.5);
    const knight = layer.puppetAt('g8')!;
    layer.retire(knight.id);
    knight.group.position.set(5.5, -0.67, 2.0);
    opening.remember();
    // A new game is set up, and stood out of the case.
    layer.reset(new Game().pieces());
    for (const p of layer.standing()) home.set(p, p.group.position.clone());
    opening.start('short');
    const duration = opening.duration;
    expect(duration).toBeGreaterThan(1.7);
    expect(duration).toBeLessThan(2.5);
    const at = (x: number, z: number) => [...layer.standing()].find((p) => p.group.visible && Math.hypot(p.group.position.x - x, p.group.position.z - z) < 1e-6);
    // At first every stone stands where the game before left it, the taken knight in its drawer.
    expect(at(0.5, -0.5)?.kind).toBe('p');
    expect(at(5.5, 2.0)?.kind).toBe('n');
    expect(at(0.5, 2.5)).toBeUndefined();
    let gone = Infinity;
    let back = false;
    play(opening, (t) => {
      const shown = [...layer.standing()].filter((p) => p.group.visible);
      if (gone === Infinity && shown.length === 1) gone = t;
      // The knight waits in its drawer till it comes out.
      if (t < 0.6) expect(at(5.5, 2.0)?.kind).toBe('n');
      back ||= shown.length === 32 && shown.every((p) => p.group.position.distanceTo(home.get(p)!) < 1e-9);
    });
    // All but the knight are in the drawers by about 0.6 s; then they come out to the new game.
    expect(gone).toBeGreaterThan(0.4);
    expect(gone).toBeLessThan(0.75);
    expect(back).toBe(true);
    expectSetOut(layer);
  });

  it('puts a stone a pawn was made into back as that pawn, rather than letting it vanish', () => {
    const { layer, opening } = setup('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    opening.start('none');
    // The game before: the pawn went through to e8 and was made a queen.
    const pawn = layer.puppetAt('e2')!;
    layer.retire(pawn.id);
    pawn.group.visible = false;
    const before = new Game('3QK3/8/8/8/8/8/8/k7 w - - 0 1');
    layer.reset(before.pieces());
    const queen = layer.puppetAt('d8')!;
    const was = queen.group.position.clone();
    opening.remember();
    layer.reset(new Game('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1').pieces());
    for (const p of layer.standing()) home.set(p, p.group.position.clone());
    opening.start('short');
    // At first something stands where the queen stood: the pawn, on its way back.
    expect([...layer.standing()].some((p) => p.group.visible && p.group.position.distanceTo(was) < 1e-6)).toBe(true);
    play(opening);
    expectSetOut(layer);
  });

  it('can be finished at any moment of the return, with the new game set out', () => {
    for (const stop of [0.05, 0.3, 0.65, 1.2]) {
      const { layer, opening } = setup();
      opening.start('none');
      opening.remember();
      layer.reset(new Game('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1').pieces());
      for (const p of layer.standing()) home.set(p, p.group.position.clone());
      opening.start('short');
      for (let t = 0; t < stop; t += DT) opening.update(DT);
      opening.finish();
      expect(opening.running).toBe(false);
      expectSetOut(layer);
      expect(layer.count).toBe(3);
    }
  });

  it('moves the lid, the clasp and the drawers in curves that start and end where they should', () => {
    expect(lidAt(0)).toBe(SHUT);
    expect(claspAt(0)).toBe(SHUT);
    expect(drawerAt(0)).toBe(0);
    expect(lidAt(10)).toBeCloseTo(0, 9);
    expect(claspAt(10)).toBeCloseTo(0, 9);
    expect(drawerAt(10)).toBe(1);
    // The lid is lifted before it goes over, and never past the altar.
    expect(lidAt(0.55)).toBeLessThan(SHUT);
    for (let t = 0; t < 4; t += 0.01) expect(lidAt(t)).toBeGreaterThanOrEqual(0);
    // A drawer runs out a little too far before it settles.
    let most = 0;
    for (let t = 0; t < 1; t += 0.01) most = Math.max(most, drawerAt(t));
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThan(1.15);
  });
});
