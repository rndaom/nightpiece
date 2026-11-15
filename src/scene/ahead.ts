/**
 * What can be done for a scene before it is first shown, so that it is not done in the frame where
 * something first comes into the picture. See `World.warm`.
 */
import { type Camera, type Material, type Mesh, type Object3D, type Scene, type SkinnedMesh, type Texture, type WebGLRenderer, WebGLRenderTarget } from 'three';

type Uniforms = Record<string, { value: unknown } | undefined>;

/**
 * Every texture the scene's materials draw with, the hidden ones' included: a material's own maps,
 * a shader's uniforms, and the uniforms a material adds to a built-in one as it is compiled (kept
 * in its `userData.uniforms`, as the pieces' are). Not the pictures that are drawn into as the
 * game runs: they are made on the card, not sent to it.
 */
export function texturesIn(root: Object3D): Set<Texture> {
  const textures = new Set<Texture>();
  const take = (value: unknown) => {
    const t = value as Texture | null;
    if (t && t.isTexture && !(t as { isRenderTargetTexture?: boolean }).isRenderTargetTexture && t.image) textures.add(t);
  };
  root.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    for (const m of material ? ([] as Material[]).concat(material) : []) {
      for (const value of Object.values(m)) take(value);
      for (const uniforms of [(m as Material & { uniforms?: Uniforms }).uniforms, m.userData['uniforms'] as Uniforms | undefined]) {
        if (uniforms && typeof uniforms === 'object') for (const u of Object.values(uniforms)) take(u?.value);
      }
    }
  });
  return textures;
}

/**
 * Work out the bounds of every skinned mesh that has none yet. three.js sorts what it draws by
 * them, and works them out on the processor from every vertex in the frame a mesh is first drawn
 * in. Done here, they are taken from the pose the mesh has now, as they would have been from that
 * one: either is a pose of the moment. Returns how many were worked out.
 */
export function boundSkins(root: Object3D): number {
  let bounded = 0;
  root.traverse((object) => {
    const skinned = object as SkinnedMesh;
    if (!skinned.isSkinnedMesh || skinned.boundingSphere !== null) return;
    skinned.computeBoundingSphere();
    bounded++;
  });
  return bounded;
}

/**
 * Build the programs of what is drawn only into a picture of its own: the meshes under `root`
 * that are on `layer` alone and are to be drawn, as `root` is drawn by itself into a picture (the
 * way the hands draw how near they are, hands/silhouette.ts). A program is built for the lights
 * of what it is drawn with and for whether it is drawn to the screen, so the programs a compile of
 * the whole scene builds for these are not the ones they are drawn with. Resolves when they are
 * ready; at once if there are none.
 */
export function compileApart(renderer: WebGLRenderer, root: Object3D, layer: number, camera: Camera): Promise<unknown> {
  const apart: Object3D[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh && object.visible && object.layers.mask === 1 << layer) apart.push(object);
  });
  if (apart.length === 0) return Promise.resolve();
  const before = renderer.getRenderTarget();
  const picture = new WebGLRenderTarget(1, 1);
  renderer.setRenderTarget(picture);
  try {
    // With `root` as the scene they are drawn in, so lit by nothing that is not in it.
    return Promise.all(apart.map((object) => renderer.compileAsync(object, camera, root as Scene))).finally(() => picture.dispose());
  } finally {
    renderer.setRenderTarget(before);
  }
}

/** Every material on what is under `root`, the hidden included. */
export function materialsIn(root: Object3D): Set<Material> {
  const materials = new Set<Material>();
  root.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    for (const m of material ? ([] as Material[]).concat(material) : []) materials.add(m);
  });
  return materials;
}

/** A program as the renderer keeps it: all that is asked of it here is whether it is built yet. */
export interface Built {
  isReady(): boolean;
}

/**
 * The programs the renderer holds for these materials, in every form each has been asked for so
 * far: a material whose defines have been changed and changed back still holds the program of
 * each form, and the one of them still being built is not the one it is drawn with now.
 */
export function programsOf(renderer: Pick<WebGLRenderer, 'properties'>, materials: Iterable<Material>): Built[] {
  const found = new Set<Built>();
  for (const material of materials) {
    const kept = renderer.properties.get(material) as { programs?: Map<string, Built>; currentProgram?: Built } | undefined;
    for (const program of kept?.programs?.values() ?? []) found.add(program);
    if (kept?.currentProgram) found.add(kept.currentProgram);
  }
  return [...found];
}

/**
 * Resolves when every one of these programs is built, looking again every `every` milliseconds
 * (the graphics card builds them aside, and says only when asked). It stops looking, and resolves,
 * as soon as `wanted` says they are no longer waited for.
 */
export function whenBuilt(programs: Built[], wanted: () => boolean = () => true, every = 8): Promise<void> {
  let waiting = programs;
  return new Promise((resolve) => {
    const look = () => {
      if (wanted()) waiting = waiting.filter((program) => !program.isReady());
      if (!wanted() || waiting.length === 0) resolve();
      else setTimeout(look, every);
    };
    look();
  });
}

/**
 * A setting that is made ready before it is taken up, so that the frame it is taken up in has
 * nothing left to build. `prepare` starts on whatever the new value needs and resolves when it is
 * there (or returns null if nothing is needed, and the value is taken up at once); `take` then
 * makes the change. Until then the old value is the one in use. A value asked for while another
 * is being made ready takes its place: the one before is never taken up.
 */
export class Staged<T> {
  private asked: T;
  private turn = 0;
  private settled: Promise<void> = Promise.resolve();

  constructor(
    private held: T,
    private prepare: (next: T, wanted: () => boolean) => Promise<unknown> | null,
    private take: (next: T) => void,
  ) {
    this.asked = held;
  }

  /** What is in use now. */
  get current(): T {
    return this.held;
  }

  /** What was last asked for: the same, unless it is still being made ready. */
  get wanted(): T {
    return this.asked;
  }

  /** Ask for a value. Resolves when it has been taken up, or when it has been given up for another. */
  ask(next: T): Promise<void> {
    if (next === this.asked) return this.settled;
    this.asked = next;
    const turn = ++this.turn;
    // Asked back to what is in use: whatever was being made ready is let go.
    if (next === this.held) return (this.settled = Promise.resolve());
    const wanted = () => turn === this.turn;
    let ready: Promise<unknown> | null;
    try {
      ready = this.prepare(next, wanted);
    } catch {
      // What could not be made ready is built where it is first drawn, as it would have been without any of this.
      ready = null;
    }
    const taken = () => {
      if (!wanted()) return;
      this.held = next;
      this.take(next);
    };
    if (ready === null) {
      taken();
      return (this.settled = Promise.resolve());
    }
    return (this.settled = ready.then(taken, taken));
  }
}
