/**
 * What the dark squares of the board mirror: the room and the pieces, drawn once more from
 * under the board looking up, at a fraction of the picture's size. The glass then looks its
 * reflection up in this by where each point of it falls in that second view.
 *
 * The method is the usual one for a flat mirror (see three's Reflector): the camera is
 * reflected in the plane of the board, and the near side of what it sees is cut off at that
 * plane, so that nothing under the board shows.
 */
import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  type Object3D,
  PerspectiveCamera,
  Plane,
  type Scene,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

const UP = new Vector3(0, 1, 0);
const ORIGIN = new Vector3(0, 0, 0);

export class Mirror {
  readonly target: WebGLRenderTarget;
  /** Takes a point of the board, in world space, to where it is in the target. */
  readonly matrix = new Matrix4();
  private camera = new PerspectiveCamera();
  private eye = new Vector3();
  private look = new Vector3();
  private aim = new Vector3();
  private rotation = new Matrix4();
  private plane = new Plane();
  private clip = new Vector4();
  private q = new Vector4();
  private frame = 0;
  private shown: Object3D[] = [];

  /**
   * `scale` is the size of the reflection against the picture's; `every` redraws it only on
   * every so many frames (a reflection one frame late is not seen).
   */
  constructor(
    private scale: number,
    public every: number,
  ) {
    // Smaller copies of it are kept as well: read from one of those, the reflection is soft.
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
    });
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
    this.frame = 0;
  }

  /**
   * Draw the reflection for this frame. `hidden` is whatever must not appear in it: the board
   * itself, and things that lie flat on it. Returns false if there was nothing to draw, because
   * the camera is looking straight down, where the glass mirrors nothing.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, hidden: Object3D[]): boolean {
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.rotation.extractRotation(camera.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rotation);
    if (this.eye.y <= 0.05 || this.look.y < -0.985) return false;
    if (this.frame++ % this.every !== 0) return true;

    const mirror = this.camera;
    // The camera's place and the point it looks at, both reflected in the board.
    this.aim.copy(this.eye).add(this.look);
    this.aim.y = -this.aim.y;
    mirror.position.set(this.eye.x, -this.eye.y, this.eye.z);
    mirror.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(UP);
    mirror.lookAt(this.aim);
    mirror.near = camera.near;
    mirror.far = camera.far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(camera.projectionMatrix);
    // The reflection is the other way round, so a picture that is off-centre is off-centre the other way.
    mirror.projectionMatrix.elements[8]! *= -1;
    mirror.projectionMatrix.elements[12]! *= -1;

    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.matrix.multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);

    // Tilt the near side of the view onto the plane of the board (Lengyel's oblique clipping).
    this.plane.setFromNormalAndCoplanarPoint(UP, ORIGIN).applyMatrix4(mirror.matrixWorldInverse);
    const clip = this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = mirror.projectionMatrix.elements;
    this.q.set((Math.sign(clip.x) + p[8]!) / p[0]!, (Math.sign(clip.y) + p[9]!) / p[5]!, -1, (1 + p[10]!) / p[14]!);
    clip.multiplyScalar(2 / clip.dot(this.q));
    p[2] = clip.x;
    p[6] = clip.y;
    p[10] = clip.z + 1;
    p[14] = clip.w;

    this.shown.length = 0;
    for (const o of hidden) {
      if (!o.visible) continue;
      o.visible = false;
      this.shown.push(o);
    }
    // Some of what is hidden casts shadows. If they were redrawn now they would be redrawn
    // without it, so that waits for the picture itself.
    const stale = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, mirror);
    renderer.setRenderTarget(target);
    renderer.shadowMap.needsUpdate = stale;
    for (const o of this.shown) o.visible = true;
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
