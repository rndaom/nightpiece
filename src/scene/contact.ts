/**
 * Soft contact shadows: one dark blur on the board under each piece.
 *
 * The key light lays each piece's own shadow across the board, but that
 * shadow leaves the foot where the light strikes it. These blurs darken the
 * board under the foot itself, and thin out and spread as a piece is lifted,
 * which is most of what makes a lift read as a lift. All of them are drawn
 * in a single call.
 */
import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial } from 'three';

/** Just above the tiles, below the lit-square marks. */
const HEIGHT = 0.002;

export class ContactShadows {
  readonly mesh: InstancedMesh;
  private strength: InstancedBufferAttribute;
  private matrix = new Matrix4();
  private used = 0;

  constructor(private capacity = 48) {
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.strength = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.strength.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aStrength', this.strength);

    const material = new ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aStrength;
        varying vec2 vUv;
        varying float vStrength;
        void main() {
          vUv = uv;
          vStrength = aStrength;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vStrength;
        void main() {
          vec2 p = abs( vUv - 0.5 ) * 2.0;
          // Between a circle and a square, like the bases that cast it.
          float d = mix( length( p ), max( p.x, p.y ), 0.45 );
          float shade = 1.0 - smoothstep( 0.25, 1.0, d );
          gl_FragColor = vec4( 0.0, 0.0, 0.0, pow( shade, 1.2 ) * vStrength );
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.name = 'contact-shadows';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
  }

  /** Start laying down this frame's shadows. */
  begin(): void {
    this.used = 0;
  }

  /**
   * One shadow. `size` is the width of the piece's base in squares, `lift` how far its foot is
   * above what it stands over, `presence` fades the shadow with a piece that is arriving or
   * leaving, and `ground` is the height of the surface the shadow falls on.
   */
  add(x: number, z: number, size: number, lift: number, presence = 1, ground = 0): void {
    if (this.used >= this.capacity || presence <= 0.01) return;
    const h = Math.max(0, lift);
    const width = size * (2.5 + 0.5 * h);
    this.matrix.makeScale(width, 1, width).setPosition(x, ground + HEIGHT, z);
    this.mesh.setMatrixAt(this.used, this.matrix);
    this.strength.setX(this.used, (0.55 * Math.min(1, presence)) / (1 + 2.4 * h));
    this.used++;
  }

  end(): void {
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.strength.needsUpdate = true;
  }
}
