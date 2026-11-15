/**
 * The hands as the eye sees them: a picture, the size of the one being drawn,
 * of how far away the nearest hand is at every point.
 *
 * The glass reads it to find where a hand's edge is on the screen, so that
 * the light inside can hug that edge at an even width whatever the shape
 * behind it (a glow that goes by the angle of the skin floods a flat palm
 * seen from the side). The line and the halo read it to know whether they
 * stand clear of the hand or lie over it.
 *
 * It is drawn from inside the frame's own draw, just before the first hand
 * is, the way a mirror draws its reflection. Nothing outside this folder has
 * to know that it exists. A frame may look at the hands more than once (the
 * board's dark glass mirrors them from below), so there is one picture for
 * each eye that looks, each the size that eye sees at.
 */
import { type Camera, Color, NearestFilter, type Object3D, type Texture, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { compileApart } from '../scene/ahead';

/** The meshes that draw this picture are on this layer and no other, so no ordinary camera sees them. */
export const SILHOUETTE_LAYER = 27;
/** Distances are kept as a share of this many squares. Nothing is seen from farther off. */
export const SILHOUETTE_FAR = 80;
/** A picture that no eye has asked for in this many frames is let go. */
const KEPT = 900;

interface View {
  target: WebGLRenderTarget;
  stale: boolean;
  /** The camera the picture was last drawn for: where it was and how it looked out. */
  seen: Float64Array;
  /** The frame it was last asked for. */
  used: number;
}

export class Silhouette {
  private views = new Map<Camera, View>();
  private frame = 0;
  private colour = new Color();

  /** `root` holds every hand. */
  constructor(private root: Object3D) {}

  /** The hands have moved: every picture must be drawn again before it is next read. Once a frame. */
  touch(): void {
    this.frame++;
    for (const [camera, view] of this.views) {
      view.stale = true;
      if (this.frame - view.used > KEPT) {
        view.target.dispose();
        this.views.delete(camera);
      }
    }
  }

  /**
   * Bring the picture up to date for what `camera` sees, for a frame `width` by `height` pixels,
   * and return it. Called as a hand is about to be drawn; draws nothing if the picture is already right.
   */
  draw(renderer: WebGLRenderer, camera: Camera, width: number, height: number): Texture {
    let view = this.views.get(camera);
    if (!view) {
      const target = new WebGLRenderTarget(1, 1, { minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
      target.texture.name = 'hands-silhouette';
      view = { target, stale: true, seen: new Float64Array(32), used: this.frame };
      this.views.set(camera, view);
    }
    view.used = this.frame;
    // A very large frame is read at half size: nothing here is finer than that.
    const scale = height > 1300 ? 0.5 : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    let same = !view.stale && view.target.width === w && view.target.height === h;
    const world = camera.matrixWorld.elements;
    const projection = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (view.seen[i] !== world[i] || view.seen[16 + i] !== projection[i]) same = false;
      view.seen[i] = world[i]!;
      view.seen[16 + i] = projection[i]!;
    }
    if (same) return view.target.texture;
    view.stale = false;
    if (view.target.width !== w || view.target.height !== h) view.target.setSize(w, h);

    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.colour);
    const layers = camera.layers.mask;
    try {
      // Cleared to "as far as can be": where there is no hand, there is nothing near.
      renderer.autoClear = true;
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(view.target);
      camera.layers.set(SILHOUETTE_LAYER);
      renderer.render(this.root, camera);
    } finally {
      camera.layers.mask = layers;
      renderer.setRenderTarget(target, face, level);
      renderer.setClearColor(this.colour, alpha);
      renderer.autoClear = autoClear;
    }
    return view.target.texture;
  }

  /**
   * Build the program the picture is drawn with before it is first wanted: it is drawn with the
   * hands alone, and so lit by nothing, which no compile of the whole room builds it for. Resolves
   * when it is ready.
   */
  warm(renderer: WebGLRenderer, camera: Camera): Promise<unknown> {
    return compileApart(renderer, this.root, SILHOUETTE_LAYER, camera);
  }

  dispose(): void {
    for (const view of this.views.values()) view.target.dispose();
    this.views.clear();
  }
}
