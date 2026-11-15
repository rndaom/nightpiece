/**
 * Development only: draw the current frame and hand it to the dev server to
 * save under docs/screenshots (see tools/dev/capture.ts). The page's HTML
 * interface is not part of the picture, only the 3D view.
 */
import type { App } from '../app/app';

export interface ShotResult {
  name: string;
  width: number;
  height: number;
  bytes: number;
}

export async function shot(app: App, name: string, quality = 0.92): Promise<ShotResult> {
  const canvas = app.canvas;
  app.redraw();
  // The drawing buffer is only guaranteed until the browser next composites, so the copy is taken at once.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, name.endsWith('.png') ? 'image/png' : 'image/jpeg', quality),
  );
  if (!blob) throw new Error('The canvas could not be read.');
  const response = await fetch(`/__capture/${name}`, {
    method: 'POST',
    headers: { 'x-nightpiece-capture': '1' },
    body: blob,
  });
  if (!response.ok) throw new Error(`Capture refused: ${response.status} ${await response.text()}`);
  return { name, width: canvas.width, height: canvas.height, bytes: blob.size };
}
