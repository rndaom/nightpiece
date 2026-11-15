/**
 * The grey-box room: a plain block the size of the case, carrying the 64
 * squares, the altar it stands on, a floor with a chalk sigil, and four
 * candles. The finished room comes from Blender; this stands in with painted
 * canvas textures while it loads, and in its place if it cannot.
 */
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';
import { SLAB_HALF } from './layout';

/** The case, from its playing surface down to the altar, and the altar it stands on. */
const SLAB_THICKNESS = 1.0;
const PLINTH_HALF = 6.2;
const PLINTH_HEIGHT = 2.0;
/** The width of the rim round the squares. */
const RIM = SLAB_HALF - 4;
export const FLOOR_Y = -(SLAB_THICKNESS + PLINTH_HEIGHT);
const FLOOR_RADIUS = 46;
const MONO = '"DM Mono", ui-monospace, Consolas, monospace';
const CANDLE_INTENSITY = 1.15;

/** Small deterministic generator so the painted textures are identical on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grain(c: CanvasRenderingContext2D, w: number, h: number, seed: number, amount: number, size: number): void {
  const r = rng(seed);
  const n = Math.round(((w * h) / (size * size)) * 0.5);
  for (let i = 0; i < n; i++) {
    const v = r();
    c.fillStyle =
      v > 0.5 ? `rgba(255,250,235,${amount * (v - 0.5) * 2})` : `rgba(0,0,0,${amount * (0.5 - v) * 2.4})`;
    c.fillRect(r() * w, r() * h, size * (0.6 + r()), size * (0.6 + r()));
  }
}

function blotches(c: CanvasRenderingContext2D, w: number, h: number, seed: number, count: number, alpha: number): void {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = r() * w;
    const y = r() * h;
    const radius = (0.06 + r() * 0.22) * Math.max(w, h);
    const g = c.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, r() > 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,248,230,${alpha * 0.7})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }
}

/** The slab's top face, drawn like a plan: Ivory's side at the bottom, the a-file on the left. */
function paintBoardTop(canvas: HTMLCanvasElement): void {
  const S = canvas.width;
  const u = S / (SLAB_HALF * 2);
  const c = canvas.getContext('2d')!;
  const r = rng(11);

  // The walnut of the case's rim.
  c.fillStyle = '#3b2f2b';
  c.fillRect(0, 0, S, S);
  blotches(c, S, S, 5, 16, 0.1);

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const light = (file + rank) % 2 === 1;
      const jitter = (r() - 0.5) * 9;
      const base = light ? [139, 132, 115] : [32, 31, 28];
      c.fillStyle = `rgb(${base.map((v) => Math.round(v + jitter * (light ? 1 : 0.4))).join(',')})`;
      c.fillRect((RIM + file) * u, (RIM + (7 - rank)) * u, u, u);
    }
  }
  c.save();
  c.beginPath();
  c.rect(RIM * u, RIM * u, 8 * u, 8 * u);
  c.clip();
  blotches(c, S, S, 9, 22, 0.08);
  c.restore();
  grain(c, S, S, 31, 0.08, S / 820);

  // Hairline joints between the squares.
  for (let i = 0; i <= 8; i++) {
    const p = (RIM + i) * u;
    c.fillStyle = 'rgba(10,9,8,0.7)';
    c.fillRect(p - 1, RIM * u, 2, 8 * u);
    c.fillRect(RIM * u, p - 1, 8 * u, 2);
  }
  c.strokeStyle = 'rgba(255,246,222,0.16)';
  c.lineWidth = 2;
  c.strokeRect(1, 1, S - 2, S - 2);

  // Coordinates, readable from each player's own side.
  c.fillStyle = 'rgba(201,164,92,0.78)';
  c.font = `500 ${Math.round(u * 0.17)}px ${MONO}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const label = (text: string, x: number, y: number, flipped: boolean) => {
    c.save();
    c.translate(x, y);
    if (flipped) c.rotate(Math.PI);
    c.fillText(text, 0, 0);
    c.restore();
  };
  for (let i = 0; i < 8; i++) {
    const along = (RIM + 0.5 + i) * u;
    const near = (8 + 1.5 * RIM) * u;
    label('abcdefgh'.charAt(i), along, near, false);
    label('abcdefgh'.charAt(i), along, (RIM / 2) * u, true);
    label(String(8 - i), (RIM / 2) * u, along, false);
    label(String(8 - i), near, along, true);
  }
}

/** A chalk circle with tick marks and glyphs, drawn on the floor around the plinth. */
export function paintSigil(canvas: HTMLCanvasElement): void {
  const S = canvas.width;
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, S, S);
  c.translate(S / 2, S / 2);
  const R = S * 0.46;
  c.strokeStyle = 'rgba(236,227,204,0.5)';
  c.lineWidth = S / 420;
  c.setLineDash([S / 40, S / 180, S / 300, S / 180]);
  c.beginPath();
  c.arc(0, 0, R * 0.9, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  c.beginPath();
  c.arc(0, 0, R, 0, Math.PI * 2);
  c.stroke();
  for (let i = 0; i < 64; i++) {
    const a = (i * Math.PI) / 32;
    const inner = R * 0.9;
    const outer = i % 4 === 0 ? R : R * 0.925;
    c.beginPath();
    c.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    c.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
    c.stroke();
  }
  const g = S / 110;
  for (let i = 0; i < 16; i++) {
    c.save();
    c.rotate((i * Math.PI) / 8 + Math.PI / 16);
    c.translate(R * 0.95, 0);
    c.rotate(Math.PI / 2);
    c.beginPath();
    if (i % 4 === 0) {
      c.moveTo(-g, g * 0.8);
      c.lineTo(0, -g);
      c.lineTo(g, g * 0.8);
      c.closePath();
    } else if (i % 4 === 1) {
      c.arc(0, 0, g * 0.85, 0.6, 5.2);
    } else if (i % 4 === 2) {
      c.moveTo(-g, 0);
      c.lineTo(g, 0);
      c.moveTo(0, -g);
      c.lineTo(0, g);
    } else {
      c.rect(-g * 0.75, -g * 0.75, g * 1.5, g * 1.5);
    }
    c.stroke();
    c.restore();
  }
}

interface Candle {
  light: PointLight;
  flame: Mesh;
  phase: number;
}

export class Board {
  readonly root = new Group();
  private topCanvas = document.createElement('canvas');
  private topTexture: CanvasTexture;
  private candles: Candle[] = [];

  constructor(anisotropy: number) {
    this.root.name = 'board';

    this.topCanvas.width = this.topCanvas.height = 2048;
    paintBoardTop(this.topCanvas);
    this.topTexture = new CanvasTexture(this.topCanvas);
    this.topTexture.colorSpace = SRGBColorSpace;
    this.topTexture.anisotropy = anisotropy;

    const top = new Mesh(
      new PlaneGeometry(SLAB_HALF * 2, SLAB_HALF * 2),
      new MeshStandardMaterial({ map: this.topTexture, roughness: 0.78, metalness: 0.04 }),
    );
    top.rotation.x = -Math.PI / 2;
    top.receiveShadow = true;
    this.root.add(top);

    const concrete = new MeshStandardMaterial({ color: 0x3b2f2b, roughness: 0.7 });
    const slab = new Mesh(new BoxGeometry(SLAB_HALF * 2, SLAB_THICKNESS, SLAB_HALF * 2), concrete);
    slab.position.y = -SLAB_THICKNESS / 2 - 0.003;
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.root.add(slab);

    const plinth = new Mesh(
      new BoxGeometry(PLINTH_HALF * 2, PLINTH_HEIGHT, PLINTH_HALF * 2),
      new MeshStandardMaterial({ color: 0x2b2924, roughness: 0.95 }),
    );
    plinth.position.y = -SLAB_THICKNESS - PLINTH_HEIGHT / 2;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    this.root.add(plinth);

    // The floor fades to the background colour with distance from the plinth, so the room has
    // no visible edge from any camera. (Distance fog would also dim the board from high views.)
    const fadeCanvas = document.createElement('canvas');
    fadeCanvas.width = fadeCanvas.height = 512;
    const fc = fadeCanvas.getContext('2d')!;
    const fade = fc.createRadialGradient(256, 256, 0, 256, 256, 256);
    fade.addColorStop(0, '#ffffff');
    fade.addColorStop(0.22, '#e9e9e9');
    fade.addColorStop(0.5, '#6a6a6a');
    fade.addColorStop(0.8, '#121212');
    fade.addColorStop(1, '#000000');
    fc.fillStyle = fade;
    fc.fillRect(0, 0, 512, 512);
    const fadeTexture = new CanvasTexture(fadeCanvas);
    fadeTexture.colorSpace = SRGBColorSpace;
    const floor = new Mesh(
      new CircleGeometry(FLOOR_RADIUS, 64),
      new MeshStandardMaterial({ color: 0x2a2824, roughness: 0.97, map: fadeTexture }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    this.root.add(floor);

    const sigilCanvas = document.createElement('canvas');
    sigilCanvas.width = sigilCanvas.height = 1024;
    paintSigil(sigilCanvas);
    const sigilTexture = new CanvasTexture(sigilCanvas);
    sigilTexture.colorSpace = SRGBColorSpace;
    sigilTexture.anisotropy = anisotropy;
    const sigil = new Mesh(
      new PlaneGeometry(25, 25),
      new MeshBasicMaterial({ map: sigilTexture, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    sigil.rotation.x = -Math.PI / 2;
    sigil.position.y = FLOOR_Y + 0.01;
    this.root.add(sigil);

    const wax = new MeshStandardMaterial({ color: 0xb9ae93, roughness: 0.6 });
    const flameMaterial = new MeshBasicMaterial({ color: 0xffdfa8, toneMapped: false });
    const ledge = -SLAB_THICKNESS;
    const corner = 5.5;
    [
      [-1, -1, 0.78],
      [1, -1, 0.62],
      [-1, 1, 0.66],
      [1, 1, 0.84],
    ].forEach(([sx, sz, height], i) => {
      const x = sx! * corner;
      const z = sz! * corner;
      const body = new Mesh(new CylinderGeometry(0.105, 0.125, height!, 12), wax);
      body.position.set(x, ledge + height! / 2, z);
      body.castShadow = true;
      this.root.add(body);
      const flame = new Mesh(new SphereGeometry(0.055, 10, 8), flameMaterial);
      flame.scale.set(1, 1.9, 1);
      flame.position.set(x, ledge + height! + 0.1, z);
      this.root.add(flame);
      const light = new PointLight(0xffbe86, CANDLE_INTENSITY, 9, 2);
      light.position.set(x, ledge + height! + 0.16, z);
      this.root.add(light);
      this.candles.push({ light, flame, phase: i * 1.9 });
    });
  }

  /** Repaint the coordinates once the webfont is available. */
  refreshLabels(): void {
    paintBoardTop(this.topCanvas);
    this.topTexture.needsUpdate = true;
  }

  /** Candle flicker. `calm` is 1 for a steady flame and 0 for a guttering one. */
  update(time: number, calm = 1): void {
    for (const c of this.candles) {
      const slow = Math.sin(time * 2.3 + c.phase) * Math.sin(time * 3.7 + c.phase * 1.3);
      const fast = Math.sin(time * 11 + c.phase * 2.1);
      const flicker = 1 + (0.07 + 0.2 * (1 - calm)) * slow + 0.03 * fast;
      c.light.intensity = CANDLE_INTENSITY * flicker;
      c.flame.scale.set(1, 1.9 * (0.94 + 0.1 * flicker), 1);
    }
  }
}
