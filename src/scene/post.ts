/**
 * Post-processing: the dark that gathers where things stand close, the lit air of the shaft
 * through the oculus, bloom from the hot borders and
 * seams, depth of field where the quality setting allows it, then one final pass that does the
 * vignette, tone mapping, the sRGB transfer and film grain together (style bible, section 9).
 * Doing the last four in a single pass matters on integrated graphics, where every full-screen
 * pass costs.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CustomBlending,
  DepthTexture,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  type Material,
  Matrix4,
  Mesh,
  OrthographicCamera,
  type PerspectiveCamera,
  RawShaderMaterial,
  type Scene,
  SrcColorFactor,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
  ZeroFactor,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { STEPS, type Step } from './pace';

export type Quality = 'low' | 'medium' | 'high';

/**
 * `focus` is depth of field: 'none', 'cuts' (only while the camera has pushed in on something),
 * or 'always' (the far wall and whatever is close to the lens are a little soft all the time).
 *
 * `mirror` is what the dark squares of the board reflect: the size of that second view of the
 * room against the picture's (0 for none, and the glass makes do with a flat idea of the room),
 * and `mirrorEvery` how many frames each drawing of it serves. `glass` is how finely the void
 * under the glass is drawn (0: one layer of mist; 1: two, with strands of smoke and breath on the glass), and `motes`
 * how much dust hangs in the shaft of light. `air` is the shaft itself: the size it is gathered
 * at against the picture's, and whether the dust in it drifts in curtains or hangs evenly.
 * `shade` is the dark that gathers where things stand close (see `ShadePass`): how many readings
 * each point takes of what is round it, or 0 for none.
 */
export const QUALITY: Record<
  Quality,
  {
    pixelRatio: number;
    budget: number;
    finest: number;
    samples: number;
    shadow: number;
    bloom: boolean;
    focus: 'none' | 'cuts' | 'always';
    mirror: number;
    mirrorEvery: number;
    glass: 0 | 1;
    motes: number;
    air: { scale: number; curtains: boolean };
    shade: number;
  }
> = {
  // Low renders at four fifths scale on a large screen: integrated graphics are bound by how many pixels they shade.
  low: { pixelRatio: 0.8, budget: 0.9e6, finest: 2, samples: 0, shadow: 1024, bloom: true, focus: 'none', mirror: 0, mirrorEvery: 1, glass: 0, motes: 160, air: { scale: 1, curtains: false }, shade: 0 },
  medium: { pixelRatio: 1.5, budget: 1.6e6, finest: 1.5, samples: 4, shadow: 2048, bloom: true, focus: 'cuts', mirror: 0.5, mirrorEvery: 2, glass: 1, motes: 380, air: { scale: 0.5, curtains: true }, shade: 8 },
  high: { pixelRatio: 2, budget: Infinity, finest: 2, samples: 4, shadow: 4096, bloom: true, focus: 'always', mirror: 0.5, mirrorEvery: 1, glass: 1, motes: 640, air: { scale: 0.5, curtains: true }, shade: 14 },
};

/**
 * How many pixels of the drawing buffer go to each CSS pixel of a picture this size, at this
 * quality, on a screen with this many device pixels to each CSS pixel.
 *
 * Each quality has a budget of pixels. A screen small enough that the budget would draw it at its
 * own size or finer (a phone, a tablet) is drawn by the budget: as many pixels as the budget
 * buys, up to the screen's own and up to `finest`. A low phone so draws as fine as its CSS size
 * or finer, where a fixed share of four fifths left it soft. A larger screen (a desktop) is drawn
 * as it always was, at the quality's fixed `pixelRatio` against the screen's own, so the budget
 * never makes one heavier, nor changes how one looks.
 */
export function drawingRatio(quality: Quality, width: number, height: number, devicePixelRatio: number): number {
  const q = QUALITY[quality];
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = Math.max(1, width * height);
  const fit = Math.sqrt(q.budget / area);
  if (fit >= 1) return Math.min(dpr, q.finest, fit);
  return Math.min(dpr, q.pixelRatio);
}

/**
 * A phone's screen, held either way: its shorter side is at most this many CSS pixels. On one,
 * the picture is never drawn below three quarters of what the budget gives it: the governor's
 * last steps would leave a picture so small that a phone's stretching of it smears the stones.
 */
const PHONE_SIDE = 500;
const PHONE_LEAST = 0.75;

/**
 * The ratio a picture this size is drawn at when the governor has it drawn at `scale` of `full`
 * (see `Governor`): never so small that the stones lose their edges, which on a phone is three
 * quarters of what its budget gives it, and elsewhere half a pixel to each CSS pixel.
 */
export function governedRatio(full: number, scale: number, width: number, height: number): number {
  const least = Math.min(width, height) <= PHONE_SIDE ? full * PHONE_LEAST : 0.5;
  return Math.min(full, Math.max(least, full * scale));
}

/**
 * The governor's steps that each change what is drawn, for a picture this size at this quality:
 * a smaller buffer, edges no longer smoothed, or the board's reflection drawn every other frame
 * (which any step below full size asks for, see `Chapel.ease`). The first is always full size.
 * On Low, which smooths no edges, the step that gives smoothing up is no step; on a desktop, Low
 * (drawn at 0.8) is down to the least of half a pixel at the fifth step and the sixth is the same
 * picture; on a phone, every quality is down to its least at the third.
 */
export function governorSteps(quality: Quality, width: number, height: number, devicePixelRatio: number): Step[] {
  const q = QUALITY[quality];
  const full = drawingRatio(quality, width, height, devicePixelRatio);
  const eases = q.mirror > 0 && q.mirrorEvery < 2;
  const out: Step[] = [];
  let last = '';
  for (const step of STEPS) {
    const ratio = governedRatio(full, step.scale, width, height);
    // What three.js makes of the ratio: the buffer is the canvas times it, rounded down.
    const drawn = `${Math.floor(width * ratio)}x${Math.floor(height * ratio)} ${step.smooth ? q.samples : 0} ${eases && step.scale < 1}`;
    if (drawn === last) continue;
    last = drawn;
    out.push(step);
  }
  return out;
}

/** A starting quality for this machine, from the name its graphics give and its screen: see `suggestQuality`. */
export function qualityFor(renderer: string, touch: boolean, shortSide: number): Quality {
  const weak = /Intel|UHD|Iris|HD Graphics|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Microsoft Basic/i.test(renderer);
  const strongIntel = /Arc/i.test(renderer);
  if (weak && !strongIntel) return 'low';
  // An iPhone's graphics give no more name than this, the same as an iPad's and a Mac's in Safari. On a
  // touch screen the size of a phone's, it may be some years old; on a tablet's, or a Mac, it is not so weak.
  if (/Apple GPU/i.test(renderer) && touch && shortSide < 600) return 'low';
  return 'medium';
}

/**
 * A starting quality for this machine: low on integrated and mobile graphics (a phone's included),
 * medium otherwise. The player can change it in Settings.
 */
export function suggestQuality(renderer: WebGLRenderer): Quality {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const shortSide = typeof screen !== 'undefined' ? Math.min(screen.width, screen.height) : Infinity;
  return qualityFor(name, touch, shortSide);
}

/**
 * A pixel that is not a number, or is brighter than anything in the room could be, is a fault in
 * whatever drew it; left alone, the first blur to read it spreads it over everything round it,
 * and the bloom's blur is as wide as the picture. Every pass that reads the frame takes it
 * through this first, so the fault stays the one pixel it was, and that pixel dark.
 *
 * Both tests are needed. Some shader compilers drop a comparison of a number with itself, and on
 * those the greater of zero and not-a-number is zero; others keep the comparison and do not say
 * what that greater is.
 */
export const SANE_GLSL = /* glsl */ `
  vec3 sane( vec3 c ) {
    float most = max( c.r, max( c.g, c.b ) );
    if ( ! ( c.r == c.r && c.g == c.g && c.b == c.b && most < 1.0e4 ) ) c = vec3( 0.0 );
    return clamp( c, 0.0, 64.0 );
  }`;

/** The bloom's first step, in place of the library's own: what is bright enough to bloom, read through `sane`. */
const BRIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  varying vec2 vUv;
  ${SANE_GLSL}
  void main() {
    vec3 c = sane( texture2D( tDiffuse, vUv ).rgb );
    float v = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    gl_FragColor = vec4( c * smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v ), 1.0 );
  }`;

class GradePass extends Pass {
  readonly uniforms = {
    tDiffuse: { value: null as unknown },
    toneMappingExposure: { value: 1 },
    uTime: { value: 0 },
    uVignette: { value: 0.5 },
    uTint: { value: new Vector3(1, 1, 1) },
    uContrast: { value: 1 },
    uGrain: { value: 0.045 },
  };
  private quad: FullScreenQuad;

  constructor() {
    super();
    const material = new RawShaderMaterial({
      name: 'GradePass',
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        precision highp float;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uVignette;
        uniform vec3 uTint;
        uniform float uContrast;
        uniform float uGrain;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        varying vec2 vUv;
        ${SANE_GLSL}

        float hash( vec2 p ) {
          vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
          p3 += dot( p3, p3.yzx + 33.33 );
          return fract( ( p3.x + p3.y ) * p3.z );
        }

        void main() {
          vec4 c = texture2D( tDiffuse, vUv );
          c.rgb = sane( c.rgb );

          // Vignette in linear light: the room falls away toward the corners.
          vec2 q = ( vUv - 0.5 ) * vec2( 1.0, 0.92 );
          float edge = smoothstep( 0.32, 0.86, length( q ) * 1.35 );
          c.rgb *= ( 1.0 - uVignette * edge ) * uTint;

          // Contrast about middle grey, still in linear light: what is darker than that sinks and
          // what is brighter lifts, with no change of hue. Then the shadows lean a little toward
          // the cold of the room and the lights toward candle.
          float light = max( dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
          c.rgb *= pow( light / 0.18, uContrast - 1.0 );
          c.rgb *= mix( vec3( 0.94, 1.0, 1.05 ), vec3( 1.03, 1.0, 0.965 ), smoothstep( 0.02, 0.55, light ) );

          c.rgb = ACESFilmicToneMapping( c.rgb );
          c = sRGBTransferOETF( c );

          // Film grain, a touch stronger in the mid-tones than in highlights or deep shadow.
          float n = hash( gl_FragCoord.xy + fract( uTime * 7.31 ) * 311.7 ) - 0.5;
          float luma = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          c.rgb += n * uGrain * ( 0.45 + 0.55 * ( 1.0 - abs( luma * 2.0 - 1.0 ) ) );

          gl_FragColor = vec4( c.rgb, 1.0 );
        }`,
    });
    this.quad = new FullScreenQuad(material);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  /** What the step is drawn with. */
  get materials(): Material[] {
    return [this.quad.material];
  }

  override dispose(): void {
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

const QUAD_VERTEX = /* glsl */ `
  precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;

/** The shaft of light through the oculus, as the room describes it for the frame about to be drawn. */
export interface Shaft {
  /** Half the width of the square the light falls in on the board, and how high above the board its source hangs. */
  beam: number;
  height: number;
  /** The height the shaft comes into the room at. */
  top: number;
  /** How far the shaft's middle stands off from the middle of the board for each unit of height above it: the key leans. */
  lean: Vector2;
  /** The colour of the lit air, and how much dust hangs in it. */
  colour: Color;
  dust: number;
  time: number;
}

/**
 * The air the key passes through, lit. Each pixel gathers the light along its line of sight
 * through the shaft, as far as whatever stands in the way: a piece in the beam has only the lit
 * air in front of it over it, so it stays dark against the brightness behind. The light is
 * gathered into a picture of its own, which may be smaller than the frame, and then laid over
 * the frame.
 */
class AirPass extends Pass {
  private uniforms = {
    tDepth: { value: null as unknown },
    uNear: { value: 0.1 },
    uFar: { value: 220 },
    uUnproject: { value: new Matrix4() },
    uCameraWorld: { value: new Matrix4() },
    uBeam: { value: 4.7 },
    uHeight: { value: 78 },
    uTop: { value: 27 },
    uLean: { value: new Vector2() },
    uColor: { value: new Color(0, 0, 0) },
    uDust: { value: 0 },
    uTime: { value: 0 },
  };
  private gathered = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private gather: FullScreenQuad;
  private lay: FullScreenQuad;
  private layUniforms = { tAir: { value: this.gathered.texture as unknown }, uTexel: { value: new Vector2(1, 1) } };

  constructor(
    private camera: PerspectiveCamera,
    private scale: number,
    curtains: boolean,
  ) {
    super();
    this.needsSwap = false;
    this.gather = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'AirGather',
        uniforms: this.uniforms,
        defines: curtains ? { CURTAINS: '' } : {},
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          // A sampler is read coarsely unless told otherwise, and depth read coarsely is a staircase.
          precision highp sampler2D;
          uniform sampler2D tDepth;
          uniform float uNear, uFar;
          uniform mat4 uUnproject;
          uniform mat4 uCameraWorld;
          uniform float uBeam, uHeight, uTop, uDust, uTime;
          uniform vec2 uLean;
          uniform vec3 uColor;
          varying vec2 vUv;

          // Keep the part of the ray on the near side of a plane.
          void keep( vec3 n, float d, vec3 o, vec3 dir, inout float tEnter, inout float tExit ) {
            float denom = dot( n, dir );
            float num = d - dot( n, o );
            if ( denom > 1e-5 ) tExit = min( tExit, num / denom );
            else if ( denom < -1e-5 ) tEnter = max( tEnter, num / denom );
            else if ( num < 0.0 ) tExit = -1.0;
          }

          // The dust thins towards the board, so the stones stand clear of the brightness above and
          // behind them; and the light is lost in the dark well below the vault, which a leaning
          // shaft would otherwise be seen to come through.
          #define RISE( y ) ( mix( 0.22, 1.0, smoothstep( 0.5, 6.5, y ) ) * ( 1.0 - smoothstep( 0.36 * uTop, 0.64 * uTop, y ) ) )

          #ifdef CURTAINS
            float hash( vec3 p ) {
              p = fract( p * 0.1031 );
              p += dot( p, p.zyx + 31.32 );
              return fract( ( p.x + p.y ) * p.z );
            }
            float noise( vec3 p ) {
              vec3 i = floor( p );
              vec3 f = fract( p );
              f = f * f * ( 3.0 - 2.0 * f );
              return mix( mix( mix( hash( i ), hash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
                               mix( hash( i + vec3( 0.0, 1.0, 0.0 ) ), hash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
                          mix( mix( hash( i + vec3( 0.0, 0.0, 1.0 ) ), hash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
                               mix( hash( i + vec3( 0.0, 1.0, 1.0 ) ), hash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
            }
            // How much dust hangs at a point, about 1 high up. It hangs in tall curtains that follow the
            // light down and drift slowly across it, with finer dust sinking through them. \`p\` is in
            // the frame that leans with the shaft.
            float dust( vec3 p ) {
              vec2 along = p.xz * uHeight / max( uHeight - p.y, 1.0 );
              float curtain = noise( vec3( along * 0.62 + vec2( uTime * 0.021, - uTime * 0.014 ), uTime * 0.026 ) );
              float fine = noise( vec3( p.x, p.y * 0.3 + uTime * 0.035, p.z ) * 1.9 + vec3( 7.3, uTime * 0.05, 2.1 ) );
              return RISE( p.y ) * ( 0.42 + 1.16 * curtain + 0.24 * fine );
            }
          #endif

          void main() {
            // The line of sight through this pixel, and how far along it the picture's surface is.
            vec4 back = uUnproject * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
            vec3 sight = back.xyz / back.w;
            float depth = texture2D( tDepth, vUv ).x;
            float ahead = ( uNear * uFar ) / ( uFar - depth * ( uFar - uNear ) );
            float reach = ahead * length( sight ) / max( - sight.z, 1e-4 );
            vec3 dir = normalize( ( uCameraWorld * vec4( sight, 0.0 ) ).xyz );
            // No part of the direction may be nothing: it is divided by.
            dir = mix( dir, vec3( 2e-5 ), step( abs( dir ), vec3( 1e-5 ) ) );
            vec3 o = uCameraWorld[ 3 ].xyz;
            // The shaft leans with the key. In a frame that leans as much it stands plumb, and a
            // straight line of sight is still straight there, and as long.
            vec3 lean = vec3( uLean.x, 0.0, uLean.y );
            vec3 axis = normalize( vec3( uLean.x, 1.0, uLean.y ) );
            float along = abs( dot( dir, axis ) );
            o -= lean * o.y;
            dir -= lean * dir.y;
            dir = mix( dir, vec3( 2e-5 ), step( abs( dir ), vec3( 1e-5 ) ) );

            // The shaft is a square that widens a little as it falls from its source.
            float tEnter = 0.0;
            float tExit = reach;
            float k = uBeam / uHeight;
            keep( vec3( 1.0, k, 0.0 ), uBeam, o, dir, tEnter, tExit );
            keep( vec3( -1.0, k, 0.0 ), uBeam, o, dir, tEnter, tExit );
            keep( vec3( 0.0, k, 1.0 ), uBeam, o, dir, tEnter, tExit );
            keep( vec3( 0.0, k, -1.0 ), uBeam, o, dir, tEnter, tExit );
            keep( vec3( 0.0, 1.0, 0.0 ), uTop, o, dir, tEnter, tExit );
            float path = max( 0.0, tExit - tEnter );

            // Light per unit of air falls off with the square of the distance below the source.
            #ifdef CURTAINS
              float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
              float sum = 0.0;
              for ( int i = 0; i < 5; i ++ ) {
                vec3 p = o + dir * ( tEnter + path * ( float( i ) + jitter ) / 5.0 );
                float below = max( uHeight - p.y, 1.0 );
                sum += dust( p ) * uHeight * uHeight / ( below * below );
              }
              float lit = sum * path / 5.0;
            #else
              float a0 = uHeight - ( o.y + dir.y * tEnter );
              float a1 = uHeight - ( o.y + dir.y * tExit );
              float lit = uHeight * uHeight * path / max( a0 * a1, 1.0 ) * RISE( o.y + dir.y * ( tEnter + tExit ) * 0.5 );
            #endif

            // Looking straight down the shaft would bury the board in haze, so it thins out overhead;
            // and from close by, where the shaft fills the picture and has no edge to be seen by, it
            // is only a veil over the far side of the board, so it thins as the eye comes near.
            float overhead = 1.0 - smoothstep( 0.55, 0.96, along );
            float apart = mix( 0.55, 1.0, smoothstep( 9.0, 16.0, length( o.xz ) ) );
            gl_FragColor = vec4( uColor * ( 1.0 - exp( - uDust * apart * lit ) ) * overhead, 1.0 );
          }`,
      }),
    );
    this.lay = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'AirLay',
        uniforms: this.layUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D tAir;
          uniform vec2 uTexel;
          varying vec2 vUv;
          void main() {
            // Four readings, half a texel apart, take the grain of the gathering out.
            vec3 air = texture2D( tAir, vUv + uTexel * vec2( 0.5, 0.5 ) ).rgb + texture2D( tAir, vUv + uTexel * vec2( -0.5, 0.5 ) ).rgb
                     + texture2D( tAir, vUv + uTexel * vec2( 0.5, -0.5 ) ).rgb + texture2D( tAir, vUv + uTexel * vec2( -0.5, -0.5 ) ).rgb;
            gl_FragColor = vec4( air * 0.25, 1.0 );
          }`,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.gather.material.depthTest = false;
    this.gather.material.depthWrite = false;
  }

  set(shaft: Shaft): void {
    const u = this.uniforms;
    u.uBeam.value = shaft.beam;
    u.uHeight.value = shaft.height;
    u.uTop.value = shaft.top;
    u.uLean.value.copy(shaft.lean);
    u.uColor.value.copy(shaft.colour);
    u.uDust.value = shaft.dust;
    u.uTime.value = shaft.time;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.ceil(width * this.scale));
    const h = Math.max(1, Math.ceil(height * this.scale));
    this.gathered.setSize(w, h);
    this.layUniforms.uTexel.value.set(1 / w, 1 / h);
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const u = this.uniforms;
    if (!readBuffer.depthTexture || u.uDust.value <= 0) return;
    u.tDepth.value = readBuffer.depthTexture;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uUnproject.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    // The frame is added to, not drawn afresh.
    const clears = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.gathered);
    this.gather.render(renderer);
    renderer.setRenderTarget(readBuffer);
    this.lay.render(renderer);
    renderer.autoClear = clears;
  }

  /** What the step is drawn with. */
  get materials(): Material[] {
    return [this.gather.material, this.lay.material];
  }

  override dispose(): void {
    this.gathered.dispose();
    this.gather.material.dispose();
    this.gather.dispose();
    this.lay.material.dispose();
    this.lay.dispose();
  }
}

/** How far round a point, in squares of the board, what stands there shades it. */
const SHADE_RADIUS = 0.62;
/** Beyond this far from the eye nothing is shaded: the walls are in the air's haze, and have their own baked shade. */
const SHADE_REACH = 46;

/**
 * The dark that gathers where things stand close: under the foot of a stone, in the joint where
 * the case meets the altar, between two pieces side by side, in the steps and the mouldings.
 * None of the lights makes it, because all but the key cast no shadow and the room's own light
 * comes from everywhere; without it things lie on one another like cut paper.
 *
 * It is worked out from the picture's depth alone. For each point, a ring of readings of what is
 * round it within `SHADE_RADIUS`: whatever stands above the point's own surface, near it, hides
 * that much of the room from it (McGuire's scalable ambient obscurance). It is gathered at half
 * size, each pixel's ring turned by an angle of its own, which leaves it as grain; the grain is
 * blurred away, across and then down, by a blur that does not cross an edge; and the frame is
 * multiplied by what is left.
 */
class ShadePass extends Pass {
  private uniforms = {
    tDepth: { value: null as unknown },
    uUnproject: { value: new Matrix4() },
    uProject: { value: new Matrix4() },
    /** One pixel of the full picture, as a step in texture coordinates. */
    uPixel: { value: new Vector2(0.001, 0.001) },
  };
  private layUniforms = {
    tShade: { value: null as unknown },
    tDepth: { value: null as unknown },
    uNear: { value: 0.1 },
    uFar: { value: 220 },
    /** One pixel of the half-size picture. */
    uTexel: { value: new Vector2(0.002, 0.002) },
    /** How dark the darkest of it is laid: 0 not at all, 1 as dark as it was found. */
    uAmount: { value: 0.8 },
  };
  private smoothUniforms = {
    tShade: { value: null as unknown },
    /** One pixel of the half-size picture along the way the blur runs. */
    uStep: { value: new Vector2(0.002, 0) },
  };
  private gathered = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private smoothed = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private gather: FullScreenQuad;
  private smooth: FullScreenQuad;
  private lay: FullScreenQuad;

  constructor(
    private camera: PerspectiveCamera,
    taps: number,
  ) {
    super();
    this.needsSwap = false;
    this.layUniforms.tShade.value = this.gathered.texture;
    this.smooth = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'ShadeSmooth',
        uniforms: this.smoothUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          precision highp sampler2D;
          uniform sampler2D tShade;
          uniform vec2 uStep;
          varying vec2 vUv;
          void main() {
            vec2 here = texture2D( tShade, vUv ).rg;
            float sum = here.r * 0.16;
            float total = 0.16;
            // Four pixels either way, each counting for less the farther off it is, and for
            // nothing if it lies on something nearer or farther than this point.
            for ( int i = 1; i <= 4; i ++ ) {
              float fi = float( i );
              float fall = 0.16 * exp( - fi * fi / 9.0 );
              for ( int side = 0; side < 2; side ++ ) {
                vec2 g = texture2D( tShade, vUv + uStep * ( side == 0 ? fi : - fi ) ).rg;
                float w = fall * max( 0.0, 1.0 - abs( g.g - here.g ) / ( 0.02 * here.g + 0.03 ) );
                sum += g.r * w;
                total += w;
              }
            }
            gl_FragColor = vec4( sum / total, here.g, 0.0, 1.0 );
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.gather = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'ShadeGather',
        uniforms: this.uniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          precision highp sampler2D;
          uniform sampler2D tDepth;
          uniform mat4 uUnproject;
          uniform mat4 uProject;
          uniform vec2 uPixel;
          varying vec2 vUv;

          // Where the surface drawn at a point of the picture is, as the camera sees it. The point
          // is moved to the middle of the pixel it lies in: this is drawn at half size, so each of
          // its own points lies on the corner between four pixels of the depth, and which of the
          // four is read there is chance; the place has to be the one that depth was drawn at.
          vec3 at( vec2 uv ) {
            uv = ( floor( uv / uPixel ) + 0.5 ) * uPixel;
            vec4 p = uUnproject * vec4( uv * 2.0 - 1.0, texture2D( tDepth, uv ).x * 2.0 - 1.0, 1.0 );
            return p.xyz / p.w;
          }

          void main() {
            // A hair off the corner, so that the same one of the four is taken all over the picture.
            vec2 here = vUv + uPixel * 0.25;
            vec3 p = at( here );
            float away = - p.z;
            float shade = 1.0;
            if ( away < ${SHADE_REACH.toFixed(1)} ) {
              // Which way the surface faces, from its neighbours in the picture: of each pair, the
              // one nearer in depth, so that an edge does not turn it.
              vec3 l = at( here - vec2( uPixel.x, 0.0 ) );
              vec3 r = at( here + vec2( uPixel.x, 0.0 ) );
              vec3 d = at( here - vec2( 0.0, uPixel.y ) );
              vec3 u = at( here + vec2( 0.0, uPixel.y ) );
              vec3 across = abs( l.z - p.z ) < abs( r.z - p.z ) ? p - l : r - p;
              vec3 up = abs( d.z - p.z ) < abs( u.z - p.z ) ? p - d : u - p;
              vec3 n = normalize( cross( across, up ) );

              // The ring, as wide in the picture as the radius is at this distance.
              vec2 span = vec2( uProject[ 0 ][ 0 ], uProject[ 1 ][ 1 ] ) * ( 0.5 * ${SHADE_RADIUS.toFixed(3)} / max( away, 0.1 ) );
              span = min( span, vec2( 0.09 ) );
              float turn = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
              float sum = 0.0;
              for ( int i = 0; i < ${taps}; i ++ ) {
                float fi = ( float( i ) + 0.5 ) / ${taps.toFixed(1)};
                float a = float( i ) * 2.39996323 + turn;
                vec3 v = at( here + vec2( cos( a ), sin( a ) ) * span * sqrt( fi ) ) - p;
                float vv = dot( v, v );
                float near = max( ${(SHADE_RADIUS * SHADE_RADIUS).toFixed(4)} - vv, 0.0 );
                // What stands above this surface hides the room from it; what lies level with it does not.
                sum += near * near * near * max( ( dot( v, n ) - 0.012 - 0.0016 * away ) / ( vv + 0.012 ), 0.0 );
              }
              shade = max( 0.0, 1.0 - sum * ${(5 / (SHADE_RADIUS ** 6 * taps)).toFixed(4)} );
              shade = mix( shade, 1.0, smoothstep( ${(SHADE_REACH * 0.55).toFixed(1)}, ${SHADE_REACH.toFixed(1)}, away ) );
            }
            gl_FragColor = vec4( shade, away, 0.0, 1.0 );
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.lay = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'ShadeLay',
        uniforms: this.layUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          precision highp sampler2D;
          uniform sampler2D tShade;
          uniform sampler2D tDepth;
          uniform float uNear;
          uniform float uFar;
          uniform vec2 uTexel;
          uniform float uAmount;
          varying vec2 vUv;
          void main() {
            float d = texture2D( tDepth, vUv ).x;
            float here = ( uNear * uFar ) / ( uFar - d * ( uFar - uNear ) );
            // Four readings of the gathering round this point. One that lies across an edge, on
            // something nearer or farther than this point, is left out.
            float sum = 0.0;
            float total = 0.0;
            for ( int i = 0; i < 4; i ++ ) {
              vec2 uv = vUv + vec2( i == 0 || i == 3 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0 ) * uTexel;
              vec2 g = texture2D( tShade, uv ).rg;
              float w = max( 0.0, 1.0 - abs( g.g - here ) / ( 0.03 * here + 0.04 ) ) + 1e-3;
              sum += g.r * w;
              total += w;
            }
            float shade = mix( 1.0, sum / total, uAmount );
            // The dark is the room's own, which is cold: a little of the blue is left in it.
            gl_FragColor = vec4( pow( vec3( shade ), vec3( 1.12, 1.0, 0.9 ) ), 1.0 );
          }`,
        // The frame is multiplied by what is drawn.
        blending: CustomBlending,
        blendSrc: ZeroFactor,
        blendDst: SrcColorFactor,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.ceil(width / 2));
    const h = Math.max(1, Math.ceil(height / 2));
    this.gathered.setSize(w, h);
    this.smoothed.setSize(w, h);
    this.uniforms.uPixel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.layUniforms.uTexel.value.set(0.5 / w, 0.5 / h);
  }

  override render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    if (!readBuffer.depthTexture) return;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.uUnproject.value.copy(this.camera.projectionMatrixInverse);
    this.uniforms.uProject.value.copy(this.camera.projectionMatrix);
    this.layUniforms.tDepth.value = readBuffer.depthTexture;
    this.layUniforms.uNear.value = this.camera.near;
    this.layUniforms.uFar.value = this.camera.far;
    const clears = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.gathered);
    this.gather.render(renderer);
    const step = this.smoothUniforms.uStep.value;
    this.smoothUniforms.tShade.value = this.gathered.texture;
    step.set(1 / this.gathered.width, 0);
    renderer.setRenderTarget(this.smoothed);
    this.smooth.render(renderer);
    this.smoothUniforms.tShade.value = this.smoothed.texture;
    step.set(0, 1 / this.gathered.height);
    renderer.setRenderTarget(this.gathered);
    this.smooth.render(renderer);
    renderer.setRenderTarget(readBuffer);
    this.lay.render(renderer);
    renderer.autoClear = clears;
  }

  /** What the step is drawn with. */
  get materials(): Material[] {
    return [this.gather.material, this.smooth.material, this.lay.material];
  }

  override dispose(): void {
    this.gathered.dispose();
    this.smoothed.dispose();
    for (const quad of [this.gather, this.smooth, this.lay]) {
      quad.material.dispose();
      quad.dispose();
    }
  }
}

/** How far from the plane of focus, in world units, a point is drawn as soft as it gets. */
const FOCUS_FALLOFF = 9;
const FOCUS_TAPS = 24;

/** Shared by the pass's shaders: distance from the lens, and how soft a point at that distance is (0 to 1). */
const FOCUS_COMMON = /* glsl */ `
  precision highp sampler2D;
  uniform sampler2D tDepth;
  uniform float uNear;
  uniform float uFar;
  uniform float uFocus;
  uniform float uRange;
  float distanceAt( vec2 uv ) {
    float d = texture2D( tDepth, uv ).x;
    return ( uNear * uFar ) / ( uFar - d * ( uFar - uNear ) );
  }
  float softness( float dist ) {
    return clamp( ( abs( dist - uFocus ) - uRange ) / ${FOCUS_FALLOFF.toFixed(1)}, 0.0, 1.0 );
  }`;

/**
 * Depth of field. Everything within `range` of the focus distance stays sharp; beyond that the
 * picture softens. The blur is gathered at half size, where it is cheap, and laid back over
 * the sharp picture according to how soft each point should be.
 *
 * It is done in three steps, because the picture holds lines one pixel wide and many times
 * brighter than white (the edges of the hands, the seams of the pieces), and a blur that reads
 * such a line at a couple of dozen scattered points draws it as that many copies of itself.
 * First the picture is taken down to half size with every point a weighted average of sixteen
 * pixels, so that a thin hot line is already a soft band. Then the blur is gathered from that,
 * its ring of taps turned by a different angle at every pixel, so that what is left of the
 * copies is fine grain and not stripes. Last, the grain is averaged away where the blur is laid
 * back over the picture.
 */
class FocusPass extends Pass {
  private shared = {
    tDepth: { value: null as unknown },
    uNear: { value: 0.1 },
    uFar: { value: 220 },
    uFocus: { value: 16 },
    uRange: { value: 6 },
  };
  private softenUniforms = {
    ...this.shared,
    tDiffuse: { value: null as unknown },
    /** One pixel of the full picture, as a step in texture coordinates. */
    uPixel: { value: new Vector2(0.001, 0.001) },
  };
  private blurUniforms = {
    ...this.shared,
    tSoft: { value: null as unknown },
    /** The widest blur, as a fraction of the picture's height. */
    uAmount: { value: 0 },
    uAspect: { value: 1 },
    uTexel: { value: 0.001 },
  };
  private mixUniforms = {
    ...this.shared,
    tDiffuse: { value: null as unknown },
    tBlur: { value: null as unknown },
    /** One pixel of the half-size pictures, as a step in texture coordinates. */
    uHalfPixel: { value: new Vector2(0.002, 0.002) },
  };
  private softened = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private blurred = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private soften: FullScreenQuad;
  private blur: FullScreenQuad;
  private mix: FullScreenQuad;

  constructor(private camera: PerspectiveCamera) {
    super();
    this.soften = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'FocusSoften',
        uniforms: this.softenUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D tDiffuse;
          uniform vec2 uPixel;
          ${FOCUS_COMMON}
          ${SANE_GLSL}
          varying vec2 vUv;
          void main() {
            vec3 sum = vec3( 0.0 );
            float total = 0.0;
            // Four readings, each the average of the four pixels round it. What is in focus is
            // left out as far as it can be, so that it does not smear into the blur beside it;
            // and the brighter a reading is the less it counts, or one hot pixel would outweigh
            // the fifteen round it.
            for ( int i = 0; i < 4; i ++ ) {
              vec2 uv = vUv + vec2( i == 0 || i == 3 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0 ) * uPixel;
              vec3 c = sane( texture2D( tDiffuse, uv ).rgb );
              float w = ( softness( distanceAt( uv ) ) + 0.02 ) / ( 1.0 + 0.3 * max( c.r, max( c.g, c.b ) ) );
              sum += c * w;
              total += w;
            }
            gl_FragColor = vec4( sum / total, 1.0 );
          }`,
      }),
    );
    this.blur = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'FocusBlur',
        uniforms: this.blurUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D tSoft;
          uniform float uAmount;
          uniform float uAspect;
          uniform float uTexel;
          ${FOCUS_COMMON}
          varying vec2 vUv;
          void main() {
            float here = distanceAt( vUv );
            float soft = softness( here ) * uAmount;
            vec3 sum = texture2D( tSoft, vUv ).rgb;
            float total = 1.0;
            // Taps on a spiral that fills a disc evenly, turned by an angle of this pixel's own.
            float turn = 6.2831853 * fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
            for ( int i = 1; i <= ${FOCUS_TAPS}; i ++ ) {
              float fi = float( i );
              float r = sqrt( ( fi - 0.5 ) / ${FOCUS_TAPS.toFixed(1)} ) * uAmount;
              float a = fi * 2.39996323 + turn;
              vec2 uv = vUv + vec2( cos( a ) / uAspect, sin( a ) ) * r;
              float there = distanceAt( uv );
              float reach = softness( there ) * uAmount;
              // What lies behind this point spreads over it only as far as this point is itself soft:
              // a blurred wall must not bleed onto a sharp piece standing in front of it.
              if ( there > here ) reach = min( reach, soft * 2.0 );
              float w = smoothstep( r - uTexel, r + uTexel, reach );
              sum += mix( sum / total, texture2D( tSoft, uv ).rgb, w );
              total += 1.0;
            }
            gl_FragColor = vec4( sum / total, 1.0 );
          }`,
      }),
    );
    this.mix = new FullScreenQuad(
      new RawShaderMaterial({
        name: 'FocusMix',
        uniforms: this.mixUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D tDiffuse;
          uniform sampler2D tBlur;
          uniform vec2 uHalfPixel;
          ${FOCUS_COMMON}
          ${SANE_GLSL}
          varying vec2 vUv;
          void main() {
            vec4 sharp = texture2D( tDiffuse, vUv );
            float k = smoothstep( 0.0, 0.3, softness( distanceAt( vUv ) ) );
            // Four readings of the blur, each between four of its pixels: the grain the turning left averages out.
            vec2 o = uHalfPixel * 0.75;
            vec3 soft = 0.25 * ( texture2D( tBlur, vUv + o ).rgb + texture2D( tBlur, vUv - o ).rgb
                               + texture2D( tBlur, vUv + vec2( o.x, - o.y ) ).rgb + texture2D( tBlur, vUv + vec2( - o.x, o.y ) ).rgb );
            gl_FragColor = vec4( mix( sane( sharp.rgb ), soft, k ), sharp.a );
          }`,
      }),
    );
  }

  /** Where the lens is focused, how deep the sharp zone is either side of that, and the widest blur (a fraction of the picture's height). */
  set(focus: number, range: number, amount: number): void {
    this.shared.uFocus.value = focus;
    this.shared.uRange.value = range;
    this.blurUniforms.uAmount.value = amount;
    this.enabled = amount > 0.0004;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.ceil(width / 2));
    const h = Math.max(1, Math.ceil(height / 2));
    this.softened.setSize(w, h);
    this.blurred.setSize(w, h);
    this.softenUniforms.uPixel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.blurUniforms.uAspect.value = Math.max(1, width) / Math.max(1, height);
    this.blurUniforms.uTexel.value = 1 / h;
    this.mixUniforms.uHalfPixel.value.set(1 / w, 1 / h);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.shared.tDepth.value = readBuffer.depthTexture;
    this.shared.uNear.value = this.camera.near;
    this.shared.uFar.value = this.camera.far;
    this.softenUniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.softened);
    this.soften.render(renderer);
    this.blurUniforms.tSoft.value = this.softened.texture;
    renderer.setRenderTarget(this.blurred);
    this.blur.render(renderer);
    this.mixUniforms.tDiffuse.value = readBuffer.texture;
    this.mixUniforms.tBlur.value = this.blurred.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.mix.render(renderer);
  }

  /** What the step is drawn with. */
  get materials(): Material[] {
    return [this.soften.material, this.blur.material, this.mix.material];
  }

  override dispose(): void {
    this.softened.dispose();
    this.blurred.dispose();
    for (const quad of [this.soften, this.blur, this.mix]) {
      quad.material.dispose();
      quad.dispose();
    }
  }
}

/** A shape with what a step of the chain is drawn on (a place and a place in the picture for each corner), and an eye to build its program for: neither is ever drawn. */
const STEP_SHAPE = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3)).setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
const STEP_CAMERA = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

export class Post {
  private composer: EffectComposer;
  private shade: ShadePass | null = null;
  private air: AirPass;
  private bloom: UnrealBloomPass;
  private focus: FocusPass | null = null;
  private grade = new GradePass();
  private time = 0;
  /** How finely the quality asks for edges to be anti-aliased. */
  private samples: number;

  constructor(
    private renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    quality: Quality,
  ) {
    const q = QUALITY[quality];
    this.samples = q.samples;
    // The lit air and depth of field both read how far away each point of the picture is, so the scene's depth is kept as a texture.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: q.samples, depthTexture: new DepthTexture(1, 1) });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    // Before the lit air: that hangs in front of things, and is not shaded by what stands behind it.
    if (q.shade > 0) {
      this.shade = new ShadePass(camera, q.shade);
      this.composer.addPass(this.shade);
    }
    this.air = new AirPass(camera, q.air.scale, q.air.curtains);
    this.composer.addPass(this.air);
    // Only what is brighter than lit stone blooms: seams, eyes, lit squares, flames, the sky.
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.42, 0.6, 1.25);
    // A wide shoulder on the threshold: a seam that breathes gains and loses its bloom gradually
    // instead of popping across a hard line.
    (this.bloom.highPassUniforms as Record<string, { value: number }>)['smoothWidth']!.value = 0.9;
    // Nothing before the bloom draws the frame afresh (the lit air is added to it where it lies),
    // so the bloom's own first reading of it is where a bad pixel has to be stopped.
    this.bloom.materialHighPassFilter.fragmentShader = BRIGHT_FRAGMENT;
    this.bloom.materialHighPassFilter.needsUpdate = true;
    this.bloom.enabled = q.bloom;
    this.composer.addPass(this.bloom);
    if (q.focus !== 'none') {
      this.focus = new FocusPass(camera);
      this.focus.enabled = false;
      this.composer.addPass(this.focus);
    }
    this.composer.addPass(this.grade);
  }

  /**
   * Whether the scene's edges are anti-aliased (as far as the quality asks for). Takes effect at
   * the next `setSize`, which makes the buffers afresh.
   */
  setSmooth(on: boolean): void {
    const samples = on ? this.samples : 0;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (target.samples === samples) continue;
      target.samples = samples;
      target.dispose();
    }
  }

  /** Whether this quality has depth of field at all. */
  get focuses(): boolean {
    return this.focus !== null;
  }

  /**
   * Focus the lens `focus` away, keep `range` either side of that sharp, and let the rest soften
   * by up to `amount` (a fraction of the picture's height). An amount of nothing turns it off.
   */
  setFocus(focus: number, range: number, amount: number): void {
    this.focus?.set(focus, range, amount);
  }

  /** The shaft of light, for the frame about to be drawn. */
  setShaft(shaft: Shaft): void {
    this.air.set(shaft);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  /** How strongly the corners fall away, a colour the whole picture leans toward, and how far its darks and lights are pulled apart (1 leaves them be). */
  setGrade(vignette: number, r: number, g: number, b: number, contrast = 1): void {
    this.grade.uniforms.uVignette.value = vignette;
    this.grade.uniforms.uTint.value.set(r, g, b);
    this.grade.uniforms.uContrast.value = contrast;
  }

  render(dt: number): void {
    this.time += dt;
    this.grade.uniforms.uTime.value = this.time;
    this.composer.render(dt);
  }

  /**
   * Build the program of every material in the scene now, the hidden ones too, as they will be
   * when drawn through this chain. Left alone, each is built the first time it shows, and the
   * frame it first shows in is a long one. Resolves when they are all ready to draw with.
   */
  warm(scene: Scene, camera: PerspectiveCamera): Promise<unknown> {
    // A program is built for where its picture goes. The scene is drawn into the chain's own
    // buffer, never straight to the screen, so that has to be the target while they are built.
    const before = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    try {
      return this.renderer.compileAsync(scene, camera);
    } finally {
      this.renderer.setRenderTarget(before);
    }
  }

  /**
   * Ask for the program of every step of the chain itself, as each will be drawn: the last to the
   * screen, the others into a buffer. A chain made while another is still in use shares with it
   * every program the two have in common, and only what differs is built. Returns the materials
   * asked for; whether they are built yet is for `programsOf` to say.
   */
  compile(): Material[] {
    const bloom = [this.bloom.materialHighPassFilter, ...this.bloom.separableBlurMaterials, this.bloom.compositeMaterial, this.bloom.blendMaterial];
    const within: Material[] = [...(this.shade?.materials ?? []), ...this.air.materials, ...bloom, ...(this.focus?.materials ?? [])];
    const last = this.grade.materials;
    const before = this.renderer.getRenderTarget();
    const mesh = new Mesh(STEP_SHAPE);
    try {
      for (const [materials, target] of [[within, this.composer.readBuffer], [last, null]] as const) {
        this.renderer.setRenderTarget(target);
        for (const material of materials) {
          mesh.material = material;
          // A step is drawn by itself, lit by nothing: so it is built by itself.
          this.renderer.compile(mesh, STEP_CAMERA);
        }
      }
    } finally {
      this.renderer.setRenderTarget(before);
    }
    return [...within, ...last];
  }

  dispose(): void {
    // The composer frees its own two buffers and nothing its passes own: the bloom's eleven would
    // be left behind at every change of quality. Nor does the bloom free the first step of its
    // own that was replaced here.
    this.composer.dispose();
    this.bloom.dispose();
    this.bloom.materialHighPassFilter.dispose();
    this.shade?.dispose();
    this.air.dispose();
    this.focus?.dispose();
    this.grade.dispose();
    this.renderer.setRenderTarget(null);
  }
}
