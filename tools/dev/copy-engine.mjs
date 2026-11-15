/**
 * Copies the chess engine out of the `stockfish` package into public/engine/,
 * where the game loads it from as a worker. Runs after `npm install` and
 * before the dev server and the build.
 *
 * Only the single-threaded "lite" build is copied (under two megabytes), with
 * the engine's licence and a note saying where its source is (SOURCE.txt)
 * beside it. The copies are not kept in git.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const from = path.join(root, 'node_modules', 'stockfish');
const to = path.join(root, 'public', 'engine');

const files = [
  ['bin/stockfish-19-lite-single.js', 'stockfish-19-lite-single.js'],
  ['bin/stockfish-19-lite-single.wasm', 'stockfish-19-lite-single.wasm'],
  ['Copying.txt', 'COPYING.txt'],
];

if (!existsSync(from)) {
  console.warn('copy-engine: the stockfish package is not installed; the computer opponent will be unavailable.');
  process.exit(0);
}
mkdirSync(to, { recursive: true });
let copied = 0;
for (const [source, target] of files) {
  const a = path.join(from, source);
  const b = path.join(to, target);
  if (!existsSync(a)) {
    console.warn(`copy-engine: ${source} is missing from the stockfish package.`);
    continue;
  }
  if (existsSync(b) && statSync(b).size === statSync(a).size) continue;
  copyFileSync(a, b);
  copied++;
}
if (copied > 0) console.log(`copy-engine: ${copied} file(s) copied to public/engine/`);

// Where the engine's source is, for anyone who is handed these files: the engine is under the GPL-3.0.
const version = JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8')).version;
const note = `The engine in this folder is Stockfish, a chess engine licensed under the GNU General Public
License, version 3 (GPL-3.0). It is Stockfish.js ${version}, the WebAssembly build made by the
stockfish.js project (https://github.com/nmrugg/stockfish.js) from the Stockfish source, and it is
used here unmodified: the two files stockfish-19-lite-single.js and stockfish-19-lite-single.wasm are
the ones the stockfish package on npm publishes.

Source code for exactly these files (the Stockfish C++ source, the build scripts and the licence):
  https://github.com/nmrugg/stockfish.js/tree/v${version}
  https://github.com/nmrugg/stockfish.js/archive/refs/tags/v${version}.tar.gz
The package they were taken from:
  https://registry.npmjs.org/stockfish/-/stockfish-${version}.tgz
The Stockfish project itself:
  https://github.com/official-stockfish/Stockfish

COPYING.txt beside this file is the licence (GPL-3.0).
`;
const noteFile = path.join(to, 'SOURCE.txt');
if (!existsSync(noteFile) || readFileSync(noteFile, 'utf8') !== note) writeFileSync(noteFile, note);
