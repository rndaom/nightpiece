/**
 * Fine lines of light in the air: the threads from a hand's fingertips to the
 * piece it has in mind.
 *
 * A strand is a run of points in the room. It is drawn as a ribbon that
 * always faces the eye, a pixel or two wide whatever the distance, and its
 * owner says how its width and its light fall away along it: so a strand has
 * a strong end and a fine end and no hard edge anywhere, and a slow pulse of
 * light travels along it. All of one owner's strands are a single draw.
 */
import { BufferAttribute, BufferGeometry, type Color, DoubleSide, DynamicDrawUsage, Mesh, ShaderMaterial, Vector2, type Vector3, type WebGLRenderer } from 'three';

export interface StrandLook {
  /** The widest a strand is, in pixels, in a picture 1080 pixels high. */
  width: number;
  /** How wide a strand is at a point along it (0 at its root to 1 at its tip), as a share of that. */
  taper: (along: number, strand: number) => number;
  /** How bright it is there, 0 to 1. */
  light: (along: number, strand: number) => number;
  /** How many pulses of light lie along a strand at once, and how many pass a point each second (negative runs them tip to root). */
  pulses: number;
  flow: number;
}

const VERTEX = /* glsl */ `
  attribute vec3 aAhead;
  attribute vec4 aWhere;
  attribute float aPhase;
  uniform vec2 uViewport;
  uniform vec2 uWidth;
  varying float vAcross;
  varying float vHalf;
  varying float vLight;
  varying float vAlong;
  varying float vPhase;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    vec4 here = projectionMatrix * mv;
    // Which way the strand runs on the screen at this point; the ribbon is laid across that.
    vec4 there = projectionMatrix * ( mv + vec4( mat3( modelViewMatrix ) * aAhead, 0.0 ) );
    vec2 run = ( there.xy / max( there.w, 1e-4 ) - here.xy / max( here.w, 1e-4 ) ) * uViewport;
    float span = length( run );
    vec2 across = span > 1e-4 ? vec2( -run.y, run.x ) / span : vec2( 0.0, 1.0 );
    // A little wider close to the eye and a little finer far from it, as the hands' own line is.
    float range = max( 0.5, -mv.z );
    vHalf = 0.5 * uWidth.x * aWhere.z * clamp( pow( max( uWidth.y / range, 0.0 ), 0.45 ), 0.75, 1.6 );
    // A pixel to spare on each side, for the soft edge.
    vAcross = aWhere.x * ( vHalf + 1.0 );
    here.xy += across * vAcross * ( 2.0 / uViewport ) * here.w;
    gl_Position = here;
    vLight = aWhere.w;
    vAlong = aWhere.y;
    vPhase = aPhase;
  }`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  uniform float uLevel;
  uniform float uTime;
  uniform vec2 uFlow;
  varying float vAcross;
  varying float vHalf;
  varying float vLight;
  varying float vAlong;
  varying float vPhase;
  void main() {
    // How much of this pixel the strand covers. Finer than a pixel, it is drawn fainter, not narrower.
    // (Carried from the ribbon's corners, a width can be read a hair outside it and come out below nothing.)
    float half_ = max( vHalf, 0.0 );
    float cover = clamp( half_ + 0.5 - abs( vAcross ), 0.0, min( 1.0, 2.0 * half_ ) );
    float there = min( cover * vLight * uStrength, 1.0 );
    if ( there < 0.004 ) discard;
    float beat = 0.5 + 0.5 * sin( 6.2832 * ( vAlong * uFlow.x - uTime * uFlow.y ) + vPhase );
    float level = uLevel * ( 0.72 + 0.56 * beat * beat );
    // Light over what is behind it, and enough of a body to be seen against a pale square.
    gl_FragColor = vec4( uColor * max( level, 0.0 ) * there, there );
  }`;

export class Strands {
  readonly mesh: Mesh;
  /** 0 hidden to 1 fully drawn. */
  strength = 1;
  /** How bright the strands are at their brightest: 1 is the colour as given. */
  level = 1;
  private points: Float32Array;
  private position: BufferAttribute;
  private ahead: BufferAttribute;
  private uniforms = {
    uColor: { value: null as unknown as Color },
    uStrength: { value: 1 },
    uLevel: { value: 1 },
    uTime: { value: 0 },
    uFlow: { value: new Vector2(1, 0.3) },
    uViewport: { value: new Vector2(1920, 1080) },
    uWidth: { value: new Vector2(1.5, 12) },
  };

  /** `count` strands of `nodes` points each. `order` is where in the picture's drawing order they come. */
  constructor(
    colour: Color,
    readonly count: number,
    readonly nodes: number,
    private look: StrandLook,
    order = 3.7,
  ) {
    const vertices = count * nodes * 2;
    this.points = new Float32Array(count * nodes * 3);
    this.position = new BufferAttribute(new Float32Array(vertices * 3), 3);
    this.ahead = new BufferAttribute(new Float32Array(vertices * 3), 3);
    this.position.setUsage(DynamicDrawUsage);
    this.ahead.setUsage(DynamicDrawUsage);
    const where = new Float32Array(vertices * 4);
    const phase = new Float32Array(vertices);
    const index: number[] = [];
    for (let s = 0; s < count; s++) {
      // Each strand's pulse is out of step with its neighbours'.
      const offset = ((s * 0.618034) % 1) * Math.PI * 2;
      for (let n = 0; n < nodes; n++) {
        const along = n / (nodes - 1);
        const v = (s * nodes + n) * 2;
        for (const side of [0, 1]) {
          where.set([side * 2 - 1, along, Math.max(0, look.taper(along, s)), Math.max(0, look.light(along, s))], (v + side) * 4);
          phase[v + side] = offset;
        }
        if (n < nodes - 1) index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('aAhead', this.ahead);
    geometry.setAttribute('aWhere', new BufferAttribute(where, 4));
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1));
    geometry.setIndex(index);
    this.uniforms.uColor.value = colour;
    this.uniforms.uFlow.value.set(look.pulses, look.flow);
    this.mesh = new Mesh(
      geometry,
      new ShaderMaterial({
        name: 'Strands',
        uniforms: this.uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        // A ribbon is laid out on the screen; which way round it comes out there is of no account.
        side: DoubleSide,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
      }),
    );
    this.mesh.name = 'strands';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
    // The size of the picture is only known as it is drawn.
    this.mesh.onBeforeRender = (renderer: WebGLRenderer) => {
      const size = this.uniforms.uViewport.value;
      const target = renderer.getRenderTarget();
      if (target) size.set(target.width, target.height);
      else renderer.getDrawingBufferSize(size);
      // A picture with no size is not drawn, but nothing is to be divided by it either.
      size.set(Math.max(1, size.x), Math.max(1, size.y));
      this.uniforms.uWidth.value.x = Math.max(1.2, (this.look.width * size.y) / 1080);
    };
  }

  /** Put one point of one strand somewhere in the room. Call `commit` when all of them have been placed. */
  set(strand: number, node: number, x: number, y: number, z: number): void {
    const o = (strand * this.nodes + node) * 3;
    this.points[o] = x;
    this.points[o + 1] = y;
    this.points[o + 2] = z;
  }

  /** Where a point of a strand was last put. */
  get(strand: number, node: number, out: Vector3): Vector3 {
    const o = (strand * this.nodes + node) * 3;
    return out.set(this.points[o]!, this.points[o + 1]!, this.points[o + 2]!);
  }

  /** Send the points to be drawn, each with the way its strand is running there. */
  commit(time: number): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uStrength.value = this.strength;
    this.uniforms.uLevel.value = this.level;
    this.mesh.visible = this.strength > 0.01;
    if (!this.mesh.visible) return;
    const p = this.points;
    const position = this.position.array as Float32Array;
    const ahead = this.ahead.array as Float32Array;
    for (let s = 0; s < this.count; s++) {
      for (let n = 0; n < this.nodes; n++) {
        const o = (s * this.nodes + n) * 3;
        const before = n > 0 ? o - 3 : o;
        const after = n < this.nodes - 1 ? o + 3 : o;
        const v = (s * this.nodes + n) * 6;
        for (let i = 0; i < 3; i++) {
          position[v + i] = position[v + 3 + i] = p[o + i]!;
          ahead[v + i] = ahead[v + 3 + i] = p[after + i]! - p[before + i]!;
        }
      }
    }
    this.position.needsUpdate = true;
    this.ahead.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
  }
}
