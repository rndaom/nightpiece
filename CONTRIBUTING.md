# Contributing

## Licences

Contributions to the code (`src/`, `server/`, `tests/`, `tools/`, and the scripts under `assets/src/`) are accepted under the [MIT licence](LICENSE), the same as the rest of the code. The art, the sound, the design documents and the name "Nightpiece" are not covered by it and are reserved; see [LICENSE-ASSETS.md](LICENSE-ASSETS.md). A change to the built models, textures or sounds, or a new one, needs to be agreed first.

## Running the game

Needs Node 22.12 or newer.

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5173>. For online play, run the server beside it in a second terminal with `npm run server`. The README has the rest of the commands, and how to rebuild the assets.

## Before sending a change

```bash
npm run typecheck
npm test
```

`npm run typecheck` checks the game, the server, the tools and the tests; plain `tsc` does not check the tests. The test suite runs the real engine and real sockets, so it takes a little while.

There is no formatter or linter. Match the style of the code around your change: layout, naming, and comments that say why, not what. Keep a change to one thing, and add a test with it where the rules, the server or the game's behaviour change.
