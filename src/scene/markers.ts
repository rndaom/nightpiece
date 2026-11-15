/**
 * Flat light drawn on the squares. This is how the board carries the rules:
 * a move, a capture and a square where the piece would be lost never share
 * a look (style bible, sections 7.3 and 8).
 */
import {
  AddEquation,
  CanvasTexture,
  CustomBlending,
  DstColorFactor,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  SRGBColorSpace,
  SrcAlphaFactor,
  type Texture,
} from 'three';
import { fileOf, rankOf, type Square } from '../core/game';
import { squareCenter } from './layout';
import { Easing, clamp01 } from './tween';

export type MarkKind = 'move' | 'capture' | 'risk' | 'captureRisk' | 'origin' | 'last' | 'check' | 'hover' | 'target' | 'hint' | 'victim';
export type MarkLayer = 'last' | 'options' | 'check' | 'hover' | 'hint';

export interface Mark {
  square: Square;
  kind: MarkKind;
  /** Seconds before this mark starts to appear, for staggered reveals. */
  delay?: number;
}

/** a1 is a dark square, and the colours alternate from there. */
export function isPale(square: Square): boolean {
  return (fileOf(square) + rankOf(square)) % 2 === 1;
}

const LAYER_HEIGHT: Record<MarkLayer, number> = { last: 0.004, options: 0.006, check: 0.008, hover: 0.01, hint: 0.012 };
const SIZE = 256;

/**
 * A square is dark or pale, and a mark has to read on both. On the dark squares it is light laid
 * on stone: a cream wash and a border hot enough to bloom. On the pale ones more light would not
 * show, since the stone is as bright as the picture goes, so the same shapes are stained into it
 * instead: these textures are multiplied into the stone (see `dress`), honey for a wash and umber
 * for a line, and what they say is how much of the stone's light to keep. `pale` asks for the
 * stain.
 */
type Paint = (c: CanvasRenderingContext2D, pale: boolean) => void;

/** A line stained into pale stone: two dark edges with a seam of the colour between them. */
function inlaid(c: CanvasRenderingContext2D, edge: string, colour: string, width: number, draw: () => void): void {
  c.strokeStyle = edge;
  c.lineWidth = width + 10;
  draw();
  c.strokeStyle = colour;
  c.lineWidth = width;
  draw();
}

function square(c: CanvasRenderingContext2D, inset: number): () => void {
  return () => c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
}

function brackets(c: CanvasRenderingContext2D, pale: boolean): void {
  const inset = 16;
  const length = 60;
  c.lineCap = 'butt';
  const corners = (): void => {
    for (const [cx, cy, dx, dy] of [
      [inset, inset, 1, 1],
      [SIZE - inset, inset, -1, 1],
      [inset, SIZE - inset, 1, -1],
      [SIZE - inset, SIZE - inset, -1, -1],
    ] as const) {
      c.beginPath();
      c.moveTo(cx + dx * length, cy);
      c.lineTo(cx, cy);
      c.lineTo(cx, cy + dy * length);
      c.stroke();
    }
  };
  if (pale) {
    inlaid(c, '#7a2412', '#ef6a44', 7, corners);
    return;
  }
  c.strokeStyle = '#d0634a';
  c.lineWidth = 11;
  c.shadowColor = '#d0634a';
  c.shadowBlur = 16;
  corners();
  c.shadowBlur = 0;
}

function hatch(c: CanvasRenderingContext2D, pale: boolean): void {
  const inset = 14;
  c.save();
  c.beginPath();
  c.rect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  c.clip();
  c.strokeStyle = pale ? 'rgba(136,96,204,0.95)' : 'rgba(146,110,190,0.8)';
  c.lineWidth = pale ? 9 : 7;
  for (let d = -SIZE; d < SIZE * 2; d += 26) {
    c.beginPath();
    c.moveTo(d, SIZE);
    c.lineTo(d + SIZE, 0);
    c.stroke();
  }
  c.restore();
  c.strokeStyle = pale ? '#6a48a2' : '#8a68b4';
  c.lineWidth = pale ? 6 : 5;
  c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
}

const PAINT: Record<MarkKind, Paint> = {
  move(c, pale) {
    const inset = 14;
    if (pale) {
      c.fillStyle = 'rgba(238,202,142,0.78)';
      c.fillRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
      inlaid(c, '#8a6226', '#ffe9bc', 3, square(c, inset + 3));
      return;
    }
    // A wash of candle light with a hot edge. The wash stays thin so the square under it still
    // reads as dark from straight overhead, with its mist showing through.
    c.fillStyle = 'rgba(234,219,176,0.2)';
    c.fillRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
    c.shadowColor = '#eadbb0';
    c.shadowBlur = 18;
    c.strokeStyle = '#fffeee';
    c.lineWidth = 6;
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  },
  capture: brackets,
  risk: hatch,
  captureRisk(c, pale) {
    hatch(c, pale);
    brackets(c, pale);
  },
  origin(c, pale) {
    const inset = 16;
    c.strokeStyle = pale ? '#8a6226' : 'rgba(234,219,176,0.9)';
    c.lineWidth = pale ? 6 : 5;
    c.setLineDash([22, 15]);
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  },
  last(c, pale) {
    const inset = 12;
    c.fillStyle = pale ? 'rgba(236,206,152,0.5)' : 'rgba(234,219,176,0.11)';
    c.fillRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
    c.strokeStyle = pale ? 'rgba(150,112,56,0.7)' : 'rgba(234,219,176,0.34)';
    c.lineWidth = pale ? 4 : 3;
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  },
  // Drawn larger than its square (see MARK_SCALE) so the glow spills around the king's base.
  check(c, pale) {
    const g = c.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.1, SIZE / 2, SIZE / 2, SIZE * 0.5);
    g.addColorStop(0, pale ? 'rgba(170,128,226,0.95)' : 'rgba(176,134,228,0.95)');
    g.addColorStop(0.45, pale ? 'rgba(170,136,214,0.7)' : 'rgba(128,92,170,0.6)');
    g.addColorStop(1, 'rgba(113,82,148,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, SIZE, SIZE);
    const side = SIZE / 1.9;
    const frame = (): void => c.strokeRect((SIZE - side) / 2, (SIZE - side) / 2, side, side);
    if (pale) {
      inlaid(c, '#553684', '#d9c2ff', 3, frame);
      return;
    }
    c.shadowColor = '#b99be6';
    c.shadowBlur = 14;
    c.strokeStyle = 'rgba(214,190,250,0.95)';
    c.lineWidth = 5;
    frame();
  },
  hover(c, pale) {
    c.strokeStyle = pale ? 'rgba(138,104,52,0.75)' : 'rgba(255,254,238,0.5)';
    c.lineWidth = 3;
    c.strokeRect(10, 10, SIZE - 20, SIZE - 20);
  },
  // A suggestion: a gilt square set on its corner inside the tile.
  hint(c, pale) {
    const mid = SIZE / 2;
    const reach = SIZE / 2 - 22;
    const outline = (): void => {
      c.beginPath();
      c.moveTo(mid, mid - reach);
      c.lineTo(mid + reach, mid);
      c.lineTo(mid, mid + reach);
      c.lineTo(mid - reach, mid);
      c.closePath();
    };
    const diamond = (): void => {
      outline();
      c.stroke();
    };
    if (pale) {
      c.fillStyle = 'rgba(244,184,72,0.85)';
      outline();
      c.fill();
      inlaid(c, '#6a3f06', '#ffcf66', 5, diamond);
      return;
    }
    c.shadowColor = '#f0c878';
    c.shadowBlur = 20;
    c.strokeStyle = '#ffe2a0';
    c.lineWidth = 7;
    diamond();
    diamond();
    c.shadowBlur = 0;
    c.fillStyle = 'rgba(240,200,120,0.16)';
    c.fill();
  },
  // The pawn that a capture in passing removes: it stands beside the square the capture lands on.
  victim(c, pale) {
    const inset = 30;
    c.strokeStyle = pale ? '#b8401f' : '#d0634a';
    c.shadowColor = '#d0634a';
    c.shadowBlur = pale ? 0 : 12;
    c.lineWidth = 7;
    c.setLineDash([16, 12]);
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  },
  // The lit square under the pointer: the bright state, laid over the dim one.
  target(c, pale) {
    const inset = 14;
    if (pale) {
      c.fillStyle = 'rgba(238,194,116,0.92)';
      c.fillRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
      inlaid(c, '#6e4a14', '#fff0c8', 5, square(c, inset + 3));
      return;
    }
    c.fillStyle = 'rgba(244,232,196,0.42)';
    c.fillRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
    c.shadowColor = '#fffeee';
    c.shadowBlur = 22;
    c.strokeStyle = '#fffeee';
    c.lineWidth = 7;
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
    c.strokeRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
  },
};

interface Live {
  layer: MarkLayer;
  kind: MarkKind;
  /** Whether it lies on a pale square, where on the finished board it is stained into the stone rather than lit. */
  pale: boolean;
  mesh: Mesh;
  material: MeshBasicMaterial;
  target: 0 | 1;
  /** Seconds since this mark was asked to appear, negative while it waits out its delay. */
  age: number;
  /** Current visibility, 0 to 1. */
  value: number;
  /** Visibility when the current fade began. */
  from: number;
  /** Size relative to one square. */
  size: number;
}

/** Marks that are drawn larger than one square. */
const MARK_SCALE: Partial<Record<MarkKind, number>> = { check: 1.9 };
const APPEAR = 0.16;
const FADE = 0.2;

export class Markers {
  readonly root = new Group();
  private geometry = new PlaneGeometry(1, 1);
  private textures = new Map<string, CanvasTexture>();
  private live = new Map<string, Live>();
  private boost = 1;
  /**
   * Whether the pale squares are honed stone, as bright as the picture goes. They are not on the
   * board that stands in while the room loads, where every mark is light.
   */
  private stone = false;
  /**
   * Two marks that are never shown, one drawn each of the two ways. A mark's material is thrown
   * away when it fades, and the last one to go would take its shader program with it, to be built
   * again for the next stone chosen. These hold the programs for as long as the board stands.
   */
  private keepers: Mesh[] = [];

  constructor() {
    this.root.name = 'markers';
  }

  /** Scale the marks' brightness. Above 1, their hot borders pass the bloom threshold. */
  setBoost(boost: number): void {
    this.boost = boost;
    for (const live of this.live.values()) live.material.color.setScalar(this.intensity(live.kind, live.pale && this.stone));
  }

  /** Say that the finished board is in: from here on, marks on its pale squares are stains. */
  setStone(on: boolean): void {
    if (this.stone === on) return;
    this.stone = on;
    for (const live of this.live.values()) if (live.pale) this.dress(live.material, live.kind, live.pale);
  }

  /** Light on a dark square is pushed until its border blooms. A stain is used as painted. */
  private intensity(kind: MarkKind, stained: boolean): number {
    return stained || kind === 'hover' || kind === 'last' || kind === 'origin' ? 1 : this.boost;
  }

  /**
   * Give a mark's material the look for where it lies. Light is laid over the square in the usual
   * way. A stain is multiplied into the stone by as much as the mark is opaque there, so that
   * however brightly the square is lit the stain keeps its colour and its depth.
   */
  private dress(material: MeshBasicMaterial, kind: MarkKind, pale: boolean): void {
    const stained = pale && this.stone;
    material.map = this.texture(kind, stained);
    material.blending = stained ? CustomBlending : NormalBlending;
    material.blendEquation = AddEquation;
    material.blendSrc = stained ? DstColorFactor : SrcAlphaFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.premultipliedAlpha = stained;
    material.color.setScalar(this.intensity(kind, stained));
    material.needsUpdate = true;
  }

  /** Replace every mark in a layer. Marks that stay keep their state; the rest ease in or out. */
  set(layer: MarkLayer, marks: Mark[]): void {
    const wanted = new Map<string, Mark>();
    for (const m of marks) wanted.set(`${layer}:${m.kind}:${m.square}`, m);

    for (const [key, live] of this.live) {
      if (live.layer !== layer || wanted.has(key) || live.target === 0) continue;
      live.target = 0;
      live.from = live.value;
      live.age = 0;
    }
    for (const [key, m] of wanted) {
      const existing = this.live.get(key);
      if (existing) {
        if (existing.target === 0) {
          existing.target = 1;
          existing.from = existing.value;
          existing.age = -(m.delay ?? 0);
        }
        continue;
      }
      const pale = isPale(m.square);
      const material = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, opacity: 0 });
      this.dress(material, m.kind, pale);
      const mesh = new Mesh(this.geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      // Lit squares sit a hair off the grid, as if laid down by hand.
      const skew = m.kind === 'hover' || m.kind === 'last' ? 0 : (((fileOf(m.square) * 7 + rankOf(m.square) * 13) % 9) - 4) * 0.006;
      mesh.rotation.z = skew;
      squareCenter(m.square, mesh.position);
      mesh.position.y = LAYER_HEIGHT[layer];
      mesh.renderOrder = 2;
      this.root.add(mesh);
      this.live.set(key, {
        layer,
        kind: m.kind,
        pale,
        mesh,
        material,
        target: 1,
        age: -(m.delay ?? 0),
        value: 0,
        from: 0,
        size: MARK_SCALE[m.kind] ?? 1,
      });
    }
  }

  update(dt: number, time: number): void {
    for (const [key, live] of this.live) {
      live.age += dt;
      if (live.age >= 0) {
        if (live.target === 1) {
          live.value = live.from + (1 - live.from) * Easing.outCubic(clamp01(live.age / APPEAR));
        } else {
          live.value = live.from * (1 - Easing.inOutSine(clamp01(live.age / FADE)));
          if (live.age >= FADE) {
            this.root.remove(live.mesh);
            live.material.dispose();
            this.live.delete(key);
            continue;
          }
        }
      }
      const pulse =
        live.layer === 'hint'
          ? 0.72 + 0.28 * Math.sin(time * 3.4)
          : live.layer === 'options' || live.layer === 'check'
            ? 0.9 + 0.1 * Math.sin(time * 2.4 + live.mesh.position.x)
            : 1;
      live.material.opacity = live.value * pulse;
      const s = (0.86 + 0.14 * live.value) * live.size;
      live.mesh.scale.set(s, s, 1);
    }
  }

  /**
   * Paint every mark there is and hand it to the graphics card now, so that the first stone a
   * player chooses does not wait while its marks are made. For once the board is in.
   */
  warm(renderer: { initTexture(texture: Texture): void }): void {
    for (const kind of Object.keys(PAINT) as MarkKind[]) {
      renderer.initTexture(this.texture(kind, false));
      if (this.stone) renderer.initTexture(this.texture(kind, true));
    }
    if (this.keepers.length > 0) return;
    for (const pale of this.stone ? [false, true] : [false]) {
      const material = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, opacity: 0 });
      this.dress(material, 'hover', pale);
      const keeper = new Mesh(this.geometry, material);
      keeper.visible = false;
      this.root.add(keeper);
      this.keepers.push(keeper);
    }
  }

  private texture(kind: MarkKind, stained: boolean): CanvasTexture {
    const key = `${kind}:${stained ? 'stain' : 'light'}`;
    let t = this.textures.get(key);
    if (!t) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      PAINT[kind](canvas.getContext('2d')!, stained);
      t = new CanvasTexture(canvas);
      t.colorSpace = SRGBColorSpace;
      this.textures.set(key, t);
    }
    return t;
  }
}
