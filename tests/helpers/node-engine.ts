/**
 * The game's chess engine under Node: the same Stockfish build the browser
 * loads as a worker, so that tests exercise the real thing.
 */
import { createRequire } from 'node:module';
import type { UciPort } from '../../src/engine/uci.ts';

const require = createRequire(import.meta.url);

export function nodePort(): UciPort {
  let onLine: (line: string) => void = () => {};
  const engine = require('stockfish')('lite-single', (line: string) => onLine(line)) as {
    processCommand(command: string): void;
    terminate(): void;
  };
  return {
    send: (line) => engine.processCommand(line),
    listen: (fn) => (onLine = fn),
    close: () => engine.terminate(),
  };
}
