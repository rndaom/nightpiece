import { ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY } from '../src/scene/post';
import { TILE_LIGHTS } from '../src/scene/roomshade';
import { SHADOW_TAPS, shadowRadius, softenShadows } from '../src/scene/shadows';

describe('the key light and its shadows', () => {
  it("reads the shadow map more times than three does, in three's own filter", () => {
    softenShadows();
    const chunk = ShaderChunk.shadowmap_pars_fragment;
    expect(chunk).toContain(`for ( int tap = 0; tap < ${SHADOW_TAPS}; tap ++ )`);
    expect(chunk).toContain(`vogelDiskSample( tap, ${SHADOW_TAPS}, phi ) * radius`);
    expect(chunk).not.toContain('vogelDiskSample( 0, 5, phi )');
    // A second call leaves it as it is.
    softenShadows();
    expect(ShaderChunk.shadowmap_pars_fragment).toBe(chunk);
  });

  it('keeps the edge of a shadow as wide on the board whatever the size of the map', () => {
    const wide = shadowRadius(4096, 10.6, 0.05);
    expect(wide).toBeCloseTo((0.05 * 4096) / 21.2, 6);
    // A map a quarter the size has texels four times as wide, and so a quarter as many across the edge.
    expect(shadowRadius(1024, 10.6, 0.05)).toBeCloseTo(wide / 4, 6);
  });

  it("lays the key's shadow on a tile at less than its strength for an eye straight overhead", () => {
    // If three words its spot shadow differently, this is where it shows.
    expect(TILE_LIGHTS).toMatch(/directLight\.color \*= \( directLight\.visible && receiveShadow \) \? mix\( 1\.0, getShadow\( spotShadowMap\[ i \][^;]*\), tileShadow \) : 1\.0;/);
    expect(TILE_LIGHTS.indexOf('float tileShadow')).toBeLessThan(TILE_LIGHTS.indexOf('mix( 1.0, getShadow('));
  });

  it('gathers the dark between things only where the machine can afford it', () => {
    expect(QUALITY.low.shade).toBe(0);
    expect(QUALITY.medium.shade).toBeGreaterThan(0);
    expect(QUALITY.high.shade).toBeGreaterThan(QUALITY.medium.shade);
  });
});
