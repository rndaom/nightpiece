/**
 * What the hands know of a stone's shape (src/hands/girth.ts), tried on a
 * shape made for the purpose: a round foot, a thin neck, and a square head
 * with flats and corners.
 */
import { BoxGeometry, type BufferGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import { Girth } from '../src/hands/girth.ts';

/** The foot is 0.3 across from its plumb line and stands to 0.5; the neck 0.1, to 0.8; the head 0.2 to its flats, to 1.1. */
function stone(): BufferGeometry {
  return mergeGeometries([
    new CylinderGeometry(0.3, 0.3, 0.5, 48).translate(0, 0.25, 0),
    new CylinderGeometry(0.1, 0.1, 0.3, 48).translate(0, 0.65, 0),
    new BoxGeometry(0.4, 0.3, 0.4).translate(0, 0.95, 0),
  ]);
}

const girth = new Girth(stone());
const CORNER = Math.hypot(0.2, 0.2);

/** The stone is kept in bands a fiftieth of a square tall, so a height is known no more closely than that: never short, at most a band over. */
function expectHeight(found: number, real: number): void {
  expect(found).toBeGreaterThan(real - 0.011);
  expect(found).toBeLessThan(real + 0.021);
}

describe('the girth of a stone', () => {
  it('says how far the stone reaches at each height, each way round', () => {
    for (const [x, z] of [
      [1, 0],
      [0, 1],
      [-1, -1],
      [0.3, -0.9],
    ]) {
      expect(girth.at(0.25, x!, z!)).toBeCloseTo(0.3, 1.8);
      expect(girth.at(0.65, x!, z!)).toBeCloseTo(0.1, 1.8);
    }
    // The head is square: nearer on its flats than at its corners.
    expect(girth.at(0.95, 1, 0)).toBeGreaterThan(0.195);
    expect(girth.at(0.95, 1, 0)).toBeLessThan(0.215);
    expect(girth.at(0.95, 1, 1)).toBeCloseTo(CORNER, 1.8);
    // Nothing above it, nothing below.
    expect(girth.at(1.2, 1, 0)).toBe(0);
    expect(girth.at(-0.1, 1, 0)).toBe(0);
  });

  it('says how deep a ball is in it', () => {
    // Half its width into the foot, from the side.
    expect(girth.depth(new Vector3(0.35, 0.25, 0), 0.1)).toBeCloseTo(0.05, 1.8);
    // Clear of it by a fifth of a square.
    expect(girth.depth(new Vector3(0.6, 0.25, 0), 0.1)).toBeCloseTo(-0.2, 1.8);
    // Beside the neck but over the foot's shoulder, which it touches with its underside.
    expect(girth.depth(new Vector3(0.25, 0.58, 0), 0.1)).toBeGreaterThan(0.02);
    expect(girth.depth(new Vector3(0.25, 0.68, 0), 0.1)).toBeLessThan(0);
  });

  it('says how high it stands under something passing over', () => {
    // Over the middle of it, the whole of it; farther out, only the foot; clear of it, nothing.
    expectHeight(girth.over(0, 0), 1.1);
    expectHeight(girth.over(0.25, 0), 1.1);
    expectHeight(girth.over(0.29, 0), 0.5);
    expectHeight(girth.over(0.39, 0.1), 0.5);
    expect(girth.over(0.5, 0.1)).toBe(0);
  });

  it('says how wide it is from a height up', () => {
    expect(girth.widest(-Infinity)).toBeCloseTo(0.3, 1.8);
    expect(girth.widest(0.6)).toBeCloseTo(CORNER, 1.8);
    expect(girth.widest(1.2)).toBe(0);
  });

  it('finds the head a hand could close on from above', () => {
    // The square head, which is thick enough all round, and its flats.
    const head = girth.head(0.15)!;
    expectHeight(head.y, 0.95);
    expect(head.half).toBeGreaterThan(0.19);
    expect(head.half).toBeLessThan(0.215);
    // Asked for something thicker than that, it is the foot; thicker than anything, nothing.
    const foot = girth.head(0.25)!;
    expectHeight(foot.y, 0.25);
    expect(foot.half).toBeCloseTo(0.3, 1.8);
    expect(girth.head(0.35)).toBeNull();
    // A part too short to take hold of is passed over.
    expectHeight(girth.head(0.15, 0.4)!.y, 0.25);
  });

  it('says how far the stone goes on from a point inside it', () => {
    const inside = new Vector3(0, 0.95, 0);
    expect(girth.across(inside, 1, 0, 0.6)).toBeGreaterThan(0.19);
    expect(girth.across(inside, 1, 0, 0.6)).toBeLessThan(0.215);
    expect(girth.across(inside, 1, 1, 0.6)).toBeCloseTo(CORNER, 1.8);
    // No farther than it is asked to look; and nothing from a point that is not in the stone.
    expect(girth.across(new Vector3(0, 0.25, 0), 1, 0, 0.1)).toBeCloseTo(0.1, 2);
    expect(girth.across(new Vector3(0.5, 0.95, 0), 1, 0, 0.6)).toBe(0);
  });

  it('is read from whatever a piece is drawn with, once for each shape', () => {
    const shape = stone();
    const one = new Group().add(new Group().add(new Mesh(shape, new MeshBasicMaterial())));
    const other = new Mesh(shape, new MeshBasicMaterial());
    const found = Girth.of(one)!;
    expect(found.mesh.geometry).toBe(shape);
    expectHeight(found.girth.over(0, 0), 1.1);
    expect(Girth.of(other)!.girth).toBe(found.girth);
    expect(Girth.of(new Group())).toBeNull();
  });
});
