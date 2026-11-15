/**
 * What the board itself does (style bible, 7.3): its tiles lift and drop in
 * a ring round a piece that has just been set down, a chalk line draws
 * itself along a move, the square a piece has left breaks up in its middle and
 * black flecks lift out of it,
 * a flat ribbon of light hangs in the air behind a piece being carried,
 * hard-edged beams join a piece to what it threatens, a fan of rays stands up
 * behind a strong move, a glass prism closes round a pinned piece, a square
 * flashes and decays, violet fog gathers for check and the stone cracks
 * toward the king, and at mate the tiles erupt outward from the king under
 * a pillar of light.
 *
 * Everything is flat light with hard edges: no sparks, no soft glows.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SrcColorFactor,
  Vector3,
  ZeroFactor,
} from 'three';
import { Spring } from '../scene/spring';

interface Ripple {
  x: number;
  z: number;
  age: number;
  /** Height of the wave, in squares. */
  height: number;
  /** Squares per second. */
  speed: number;
  /** How long one tile takes to rise and fall. */
  beat: number;
  /** Tiles nearer than this stay put: a piece is standing there. */
  hole: number;
  reach: number;
}

interface Ribbon {
  mesh: Mesh;
  material: ShaderMaterial;
  age: number;
  draw: number;
  hold: number;
  fade: number;
  delay: number;
  busy: boolean;
}

interface Flash {
  mesh: Mesh;
  material: ShaderMaterial;
  age: number;
  life: number;
  busy: boolean;
}

const RIBBON_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;

/** A band of light that draws itself from one end. `uChalk` breaks it into the dashes of a chalk line. */
const RIBBON_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uDrawn;
  uniform float uOpacity;
  uniform float uLength;
  uniform float uChalk;
  varying vec2 vUv;
  void main() {
    float along = vUv.x * uLength;
    float across = abs( vUv.y - 0.5 ) * 2.0;
    // A hard edge with a hot core, and a head that is brighter than the tail.
    float body = 1.0 - smoothstep( 0.55, 0.95, across );
    float core = 1.0 - smoothstep( 0.0, 0.35, across );
    float shown = step( vUv.x, uDrawn );
    float head = smoothstep( uDrawn - 0.12, uDrawn, vUv.x ) * shown;
    float dash = mix( 1.0, step( 0.32, fract( along * 2.6 ) ), uChalk );
    float level = shown * dash * ( body * 0.55 + core * 0.6 + head * 0.9 ) * uOpacity;
    gl_FragColor = vec4( uColor * level, 1.0 );
  }`;

const FLASH_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLevel;
  varying vec2 vUv;
  void main() {
    vec2 p = abs( vUv - 0.5 ) * 2.0;
    float edge = max( p.x, p.y );
    // A square of flat light with a hot border, like the lit squares.
    float fill = 1.0 - smoothstep( 0.86, 0.9, edge );
    float border = smoothstep( 0.74, 0.84, edge ) * fill;
    gl_FragColor = vec4( uColor * ( fill * 0.35 + border * 0.9 ) * uLevel, 1.0 );
  }`;

/** How many points of its path a wake keeps, and how long each one hangs in the air. */
const WAKE_POINTS = 72;
const WAKE_LIFE = 1.15;
/** A wake takes a new point each time what it follows has gone this far. */
const WAKE_STEP = 0.045;

/** The ribbon behind a piece being carried: the path it has taken, oldest first, drawn as a band that faces the eye. */
interface Wake {
  mesh: Mesh;
  material: ShaderMaterial;
  points: { x: number; y: number; z: number; born: number }[];
  /** Whether what it follows is still in the air. Once it is not, the band only hangs and thins. */
  live: boolean;
}

/**
 * A band that follows a path. Each point of the path is two corners, one either side of it, pushed
 * apart across the line of sight, so the band is seen flat from wherever it is looked at: paper
 * tape let go in the air. It keeps its width for a while, then thins to a thread, swaying as it hangs.
 */
const WAKE_VERTEX = /* glsl */ `
  attribute vec3 aAlong;
  attribute float aSide;
  attribute float aBorn;
  uniform float uNow;
  uniform float uWidth;
  uniform float uLife;
  varying float vAcross;
  varying float vAge;
  void main() {
    float k = clamp( ( uNow - aBorn ) / uLife, 0.0, 1.0 );
    vec4 at = modelMatrix * vec4( position, 1.0 );
    at.y += sin( aBorn * 6.0 + uNow * 2.3 ) * 0.07 * k * k;
    vec3 across = cross( normalize( aAlong ), normalize( cameraPosition - at.xyz ) );
    float l = length( across );
    across = l > 1e-4 ? across / l : vec3( 0.0, 1.0, 0.0 );
    at.xyz += across * aSide * 0.5 * uWidth * ( 1.0 - k * k * k );
    vAcross = aSide;
    vAge = k;
    gl_Position = projectionMatrix * viewMatrix * at;
  }`;

/** Flat near-white with a hot border, as every lit thing here has: the border is what blooms. */
const WAKE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAcross;
  varying float vAge;
  void main() {
    float border = smoothstep( 0.56, 0.74, abs( vAcross ) );
    float fade = clamp( 1.0 - vAge * vAge, 0.0, 1.0 );
    gl_FragColor = vec4( uColor * ( 0.5 + border * 1.1 ) * fade, ( 0.62 + border * 0.3 ) * fade );
  }`;

/** How many rays stand in a fan, and how long it takes to open, stand and go. */
const RAYS = 7;
const RAYS_OPEN = 0.16;
const RAYS_HOLD = 0.34;
const RAYS_FADE = 0.75;

/**
 * A fan of rays: each is a wedge that starts at a point and widens along its way, its two edges
 * pushed apart across the line of sight like the wake's, so the fan reads from every camera. It
 * stands behind the stone whichever side it is seen from: a ray that would lean toward the eye is
 * turned round to lean away. From overhead none is in the way, and they are left as they are.
 */
const RAYS_VERTEX = /* glsl */ `
  attribute vec3 aDir;
  attribute float aT;
  attribute float aSide;
  attribute float aLate;
  uniform float uOpen;
  uniform float uSpread;
  varying float vAcross;
  varying float vAlong;
  void main() {
    // Each ray is let go a little after the one before, and shoots out fast with a slow finish.
    float k = clamp( ( uOpen - aLate ) / ( 1.0 - aLate ), 0.0, 1.0 );
    float left = 1.0 - k;
    float out_ = 1.0 - left * left * left;
    vec4 at = modelMatrix * vec4( position, 1.0 );
    vec3 dir = aDir;
    vec3 eye = cameraPosition - at.xyz;
    float along = length( eye.xz );
    if ( along > 1e-4 ) {
      vec2 toward = eye.xz / along;
      float fold = 1.0 - smoothstep( 0.8, 0.96, eye.y / length( eye ) );
      dir.xz -= toward * max( 0.0, dot( dir.xz, toward ) ) * 2.0 * fold;
    }
    at.xyz += dir * aT * out_;
    vec3 across = cross( normalize( dir ), normalize( cameraPosition - at.xyz ) );
    float l = length( across );
    across = l > 1e-4 ? across / l : vec3( 1.0, 0.0, 0.0 );
    at.xyz += across * aSide * uSpread * length( dir ) * aT * out_;
    vAcross = aSide;
    vAlong = aT;
    gl_Position = projectionMatrix * viewMatrix * at;
  }`;

/**
 * Flat light, brightest along its two edges and at its root, cut off square at the far end. It is
 * drawn twice: the faint body first, then the two edges alone (`uEdge`), which also say how far away
 * they are, so that the lens keeps them hard against a wall it has let go soft.
 */
const RAYS_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLevel;
  uniform float uEdge;
  varying float vAcross;
  varying float vAlong;
  void main() {
    float border = smoothstep( 0.72, 0.86, abs( vAcross ) );
    // Never less than nothing: the picture can ask about a point a hair past the ray's end, and the
    // root of a number below nought is no number at all, which the glow then spreads over everything.
    float body = pow( clamp( 1.0 - vAlong, 0.0, 1.0 ), 0.7 );
    float light = mix( 0.2, border * 0.75, uEdge ) * body * uLevel;
    if ( uEdge > 0.5 && light < 0.03 ) discard;
    gl_FragColor = vec4( uColor * light, 1.0 );
  }`;

/** How long a prism takes to rise round a piece, and to go. */
const PRISM_RISE = 0.3;
const PRISM_FADE = 0.8;

/** How much narrower a prism is at its top than at its foot. */
const PRISM_TAPER = 0.22;

/**
 * A case of glass, narrower at the top: almost nothing on its faces, and a hard line of light
 * along every edge. Like the rays it is drawn twice, the faces first and then the lines alone
 * (`uLines`), which say how far away they are and so stay hard where the lens has gone soft.
 */
const PRISM_VERTEX = /* glsl */ `
  uniform vec3 uSize;
  varying vec3 vAt;
  varying float vFace;
  void main() {
    float narrow = 1.0 - ${PRISM_TAPER.toFixed(2)} * position.y;
    vec3 p = vec3( position.x * narrow, position.y, position.z * narrow );
    // Where on the case this is, in squares across and as a share of its height, and which kind of
    // face it is on: the lid or the floor, a face across x, or a face across z.
    vAt = vec3( p.x * uSize.x, p.y, p.z * uSize.z );
    vFace = abs( normal.y ) > 0.5 ? 0.0 : abs( normal.x ) > 0.5 ? 1.0 : 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
  }`;

const PRISM_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSize;
  uniform float uLevel;
  uniform float uLines;
  varying vec3 vAt;
  varying float vFace;
  void main() {
    // How far it is from here to the nearest edge of this face, so that every line has one thickness.
    vec2 reach = 0.5 * uSize.xz * ( 1.0 - ${PRISM_TAPER.toFixed(2)} * vAt.y );
    float d;
    if ( vFace < 0.5 ) {
      d = min( reach.x - abs( vAt.x ), reach.y - abs( vAt.z ) );
    } else {
      float side = vFace < 1.5 ? reach.y - abs( vAt.z ) : reach.x - abs( vAt.x );
      d = min( side, min( vAt.y, 1.0 - vAt.y ) * uSize.y );
    }
    float line = 1.0 - smoothstep( 0.011, 0.019, d );
    // The glass itself: a breath of light, a little more toward the top where it closes.
    float glass = 0.03 + 0.05 * vAt.y * vAt.y;
    float light = mix( glass, line * 0.85, uLines ) * uLevel;
    if ( uLines > 0.5 && light < 0.03 ) discard;
    gl_FragColor = vec4( uColor * light, 1.0 );
  }`;

interface Prism {
  /** The faces and the lines, drawn one after the other. */
  body: Group;
  /** What both of them are told: the colour, how bright, and how big the case is now. */
  told: { uColor: { value: Color }; uLevel: { value: number }; uSize: { value: Vector3 } };
  age: number;
  hold: number;
  height: number;
  busy: boolean;
}

/** How many flecks can be in the air at once. */
const FLECKS = 44;

/** One fleck of the square a piece has left: a small dark shard that lifts, turns and is gone. */
interface Fleck {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  axis: Vector3;
  turn: number;
  spin: number;
  size: number;
  /** How much longer than wide. */
  long: number;
  age: number;
  life: number;
}

/**
 * The face of a square a stone has left breaking up, and setting itself right (the tiles' material
 * draws it: see `TILE_CRUMBLE`). It lasts this many seconds in all, and the square is whole at the end.
 */
const CRUMBLE_LIFE = 1.7;
/** Shortest time a square may be left to finish in once something is to be set down on it, or the board is stood again. */
const CRUMBLE_MEND = 0.22;
/** How far the whole slab gives as it is released, and how far it seats itself at the end, in squares. */
const CRUMBLE_GIVE = 0.03;
const CRUMBLE_SEAT = 0.008;

interface Crumble {
  /** The square, a1 first. */
  square: number;
  /** How much of its face is let go: 1 to 7. */
  level: number;
  age: number;
  /** How fast it runs: more than 1 once it is being hurried. */
  pace: number;
}

/** How many cracks can lie in the board at once, and the most pieces of line any one is made of. */
const CRACKS = 4;
const CRACK_PIECES = 72;
/** How long a crack takes to close once the king is safe. */
const CRACK_HEAL = 0.9;

/**
 * A break in the stone: a path of flat pieces lying on the board, drawn twice. First dark,
 * multiplied into whatever is under it, because a break is dark before it is anything else and
 * light alone is lost on pale stone; then a thread of light down the middle of it. It runs from
 * one end to the other (`uDrawn`), and the running end is the brightest part.
 */
const CRACK_VERTEX = /* glsl */ `
  attribute float aSide;
  attribute float aRun;
  varying float vSide;
  varying float vRun;
  void main() {
    vSide = aSide;
    vRun = aRun;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;

const CRACK_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uDrawn;
  uniform float uLevel;
  uniform float uGlow;
  uniform float uDark;
  varying float vSide;
  varying float vRun;
  void main() {
    float across = abs( vSide );
    float shown = step( vRun, uDrawn ) * uLevel;
    if ( uDark > 0.5 ) {
      float body = 1.0 - smoothstep( 0.5, 1.0, across );
      gl_FragColor = vec4( vec3( 1.0 - 0.82 * body * shown ), 1.0 );
    } else {
      float core = 1.0 - smoothstep( 0.08, 0.55, across );
      float head = smoothstep( uDrawn - 0.18, uDrawn, vRun );
      gl_FragColor = vec4( uColor * core * shown * ( uGlow + head * 1.6 ), 1.0 );
    }
  }`;

interface Crack {
  /** The dark of it and the light in it, drawn one after the other. */
  body: Group;
  geometry: BufferGeometry;
  told: { uColor: { value: Color }; uDrawn: { value: number }; uLevel: { value: number }; uGlow: { value: number } };
  age: number;
  draw: number;
  /** How long it has been closing, or -1 while it stands. */
  healing: number;
  busy: boolean;
}

/** A point on a crack's path: where it is, half how wide the break is there, and how far along the whole it comes. */
interface CrackPoint {
  x: number;
  z: number;
  w: number;
  s: number;
}

const UP = new Vector3(0, 1, 0);
const fleckAt = new Vector3();
const fleckTurn = new Quaternion();
const fleckSize = new Vector3();
const fleckMatrix = new Matrix4();

export class BoardFx {
  readonly root = new Group();
  private ripples: Ripple[] = [];
  private ribbons: Ribbon[] = [];
  private flashes: Flash[] = [];
  private fog: ShaderMaterial;
  private fogLevel = new Spring();
  private pillar: Mesh;
  private pillarLevel = new Spring();
  private wakes: Wake[] = [];
  private flecks: Fleck[] = [];
  private fleckMesh: InstancedMesh;
  private cracks: Crack[] = [];
  private crumbles: Crumble[] = [];
  /** Whether the effects are to be lighter: the quality is the lowest. Fewer flecks. */
  thin = false;
  /** Whether the player has asked for less motion: a square gives nothing of its height, and breaks and mends in half the time. */
  still = false;
  /** The fan of rays: their bodies, and their edges drawn over them. */
  private fan = new Group();
  private fanTold = { uColor: { value: new Color() }, uOpen: { value: 0 }, uLevel: { value: 0 }, uSpread: { value: 0.085 } };
  /** Seconds since the fan of rays was let go, or negative when there is none. */
  private rayAge = -1;
  private prisms: Prism[] = [];
  /** The effects' own clock. */
  private now = 0;
  /** Where the flecks' scatter has got to: the same game scatters the same way. */
  private seed = 0x9e3779b9;

  /** `lift` is the tiles' shared height table: 64 values, a1 first, read by their material. */
  constructor(
    private lift: Float32Array,
    private broken: Float32Array = new Float32Array(64),
  ) {
    this.root.name = 'board-effects';

    const quad = new PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const material = new ShaderMaterial({
        uniforms: {
          uColor: { value: new Color() },
          uDrawn: { value: 0 },
          uOpacity: { value: 0 },
          uLength: { value: 1 },
          uChalk: { value: 0 },
        },
        vertexShader: RIBBON_VERTEX,
        fragmentShader: RIBBON_FRAGMENT,
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
      const mesh = new Mesh(quad, material);
      mesh.visible = false;
      mesh.renderOrder = 2.5;
      this.root.add(mesh);
      this.ribbons.push({ mesh, material, age: 0, draw: 0.3, hold: 0.5, fade: 0.8, delay: 0, busy: false });
    }
    for (let i = 0; i < 8; i++) {
      const material = new ShaderMaterial({
        uniforms: { uColor: { value: new Color() }, uLevel: { value: 0 } },
        vertexShader: RIBBON_VERTEX,
        fragmentShader: FLASH_FRAGMENT,
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
      const mesh = new Mesh(quad, material);
      mesh.visible = false;
      mesh.renderOrder = 2.4;
      this.root.add(mesh);
      this.flashes.push({ mesh, material, age: 0, life: 1, busy: false });
    }

    // Fog that lies on the board and spills over the plinth: drifting, with soft edges.
    this.fog = new ShaderMaterial({
      uniforms: { uColor: { value: new Color(0.24, 0.15, 0.4) }, uLevel: { value: 0 }, uTime: { value: 0 } },
      vertexShader: RIBBON_VERTEX,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uLevel;
        uniform float uTime;
        varying vec2 vUv;
        float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
        float noise( vec2 p ) {
          vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( hash( i ), hash( i + vec2( 1, 0 ) ), f.x ), mix( hash( i + vec2( 0, 1 ) ), hash( i + vec2( 1, 1 ) ), f.x ), f.y );
        }
        void main() {
          vec2 p = vUv * 7.0;
          float n = noise( p + vec2( uTime * 0.11, 0.0 ) ) * 0.6 + noise( p * 2.1 - vec2( 0.0, uTime * 0.16 ) ) * 0.4;
          float edge = 1.0 - smoothstep( 0.55, 1.0, length( vUv - 0.5 ) * 2.0 );
          gl_FragColor = vec4( uColor * smoothstep( 0.3, 0.9, n ) * edge * uLevel, 1.0 );
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const fogPlane = new PlaneGeometry(15, 15);
    fogPlane.rotateX(-Math.PI / 2);
    const fog = new Mesh(fogPlane, this.fog);
    fog.position.y = 0.09;
    fog.renderOrder = 2.2;
    this.root.add(fog);

    // The pillar: two tall crossed sheets of light.
    const sheets = new BufferGeometry();
    const h = 16;
    const w = 0.34;
    sheets.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, w, h, 0, -w, h, 0, 0, 0, -w, 0, 0, w, 0, h, w, 0, h, -w]), 3),
    );
    sheets.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]), 2));
    sheets.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.pillar = new Mesh(
      sheets,
      new ShaderMaterial({
        uniforms: { uColor: { value: new Color(0.55, 1.0, 0.92) }, uLevel: { value: 0 } },
        vertexShader: RIBBON_VERTEX,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uLevel;
          varying vec2 vUv;
          void main() {
            float across = abs( vUv.x - 0.5 ) * 2.0;
            float core = 1.0 - smoothstep( 0.0, 0.3, across );
            float body = 1.0 - smoothstep( 0.5, 1.0, across );
            float up = 1.0 - smoothstep( 0.5, 1.0, vUv.y ) * 0.7;
            gl_FragColor = vec4( uColor * ( core * 2.2 + body * 0.5 ) * up * uLevel, 1.0 );
          }`,
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
        side: DoubleSide,
      }),
    );
    this.pillar.renderOrder = 7.5;
    this.pillar.visible = false;
    this.root.add(this.pillar);

    // The wakes: one for a piece being carried, and one more for the rook when a king castles.
    const index: number[] = [];
    for (let i = 0; i < WAKE_POINTS - 1; i++) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    const sides = new Float32Array(WAKE_POINTS * 2);
    for (let i = 0; i < WAKE_POINTS; i++) {
      sides[2 * i] = -1;
      sides[2 * i + 1] = 1;
    }
    for (let w = 0; w < 2; w++) {
      const geometry = new BufferGeometry();
      for (const [name, size] of [['position', 3], ['aAlong', 3], ['aBorn', 1]] as const) {
        const attribute = new BufferAttribute(new Float32Array(WAKE_POINTS * 2 * size), size);
        attribute.setUsage(DynamicDrawUsage);
        geometry.setAttribute(name, attribute);
      }
      geometry.setAttribute('aSide', new BufferAttribute(sides, 1));
      geometry.setIndex(index);
      geometry.setDrawRange(0, 0);
      const material = new ShaderMaterial({
        uniforms: { uColor: { value: new Color() }, uNow: { value: 0 }, uWidth: { value: 0.2 }, uLife: { value: WAKE_LIFE } },
        vertexShader: WAKE_VERTEX,
        fragmentShader: WAKE_FRAGMENT,
        depthWrite: false,
        transparent: true,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      // Its corners are moved in the shader, so where it is cannot be known from its points.
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6.5;
      this.root.add(mesh);
      this.wakes.push({ mesh, material, points: [], live: false });
    }

    // The flecks: one shape, drawn as often as there are flecks in the air, each turned and stretched its own way.
    const shard = new BufferGeometry();
    shard.setAttribute('position', new BufferAttribute(new Float32Array([-0.9, -0.3, 0, -0.15, -0.85, 0, 0.8, -0.5, 0, 1, 0.3, 0, -0.25, 0.9, 0]), 3));
    shard.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
    this.fleckMesh = new InstancedMesh(shard, new MeshBasicMaterial({ color: 0x070906, side: DoubleSide }), FLECKS);
    this.fleckMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.fleckMesh.count = 0;
    this.fleckMesh.frustumCulled = false;
    this.fleckMesh.renderOrder = 2.6;
    this.root.add(this.fleckMesh);

    // The fan of rays: every ray is four corners, two at its root and two at its far end.
    const fan = new BufferGeometry();
    const rayIndex: number[] = [];
    const ends = new Float32Array(RAYS * 4);
    const edges = new Float32Array(RAYS * 4);
    for (let i = 0; i < RAYS; i++) {
      const v = i * 4;
      ends.set([0, 0, 1, 1], v);
      edges.set([-1, 1, -1, 1], v);
      rayIndex.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
    fan.setAttribute('position', new BufferAttribute(new Float32Array(RAYS * 4 * 3), 3));
    fan.setAttribute('aDir', new BufferAttribute(new Float32Array(RAYS * 4 * 3), 3));
    fan.setAttribute('aLate', new BufferAttribute(new Float32Array(RAYS * 4), 1));
    fan.setAttribute('aT', new BufferAttribute(ends, 1));
    fan.setAttribute('aSide', new BufferAttribute(edges, 1));
    fan.setIndex(rayIndex);
    // Drawn twice: the bodies, then the edges, which write how far away they are (see the shader).
    // The edges come after everything else that is light, so that nothing drawn later is hidden by them.
    for (const edge of [0, 1]) {
      const mesh = new Mesh(
        fan,
        new ShaderMaterial({
          uniforms: { ...this.fanTold, uEdge: { value: edge } },
          vertexShader: RAYS_VERTEX,
          fragmentShader: RAYS_FRAGMENT,
          blending: AdditiveBlending,
          depthWrite: edge === 1,
          transparent: true,
          side: DoubleSide,
        }),
      );
      mesh.frustumCulled = false;
      mesh.renderOrder = edge === 1 ? 7.7 : 6.4;
      this.fan.add(mesh);
    }
    this.fan.visible = false;
    this.root.add(this.fan);

    // The prisms: a box each, stood on the board, so that its own height runs from nought to one.
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    for (let i = 0; i < 2; i++) {
      const told = { uColor: { value: new Color() }, uLevel: { value: 0 }, uSize: { value: new Vector3(1, 1, 1) } };
      const body = new Group();
      for (const lines of [0, 1]) {
        const mesh = new Mesh(
          box,
          new ShaderMaterial({
            uniforms: { ...told, uLines: { value: lines } },
            vertexShader: PRISM_VERTEX,
            fragmentShader: PRISM_FRAGMENT,
            blending: AdditiveBlending,
            depthWrite: lines === 1,
            transparent: true,
            side: DoubleSide,
          }),
        );
        mesh.renderOrder = lines === 1 ? 7.6 : 6.3;
        body.add(mesh);
      }
      body.visible = false;
      this.root.add(body);
      this.prisms.push({ body, told, age: 0, hold: 1.5, height: 1, busy: false });
    }

    // The cracks: each a run of flat pieces laid on the board, made anew whenever one is asked for.
    const pieceIndex: number[] = [];
    for (let i = 0; i < CRACK_PIECES; i++) pieceIndex.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
    for (let i = 0; i < CRACKS; i++) {
      const geometry = new BufferGeometry();
      for (const [name, size] of [['position', 3], ['aSide', 1], ['aRun', 1]] as const) {
        const attribute = new BufferAttribute(new Float32Array(CRACK_PIECES * 4 * size), size);
        attribute.setUsage(DynamicDrawUsage);
        geometry.setAttribute(name, attribute);
      }
      geometry.setIndex(pieceIndex);
      geometry.setDrawRange(0, 0);
      const told = { uColor: { value: new Color() }, uDrawn: { value: 0 }, uLevel: { value: 0 }, uGlow: { value: 0 } };
      const body = new Group();
      for (const dark of [1, 0]) {
        const mesh = new Mesh(
          geometry,
          new ShaderMaterial({
            uniforms: { ...told, uDark: { value: dark } },
            vertexShader: CRACK_VERTEX,
            fragmentShader: CRACK_FRAGMENT,
            ...(dark ? { blending: CustomBlending, blendSrc: ZeroFactor, blendDst: SrcColorFactor } : { blending: AdditiveBlending }),
            depthWrite: false,
            transparent: true,
            side: DoubleSide,
          }),
        );
        // Its corners are all over the board, so where it is cannot be known from them.
        mesh.frustumCulled = false;
        mesh.renderOrder = dark ? 2.3 : 2.45;
        body.add(mesh);
      }
      body.visible = false;
      this.root.add(body);
      this.cracks.push({ body, geometry, told, age: 0, draw: 0.34, healing: -1, busy: false });
    }
  }

  /** A number from 0 to 1, the next of a fixed run. */
  private scatter(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * The square a piece has just left breaks up in its middle: black flecks lift out of it, and
   * in the stone shards let go, one after another, and lie as pits and set themselves back. It is
   * whole again inside two seconds, and sooner if something is set down on it. The heavier the
   * piece, the more of the face goes; the rim of it never does.
   */
  crumble(at: Vector3, amount = 1): void {
    const file = Math.floor(at.x + 4);
    const rank = Math.floor(4 - at.z);
    if (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
      const square = rank * 8 + file;
      const level = Math.max(1, Math.min(7, Math.round(amount * 5)));
      const standing = this.crumbles.find((c) => c.square === square);
      if (standing) {
        standing.level = level;
        standing.age = 0;
        standing.pace = 1;
      } else this.crumbles.push({ square, level, age: 0, pace: 1 });
    }
    this.fleck(at, this.thin ? amount * 0.6 : amount);
  }

  /**
   * Hurry the squares that are breaking up to their end: the one under a point, or (with none)
   * all of them. Something is about to be set down there. They are whole again in a fifth of a second.
   */
  mend(at?: Vector3): void {
    const file = at ? Math.floor(at.x + 4) : 0;
    const rank = at ? Math.floor(4 - at.z) : 0;
    if (at && (file < 0 || file > 7 || rank < 0 || rank > 7)) return;
    for (const c of this.crumbles) {
      if (at && c.square !== rank * 8 + file) continue;
      const left = (this.still ? CRUMBLE_LIFE / 2 : CRUMBLE_LIFE) - c.age;
      c.pace = Math.max(c.pace, left / CRUMBLE_MEND);
    }
  }

  /** Black flecks lift out of a square: they rise, turn and are gone inside a second and a half. */
  private fleck(at: Vector3, amount: number): void {
    const count = Math.max(1, Math.round(8 * amount));
    for (let i = 0; i < count; i++) {
      // More than can be in the air at once: the oldest give way.
      if (this.flecks.length >= FLECKS) this.flecks.shift();
      const angle = this.scatter() * Math.PI * 2;
      const out = 0.12 + this.scatter() * 0.34;
      const speed = 0.15 + this.scatter() * 0.45;
      this.flecks.push({
        x: at.x + Math.cos(angle) * out,
        y: at.y + 0.03 + this.scatter() * 0.05,
        z: at.z + Math.sin(angle) * out,
        vx: Math.cos(angle) * speed,
        vy: 0.7 + this.scatter() * 1.1,
        vz: Math.sin(angle) * speed,
        axis: new Vector3(this.scatter() - 0.5, this.scatter() - 0.5, this.scatter() - 0.5).normalize(),
        turn: this.scatter() * Math.PI * 2,
        spin: (this.scatter() < 0.5 ? -1 : 1) * (2 + this.scatter() * 6),
        size: 0.026 + this.scatter() * 0.046,
        long: 1 + this.scatter() * 0.9,
        // The first few are let go a moment later than the rest, so that the square does not go off like a shot.
        age: -this.scatter() * 0.24,
        life: 0.85 + this.scatter() * 0.6,
      });
    }
  }

  /**
   * Begin a ribbon behind something that is about to be carried through the air. `which` is 0 for
   * the piece being moved and 1 for the rook that goes with a castling king.
   */
  wakeBegin(which: 0 | 1, colour: Color, width = 0.2): void {
    const w = this.wakes[which]!;
    w.points.length = 0;
    w.live = true;
    (w.material.uniforms.uColor!.value as Color).copy(colour);
    w.material.uniforms.uWidth!.value = width;
  }

  /** Where the thing a wake follows is now. Called every frame while it is in the air. */
  wakeTo(which: 0 | 1, x: number, y: number, z: number): void {
    const w = this.wakes[which]!;
    if (!w.live) return;
    const last = w.points[w.points.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y, z - last.z) < WAKE_STEP) return;
    if (w.points.length >= WAKE_POINTS) w.points.shift();
    w.points.push({ x, y, z, born: this.now });
  }

  /** What a wake followed has been set down. The ribbon hangs where it is and thins away. */
  wakeEnd(which: 0 | 1): void {
    this.wakes[which]!.live = false;
  }

  /**
   * A fan of hard rays stands up from a point and is gone inside a second and a half: the move
   * made there was a strong one. `height` is about how tall the fan stands, in squares.
   */
  rays(at: Vector3, colour: Color, height = 2.4): void {
    const g = (this.fan.children[0] as Mesh).geometry;
    const position = g.getAttribute('position') as BufferAttribute;
    const dir = g.getAttribute('aDir') as BufferAttribute;
    const late = g.getAttribute('aLate') as BufferAttribute;
    const turn = this.scatter() * Math.PI * 2;
    for (let i = 0; i < RAYS; i++) {
      // Spread round the piece and leaning out from it, long and short by turns, none of them quite regular.
      const angle = turn + ((i + (this.scatter() - 0.5) * 0.5) / RAYS) * Math.PI * 2;
      const lean = (i % 2 === 0 ? 0.32 : 0.62) + (this.scatter() - 0.5) * 0.16;
      const length = height * ((i % 2 === 0 ? 1 : 0.68) + (this.scatter() - 0.5) * 0.14);
      const x = Math.cos(angle) * Math.sin(lean) * length;
      const y = Math.cos(lean) * length;
      const z = Math.sin(angle) * Math.sin(lean) * length;
      const wait = this.scatter() * 0.3;
      for (let c = 0; c < 4; c++) {
        position.setXYZ(i * 4 + c, at.x, at.y + 0.05, at.z);
        dir.setXYZ(i * 4 + c, x, y, z);
        late.setX(i * 4 + c, wait);
      }
    }
    position.needsUpdate = true;
    dir.needsUpdate = true;
    late.needsUpdate = true;
    this.fanTold.uColor.value.copy(colour);
    this.rayAge = 0;
  }

  /**
   * A glass prism rises round the piece on a square, stands for `hold` seconds and goes: the piece
   * is pinned. `height` is how tall the piece is.
   */
  prism(at: Vector3, height: number, colour: Color, hold = 1.5): void {
    const p = this.prisms.find((x) => !x.busy) ?? this.prisms[0]!;
    p.busy = true;
    p.age = 0;
    p.hold = hold;
    p.height = height + 0.22;
    p.body.position.set(at.x, at.y + 0.01, at.z);
    p.told.uColor.value.copy(colour);
    p.told.uLevel.value = 0;
  }

  /**
   * The stone breaks from one square toward another: a crack runs from the first to the foot of
   * whatever stands on the second, parts there and runs on round it, and stays until `heal`.
   * `width` makes it a wider break than usual (1); `draw` is how long it takes to arrive.
   */
  crack(from: Vector3, to: Vector3, colour: Color, o: { width?: number; draw?: number } = {}): void {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    if (length < 0.9) return;
    // If every one is in use, the one that has been closing longest gives way.
    const c = this.cracks.find((x) => !x.busy) ?? this.cracks.reduce((a, b) => (b.healing > a.healing ? b : a));
    const wide = 0.052 * (o.width ?? 1);
    const ax = (to.x - from.x) / length;
    const az = (to.z - from.z) / length;
    const y = Math.max(from.y, to.y) + 0.016;
    const position = c.geometry.getAttribute('position') as BufferAttribute;
    const side = c.geometry.getAttribute('aSide') as BufferAttribute;
    const run = c.geometry.getAttribute('aRun') as BufferAttribute;
    let pieces = 0;
    let far = 0;
    /** Lay a path down as flat pieces, each the width the break has at its two ends. */
    const lay = (path: CrackPoint[]) => {
      far = Math.max(far, path[path.length - 1]!.s);
      for (let i = 0; i + 1 < path.length && pieces < CRACK_PIECES; i++) {
        for (const end of [0, 1]) {
          const j = i + end;
          const a = path[Math.max(0, j - 1)]!;
          const b = path[Math.min(path.length - 1, j + 1)]!;
          const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const p = path[j]!;
          for (const edge of [-1, 1]) {
            // Out to either side, across the way the path is going here.
            const v = pieces * 4 + end * 2 + (edge + 1) / 2;
            position.setXYZ(v, p.x - ((b.z - a.z) / l) * p.w * edge, y, p.z + ((b.x - a.x) / l) * p.w * edge);
            side.setX(v, edge);
            run.setX(v, p.s);
          }
        }
        pieces += 1;
      }
    };
    /** The next point of a path: `reach` on from `p`, heading `angle`. */
    const on = (p: CrackPoint, angle: number, reach: number, w: number): CrackPoint => ({ x: p.x + Math.cos(angle) * reach, z: p.z + Math.sin(angle) * reach, w, s: p.s + reach });

    // The main break: from the edge of the attacker's square to the foot of the king, never straight for long.
    const begin = 0.36;
    const end = length - 0.4;
    const steps = Math.max(1, Math.round((end - begin) / 0.26));
    const main: CrackPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const inner = i > 0 && i < steps;
      const t = begin + ((end - begin) * (i + (inner ? (this.scatter() - 0.5) * 0.5 : 0))) / steps;
      const off = inner ? (this.scatter() - 0.5) * 0.24 : 0;
      const x = from.x + ax * t - az * off;
      const z = from.z + az * t + ax * off;
      const before = main[i - 1];
      main.push({ x, z, w: wide * (1 - 0.3 * (i / steps)), s: before ? before.s + Math.hypot(x - before.x, z - before.z) : 0 });
    }
    lay(main);

    // Lesser breaks off it, to one side and then the other, each with a turn in it and ending in nothing.
    const heading = Math.atan2(az, ax);
    let hand = this.scatter() < 0.5 ? 1 : -1;
    for (let i = 1; i < main.length - 1; i++) {
      if (main.length > 4 && this.scatter() < 0.3) continue;
      const root = main[i]!;
      const angle = heading + hand * (0.6 + this.scatter() * 0.5);
      const reach = 0.16 + this.scatter() * 0.26;
      const knee = on(root, angle, reach * 0.55, root.w * 0.5);
      lay([{ ...root, w: root.w * 0.75 }, knee, on(knee, angle - hand * 0.5, reach * 0.45, 0.003)]);
      hand = -hand;
    }

    // Where it reaches the king it parts, and runs on round the foot of it both ways.
    const tip = main[main.length - 1]!;
    const facing = Math.atan2(-az, -ax);
    for (const way of [-1, 1]) {
      const arm = [tip];
      for (let k = 1; k <= 3; k++) {
        const angle = facing + way * (0.4 + this.scatter() * 0.14) * k;
        const radius = 0.4 + (this.scatter() - 0.5) * 0.07;
        const x = to.x + Math.cos(angle) * radius;
        const z = to.z + Math.sin(angle) * radius;
        const before = arm[arm.length - 1]!;
        arm.push({ x, z, w: tip.w * (1 - k / 3.3), s: before.s + Math.hypot(x - before.x, z - before.z) });
      }
      lay(arm);
    }

    for (let v = 0; v < pieces * 4; v++) run.setX(v, run.getX(v) / far);
    position.needsUpdate = true;
    side.needsUpdate = true;
    run.needsUpdate = true;
    c.geometry.setDrawRange(0, pieces * 6);
    c.told.uColor.value.copy(colour);
    c.told.uDrawn.value = 0;
    c.told.uLevel.value = 1;
    c.age = 0;
    c.draw = o.draw ?? 0.34;
    c.healing = -1;
    c.busy = true;
  }

  /** The king is safe again: every crack closes. */
  heal(): void {
    for (const c of this.cracks) if (c.busy && c.healing < 0) c.healing = 0;
  }

  /** Tiles lift and drop in a ring spreading from a point: a piece has been set down there. */
  ripple(at: Vector3, strength = 1): void {
    this.mend(at);
    this.ripples.push({ x: at.x, z: at.z, age: 0, height: 0.075 * strength, speed: 11, beat: 0.3, hole: 0.6, reach: 2.6 + strength });
  }

  /** The whole board erupts outward from a point, square by square: mate. */
  erupt(at: Vector3): void {
    this.ripples.push({ x: at.x, z: at.z, age: 0, height: 0.6, speed: 6, beat: 0.75, hole: 0.6, reach: 12 });
  }

  /**
   * A band of light from one point on the board to another, drawing itself over `draw` seconds,
   * staying for `hold` and fading over `fade`. With `chalk` it is a dashed chalk line.
   */
  line(from: Vector3, to: Vector3, colour: Color, o: { width?: number; draw?: number; hold?: number; fade?: number; delay?: number; chalk?: boolean; level?: number } = {}): void {
    const r = this.ribbons.find((x) => !x.busy) ?? this.ribbons[0]!;
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    if (length < 1e-3) return;
    r.busy = true;
    r.age = 0;
    r.draw = o.draw ?? 0.28;
    r.hold = o.hold ?? 0.5;
    r.fade = o.fade ?? 0.9;
    r.delay = o.delay ?? 0;
    r.mesh.position.set((from.x + to.x) / 2, Math.max(from.y, to.y) + 0.014, (from.z + to.z) / 2);
    r.mesh.scale.set(length, 1, o.width ?? 0.085);
    // The quad's own x runs along the line, from `from` to `to`.
    r.mesh.quaternion.setFromAxisAngle(UP, Math.atan2(-(to.z - from.z), to.x - from.x));
    const u = r.material.uniforms;
    (u.uColor!.value as Color).copy(colour).multiplyScalar(o.level ?? 1);
    u.uLength!.value = length;
    u.uChalk!.value = o.chalk ? 1 : 0;
    u.uDrawn!.value = 0;
    u.uOpacity!.value = 0;
  }

  /** A square of flat light that decays. */
  flash(at: Vector3, colour: Color, seconds = 1, size = 1): void {
    const f = this.flashes.find((x) => !x.busy) ?? this.flashes[0]!;
    f.busy = true;
    f.age = 0;
    f.life = seconds;
    f.mesh.position.set(at.x, at.y + 0.012, at.z);
    f.mesh.scale.set(size, 1, size);
    (f.material.uniforms.uColor!.value as Color).copy(colour);
    f.mesh.visible = true;
  }

  /** Violet fog over the board, 0 (none) to 1. */
  setFog(level: number): void {
    this.fogLevel.goal = level;
  }

  /** A pillar of light on a point, or (with null) none. */
  setPillar(at: Vector3 | null): void {
    if (at) this.pillar.position.set(at.x, 0, at.z);
    this.pillarLevel.goal = at ? 1 : 0;
  }

  /** How high the tile under a point is standing just now. Pieces ride their tiles. */
  liftAt(x: number, z: number): number {
    const file = Math.floor(x + 4);
    const rank = Math.floor(4 - z);
    return file < 0 || file > 7 || rank < 0 || rank > 7 ? 0 : this.lift[rank * 8 + file]!;
  }

  /** Stop everything at once, for a new game. */
  clear(): void {
    this.ripples.length = 0;
    this.lift.fill(0);
    for (const r of this.ribbons) {
      r.busy = false;
      r.mesh.visible = false;
    }
    for (const f of this.flashes) {
      f.busy = false;
      f.mesh.visible = false;
    }
    for (const w of this.wakes) {
      w.points.length = 0;
      w.live = false;
      w.mesh.visible = false;
    }
    this.flecks.length = 0;
    this.fleckMesh.count = 0;
    this.crumbles.length = 0;
    this.broken.fill(0);
    this.rayAge = -1;
    this.fan.visible = false;
    for (const p of this.prisms) {
      p.busy = false;
      p.body.visible = false;
    }
    for (const c of this.cracks) {
      c.busy = false;
      c.body.visible = false;
    }
    this.fogLevel.snap(0);
    this.pillarLevel.snap(0);
  }

  /** What is in the air or on the board: flecks, the points each wake is holding, a fan of rays, prisms, cracks. For tests, which have no eyes. */
  get airborne(): { flecks: number; wakes: number[]; rays: boolean; prisms: number; cracks: number } {
    return {
      flecks: this.flecks.length,
      wakes: this.wakes.map((w) => w.points.length),
      rays: this.rayAge >= 0,
      prisms: this.prisms.filter((p) => p.busy).length,
      cracks: this.cracks.filter((c) => c.busy).length,
    };
  }

  /** How many squares are breaking up or setting themselves right just now. For tests. */
  get crumbling(): number {
    return this.crumbles.length;
  }

  /** How many cracks are standing: there, and not on their way out. */
  get cracked(): number {
    return this.cracks.filter((c) => c.busy && c.healing < 0).length;
  }

  update(dt: number, time: number): void {
    this.now += dt;
    this.updateWakes();
    this.updateFlecks(dt);
    this.updateRays(dt);
    this.updatePrisms(dt);
    this.updateCracks(dt, time);

    // Tiles: each one's height is the sum of the waves passing under it.
    this.lift.fill(0);
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < r.reach / r.speed + r.beat + 0.05);
    if (this.ripples.length > 0) {
      for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
          const x = file - 3.5;
          const z = 3.5 - rank;
          let y = 0;
          for (const r of this.ripples) {
            const d = Math.hypot(x - r.x, z - r.z);
            if (d < r.hole || d > r.reach) continue;
            const since = r.age - d / r.speed;
            if (since <= 0 || since >= r.beat) continue;
            // Up fast, down slower, smaller the further out.
            const k = since / r.beat;
            y += r.height * Math.sin(Math.PI * Math.pow(k, 0.7)) / (1 + 0.3 * d);
          }
          this.lift[rank * 8 + file] = y;
        }
      }
    }

    for (const r of this.ribbons) {
      if (!r.busy) continue;
      r.age += dt;
      const t = r.age - r.delay;
      const u = r.material.uniforms;
      r.mesh.visible = t > 0;
      if (t <= 0) continue;
      // Drawn with a slow finish, held, then let go.
      const k = Math.min(1, t / r.draw);
      u.uDrawn!.value = 1 - Math.pow(1 - k, 3);
      const fading = (t - r.draw - r.hold) / r.fade;
      u.uOpacity!.value = fading <= 0 ? 1 : Math.max(0, 1 - fading * fading * (3 - 2 * fading));
      if (fading >= 1) {
        r.busy = false;
        r.mesh.visible = false;
      }
    }

    for (const f of this.flashes) {
      if (!f.busy) continue;
      f.age += dt;
      const k = f.age / f.life;
      // A clear first frame, then out of the way.
      f.material.uniforms.uLevel!.value = Math.pow(Math.max(0, 1 - k), 2.2);
      if (k >= 1) {
        f.busy = false;
        f.mesh.visible = false;
      }
    }

    this.fogLevel.step(dt, 1.4);
    this.fog.uniforms.uLevel!.value = Math.max(0, this.fogLevel.value);
    this.fog.uniforms.uTime!.value = time;
    this.pillarLevel.step(dt, 2.2);
    const pillar = Math.max(0, this.pillarLevel.value);
    this.pillar.visible = pillar > 0.01;
    (this.pillar.material as ShaderMaterial).uniforms.uLevel!.value = pillar * (0.92 + 0.08 * Math.sin(time * 9));
    this.updateCrumbles(dt);
  }

  /**
   * Squares that are breaking up: tell the tiles' material how far each has got, and let the slab
   * give a little as it is released and seat itself as it is whole. Nothing to do with none.
   */
  private updateCrumbles(dt: number): void {
    if (this.crumbles.length === 0) return;
    const life = this.still ? CRUMBLE_LIFE / 2 : CRUMBLE_LIFE;
    for (const c of this.crumbles) {
      c.age += dt * c.pace;
      const k = c.age / life;
      if (k >= 1) {
        this.broken[c.square] = 0;
        continue;
      }
      // Its level and, behind the point, how far through it is: never quite 1, which would be the next level.
      this.broken[c.square] = c.level + Math.min(0.98, k * 0.98);
      if (this.still) continue;
      const give = k < 0.22 ? Math.sin((Math.PI * k) / 0.22) : 0;
      const seat = k > 0.82 ? Math.sin((Math.PI * (k - 0.82)) / 0.18) : 0;
      this.lift[c.square] -= CRUMBLE_GIVE * give + CRUMBLE_SEAT * seat;
    }
    this.crumbles = this.crumbles.filter((c) => c.age < life);
  }

  /** The fan shoots out, stands, and fades where it stands. */
  private updateRays(dt: number): void {
    if (this.rayAge < 0) return;
    this.rayAge += dt;
    const fading = (this.rayAge - RAYS_OPEN - RAYS_HOLD) / RAYS_FADE;
    if (fading >= 1) {
      this.rayAge = -1;
      this.fan.visible = false;
      return;
    }
    this.fanTold.uOpen.value = Math.min(1, this.rayAge / RAYS_OPEN);
    this.fanTold.uLevel.value = fading <= 0 ? 1 : 1 - fading * fading * (3 - 2 * fading);
    this.fan.visible = true;
  }

  /** Each crack runs to its end, lies there with a low light in it, and closes when it is told to. */
  private updateCracks(dt: number, time: number): void {
    for (const c of this.cracks) {
      if (!c.busy) continue;
      c.age += dt;
      if (c.healing >= 0) c.healing += dt;
      if (c.healing >= CRACK_HEAL) {
        c.busy = false;
        c.body.visible = false;
        continue;
      }
      // It sets off fast and arrives slowing, and runs a little past its end so that its bright head leaves it.
      const k = Math.min(1, c.age / c.draw);
      c.told.uDrawn.value = (1 - (1 - k) * (1 - k)) * 1.2;
      const closing = c.healing < 0 ? 0 : c.healing / CRACK_HEAL;
      c.told.uLevel.value = 1 - closing * closing * (3 - 2 * closing);
      // The light in it beats slowly for as long as it stands.
      c.told.uGlow.value = 0.5 + 0.18 * Math.sin(time * 5.2);
      c.body.visible = true;
    }
  }

  /** Each prism rises from the board to its height, stands, and fades. */
  private updatePrisms(dt: number): void {
    for (const p of this.prisms) {
      if (!p.busy) continue;
      p.age += dt;
      const fading = (p.age - PRISM_RISE - p.hold) / PRISM_FADE;
      if (fading >= 1) {
        p.busy = false;
        p.body.visible = false;
        continue;
      }
      const k = Math.min(1, p.age / PRISM_RISE);
      const risen = 1 - Math.pow(1 - k, 3);
      const height = Math.max(0.02, p.height * risen);
      p.body.scale.set(0.8, height, 0.8);
      p.told.uSize.value.set(0.8, height, 0.8);
      // Brightest as it closes, then steady.
      const level = fading <= 0 ? 0.75 + 0.5 * Math.max(0, 1 - Math.abs(p.age - PRISM_RISE) / 0.18) : 0.75 * (1 - fading * fading * (3 - 2 * fading));
      p.told.uLevel.value = level;
      p.body.visible = true;
    }
  }

  /** Let go of the points that have hung long enough, and lay the rest out for drawing. */
  private updateWakes(): void {
    for (const w of this.wakes) {
      const p = w.points;
      while (p.length > 0 && this.now - p[0]!.born >= WAKE_LIFE) p.shift();
      // A band needs two points; one alone is nothing to see.
      w.mesh.visible = p.length > 1;
      if (p.length < 2) {
        if (!w.live) p.length = 0;
        continue;
      }
      const g = w.mesh.geometry;
      const position = g.getAttribute('position') as BufferAttribute;
      const along = g.getAttribute('aAlong') as BufferAttribute;
      const born = g.getAttribute('aBorn') as BufferAttribute;
      for (let i = 0; i < p.length; i++) {
        const at = p[i]!;
        // Which way the path runs here: from the point before to the point after.
        const a = p[Math.max(0, i - 1)]!;
        const b = p[Math.min(p.length - 1, i + 1)]!;
        for (let side = 0; side < 2; side++) {
          const v = 2 * i + side;
          position.setXYZ(v, at.x, at.y, at.z);
          along.setXYZ(v, b.x - a.x, b.y - a.y, b.z - a.z);
          born.setX(v, at.born);
        }
      }
      position.needsUpdate = true;
      along.needsUpdate = true;
      born.needsUpdate = true;
      g.setDrawRange(0, (p.length - 1) * 6);
      w.material.uniforms.uNow!.value = this.now;
    }
  }

  /** Carry the flecks on: up fast and then slower, turning, and at the end shrinking to nothing. */
  private updateFlecks(dt: number): void {
    if (this.flecks.length === 0) {
      this.fleckMesh.count = 0;
      return;
    }
    const slow = Math.exp(-dt * 2.1);
    for (const f of this.flecks) {
      f.age += dt;
      if (f.age <= 0) continue;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      f.vx *= slow;
      f.vy *= slow;
      f.vz *= slow;
      f.turn += f.spin * dt;
    }
    this.flecks = this.flecks.filter((f) => f.age < f.life);
    let shown = 0;
    for (const f of this.flecks) {
      if (f.age <= 0) continue;
      const k = f.age / f.life;
      // There at once, whole for most of its life, then drawn in to a point.
      const end = Math.max(0, (k - 0.5) / 0.5);
      const scale = f.size * Math.min(1, k / 0.06) * (1 - end * end);
      fleckAt.set(f.x, f.y, f.z);
      fleckTurn.setFromAxisAngle(f.axis, f.turn);
      fleckSize.set(scale * f.long, scale, scale);
      this.fleckMesh.setMatrixAt(shown++, fleckMatrix.compose(fleckAt, fleckTurn, fleckSize));
    }
    this.fleckMesh.count = shown;
    this.fleckMesh.instanceMatrix.needsUpdate = true;
  }
}
