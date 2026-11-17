import { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame } from 'remotion';
import { EndCard, TitleCard } from './Cards';
import { fonts } from './fonts';
import { Footage, type Source } from './Footage';
import { BoilDefs, GRAIN } from './Sheet';
import { REELS } from './timeline';
import { Caption, Card, Slam } from './Titles';

export interface FilmProps extends Source {
  /** Which of the films (timeline.ts). */
  reel: string;
  /** The address on the last card. */
  address: string;
  [key: string]: unknown;
}

/** Nothing is drawn until the typefaces and the paper's grain are in: what is written is measured, and must be measured in its own face. */
function useReady(): boolean {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender('typefaces and paper'));
  useEffect(() => {
    const grain = new Image();
    grain.src = GRAIN;
    void Promise.all([fonts, grain.decode()]).then(() => {
      setReady(true);
      continueRender(handle);
    });
  }, [handle]);
  return ready;
}

export function Film(props: FilmProps) {
  const frame = useCurrentFrame();
  const ready = useReady();
  const reel = REELS[props.reel];
  if (!ready || !reel) return null;
  const cut = reel.cuts.find((c) => frame >= c.from && frame < c.to);
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      {cut ? <Footage key={`${cut.shot}-${cut.from}`} source={props} shot={cut.shot} from={cut.from} skip={cut.skip} /> : null}
      <BoilDefs />
      {reel.captions.map((c) => (
        <Caption key={c.id} spec={c} />
      ))}
      {reel.slams.map((s) => (
        <Slam key={s.id} spec={s} />
      ))}
      {reel.cards.map((c) => (
        <Card key={c.id} spec={c} />
      ))}
      <TitleCard from={reel.title.from} to={reel.title.to} />
      <EndCard from={reel.end.from} to={reel.end.to} address={props.address} />
    </AbsoluteFill>
  );
}
