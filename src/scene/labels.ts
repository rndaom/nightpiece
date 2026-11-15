/**
 * A small medallion on top of each stone, showing which piece it is by the
 * same flat silhouette the interface uses for it. From straight above the
 * stones are told apart only by the marks cut into their tops, which a
 * newcomer has not learned yet.
 *
 * The medallions lie flat, so they show from above and are edge-on from the
 * side, and they are only brought in for the overhead view. All of them are
 * drawn in one call from one small picture.
 */
import {
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
} from 'three';
import type { Kind, Side } from '../core/game';
import { STONES } from '../ui/stones';
import { PIECE_HEIGHT } from './pieceShapes';
import type { Puppet } from './pieces';
import { Spring } from './spring';

const KINDS: Kind[] = ['k', 'q', 'r', 'b', 'n', 'p'];
const CELL = 128;
const COLUMNS = 4;
const ROWS = 3;
const CAPACITY = 32;
const SIZE = 0.5;
/** The furthest a medallion is slid from over its stone's head, in squares. */
const REACH = 0.45;

/** How large a stone's silhouette is drawn on its medallion: its 32 by 32 box, in pixels of the picture. */
const STONE = CELL * 0.66;

function paint(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * COLUMNS;
  canvas.height = CELL * ROWS;
  const c = canvas.getContext('2d')!;
  (['w', 'b'] as Side[]).forEach((side, s) => {
    KINDS.forEach((kind, k) => {
      const i = s * 6 + k;
      const x = (i % COLUMNS) * CELL + CELL / 2;
      const y = Math.floor(i / COLUMNS) * CELL + CELL / 2;
      // Ivory's are a pale disc with a dark stone on it; Void's the reverse, ringed in their own light.
      c.beginPath();
      c.arc(x, y, CELL * 0.43, 0, Math.PI * 2);
      c.fillStyle = side === 'w' ? 'rgba(236,227,204,0.95)' : 'rgba(14,16,15,0.93)';
      c.fill();
      c.lineWidth = 5;
      c.strokeStyle = side === 'w' ? 'rgba(60,52,38,0.9)' : 'rgba(89,229,204,0.95)';
      c.stroke();
      // The silhouette's ink sits between 2 and 28 of its box's height, so the middle of it is put on the middle of the disc.
      c.save();
      c.translate(x - STONE / 2, y - (STONE * 15) / 32);
      c.scale(STONE / 32, STONE / 32);
      c.fillStyle = side === 'w' ? '#17140f' : '#7ff0dc';
      c.fill(new Path2D(STONES[kind]), 'evenodd');
      c.restore();
    });
  });
  return canvas;
}

export class Labels {
  readonly mesh: InstancedMesh;
  /** Whether the medallions are wanted, and which player the overhead view is turned toward. */
  show = false;
  seat: Side = 'w';
  private cell: InstancedBufferAttribute;
  private uniforms = { uMap: { value: null as CanvasTexture | null }, uOpacity: { value: 0 }, uTurn: { value: 0 } };
  private opacity = new Spring(0);
  private matrix = new Matrix4();

  constructor() {
    const geometry = new PlaneGeometry(SIZE, SIZE);
    geometry.rotateX(-Math.PI / 2);
    this.cell = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    this.cell.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aCell', this.cell);
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aCell;
        uniform float uTurn;
        varying vec2 vUv;
        void main() {
          // Turned in place so that it reads the right way up for whoever the view is facing.
          float c = cos( uTurn );
          float s = sin( uTurn );
          vec3 p = vec3( c * position.x - s * position.z, position.y, s * position.x + c * position.z );
          float column = mod( aCell, ${COLUMNS.toFixed(1)} );
          float row = floor( aCell / ${COLUMNS.toFixed(1)} );
          vUv = vec2( ( column + uv.x ) / ${COLUMNS.toFixed(1)}, 1.0 - ( row + 1.0 - uv.y ) / ${ROWS.toFixed(1)} );
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 t = texture2D( uMap, vUv );
          float a = t.a * uOpacity;
          if ( a < 0.01 ) discard;
          gl_FragColor = vec4( t.rgb * 0.82, a );
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(geometry, material, CAPACITY);
    this.mesh.name = 'piece-labels';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2.5;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Paint the picture again. It is painted the first time it is needed without being asked. */
  repaint(): void {
    this.uniforms.uMap.value?.dispose();
    const texture = new CanvasTexture(paint());
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    this.uniforms.uMap.value = texture;
  }

  /**
   * Lay a medallion on each stone standing on the board. `eye` is where the picture is seen from:
   * a tall stone near the edge is seen a little from the side even from overhead, its head pushed
   * outward over the line of its square, so each medallion is slid back along the line of sight
   * until it lies over the middle of the square the stone stands on. The medallions then make an
   * even grid, which is what the overhead view is for.
   */
  update(dt: number, standing: Iterable<Puppet>, eye: { x: number; y: number; z: number }): void {
    this.opacity.goal = this.show ? 1 : 0;
    this.opacity.step(dt, 7);
    const opacity = this.opacity.value;
    this.mesh.visible = opacity > 0.01;
    if (!this.mesh.visible) return;
    if (!this.uniforms.uMap.value) this.repaint();
    this.uniforms.uOpacity.value = Math.min(1, opacity);
    this.uniforms.uTurn.value = this.seat === 'w' ? 0 : Math.PI;
    let n = 0;
    for (const p of standing) {
      if (n >= CAPACITY) break;
      const at = p.group.position;
      const height = at.y + PIECE_HEIGHT[p.kind] * p.group.scale.y + 0.035;
      const along = eye.y > height ? height / eye.y : 0;
      let dx = (eye.x - at.x) * along;
      let dz = (eye.z - at.z) * along;
      // Never further than keeps it over its own stone: on the way to the overhead view the eye is still low.
      const far = Math.hypot(dx, dz);
      if (far > REACH) {
        dx *= REACH / far;
        dz *= REACH / far;
      }
      this.matrix.makeTranslation(at.x + dx, height, at.z + dz);
      this.mesh.setMatrixAt(n, this.matrix);
      this.cell.setX(n, (p.side === 'w' ? 0 : 6) + KINDS.indexOf(p.kind));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = true;
  }
}
