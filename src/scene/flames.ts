/**
 * Every candle flame in the room in two draw calls: the flames (upright
 * billboards) and their halos (camera-facing). The light the candles in the
 * wall niches throw is baked (see roomshade.ts); only the tall candles at the
 * corners of the board carry real lights.
 *
 * The flicker runs in the shaders from one clock, so the only per-frame work
 * on the CPU is that handful of lights.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';

/** The same flicker in GLSL and in TypeScript, so lights and flames move together. */
export const FLICKER_GLSL = /* glsl */ `
  float flicker( float phase, float time, float calm ) {
    float slow = sin( time * 2.3 + phase ) * sin( time * 3.7 + phase * 1.3 );
    float fast = sin( time * 11.0 + phase * 2.1 );
    return 1.0 + ( 0.08 + 0.22 * ( 1.0 - calm ) ) * slow + 0.035 * fast;
  }`;

/** How bright a flame is at a moment, around 1. `calm` is 1 for steady flames and 0 for guttering ones. */
export function flicker(phase: number, time: number, calm: number): number {
  const slow = Math.sin(time * 2.3 + phase) * Math.sin(time * 3.7 + phase * 1.3);
  const fast = Math.sin(time * 11 + phase * 2.1);
  return 1 + (0.08 + 0.22 * (1 - calm)) * slow + 0.035 * fast;
}

function flameTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 86, 2, 32, 74, 50);
  g.addColorStop(0, 'rgba(255,250,225,1)');
  g.addColorStop(0.22, 'rgba(255,214,130,0.95)');
  g.addColorStop(0.55, 'rgba(255,140,50,0.4)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  x.fillStyle = g;
  x.beginPath();
  x.moveTo(32, 4);
  x.bezierCurveTo(52, 50, 60, 84, 32, 124);
  x.bezierCurveTo(4, 84, 12, 50, 32, 4);
  x.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function haloTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,190,110,0.55)');
  g.addColorStop(0.3, 'rgba(255,150,70,0.16)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

interface Card {
  at: Vector3;
  width: number;
  height: number;
  phase: number;
  /** How far toward the eye the card is drawn from where it stands, so that what it glows round does not cut it. */
  lift?: number;
}

/** One quad per card; the corners are pushed out from the shared centre in the vertex shader. */
function cardGeometry(cards: Card[]): BufferGeometry {
  const position = new Float32Array(cards.length * 12);
  const corner = new Float32Array(cards.length * 8);
  const size = new Float32Array(cards.length * 8);
  const phase = new Float32Array(cards.length * 4);
  const lift = new Float32Array(cards.length * 4);
  const index: number[] = [];
  const corners = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
  cards.forEach((card, i) => {
    for (let v = 0; v < 4; v++) {
      position.set([card.at.x, card.at.y, card.at.z], i * 12 + v * 3);
      corner.set([corners[v * 2]!, corners[v * 2 + 1]!], i * 8 + v * 2);
      size.set([card.width, card.height], i * 8 + v * 2);
      phase[i * 4 + v] = card.phase;
      lift[i * 4 + v] = card.lift ?? 0;
    }
    const o = i * 4;
    index.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('aCorner', new BufferAttribute(corner, 2));
  g.setAttribute('aSize', new BufferAttribute(size, 2));
  g.setAttribute('aPhase', new BufferAttribute(phase, 1));
  g.setAttribute('aLift', new BufferAttribute(lift, 1));
  g.setIndex(index);
  return g;
}

interface CardOptions {
  map: CanvasTexture;
  color: Color;
  /** Flames stand upright and turn about their wick; halos face the camera squarely. */
  upright: boolean;
  /** How much of the flicker shows as a change in brightness (the rest, for flames, is shape). */
  shimmer: number;
}

function cardMaterial(o: CardOptions): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: o.map },
      uColor: { value: o.color },
      uTime: { value: 0 },
      uCalm: { value: 1 },
      uLit: { value: 1 },
      uUpright: { value: o.upright ? 1 : 0 },
      uShimmer: { value: o.shimmer },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec2 aSize;
      attribute float aPhase;
      attribute float aLift;
      uniform float uTime, uCalm, uUpright;
      varying vec2 vUv;
      varying float vFlicker;
      ${FLICKER_GLSL}
      void main() {
        float f = flicker( aPhase, uTime, uCalm );
        vec3 centre = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        centre += normalize( cameraPosition - centre ) * aLift;
        vec3 toCamera = cameraPosition - centre;
        // How nearly straight down on it the eye looks.
        float steepness = abs( toCamera.y ) / max( length( toCamera ), 1e-4 );
        vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
        vec3 up = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
        vec2 size = aSize;
        if ( uUpright > 0.5 ) {
          // Upright, except from steeply above, where an upright card would be seen edge-on.
          float steep = smoothstep( 0.55, 0.9, steepness );
          up = normalize( mix( vec3( 0.0, 1.0, 0.0 ), up, steep ) );
          vec3 across = cross( up, toCamera );
          if ( dot( across, across ) > 1e-8 ) right = normalize( across );
          // A flame that grows taller grows thinner; and seen from above it is only as long as it is wide.
          size *= vec2( 2.0 - f, f );
          size.y = mix( size.y, size.x * 1.1, steep );
        } else {
          // Looked down on, a candle's glow is the small pool round its wick and no more.
          float above = smoothstep( 0.6, 0.95, steepness );
          size *= mix( 1.0, 0.32, above );
          f *= mix( 1.0, 0.6, above );
        }
        vec3 world = centre + right * ( aCorner.x * size.x ) + up * ( aCorner.y * size.y );
        vUv = aCorner + 0.5;
        vFlicker = f;
        gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uShimmer;
      uniform float uLit;
      varying vec2 vUv;
      varying float vFlicker;
      void main() {
        vec4 t = texture2D( uMap, vUv );
        gl_FragColor = vec4( t.rgb * uColor * t.a * mix( 1.0, vFlicker, uShimmer ) * uLit, 1.0 );
      }`,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}

export interface FlameSpec {
  at: Vector3;
  /** How wide the glow round it is drawn: wide for a tall candle in the open, close for a stub or one in a niche. */
  halo: number;
}

/** A lantern's flicker phase, from where it hangs; the glass of the lantern there (roomshade.ts) moves with the same one. */
export const lanternPhase = (at: Vector3): number => Math.floor(at.x * 0.17 + 0.5) * 3.1 + Math.floor(at.z * 0.17 + 0.5) * 7.3;

export class Flames {
  readonly root = new Group();
  private materials: ShaderMaterial[] = [];

  /**
   * `lanterns` are the middles of the lanterns' glass: each has a wide, faint halo and no flame
   * card of its own, as its flame is behind the glass. The halo is drawn a little toward the eye,
   * clear of the lantern's frame, so that it does not come and go as the frame passes in front of it.
   */
  constructor(specs: FlameSpec[], lanterns: Vector3[] = []) {
    this.root.name = 'flames';
    const phases = specs.map((_, i) => i * 1.9);

    const flames = cardMaterial({ map: flameTexture(), color: new Color(2.2, 1.9, 1.5), upright: true, shimmer: 0 });
    const halos = cardMaterial({ map: haloTexture(), color: new Color(0.4, 0.4, 0.4), upright: false, shimmer: 1 });
    this.add(new Mesh(cardGeometry(specs.map((s, i) => ({ at: s.at, width: 0.13, height: 0.3, phase: phases[i]! }))), flames), 7);
    this.add(new Mesh(cardGeometry(specs.map((s, i) => ({ at: s.at, width: s.halo, height: s.halo, phase: phases[i]! }))), halos), 7);
    if (lanterns.length > 0) {
      const glass = cardMaterial({ map: haloTexture(), color: new Color(0.3, 0.24, 0.16), upright: false, shimmer: 0.7 });
      this.add(new Mesh(cardGeometry(lanterns.map((at) => ({ at, width: 2.2, height: 2.6, phase: lanternPhase(at), lift: 0.7 }))), glass), 7);
    }
  }

  private add(mesh: Mesh, renderOrder: number): void {
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    this.materials.push(mesh.material as ShaderMaterial);
    this.root.add(mesh);
  }

  /** `calm` is 1 for steady flames and 0 for guttering ones; `lit` is how brightly they burn, 0 for out. */
  update(time: number, calm: number, lit = 1): void {
    for (const m of this.materials) {
      m.uniforms.uTime!.value = time;
      m.uniforms.uCalm!.value = calm;
      m.uniforms.uLit!.value = lit;
    }
  }
}
