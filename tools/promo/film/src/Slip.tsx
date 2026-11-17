import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useCurrentFrame } from 'remotion';
import { Sheet } from './Sheet';

/** A sheet cut to fit what is written on it: the writing is measured, and the paper laid under it. */
export function Slip(props: {
  id: string;
  pad?: [number, number];
  children: React.ReactNode;
  sheet?: Omit<React.ComponentProps<typeof Sheet>, 'id' | 'w' | 'h' | 'children'>;
  style?: React.CSSProperties;
}) {
  const { id, pad = [34, 18] } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    if (w !== size[0] || h !== size[1]) setSize([w, h]);
  }, [frame, size, props.children]);
  return (
    <div style={{ position: 'relative', display: 'inline-block', ...props.style }}>
      <div style={{ position: 'absolute', left: 0, top: 0, visibility: size[0] ? 'visible' : 'hidden' }}>
        <Sheet id={id} w={size[0]} h={size[1]} {...props.sheet} />
      </div>
      <div ref={ref} style={{ position: 'relative', padding: `${pad[1]}px ${pad[0]}px`, whiteSpace: 'nowrap' }}>
        {props.children}
      </div>
    </div>
  );
}
