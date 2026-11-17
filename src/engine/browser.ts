/**
 * The engine in the browser: Stockfish compiled to WebAssembly, running in a
 * worker so that a search never holds up a frame.
 *
 * The engine's two files are copied out of the `stockfish` package into
 * public/engine/ by tools/dev/copy-engine.mjs (see CREDITS.md for its
 * licence). This is the single-threaded "lite" build: under two megabytes,
 * needs no special server headers, and is far stronger than any person.
 */
import { Engine, type UciPort } from './uci';

const ENGINE_FILE = 'engine/stockfish-19-lite-single.js';
/**
 * How long the engine is given to come up, in milliseconds: its program is nearly two megabytes
 * and may be arriving over a slow connection. If the worker's own script is missing the browser
 * says so, but if the larger file it then fetches fails, nothing is said at all, and this limit
 * is the only way to find out.
 */
const START_PATIENCE = 45000;

/** Start the engine. Rejects if the browser cannot load it, or it has not answered within the limit. */
export async function startEngine(base = import.meta.env.BASE_URL): Promise<Engine> {
  const worker = new Worker(`${base}${ENGINE_FILE}`);
  const failed = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => reject(new Error(`The chess engine did not load: ${event.message || 'unknown error'}`)), { once: true });
  });
  const port: UciPort = {
    send: (line) => worker.postMessage(line),
    listen: (onLine) => worker.addEventListener('message', (event) => typeof event.data === 'string' && onLine(event.data)),
    close: () => worker.terminate(),
  };
  const engine = new Engine(port);
  try {
    await Promise.race([engine.start(START_PATIENCE), failed]);
  } catch (error) {
    engine.close();
    throw error;
  }
  // A worker that dies later (out of memory, say) says so only here. The engine is closed, so that a
  // search under way fails and is reported, and is not waited on for ever.
  worker.addEventListener('error', () => engine.close());
  return engine;
}
