/**
 * What is shown instead of the game when it cannot start. The room is drawn with WebGL, so a
 * browser or a machine without it would otherwise show a black page and nothing else.
 */
import { render } from 'preact';
import { BRAND } from '../app/brand';

export const NO_WEBGL = "Nightpiece needs WebGL to draw its room. Turn on hardware acceleration in your browser's settings, or try another browser.";

export function Unavailable() {
  return (
    <div class="hud">
      <div class="veil">
        <section class="card dialog" role="alert">
          <header class="card-head">
            <h2 class="plate plate-small">{BRAND.name}</h2>
          </header>
          <h2>The room cannot be drawn</h2>
          <p>{NO_WEBGL}</p>
        </section>
      </div>
    </div>
  );
}

/** Takes the empty canvas away and puts the explanation in its place. */
export function showUnavailable(canvas: HTMLCanvasElement, hud: HTMLElement): void {
  canvas.remove();
  render(<Unavailable />, hud);
}
