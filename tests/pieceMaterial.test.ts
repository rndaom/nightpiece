/**
 * A piece's stone is three's standard material with shader text of our own put into it by hand.
 * Text that three no longer words the same way is silently left out, and the pieces would then
 * lose their own shadows, or their light, without any error. These say so out loud.
 */
import { ShaderLib, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import type { Assets } from '../src/scene/assets.ts';
import { pieceMaterial } from '../src/scene/materials.ts';

const surface = () => ({ albedo: new Texture(), normal: new Texture(), orm: new Texture() });
const assets = { surfaces: { pieces_bone: surface(), pieces_ebony: surface() }, piecesAo: new Texture(), piecesGlow: new Texture() } as unknown as Assets;

/** The shader as three would compile it for a piece, before its own includes are resolved. */
function compiled(side: 'w' | 'b') {
  const material = pieceMaterial(assets, side);
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader as never, undefined as never);
  return { material, shader };
}

describe('the piece material', () => {
  for (const side of ['w', 'b'] as const) {
    it(`moves the blocks of a ${side === 'w' ? 'bone' : 'ebony'} piece in the vertex shader`, () => {
      const { shader } = compiled(side);
      expect(shader.vertexShader).toContain('attribute vec4 aData;');
      expect(shader.vertexShader).toContain('vMapUv += uStone;');
      expect(shader.vertexShader).toContain('objectNormal = pieceTurned( objectNormal, pieceCos, pieceSin );');
      expect(shader.vertexShader).toContain('vPieceData = aData.gba;');
    });

    it(`lights a ${side === 'w' ? 'bone' : 'ebony'} piece from inside and keeps part of its baked shade under the leaning key`, () => {
      const { material, shader } = compiled(side);
      const fragment = shader.fragmentShader;
      expect(fragment).toContain('float glow = step( 0.5, vPieceData.x );');
      expect(fragment).toContain('roughnessFactor *= mix( 1.0, uSheen.w, chamfer );');
      expect(fragment).toContain('reflectedLight.indirectSpecular *= uGloss;');
      // three's own loop over the lights is replaced by ours, in which the key carries part of the
      // shade baked for a light from overhead; the shadow map is asked on every face, as three asks it.
      expect(fragment).not.toContain('#include <lights_fragment_begin>');
      expect(fragment).toMatch(/directLight\.color \*= mix\( 1\.0, pieceKeyOpen, 0\.\d+ \);/);
      expect(fragment).toMatch(/directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( spotShadowMap\[ i \]/);
      expect(fragment).not.toContain('pieceKeyClear');
      // What the loop reads is declared before it.
      expect(fragment.indexOf('float pieceKeyOpen')).toBeGreaterThan(-1);
      expect(fragment.indexOf('float pieceKeyOpen')).toBeLessThan(fragment.indexOf('directLight.color *= mix( 1.0, pieceKeyOpen'));
      for (const name of Object.keys(material.userData.uniforms)) expect(shader.uniforms).toHaveProperty(name);
    });

    it(`turns the low light from the far end of the room toward a colour of its own on a ${side === 'w' ? 'bone' : 'ebony'} piece`, () => {
      const { shader } = compiled(side);
      const fragment = shader.fragmentShader;
      // Every spot light that is not the key goes through it, and what it reads is declared before the loop.
      expect(fragment).toMatch(/#else\s+directLight\.color = mix\( directLight\.color, uRim\.rgb \* dot\(/);
      expect(fragment.indexOf('vec3 pieceFarEnd')).toBeGreaterThan(-1);
      expect(fragment.indexOf('vec3 pieceFarEnd')).toBeLessThan(fragment.indexOf('dot( directLight.direction, pieceFarEnd )'));
      // Nothing is declared inside the loop, which three writes out once for each light.
      const spots = fragment.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )');
      expect(spots).toBeGreaterThan(-1);
      // The body of the loop: what stands between its opening brace and the end of the unrolling.
      const loop = fragment.slice(fragment.indexOf('{', fragment.indexOf('#pragma unroll_loop_start', spots)), fragment.indexOf('#pragma unroll_loop_end', spots));
      expect(loop).toContain('uRim.a');
      expect(loop).not.toMatch(/\b(float|vec[234]|mat[234]|int|bool)\s+\w+\s*(=|;)/);
    });
  }

  it("turns Void's green toward bone on Ivory's faces and leaves Ivory's gold on Void's alone, never changing how bright the light is", () => {
    const ivory = compiled('w').material.userData.uniforms;
    const dark = compiled('b').material.userData.uniforms;
    const brightness = (v: { x: number; y: number; z: number }) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
    expect(brightness(ivory.uRim.value)).toBeCloseTo(1, 5);
    expect(brightness(dark.uRim.value)).toBeCloseTo(1, 5);
    expect(ivory.uRim.value.w).toBeGreaterThan(0.5);
    expect(ivory.uRim.value.w).toBeLessThanOrEqual(1);
    // Warm: more red than blue.
    expect(ivory.uRim.value.x).toBeGreaterThan(ivory.uRim.value.z);
    expect(dark.uRim.value.w).toBe(0);
    // Each side's faces are lit from the other's end: Void sits at -z.
    expect(ivory.uRimFrom.value).toBe(-1);
    expect(dark.uRimFrom.value).toBe(1);
  });
});
