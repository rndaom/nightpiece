import { Bone, BufferGeometry, type Camera, PerspectiveCamera, Float32BufferAttribute, Mesh, MeshStandardMaterial, Object3D, ShaderMaterial, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, WebGLRenderTarget } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { SILHOUETTE_LAYER } from '../src/hands/silhouette';
import { boundSkins, type Built, compileApart, materialsIn, programsOf, Staged, texturesIn, whenBuilt } from '../src/scene/ahead';
import { QUALITY, type Quality } from '../src/scene/post';
import { setGlass } from '../src/scene/roomshade';
import { handsRig, loadHands } from './helpers/hands-rig';

/** A texture with a picture to send. */
const picture = (name: string) => {
  const t = new Texture({ width: 4, height: 4 } as unknown as HTMLImageElement);
  t.name = name;
  return t;
};

describe('what is made ready before the scene is shown', () => {
  it("finds a material's maps, a shader's uniforms and the uniforms kept for a built-in one, hidden or not", () => {
    const root = new Object3D();
    const map = picture('map');
    const ao = picture('ao');
    const glow = picture('glow');
    const stone = new MeshStandardMaterial({ map, aoMap: ao });
    stone.userData['uniforms'] = { uSpillMap: { value: glow }, uEnergy: { value: 1 } };
    const hidden = new Mesh(new BufferGeometry(), stone);
    hidden.visible = false;
    root.add(hidden);
    const sky = picture('sky');
    const drawnInto = new WebGLRenderTarget(4, 4);
    root.add(new Mesh(new BufferGeometry(), new ShaderMaterial({ uniforms: { tSky: { value: sky }, tLast: { value: drawnInto.texture }, uAmount: { value: 2 } } })));
    // Without a picture there is nothing to send yet.
    root.add(new Mesh(new BufferGeometry(), new MeshStandardMaterial({ map: new Texture() })));
    const found = [...texturesIn(root)].map((t) => t.name).sort();
    expect(found).toEqual(['ao', 'glow', 'map', 'sky']);
  });

  it('works out the bounds of a skinned mesh that has none, once', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const bone = new Bone();
    const skin = new SkinnedMesh(geometry, new MeshStandardMaterial());
    skin.add(bone);
    skin.bind(new Skeleton([bone]));
    const root = new Object3D();
    root.add(skin);
    expect(skin.boundingSphere).toBeNull();
    expect(boundSkins(root)).toBe(1);
    expect(skin.boundingSphere!.radius).toBeGreaterThan(0.9);
    expect(boundSkins(root)).toBe(0);
  });

  it('builds what is drawn only into a picture of its own as it will be drawn there: by itself, into a picture', async () => {
    const root = new Object3D();
    const apart = new Mesh(new BufferGeometry(), new ShaderMaterial());
    apart.layers.set(27);
    const hidden = new Mesh(new BufferGeometry(), new ShaderMaterial());
    hidden.layers.set(27);
    hidden.visible = false;
    root.add(apart, hidden, new Mesh(new BufferGeometry(), new ShaderMaterial()));
    const camera = new PerspectiveCamera();
    const screen = { name: 'screen' };
    let target: unknown = screen;
    const built: { object: Object3D; scene: Object3D | undefined; target: unknown; camera: Camera }[] = [];
    const renderer = {
      getRenderTarget: () => target,
      setRenderTarget: (t: unknown) => void (target = t),
      compileAsync: (object: Object3D, c: Camera, scene?: Object3D) => {
        built.push({ object, scene, target, camera: c });
        return Promise.resolve();
      },
    };
    await compileApart(renderer as never, root, 27, camera);
    expect(built.map((b) => b.object)).toEqual([apart]);
    // Lit by what is in the picture's own scene, and drawn into a picture, not to the screen.
    expect(built[0]!.scene).toBe(root);
    expect(built[0]!.camera).toBe(camera);
    expect((built[0]!.target as WebGLRenderTarget).isWebGLRenderTarget).toBe(true);
    expect(target).toBe(screen);
    // Nothing on that layer: nothing to build.
    built.length = 0;
    await compileApart(renderer as never, new Object3D(), 27, camera);
    expect(built).toEqual([]);
  });
});

describe("the hands' own picture", () => {
  beforeAll(loadHands);

  it('is built before the first move for every hand that draws into it, and for none on the lowest quality', async () => {
    const { stage } = handsRig();
    const built: Object3D[] = [];
    let target: unknown = null;
    const renderer = {
      getRenderTarget: () => target,
      setRenderTarget: (t: unknown) => void (target = t),
      compileAsync: (object: Object3D) => {
        built.push(object);
        return Promise.resolve();
      },
    };
    await stage.warmPictures(renderer as never, new PerspectiveCamera());
    expect(built).toHaveLength(4);
    for (const object of built) expect(object.layers.mask).toBe(1 << SILHOUETTE_LAYER);
    built.length = 0;
    stage.setQuality('low');
    await stage.warmPictures(renderer as never, new PerspectiveCamera());
    expect(built).toHaveLength(0);
  });
});

/** A program that is built after it has been asked about `after` times. */
const program = (after: number): Built & { asked: number } => ({
  asked: 0,
  isReady() {
    return this.asked++ >= after;
  },
});

describe('the programs of a quality that is not the one in use', () => {
  it('are found for every material under the scene, in every form each has been asked for', () => {
    const root = new Object3D();
    const glass = new MeshStandardMaterial();
    const skin = new ShaderMaterial();
    const hidden = new Mesh(new BufferGeometry(), skin);
    hidden.visible = false;
    root.add(new Mesh(new BufferGeometry(), glass), hidden, new Mesh(new BufferGeometry(), [glass, skin]), new Object3D());
    expect([...materialsIn(root)]).toEqual([glass, skin]);

    const [plain, mirrored, drawn] = [program(0), program(0), program(0)];
    const kept = new Map<unknown, unknown>([
      // Set as it will be, asked for, and set back: it is drawn with one program and holds another being built.
      [glass, { programs: new Map([['plain', plain], ['mirrored', mirrored]]), currentProgram: plain }],
      [skin, { programs: new Map([['drawn', drawn]]), currentProgram: drawn }],
    ]);
    const renderer = { properties: { get: (m: unknown) => kept.get(m) ?? {} } };
    expect(programsOf(renderer as never, [glass, skin, new ShaderMaterial()])).toEqual([plain, mirrored, drawn]);
  });

  it('are waited for until the last of them is built, and no longer once they are not wanted', async () => {
    const [quick, slow] = [program(0), program(3)];
    await whenBuilt([quick, slow], () => true, 1);
    expect(quick.asked).toBe(1);
    expect(slow.asked).toBe(4);
    // Nothing to build: nothing to wait for.
    await whenBuilt([]);
    // One that is never built is given up as soon as something else is wanted.
    const never = program(Infinity);
    let wanted = true;
    setTimeout(() => (wanted = false), 5);
    await whenBuilt([never], () => wanted, 1);
    expect(never.asked).toBeGreaterThan(0);
  });

  it('leave the glass as it was when it is set for another quality and set back', () => {
    const forms = (q: Quality) => [QUALITY[q].mirror > 0, QUALITY[q].glass] as const;
    const material = new MeshStandardMaterial();
    material.defines = { STANDARD: '' };
    setGlass(material, ...forms('high'));
    const high = JSON.stringify(material.defines);
    setGlass(material, ...forms('low'));
    const low = JSON.stringify(material.defines);
    expect(low).not.toBe(high);
    setGlass(material, ...forms('high'));
    expect(JSON.stringify(material.defines)).toBe(high);
    // Medium and high draw the glass alike: one program serves both.
    setGlass(material, ...forms('medium'));
    expect(JSON.stringify(material.defines)).toBe(high);
  });
});

describe("the hands' programs for another quality", () => {
  beforeAll(loadHands);

  it('are asked for with the hands set as that quality has them, and the hands set back are as they were', async () => {
    const { stage } = handsRig();
    const defines = () => JSON.stringify([...materialsIn(stage.root)].map((m) => (m as ShaderMaterial).defines ?? null));
    const shown = () => {
      const seen: boolean[] = [];
      stage.root.traverse((o) => seen.push(o.visible));
      return JSON.stringify(seen);
    };
    const built: Object3D[] = [];
    const renderer = { getRenderTarget: () => null, setRenderTarget: () => undefined, compileAsync: (object: Object3D) => (built.push(object), Promise.resolve()) };
    stage.setQuality('low');
    const [low, lowShown] = [defines(), shown()];
    // As World.askFor does: set, ask, set back.
    stage.setQuality('high');
    expect(defines()).not.toBe(low);
    await stage.warmPictures(renderer as never, new PerspectiveCamera());
    stage.setQuality('low');
    expect(built).toHaveLength(4);
    expect(defines()).toBe(low);
    expect(shown()).toBe(lowShown);
  });
});

describe('a setting made ready before it is taken up', () => {
  /** A staged setting whose making ready is finished by hand. */
  const staged = (nothingToMake = false) => {
    const taken: string[] = [];
    const making: { next: string; wanted: () => boolean; done: () => void }[] = [];
    const s = new Staged<string>(
      'medium',
      (next, wanted) => (nothingToMake ? null : new Promise<void>((done) => making.push({ next, wanted, done }))),
      (next) => taken.push(next),
    );
    return { s, taken, making };
  };

  it('goes on with the old one until the new one is ready', async () => {
    const { s, taken, making } = staged();
    const asked = s.ask('low');
    expect(s.current).toBe('medium');
    expect(s.wanted).toBe('low');
    expect(taken).toEqual([]);
    making[0]!.done();
    await asked;
    expect(s.current).toBe('low');
    expect(taken).toEqual(['low']);
  });

  it('takes it up at once when there is nothing to make', () => {
    const { s, taken } = staged(true);
    void s.ask('high');
    expect(s.current).toBe('high');
    expect(taken).toEqual(['high']);
  });

  it('never takes up one that another has been asked for in place of', async () => {
    const { s, taken, making } = staged();
    const first = s.ask('low');
    const second = s.ask('high');
    expect(making[0]!.wanted()).toBe(false);
    expect(making[1]!.wanted()).toBe(true);
    making[0]!.done();
    await first;
    expect(taken).toEqual([]);
    expect(s.current).toBe('medium');
    making[1]!.done();
    await second;
    expect(taken).toEqual(['high']);
  });

  it('lets go of what was being made when asked back to what is in use', async () => {
    const { s, taken, making } = staged();
    const there = s.ask('low');
    await s.ask('medium');
    expect(making[0]!.wanted()).toBe(false);
    making[0]!.done();
    await there;
    expect(taken).toEqual([]);
    expect(s.current).toBe('medium');
    expect(s.wanted).toBe('medium');
  });

  it('asks once for the same thing asked twice', async () => {
    const { s, taken, making } = staged();
    const a = s.ask('low');
    const b = s.ask('low');
    expect(making).toHaveLength(1);
    making[0]!.done();
    await Promise.all([a, b]);
    expect(taken).toEqual(['low']);
  });

  it('takes it up all the same when it could not be made ready', async () => {
    const taken: string[] = [];
    const thrown = new Staged<string>('medium', () => { throw new Error('no context'); }, (next) => taken.push(next));
    void thrown.ask('low');
    expect(taken).toEqual(['low']);
    const refused = new Staged<string>('medium', () => Promise.reject(new Error('lost')), (next) => taken.push(next));
    await refused.ask('high');
    expect(taken).toEqual(['low', 'high']);
  });
});
