/**
 * The finished room, built from the Blender assets: the case on its stone altar, and round it a
 * Gothic chapel of clustered piers and pointed arches, candle niches, tall leaded windows, iron
 * lanterns on the piers, a rose at each end and a doorway under a cross of lancets in each side
 * wall, and a ribbed vault with a square oculus; tallow candles; and the light: one hard shaft
 * through the oculus that falls on the board and little else, a warm low light from Ivory's end
 * of the room and a spirit-green one from Void's (style bible, sections 5 and 9).
 *
 * The light that never moves is baked (assets/src/environment.py) and only coloured here, so
 * the room's four states cost nothing to change between.
 */
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SpotLight,
  type Texture,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { Assets } from './assets';
import { paintSigil } from './board';
import { flicker, Flames } from './flames';
import { roomMaterials } from './materials';
import { Mirror } from './mirror';
import { QUALITY, type Quality, type Shaft } from './post';
import { type RoomLook, setGlass } from './roomshade';
import { shadowRadius, softenShadows } from './shadows';
import { Spring } from './spring';

/** The room's four states (style bible, section 9). */
export type Mood = 'calm' | 'sharp' | 'check' | 'mate';

type Triple = [number, number, number];

/** Everything about the light that changes with the room's state. Colours are linear and carry their own strength. */
interface Look {
  /**
   * The key through the oculus: how much light it lays on the board, and its colour. Round the
   * hard square that falls on the slab there is a softer one: `pool` is half its width and
   * `spill` how strong it is against the key.
   */
  key: number;
  keyColour: Triple;
  pool: number;
  spill: number;
  /** The low lights from the two ends of the room, as what each lays on a face turned toward it at the middle of the board. */
  ivory: Triple;
  void: Triple;
  /** The lit air of the shaft: its colour, and how much dust hangs in it. */
  shaft: Triple;
  dust: number;
  /** Candles: 1 for steady, 0 for guttering; and how brightly they burn at all. */
  steady: number;
  lit: number;
  /** Night sky: what it lays on the room through the openings, and how the openings themselves look. */
  sky: Triple;
  night: Triple;
  /**
   * Void's ring and Ivory's disc, as the light each throws into the room; the slot under the
   * slab, as how bright it is itself; light up through the joints of the board; and light that
   * comes up from the board onto whatever stands on it.
   */
  ring: Triple;
  disc: Triple;
  slot: Triple;
  joint: Triple;
  under: Triple;
  /** The air: its colour toward each end of the room and along the floor, how thick it is, and how much the floor's colour takes over low down. */
  hazeWarm: Triple;
  hazeCool: Triple;
  hazeLow: Triple;
  veil: number;
  low: number;
  /** The mist under the glass, and how much the pieces and tiles get from the room around them. */
  mist: number;
  ambient: number;
}

const SPIRIT: Triple = [0.2, 0.92, 0.74];
const GOLD: Triple = [1.0, 0.6, 0.22];
const times = (c: Triple, k: number): Triple => [c[0] * k, c[1] * k, c[2] * k];

const LOOKS: Record<Mood, Look> = {
  // A cool column on the board with a wide, soft square of light round it; candles steady; gold
  // at one end of the room and green at the other.
  calm: {
    key: 5.4,
    keyColour: [0.86, 0.906, 0.89],
    pool: 9.2,
    spill: 0.2,
    ivory: times([1.0, 0.68, 0.36], 1.15),
    void: times([0.3, 0.95, 0.8], 1.3),
    shaft: [0.4, 0.5, 0.5],
    dust: 0.04,
    steady: 1,
    lit: 1,
    sky: times([0.42, 0.6, 0.82], 0.5),
    night: times([0.3, 0.52, 1.0], 0.85),
    ring: times(SPIRIT, 2.4),
    disc: times(GOLD, 2.4),
    slot: times([0.66, 0.95, 0.88], 0.55),
    joint: [0, 0, 0],
    under: [0, 0, 0],
    hazeWarm: [0.045, 0.03, 0.016],
    hazeCool: [0.012, 0.034, 0.036],
    hazeLow: [0.016, 0.02, 0.02],
    veil: 0.016,
    low: 0.15,
    mist: 1,
    ambient: 1,
  },
  // The soft square draws in until little but the column is left; the green end of the room wins; the candles gutter.
  sharp: {
    key: 5.8,
    keyColour: [0.72, 0.94, 0.9],
    pool: 6.6,
    spill: 0.14,
    ivory: times([1.0, 0.68, 0.36], 1.05),
    void: times([0.2, 0.98, 0.84], 2.4),
    shaft: [0.27, 0.52, 0.49],
    dust: 0.034,
    steady: 0.45,
    lit: 0.9,
    sky: times([0.3, 0.66, 0.8], 0.45),
    night: times([0.2, 0.62, 0.95], 0.85),
    ring: times(SPIRIT, 3.8),
    disc: times(GOLD, 1.6),
    slot: times([0.5, 1.0, 0.86], 1.8),
    joint: [0, 0, 0],
    under: [0, 0, 0],
    hazeWarm: [0.026, 0.028, 0.02],
    hazeCool: [0.008, 0.044, 0.042],
    hazeLow: [0.008, 0.03, 0.028],
    veil: 0.02,
    low: 0.35,
    mist: 1.25,
    ambient: 0.9,
  },
  // Only the slab is lit, and that pale violet; violet lies along the floor and comes up under the slab.
  check: {
    key: 4.7,
    keyColour: [0.86, 0.78, 1.0],
    pool: 5.2,
    spill: 0.05,
    ivory: times([0.9, 0.5, 0.62], 0.7),
    void: times([0.5, 0.52, 1.0], 1.2),
    shaft: [0.46, 0.32, 0.7],
    dust: 0.046,
    steady: 0.2,
    lit: 0.5,
    sky: times([0.46, 0.42, 0.9], 0.4),
    night: times([0.4, 0.34, 1.0], 0.9),
    ring: times([0.42, 0.5, 1.0], 2.4),
    disc: times([0.9, 0.42, 0.5], 1.2),
    slot: times([0.6, 0.4, 1.0], 4.2),
    joint: times([0.55, 0.34, 1.0], 0.5),
    under: times([0.55, 0.36, 1.0], 0.5),
    hazeWarm: [0.034, 0.018, 0.044],
    hazeCool: [0.022, 0.02, 0.062],
    hazeLow: [0.04, 0.018, 0.085],
    veil: 0.022,
    low: 0.85,
    mist: 1.3,
    ambient: 0.75,
  },
  // The light all but goes. What is left comes up out of the board.
  mate: {
    key: 0.45,
    keyColour: [0.7, 0.62, 1.0],
    pool: 5.0,
    spill: 0,
    ivory: times([0.8, 0.4, 0.7], 0.4),
    void: times([0.5, 0.42, 1.0], 1.2),
    shaft: [0.4, 0.26, 0.66],
    dust: 0.075,
    steady: 0,
    lit: 0.04,
    sky: times([0.38, 0.3, 0.9], 0.24),
    night: times([0.34, 0.26, 1.0], 0.7),
    ring: times([0.4, 0.4, 1.0], 1.4),
    disc: times([0.7, 0.3, 0.6], 0.3),
    slot: times([0.6, 0.36, 1.0], 10),
    joint: times([0.55, 0.32, 1.0], 1.5),
    under: times([0.6, 0.36, 1.0], 1.6),
    hazeWarm: [0.018, 0.008, 0.036],
    hazeCool: [0.014, 0.008, 0.045],
    hazeLow: [0.03, 0.01, 0.085],
    veil: 0.022,
    low: 1,
    mist: 1.7,
    ambient: 0.4,
  },
};

/** The order a look's numbers are laid out in, one spring to each. */
const FIELDS = Object.keys(LOOKS.calm) as (keyof Look)[];
const flatten = (l: Look): number[] => FIELDS.flatMap((k) => l[k]);

/** Candle flame, as the colour of the light it gives. */
const FLAME: Triple = [1.0, 0.56, 0.22];
/**
 * How strong a real light each tall candle at the corners of the board is, in candela: enough
 * that each cluster lays a warm pool on the altar round it and a warm side on the nearest rook,
 * against the key's cold (the key's soft square is drawn in for the same reason: see `spill`).
 */
const CANDLE_INTENSITY = 24;
/** How much more the niche candles give the walls than they were baked giving. */
const NICHE_LIGHT = 1.7;
/** The low lights at the ends of the room stand this far from the middle of the board. */
const RIM = new Vector3(4, 5.2, 15);
const RIM_REACH = 36;
/** Half the width of what the key's light is drawn across, at the height of the board. */
const KEY_REACH = 10.6;
/**
 * The key does not fall plumb. It leans by this much (radians), from the h-file's side of the
 * room and from Void's end of it (`KEY_BEARING`, measured from the h-file's side round toward
 * Ivory's end, so it is negative): so every stone lays a shadow as long as two thirds of its own
 * height across the squares beside it, and has a lit side and a dark one, where under a plumb
 * light its shadow hid beneath it and all its sides were the same grey. From Ivory's seat the
 * light comes over the far right corner: the stones are lit from behind and beside, their shadows
 * fall toward the player, and the faces turned to the seat are filled by the candle gold from
 * that end of the room. From Void's seat it comes over the player's shoulder. The Side view
 * stands on the side it comes from, with the shadows falling away to the left.
 */
const KEY_LEAN = 0.62;
const KEY_BEARING = -0.85;
/** How wide the edge of the key's shadows is, on the board. */
const KEY_SOFT = 0.05;

export class Chapel {
  readonly root = new Group();
  readonly key: SpotLight;
  /** How high each square's tile stands. Written by the board's effects, read by the tiles' material. */
  readonly tileLift: Float32Array;
  /** How far each square's face has got in breaking up. Written by the board's effects, read by the tiles' material. */
  readonly tileCrumble: Float32Array;
  /** How much the pieces and tiles get from the room around them, for the scene's environment. */
  ambient = 1;
  /** The shaft of light as it is this frame, for the pass that draws its lit air. */
  readonly shaft: Shaft;
  private shade: RoomLook;
  private gains: Assets['room']['gains'];
  private keyUnit: number;
  private keyHeight: number;
  private beam: number;
  private slotGlow: number;
  /** The board's materials are made here with the room's, as they read the same light; the case uses them. */
  readonly materials: ReturnType<typeof roomMaterials>;
  private flames: Flames;
  private candleLights: { light: PointLight; phase: number }[] = [];
  private rims: [SpotLight, SpotLight];
  private under: HemisphereLight;
  private sky: MeshBasicMaterial;
  private motes: ShaderMaterial;
  private moteCloud: Points;
  /** The square the key falls in, drawn into a small texture that the light shines through. */
  private cookie = new WebGLRenderTarget(512, 512, { depthBuffer: false });
  private cookieQuad: FullScreenQuad;
  private cookieDrawn = -1;
  /** How far the key hangs from the middle of the board, along its own line. */
  private keyAway: number;
  private mirror: Mirror | null = null;
  private width = 1;
  private height = 1;
  /** What never appears in the dark squares' reflection: the board itself, and whatever is under it. */
  private unmirrored: Object3D[] = [];
  private hands: Object3D | null = null;
  private hidden: Object3D[] = [];
  private shellNear: Mesh;
  private shellFar: Mesh;
  /** The current look, as one spring to each number, easing toward the state asked for. */
  private look = flatten(LOOKS.calm).map((v) => new Spring(v));
  private now: Look = structuredClone(LOOKS.calm);

  constructor(assets: Assets, anisotropy: number, quality: Quality) {
    this.root.name = 'chapel';
    const r = assets.room;
    this.gains = r.gains;
    this.keyUnit = r.keyUnit;
    this.keyHeight = r.keyHeight;
    this.beam = r.beam;
    this.slotGlow = r.slotGlow;
    this.shaft = { beam: r.beam, height: r.keyHeight, top: r.ceiling + 2, lean: new Vector2(), colour: new Color(), dust: 0, time: 0 };

    // Chalk on the floor around the altar: part of the floor's own colour, so the light falls on it as on the rest.
    const sigilCanvas = document.createElement('canvas');
    sigilCanvas.width = sigilCanvas.height = 1024;
    paintSigil(sigilCanvas);
    const sigil = new CanvasTexture(sigilCanvas);
    sigil.anisotropy = anisotropy;

    const m = roomMaterials(assets, sigil);
    this.materials = m;
    this.shade = m.look;
    this.tileLift = m.tileLift;
    this.tileCrumble = m.tileCrumble;

    const add = (geometry: BufferGeometry, material: Mesh['material'], cast: boolean, receive: boolean, name: string) => {
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      this.root.add(mesh);
      return mesh;
    };
    // The board is the case, which the world builds (casework.ts) from these materials.
    const plinth = add(r.plinth, m.plinth, true, true, 'plinth');
    const floor = add(r.floor, m.floor, false, true, 'floor');
    // The key hangs above the ceiling and the square it falls in is drawn, not cut by the oculus,
    // so the walls and ceiling cast nothing.
    this.shellNear = add(r.shell, m.shell, false, false, 'shell');
    // What the board's mirror draws in the shell's place: the same walls with a tenth of the triangles.
    this.shellFar = add(r.shellFar, m.shell, false, false, 'shell_far');
    this.shellFar.visible = false;
    add(r.timber, m.timber, false, false, 'timber');
    add(r.metal, m.metal, false, false, 'metal');
    add(r.candles, m.wax, true, false, 'candles');
    const glow = add(r.glow, m.glow, false, false, 'glow');
    this.unmirrored.push(plinth, floor);

    // The sky seen up through the oculus: a bright plane above the opening.
    this.sky = new MeshBasicMaterial({ color: new Color(1, 1, 1) });
    const sky = new Mesh(new PlaneGeometry(r.oculusHalf * 2 + 2, r.oculusHalf * 2 + 2), this.sky);
    sky.rotation.x = Math.PI / 2;
    sky.position.y = r.ceiling + 2.25;
    this.root.add(sky);

    // One cool key from high up, leaning (see KEY_LEAN). It is wider than the square it lights:
    // the square itself is a texture the light shines through, which the room's state can draw in.
    softenShadows();
    const key = new SpotLight(0xffffff, 1, 0, Math.atan(KEY_REACH / this.keyHeight), 0.04, 2);
    const out = this.keyHeight * Math.tan(KEY_LEAN);
    key.position.set(out * Math.cos(KEY_BEARING), this.keyHeight, out * Math.sin(KEY_BEARING));
    key.target.position.set(0, 0, 0);
    this.keyAway = key.position.length();
    this.shaft.lean.set(key.position.x / this.keyHeight, key.position.z / this.keyHeight);
    key.castShadow = true;
    key.shadow.mapSize.setScalar(QUALITY[quality].shadow);
    key.shadow.camera.near = this.keyAway - 14;
    key.shadow.camera.far = this.keyAway + 12;
    // So high a light has no natural "up"; this one lines the texture's sides up with the board's.
    key.shadow.camera.up.set(0, 0, -1);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = shadowRadius(QUALITY[quality].shadow, KEY_REACH, KEY_SOFT);
    key.map = this.cookie.texture;
    this.root.add(key, key.target);
    this.key = key;
    // The square is drawn where it falls on the board, not across the light's own leaning view of it.
    const keyView = new Matrix4().lookAt(key.position, key.target.position, key.shadow.camera.up).setPosition(key.position);
    this.cookieQuad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: {
          uBeam: { value: this.beam },
          uPool: { value: 9.2 },
          uSpill: { value: 0.3 },
          uSpread: { value: KEY_REACH / this.keyHeight },
          uKeyView: { value: keyView },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4( position.xy, 0.0, 1.0 );
          }`,
        fragmentShader: /* glsl */ `
          uniform float uBeam, uPool, uSpill, uSpread;
          uniform mat4 uKeyView;
          varying vec2 vUv;
          void main() {
            // Where the light through this point of the picture meets the plane of the board.
            vec3 from = uKeyView[ 3 ].xyz;
            vec3 dir = mat3( uKeyView ) * vec3( ( vUv * 2.0 - 1.0 ) * uSpread, -1.0 );
            vec2 p = abs( from.xz - dir.xz * ( from.y / dir.y ) );
            float away = max( p.x, p.y );
            // The hard square that comes straight through the oculus, and the softer one round it.
            float column = 1.0 - smoothstep( uBeam - 0.14, uBeam + 0.2, away );
            float skirt = 1.0 - smoothstep( uPool - 1.8, uPool + 0.5, away );
            gl_FragColor = vec4( vec3( mix( uSpill * skirt, 1.0, column ) ), 1.0 );
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );

    // A low light behind each player: candle gold from Ivory's end of the room, spirit green from
    // Void's. Each lights the faces turned toward it and edges everything seen from the other end.
    this.rims = [1, -1].map((end) => {
      const rim = new SpotLight(0xffffff, 1, RIM_REACH, 0.5, 0.85, 2);
      rim.position.set(-RIM.x * end, RIM.y, RIM.z * end);
      rim.target.position.set(0, 0.5, 0);
      this.root.add(rim, rim.target);
      return rim;
    }) as [SpotLight, SpotLight];

    // Light that comes up out of the board, when the room's state has it glow: on the undersides
    // of things in full, on their sides by half, and on what faces up not at all.
    this.under = new HemisphereLight(0x000000, 0xffffff, 0);
    this.root.add(this.under);

    // Candles: a flame and a soft halo each; the tall one at each corner of the board carries real
    // light. The lanterns on the piers have a wide, faint halo and no light of their own: theirs is baked.
    this.flames = new Flames(
      r.flames.map((at, i) => ({ at, halo: i >= r.plinthFlames ? 0.85 : i % 3 === 0 ? 1.0 : 0.5 })),
      r.lanterns,
    );
    this.root.add(this.flames.root);
    r.flames.forEach((p, i) => {
      if (i >= r.plinthFlames || i % 3 !== 0) return;
      const light = new PointLight(new Color(1.0, 0.6, 0.3), CANDLE_INTENSITY, 14, 2);
      light.position.copy(p).add(new Vector3(0, 0.3, 0));
      this.root.add(light);
      this.candleLights.push({ light, phase: i * 1.9 });
    });

    // Dust in the shaft. It shows only where the light is.
    const COUNT = 640;
    const seeds = new Float32Array(COUNT * 4);
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < COUNT * 4; i++) seeds[i] = rnd();
    const moteGeometry = new BufferGeometry();
    moteGeometry.setAttribute('position', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    moteGeometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    this.motes = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: 13 },
        uBottom: { value: 0.1 },
        uHeight: { value: this.keyHeight },
        uBeam: { value: this.beam },
        uLean: { value: this.shaft.lean },
        uColor: { value: new Color() },
        uScale: { value: 300 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime, uTop, uBottom, uHeight, uBeam, uScale;
        uniform vec2 uLean;
        varying float vAlpha;
        void main() {
          float span = uTop - uBottom;
          float y = uBottom + mod( aSeed.y * span - uTime * ( 0.035 + aSeed.w * 0.05 ), span );
          float reach = uBeam * ( uHeight - y ) / uHeight - 0.12;
          vec3 p = vec3( ( aSeed.x * 2.0 - 1.0 ) * reach + uLean.x * y, y, ( aSeed.z * 2.0 - 1.0 ) * reach + uLean.y * y );
          p.x += sin( uTime * 0.21 + aSeed.w * 40.0 ) * 0.1;
          p.z += cos( uTime * 0.17 + aSeed.x * 40.0 ) * 0.1;
          vec4 mv = viewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max( 1.5, ( 0.6 + aSeed.w * 1.3 ) * uScale / max( 1.0, -mv.z ) * 0.02 );
          // Dust, not glitter: it hangs in the light and is never bright, and does not flash as it turns.
          float lit = 0.4 + 0.2 * sin( uTime * ( 0.1 + 0.2 * aSeed.x ) + aSeed.z * 30.0 );
          vAlpha = lit * 0.26 * smoothstep( uBottom, uBottom + 0.6, y ) * ( 1.0 - smoothstep( uTop - 3.0, uTop, y ) );
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length( gl_PointCoord - 0.5 );
          gl_FragColor = vec4( uColor * ( 1.0 - smoothstep( 0.05, 0.5, d ) ) * vAlpha, 1.0 );
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.moteCloud = new Points(moteGeometry, this.motes);
    this.moteCloud.frustumCulled = false;
    this.moteCloud.renderOrder = 6;
    this.root.add(this.moteCloud);
    // The slot is under the slab, and the mirror has no slab to hide it with.
    this.unmirrored.push(this.moteCloud, glow);

    this.setQuality(quality);
    this.setMood('calm', true);
    this.update(0, 0);
  }

  /** The size of the drawing buffer: point sprites and the reflection are sized by it. */
  setViewport(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.motes.uniforms.uScale!.value = height;
    this.mirror?.setSize(width, height);
  }

  /** What the quality setting changes in the room: whether the board mirrors it, how finely the glass is drawn, how much dust there is. */
  setQuality(quality: Quality): void {
    const q = QUALITY[quality];
    this.mirror?.dispose();
    this.mirrorEvery = q.mirrorEvery;
    this.mirror = q.mirror > 0 ? new Mirror(q.mirror, Math.max(q.mirrorEvery, this.eased ? 2 : 1)) : null;
    this.mirror?.setSize(this.width, this.height);
    this.key.shadow.radius = shadowRadius(q.shadow, KEY_REACH, KEY_SOFT);
    this.shade.tMirror.value = this.mirror?.target.texture ?? null;
    setGlass(this.materials.tilesDark, this.mirror !== null, q.glass);
    setGlass(this.materials.tilesLight, this.mirror !== null, q.glass);
    this.moteCloud.geometry.setDrawRange(0, q.motes);
  }

  private mirrorEvery = 1;
  private eased = false;

  /**
   * The machine is struggling (or no longer is): while it is, the reflection in the dark squares
   * is drawn afresh on every other frame at most, which halves what that second view of the room costs.
   */
  ease(on: boolean): void {
    this.eased = on;
    if (this.mirror) this.mirror.every = Math.max(this.mirrorEvery, on ? 2 : 1);
  }

  /** Change the room's state. It eases there over a few seconds; with `now`, at once. */
  setMood(mood: Mood, now = false): void {
    flatten(LOOKS[mood]).forEach((goal, i) => (now ? this.look[i]!.snap(goal) : (this.look[i]!.goal = goal)));
  }

  /** Per-frame life: the light eases toward its state, the flames flicker. */
  update(time: number, dt = 0): void {
    let i = 0;
    const l = this.now as unknown as Record<string, number | number[]>;
    for (const field of FIELDS) {
      const was = l[field]!;
      if (typeof was === 'number') {
        const s = this.look[i++]!;
        s.step(dt, 1.1);
        l[field] = s.value;
      } else {
        for (let c = 0; c < was.length; c++) {
          const s = this.look[i++]!;
          s.step(dt, 1.1);
          was[c] = s.value;
        }
      }
    }
    const look = this.now;
    const shade = this.shade;
    const g = this.gains;

    // The key: so many candela that the board, straight under it, gets what the look asks for.
    this.key.intensity = look.key * this.keyAway * this.keyAway;
    this.key.color.setRGB(...look.keyColour);
    this.rims.forEach((rim, end) => {
      const c = end === 0 ? look.ivory : look.void;
      const strength = Math.max(c[0], c[1], c[2], 1e-4);
      const d = rim.position.distanceTo(rim.target.position);
      // What reaches the board is less than the inverse square says, because the light is cut off at a distance.
      const cut = (1 - (d / RIM_REACH) ** 4) ** 2;
      rim.intensity = (strength * d * d) / cut;
      rim.color.setRGB(c[0] / strength, c[1] / strength, c[2] / strength);
    });
    const under = Math.max(look.under[0], look.under[1], look.under[2]);
    this.under.intensity = under;
    if (under > 1e-4) this.under.groundColor.setRGB(look.under[0] / under, look.under[1] / under, look.under[2] / under);

    // The baked light, coloured. What the key bounces round the room follows the key: its
    // colour, and how strong it is against what the bake assumed.
    shade.uCandle.value.setRGB(...FLAME).multiplyScalar((NICHE_LIGHT * look.lit) / g.candles);
    shade.uSky.value.setRGB(...look.sky).multiplyScalar(1 / g.sky);
    shade.uBounce.value.setRGB(...look.keyColour).multiplyScalar(look.key / (Math.PI * this.keyUnit * g.key));
    shade.uRing.value.setRGB(...look.ring).multiplyScalar(1 / g.ring);
    shade.uDisc.value.setRGB(...look.disc).multiplyScalar(1 / g.disc);
    shade.uSlot.value.setRGB(...look.slot).multiplyScalar(1 / (this.slotGlow * g.slot));
    shade.uCalm.value = look.steady;
    shade.uTime.value = time;
    shade.uHazeWarm.value.setRGB(...look.hazeWarm);
    shade.uHazeCool.value.setRGB(...look.hazeCool);
    shade.uHazeLow.value.setRGB(...look.hazeLow);
    shade.uHaze.value.set(look.veil, 7, look.low);
    shade.uMist.value = look.mist;
    // Pale and a little cold: breath and smoke, with only as much of Void's green as ties it to that side.
    shade.uMistColour.value.setRGB(0.021, 0.04, 0.037).multiplyScalar(look.mist);
    shade.uJoint.value.setRGB(...look.joint);
    // How each thing that is itself light looks: seen directly, and in whatever mirrors it.
    const glow = shade.uGlow.value;
    glow[0]!.setRGB(...look.slot);
    glow[1]!.setRGB(...look.night);
    // The roses are wide panes of glass: held well under the board, so that they colour the ends of the room and do not outshine it.
    glow[2]!.setRGB(...look.ring).multiplyScalar(0.11);
    glow[3]!.setRGB(...look.disc).multiplyScalar(0.26);
    // A lantern's glass, lit from behind by the candle in it: cream, as bright as the candles burn.
    glow[4]!.setRGB(1.0, 0.7, 0.4).multiplyScalar(1.8 * look.lit);
    shade.uNiche.value.setRGB(...FLAME).multiplyScalar(1.5 * look.lit);
    shade.uWax.value.setRGB(1.0, 0.46, 0.16).multiplyScalar(0.85 * look.lit);
    this.sky.color.setRGB(...look.night).multiplyScalar(1.6);
    this.ambient = look.ambient;

    this.shaft.colour.setRGB(...look.shaft);
    this.shaft.dust = look.dust;
    this.shaft.time = time;
    (this.motes.uniforms.uColor!.value as Color).setRGB(...look.keyColour).multiplyScalar(Math.min(1.2, 0.25 + look.key / 5.4));
    this.motes.uniforms.uTime!.value = time;
    this.flames.update(time, look.steady, look.lit);
    for (const c of this.candleLights) c.light.intensity = CANDLE_INTENSITY * look.lit * flicker(c.phase, time, look.steady);
  }

  /**
   * Draw what has to be ready before the picture itself: the square the key shines through,
   * and what the dark squares mirror. `hidden` is whatever else must stay out of the mirror.
   */
  prepare(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, hidden: Object3D[]): void {
    const { pool, spill } = this.now;
    const drawn = pool + spill * 100;
    if (Math.abs(drawn - this.cookieDrawn) > 0.002) {
      this.cookieDrawn = drawn;
      const u = (this.cookieQuad.material as ShaderMaterial).uniforms;
      u.uPool!.value = Math.min(pool, KEY_REACH - 1.4);
      u.uSpill!.value = spill;
      const target = renderer.getRenderTarget();
      renderer.setRenderTarget(this.cookie);
      this.cookieQuad.render(renderer);
      renderer.setRenderTarget(target);
    }
    let mirrored = false;
    if (this.mirror) {
      // The hands are drawn in a way of their own, which a second view of the room cannot repeat; they are left out of it.
      this.hands ??= scene.children.find((child) => child.name === 'hands') ?? null;
      const out = this.hidden;
      out.length = 0;
      out.push(...this.unmirrored, ...hidden);
      if (this.hands) out.push(this.hands);
      this.shellNear.visible = false;
      this.shellFar.visible = true;
      mirrored = this.mirror.render(renderer, scene, camera, out);
      this.shellNear.visible = true;
      this.shellFar.visible = false;
      this.shade.uMirrorMatrix.value.copy(this.mirror.matrix);
    }
    // Where there is no mirror the board gives back the room as it is known to be laid out, without the pieces.
    this.shade.uMirror.value = this.mirror && !mirrored ? 0 : 1;
  }

  /**
   * What the room looks like from the middle of the board, for the pieces and tiles to reflect
   * and be lit by: the square of sky overhead, the lit board underfoot, candlelight and lanterns
   * low on every wall, Void's rose at one end and Ivory's at the other, the night in the tall
   * windows, and the doorways and crosses of lancets in the other two walls.
   */
  environment(renderer: WebGLRenderer, assets: Assets): Texture {
    const r = assets.room;
    const scene = new Scene();
    const calm = LOOKS.calm;
    const glowing = (colour: Triple, k = 1) => new MeshBasicMaterial({ color: new Color(...times(colour, k)), side: DoubleSide });
    const put = (mesh: Mesh, x: number, y: number, z: number) => {
      mesh.position.set(x, y, z);
      scene.add(mesh);
      return mesh;
    };
    const wall = r.wall;
    const eye = 0.9;
    put(new Mesh(new BoxGeometry(wall * 2, r.ceiling - r.floorY, wall * 2), new MeshBasicMaterial({ color: new Color(0.006, 0.008, 0.008), side: BackSide })), 0, (r.ceiling + r.floorY) / 2 - eye, 0);
    // Overhead, the sky in the oculus, as bright as it needs to be to lay on the board what the bake says it does.
    put(new Mesh(new PlaneGeometry(r.oculusHalf * 2, r.oculusHalf * 2), glowing(calm.sky, 21)), 0, r.ceiling - eye, 0).rotation.x = Math.PI / 2;
    // Underfoot, the lit slab, and the altar round it in the softer light.
    const lit = times(calm.keyColour, calm.key / Math.PI);
    put(new Mesh(new PlaneGeometry(r.beam * 2, r.beam * 2), glowing(lit, 0.24)), 0, -eye, 0).rotation.x = -Math.PI / 2;
    put(new Mesh(new PlaneGeometry(calm.pool * 2, calm.pool * 2), glowing(lit, 0.09 * calm.spill)), 0, -eye - 0.7, 0).rotation.x = -Math.PI / 2;
    // Candlelight in the niches and the lanterns on the piers, as one low band along each wall.
    for (let k = 0; k < 4; k++) {
      const band = put(new Mesh(new PlaneGeometry(wall * 1.75, 3.2), glowing(FLAME, 0.3)), 0, 1 - eye, 0);
      band.rotation.y = (k * Math.PI) / 2;
      band.position.set(Math.sin((k * Math.PI) / 2) * (wall - 0.5), 1 - eye, Math.cos((k * Math.PI) / 2) * (wall - 0.5));
    }
    for (const at of r.lanterns) {
      const glass = put(new Mesh(new PlaneGeometry(r.lantern.radius * 2, r.lantern.half * 2), glowing([1.0, 0.7, 0.4], 1.2)), at.x, at.y - eye, at.z);
      glass.lookAt(0, at.y - eye, 0);
    }
    // Void's rose and Ivory's, glass behind tracery.
    put(new Mesh(new RingGeometry(r.ring.inner, r.ring.outer, 48), glowing(calm.ring, 0.16)), 0, r.ring.y - eye, -wall + 0.5);
    put(new Mesh(new RingGeometry(0, r.disc.radius, 48), glowing(calm.disc, 0.06)), 0, r.disc.y - eye, wall - 0.6);
    // The night through the tall windows of the outer bays, and through the doorways and crosses of lancets in the other two walls.
    const night = glowing(calm.night, 0.3);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      for (const along of [-3, -2, -1, 1, 2, 3].map((n) => (n + 0.5 * Math.sign(n)) * r.bay)) {
        const pane = put(new Mesh(new PlaneGeometry(r.window.half * 1.6, r.window.head - r.window.sill), night), 0, 0, 0);
        pane.position.set(Math.sin(a) * (wall - 0.4) + Math.cos(a) * along, (r.window.head + r.window.sill) / 2 - eye, Math.cos(a) * (wall - 0.4) - Math.sin(a) * along);
        pane.rotation.y = a;
      }
    }
    for (const side of [-1, 1]) {
      const door = put(new Mesh(new PlaneGeometry(r.door.half * 2, r.door.head - r.floorY), glowing(calm.night, 0.7)), side * (wall - 0.4), (r.door.head + r.floorY) / 2 - eye, 0);
      door.rotation.y = Math.PI / 2;
      const upright = put(new Mesh(new PlaneGeometry(r.cross.half * 2, r.cross.head - r.cross.foot), glowing(calm.night, 0.7)), side * (wall - 0.4), (r.cross.head + r.cross.foot) / 2 - eye, 0);
      upright.rotation.y = Math.PI / 2;
      for (const arm of [-1, 1]) {
        const light = put(new Mesh(new PlaneGeometry(r.cross.armHalf * 2, r.cross.armHead - r.cross.armSill), glowing(calm.night, 0.7)),
          side * (wall - 0.4), (r.cross.armHead + r.cross.armSill) / 2 - eye, arm * r.cross.armAt);
        light.rotation.y = Math.PI / 2;
      }
    }
    const pmrem = new PMREMGenerator(renderer);
    const texture = pmrem.fromScene(scene, 0.015, 0.1, 100).texture;
    pmrem.dispose();
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    });
    return texture;
  }
}
