/**
 * What a hand does to the stone beneath it: a soft shade, tighter and darker
 * the nearer the hand is, and while the hand is at work a little of its own
 * light. The key light falls almost straight down, so the shade lies right
 * under the hand and is drawn out along it.
 *
 * It falls on the squares, on the case's rim round them and on the altar the
 * case stands on, each at its own height, and stops at their edges. All the hands' shades
 * are drawn in a single call.
 */
import { type Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { ALTAR_HALF, ALTAR_TOP, FIELD_HALF, RIM_TOP, SLAB_HALF } from '../scene/layout';

/** Just above the stone, and above the soft shadows of the pieces. */
const HEIGHT = 0.004;
/** The surfaces a shade can fall on: how high each is, and how far out from the middle of the board it runs. */
const LEVELS = [
  { y: 0, from: 0, to: FIELD_HALF },
  { y: RIM_TOP, from: FIELD_HALF, to: SLAB_HALF },
  { y: ALTAR_TOP, from: SLAB_HALF, to: ALTAR_HALF },
];

const UP = new Vector3(0, 1, 0);

export class Ground {
  readonly mesh: InstancedMesh;
  private shade: InstancedBufferAttribute;
  private light: InstancedBufferAttribute;
  private band: InstancedBufferAttribute;
  private matrix = new Matrix4();
  private turn = new Quaternion();
  private size = new Vector3();
  private centre = new Vector3();
  private used = 0;

  /** Room for `hands` hands. */
  constructor(private hands = 4) {
    const capacity = hands * LEVELS.length;
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.shade = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.light = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.band = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    for (const a of [this.shade, this.light, this.band]) a.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aShade', this.shade);
    geometry.setAttribute('aLight', this.light);
    geometry.setAttribute('aBand', this.band);
    const material = new ShaderMaterial({
      name: 'HandShade',
      vertexShader: /* glsl */ `
        attribute float aShade;
        attribute vec3 aLight;
        attribute vec2 aBand;
        varying vec2 vUv;
        varying vec2 vPlace;
        varying float vShade;
        varying vec3 vLight;
        varying vec2 vBand;
        void main() {
          vUv = uv;
          vShade = aShade;
          vLight = aLight;
          vBand = aBand;
          vec4 world = modelMatrix * instanceMatrix * vec4( position, 1.0 );
          vPlace = world.xz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec2 vPlace;
        varying float vShade;
        varying vec3 vLight;
        varying vec2 vBand;
        void main() {
          // Only on what it was laid on: the squares end at the rim, and the altar is lower.
          float out_ = max( abs( vPlace.x ), abs( vPlace.y ) );
          if ( out_ < vBand.x || out_ > vBand.y ) discard;
          float d = length( vUv - 0.5 ) * 2.0;
          float fall = 1.0 - smoothstep( 0.1, 1.0, d );
          // The shade is darkest under the middle of the hand; its light pools more tightly still.
          gl_FragColor = vec4( max( vLight, vec3( 0.0 ) ) * fall * fall * fall, clamp( vShade, 0.0, 1.0 ) * fall * fall );
        }`,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.name = 'hand-shades';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    // After the stone and the pieces' own soft shadows, before the hands.
    this.mesh.renderOrder = 1.5;
    this.mesh.count = 0;
  }

  /** Start laying down this frame's shades. */
  begin(): void {
    this.used = 0;
  }

  /**
   * One hand's shade. `wrist` and `tips` are where the two ends of the hand are in the room;
   * `presence` is how much of the hand there is (0 to 1), and `light` is what it gives off (its
   * colour, already as strong as it should be at no distance).
   */
  add(wrist: Vector3, tips: Vector3, presence: number, light: Color, glow: number): void {
    if (presence <= 0.01) return;
    const dx = tips.x - wrist.x;
    const dz = tips.z - wrist.z;
    const length = Math.hypot(dx, dz);
    this.turn.setFromAxisAngle(UP, Math.atan2(dx, dz));
    for (const level of LEVELS) {
      if (this.used >= this.hands * LEVELS.length) return;
      // How far above this surface the hand is, give or take its tilt.
      const lift = Math.max(0, (wrist.y + tips.y) / 2 - level.y);
      const blur = 1 + 0.3 * lift;
      this.size.set((1.9 + 0.2 * length) * blur, 1, (length + 1.5) * blur);
      this.centre.set((wrist.x + tips.x) / 2, level.y + HEIGHT, (wrist.z + tips.z) / 2);
      this.matrix.compose(this.centre, this.turn, this.size);
      this.mesh.setMatrixAt(this.used, this.matrix);
      this.shade.setX(this.used, (0.5 * Math.min(1, presence)) / (1 + 1.1 * lift));
      const lit = glow / (1 + 0.8 * lift * lift);
      this.light.setXYZ(this.used, light.r * lit, light.g * lit, light.b * lit);
      this.band.setXY(this.used, level.from, level.to);
      this.used++;
    }
  }

  end(): void {
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shade.needsUpdate = true;
    this.light.needsUpdate = true;
    this.band.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
  }
}
