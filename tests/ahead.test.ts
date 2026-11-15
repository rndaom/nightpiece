import { Bone, BufferGeometry, type Camera, PerspectiveCamera, Float32BufferAttribute, Mesh, MeshStandardMaterial, Object3D, ShaderMaterial, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, WebGLRenderTarget } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { SILHOUETTE_LAYER } from '../src/hands/silhouette';
import { boundSkins, compileApart, texturesIn } from '../src/scene/ahead';
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
