/**
 * The case, as the room shows it: the board is a walnut box of two halves on the altar.
 * Void's half stays where it is; Ivory's half is the lid, and turns about the hinge along the
 * middle of the board through half a turn, to lie upside down on Void's when the case is shut.
 * A drawer under each side rail of each half slides out along x, and the taken stones stand in
 * them. The hasp on the front of Void's half holds the lid shut.
 *
 * The meshes come from assets/src/case.py, every one placed as the case stands open with its
 * drawers in. Their materials are made with the room's (materials.ts), because the squares read
 * the same light as the room does.
 */
import { type BufferGeometry, Group, type Material, Mesh } from 'three';
import type { Assets, CaseHalf, DrawerName } from './assets';
import type { CasePose } from './opening';
import { DRAWER_NAMES } from './opening';

export interface CaseMaterials {
  tilesLight: Material;
  tilesDark: Material;
  inlay: Material;
  case: Material;
}

export class Casework {
  readonly root = new Group();
  /** The lid's half hangs from this, which turns about the hinge line. */
  private lid = new Group();
  private drawers = {} as Record<DrawerName, Mesh>;
  private clasp = new Group();
  private travel: number;
  /** Everything that casts a shadow, for the world to know when to draw the shadows again. */
  private last = { lid: -1, clasp: -1, drawers: -1 };

  constructor(assets: Assets, m: CaseMaterials) {
    this.root.name = 'case';
    const b = assets.board;
    this.travel = b.meta.drawer.travel;

    const mesh = (geometry: BufferGeometry, material: Material, name: string, cast: boolean) => {
      const out = new Mesh(geometry, material);
      out.name = name;
      out.castShadow = cast;
      out.receiveShadow = true;
      return out;
    };
    const half = (h: CaseHalf, name: string) => [
      mesh(h.frame, m.case, `${name}_frame`, true),
      mesh(h.tilesLight, m.tilesLight, `${name}_tiles_light`, false),
      mesh(h.tilesDark, m.tilesDark, `${name}_tiles_dark`, false),
      mesh(h.inlay, m.inlay, `${name}_inlay`, false),
    ];
    this.root.add(...half(b.void, 'void'));

    // The lid turns about the hinge line: its parts hang from a pivot there, set back by as much.
    const hinge = b.meta.hinge;
    this.lid.name = 'lid';
    this.lid.position.set(0, hinge.y, hinge.z);
    const lidParts = new Group();
    lidParts.position.set(0, -hinge.y, -hinge.z);
    lidParts.add(...half(b.lid, 'lid'));
    this.lid.add(lidParts);
    this.root.add(this.lid);

    for (const name of DRAWER_NAMES) {
      const drawer = mesh(b.drawers[name], m.case, `drawer_${name}`, true);
      this.drawers[name] = drawer;
      (name.startsWith('lid') ? lidParts : this.root).add(drawer);
    }

    // The hasp turns about its own pin, under the lip of Void's half.
    const [py, pz] = b.meta.clasp.pivot;
    this.clasp.name = 'clasp';
    this.clasp.position.set(0, py, pz);
    const hasp = mesh(b.clasp, m.case, 'clasp', true);
    hasp.position.set(0, -py, -pz);
    this.clasp.add(hasp);
    this.root.add(this.clasp);
  }

  /**
   * Stand the case as `pose` says. Returns true if anything that casts a shadow moved since the
   * last call, so that the shadows can be drawn again.
   */
  apply(pose: CasePose): boolean {
    // Open is 0 and shut is pi; the lid goes up and over toward Void, which is a turn about -x.
    this.lid.rotation.x = -pose.lid;
    // The hasp swings out (toward -z) on its way down from holding the lid.
    this.clasp.rotation.x = pose.clasp;
    let out = 0;
    for (const name of DRAWER_NAMES) {
      const k = pose.drawers[name];
      this.drawers[name].position.x = (name.endsWith('_e') ? 1 : -1) * this.travel * k;
      out += k;
    }
    const moved = pose.lid !== this.last.lid || pose.clasp !== this.last.clasp || out !== this.last.drawers;
    this.last = { lid: pose.lid, clasp: pose.clasp, drawers: out };
    return moved;
  }
}
