import { Easing, interpolate, spring } from 'remotion';

export const FPS = 60;

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** 0 to 1 over a stretch of frames, eased. */
export const ease = (frame: number, from: number, to: number, easing: (t: number) => number = Easing.out(Easing.cubic)) => interpolate(frame, [from, to], [0, 1], { ...clamp, easing });

/**
 * A sheet slapped down on the picture at frame `at`: it is there at once, large and askew, and
 * lands in a few frames with a little bounce. The answer is how far from landed it still is:
 * 1 at the first frame, 0 when it lies still (and slightly past 0 in the bounce).
 */
export function slap(frame: number, at: number): number {
  if (frame < at) return 1;
  return 1 - spring({ frame: frame - at, fps: FPS, config: { damping: 15, stiffness: 300, mass: 0.6 } });
}

/** Gone by frame `at`: whisked off over the `over` frames before it. 0 while it stays, 1 once gone. */
export const leave = (frame: number, at: number, over = 7) => interpolate(frame, [at - over, at], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });

export { clamp };
