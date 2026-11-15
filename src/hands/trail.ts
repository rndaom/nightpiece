/**
 * What a hand lets go of: wisps of its own vapour, that come loose from it,
 * hang in the air where they were left, rise a little, spread and thin away
 * to nothing (style bible, section 6.4). They are smoke, not sparks: soft,
 * never bright, and they do not twinkle. A hand at rest sheds one now and
 * then; a hand that moves fast leaves a breath of them behind it; a hand
 * that arrives or goes sheds them from all over.
 *
 * One buffer of points per player. A wisp is written once, when it is shed,
 * and the shader does the rest from its age, so nothing is updated per
 * particle per frame.
 */
import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points, ShaderMaterial, type Vector3 } from 'three';

const COUNT = 192;

export class Trail {
  readonly points: Points;
  private position: BufferAttribute;
  /** For each mote: when it was shed; then three numbers that make it differ from its neighbours, and how long it lasts. */
  private birth: BufferAttribute;
  private seed: BufferAttribute;
  private uniforms = { uTime: { value: 0 }, uColor: { value: new Color() }, uScale: { value: 1080 } };
  private next = 0;
  private roll = 0.37;

  constructor(color: Color) {
    const geometry = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(COUNT * 3), 3);
    this.birth = new BufferAttribute(new Float32Array(COUNT).fill(-100), 1);
    this.seed = new BufferAttribute(new Float32Array(COUNT * 4).fill(1), 4);
    for (const a of [this.position, this.birth, this.seed]) a.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('aBirth', this.birth);
    geometry.setAttribute('aSeed', this.seed);
    this.uniforms.uColor.value.copy(color);
    this.points = new Points(
      geometry,
      new ShaderMaterial({
        name: 'Wisps',
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          attribute float aBirth;
          attribute vec4 aSeed;
          uniform float uTime;
          uniform float uScale;
          varying float vAlpha;
          varying vec2 vTurn;
          void main() {
            float since = uTime - aBirth;
            float age = since / max( aSeed.w, 1e-3 );
            float alive = step( 0.0, age ) * step( age, 1.0 );
            // It hangs where it was left, rises slowly, and wanders more the older it is.
            vec3 p = position;
            p.y += since * ( 0.04 + 0.11 * aSeed.z );
            p.x += sin( since * ( 0.9 + aSeed.x ) + aSeed.y * 40.0 ) * 0.05 * age;
            p.z += cos( since * ( 0.7 + aSeed.y ) + aSeed.x * 40.0 ) * 0.05 * age;
            vec4 mv = modelViewMatrix * vec4( p, 1.0 );
            gl_Position = projectionMatrix * mv;
            // It comes quickly and goes slowly, and is at no time more than a breath.
            vAlpha = alive * smoothstep( 0.0, 0.18, age ) * ( 1.0 - age ) * ( 1.0 - age ) * ( 0.45 + 0.55 * aSeed.y );
            // And it spreads as it goes, as smoke does.
            gl_PointSize = alive * max( 6.0, ( 0.8 + 1.2 * aSeed.y ) * ( 1.0 + 2.4 * age ) * uScale / max( 1.0, -mv.z ) * 0.075 );
            // Each is turned its own way, and turns slowly.
            vTurn = vec2( aSeed.x * 6.2832 + since * ( aSeed.z - 0.5 ) * 0.8, aSeed.z * 40.0 );
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vAlpha;
          varying vec2 vTurn;
          void main() {
            vec2 p = ( gl_PointCoord - 0.5 ) * 2.0;
            // Not a disc: a lopsided puff, drawn out one way more than the other.
            float round = atan( p.y, p.x ) + vTurn.x;
            float r = length( p ) * ( 1.0 + 0.22 * sin( round * 2.0 + vTurn.y ) + 0.12 * sin( round * 5.0 - vTurn.y ) );
            float d = exp( - r * r * 3.2 ) * ( 1.0 - smoothstep( 0.75, 1.0, length( p ) ) );
            float there = clamp( d * vAlpha, 0.0, 1.0 );
            if ( there < 0.003 ) discard;
            // Vapour: a little of the hand's light in it, and hardly any body.
            gl_FragColor = vec4( uColor * 0.34 * there, there * 0.22 );
          }`,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
      }),
    );
    this.points.name = 'hand-motes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  /** The height of the picture in pixels, so that motes are the same size on any screen. */
  setViewportHeight(pixels: number): void {
    this.uniforms.uScale.value = pixels;
  }

  /** Let one mote go at a point in the room, give or take `spread`. It lasts about `life` seconds. */
  shed(at: Vector3, time: number, spread = 0.03, life = 2.2): void {
    const i = this.next;
    this.next = (this.next + 1) % COUNT;
    this.position.setXYZ(i, at.x + (this.random() - 0.5) * 2 * spread, at.y + (this.random() - 0.5) * 2 * spread, at.z + (this.random() - 0.5) * 2 * spread);
    this.birth.setX(i, time);
    this.seed.setXYZW(i, this.random(), this.random(), this.random(), life * (0.7 + 0.6 * this.random()));
    this.position.needsUpdate = this.birth.needsUpdate = this.seed.needsUpdate = true;
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  /** Put every mote out at once. */
  clear(): void {
    (this.birth.array as Float32Array).fill(-100);
    this.birth.needsUpdate = true;
  }

  /** Repeatable, so that a frame captured twice looks the same. */
  random(): number {
    this.roll = (this.roll * 9301 + 0.2113) % 1;
    return this.roll;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as ShaderMaterial).dispose();
  }
}
