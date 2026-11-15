/**
 * How soft the key's shadows are. three filters a shadow with five readings of its map, scattered
 * over a disc; over the few texels of a hard edge that is enough, but the key's shadows are drawn
 * with a penumbra a finger wide (the moon through the lantern's glass is not a point), and five
 * readings over that width show as grain. Here the same disc is read sixteen times.
 *
 * It is put into three's own shader text, once, before any material is compiled: every material
 * that receives a shadow reads the same function.
 */
import { ShaderChunk } from 'three';

/** How many readings of the shadow map each shaded point takes. */
export const SHADOW_TAPS = 16;

/** three's five readings and their average, as it writes them. */
const FIVE = /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \)[\s\S]*?\) \* 0\.2;/;

const MANY = /* glsl */ `shadow = 0.0;
				for ( int tap = 0; tap < ${SHADOW_TAPS}; tap ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( tap, ${SHADOW_TAPS}, phi ) * radius, shadowCoord.z ) );
				}
				shadow *= ${(1 / SHADOW_TAPS).toFixed(6)};`;

let done = false;

/** Have every shadow read its map `SHADOW_TAPS` times. Safe to call more than once. */
export function softenShadows(): void {
  if (done) return;
  const chunk = ShaderChunk.shadowmap_pars_fragment;
  // three words this differently from one release to the next. If it has, say so: the shadows
  // would otherwise be left as grainy as they were, without any error.
  if (!FIVE.test(chunk)) throw new Error("three's shadow filter is not worded as expected (src/scene/shadows.ts)");
  ShaderChunk.shadowmap_pars_fragment = chunk.replace(FIVE, MANY);
  done = true;
}

/**
 * The width of the blur, in texels of a shadow map this many texels across that covers `reach`
 * either side of the board: so that the penumbra is `soft` wide on the board whatever the map's size.
 */
export function shadowRadius(mapSize: number, reach: number, soft: number): number {
  return (soft * mapSize) / (2 * reach);
}
