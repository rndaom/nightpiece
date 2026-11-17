import { Composition } from 'remotion';
import { Film, type FilmProps } from './Film';
import { FPS, REELS } from './timeline';

/** The films, each drawn 1920 by 1080; rendered at twice that they are 3840 by 2160, and the shots are fetched at whatever size they were filmed. */
export function Root() {
  return (
    <>
      {Object.values(REELS).map((reel) => {
        const defaults: FilmProps = { reel: reel.id, base: 'http://127.0.0.1:5180', ext: 'jpg', address: 'playnightpiece.com' };
        return <Composition key={reel.id} id={reel.id} component={Film} width={1920} height={1080} fps={FPS} durationInFrames={reel.length} defaultProps={defaults} />;
      })}
    </>
  );
}
