import { AbsoluteFill, Img, useCurrentFrame } from 'remotion';

/** Where the shots' frames are fetched from, and what kind of file they are: given when the film is rendered (render.mjs). */
export interface Source {
  base: string;
  ext: 'png' | 'jpg';
}

/** The handle each shot is filmed with before its cut begins, in frames (shots.mjs, `span`). */
export const HANDLE = 12;

/**
 * A stretch of one shot: the frame of the film it begins at, and how far into the shot's used part
 * that is, in frames. The shot is a folder of numbered pictures, one to a frame.
 */
export function Footage(props: { source: Source; shot: string; from: number; skip?: number; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const n = HANDLE + (props.skip ?? 0) + (frame - props.from);
  const src = `${props.source.base}/${props.shot}/frame_${String(Math.max(0, n)).padStart(5, '0')}.${props.source.ext}`;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', ...props.style }} pauseWhenLoading />
    </AbsoluteFill>
  );
}
