# Credits and licences

Every third-party source used by this project, with its licence. Update this file whenever an asset, font, sound or library is added.

## Shipped with the game

### Libraries

| Library | Version | Licence | Source |
|---|---|---|---|
| three.js | 0.187.0 | MIT | <https://github.com/mrdoob/three.js> |
| chess.js | 1.4.0 | BSD-2-Clause | <https://github.com/jhlywa/chess.js> |
| Preact | 11.2.0 | MIT | <https://github.com/preactjs/preact> |
| @preact/signals | 2.11.4 | MIT | <https://github.com/preactjs/signals> |
| ws | 8.22.2 | MIT | <https://github.com/websockets/ws>. Used by the game's server only |
| tsx | 4.23.15 | MIT | <https://github.com/privatenumber/tsx>. Runs the game's server; not sent to players |

### The chess engine

The computer opponent and the judging of moves use **Stockfish 19**, in the WebAssembly build published as the npm package `stockfish` (stockfish.js 19.0.1, by Nathan Rugg and Chess.com, from the Stockfish developers' engine).

- **Licence: GNU General Public License, version 3.** The full text ships beside the engine as `engine/COPYING.txt`.
- **Source:** <https://github.com/nmrugg/stockfish.js> (the tag for 19.0.1 holds the C++ source and build scripts for exactly these files), and upstream at <https://github.com/official-stockfish/Stockfish>.
- **How it is used:** unmodified, as two separate files (`engine/stockfish-19-lite-single.js` and `.wasm`) that the game runs as its own program in a worker and talks to only in UCI, the standard text protocol for chess engines. None of its code is compiled into the game's own.
- **If you pass the game on**, keep `engine/COPYING.txt` with the engine files and keep the source link above reachable. That is what the engine's licence asks of anyone who distributes it.

`tools/dev/copy-engine.mjs` copies the three files out of `node_modules` into `public/engine/` on install and before each build. They are not kept in git.

### Typefaces

The game bundles four, through the Fontsource packages (version 5.3.0):

| Typeface | Used for | Authors | Licence | Source |
|---|---|---|---|---|
| Fraunces | The name, headings, buttons | The Fraunces Project Authors | SIL Open Font License 1.1 | <https://github.com/undercasetype/Fraunces> |
| Archivo | Block capitals: plates, the seats, the call-out | The Archivo Project Authors | SIL Open Font License 1.1 | <https://github.com/Omnibus-Type/Archivo> |
| Figtree | Running text | The Figtree Project Authors | SIL Open Font License 1.1 | <https://github.com/erikdkennedy/figtree> |
| DM Mono | Notation, key caps | The DM Mono Project Authors | SIL Open Font License 1.1 | <https://github.com/googlefonts/dm-mono> |

Each typeface's licence, with its own copyright notice, ships beside its font files as `assets/<typeface>-LICENSE.txt`, and the game's page of credits and licences (`credits.html`, made from this file, `LICENSE` and `LICENSE-ASSETS.md` by `tools/dev/credits.ts`) links to each.

Two more are not part of the game. They are loaded from Google Fonts by `docs/visual-direction.html`, the page drawn for milestone 1, and were the game's display faces until the interface was redrawn:

| Typeface | Authors | Licence | Source |
|---|---|---|---|
| Big Shoulders Display | The Big Shoulders Project Authors | SIL Open Font License 1.1 | <https://github.com/google/fonts/tree/main/ofl/bigshouldersdisplay> |
| Big Shoulders Stencil Display | The Big Shoulders Project Authors | SIL Open Font License 1.1 | <https://github.com/google/fonts/tree/main/ofl/bigshouldersstencildisplay> |

### Models and textures

All original. Every model, the hand and its skeleton included, is built by the scripts in `assets/src/`, and every texture is synthesised from noise by `assets/src/textures.py`; no scans, photographs, asset packs or third-party models are used.

The board's engraved coordinates are cut from DM Mono Medium (SIL Open Font License 1.1). The font file and its licence are in `assets/src/fonts/`; only the resulting geometry ships.

### Lookalike letters

A name is checked against the few names nobody may take by what it looks like, whatever alphabet it is written in. The table of letters that are drawn like Latin ones (`src/net/lookalikes.ts`) is taken from the Unicode Consortium's list of confusable characters (`confusables.txt`, Unicode Technical Standard #39), © Unicode, Inc., used under the Unicode License v3: <https://www.unicode.org/license.txt>.

### Audio

Every sound in the game is made from recordings: stone is recordings of stone, the glass tones are struck glasses, the bell is a tubular bell, the room's drone is a bowed double bass, wine glasses and a bowed vibraphone. Nothing is an oscillator. `assets/src/sound/build.py` cuts, tunes, layers and levels the recordings into the files in `public/assets/sound/`; the game (`src/audio/sound.ts`) places them in the room and adds the chapel's echo, which is itself built by `assets/src/sound/hall.py` and not recorded.

All of the recordings are dedicated to the public domain under **CC0 1.0**, which asks for nothing; they are credited here because their makers deserve it. They are not kept in git: `assets/src/sound/sources.json` lists each one with the address it came from and its SHA-256, and `python assets/src/sound/fetch.py` gets them again.

**Instruments.** Two sample libraries by Versilian Studios (Sam Gossner and contributors), both CC0 1.0, fetched from GitHub at the commits recorded in `sources.json`:

| Library | Used for | Source |
|---|---|---|
| Versilian Community Sample Library (VCSL) | Tubular bells, gong, bass drums, timpani and a suspended cymbal (the bell, check, mate, a discovered attack); concert harp, wine glasses and a bowed vibraphone (a strong move, the glass tones, the room); a pipe organ's pedal (the room) | <https://github.com/sgossner/VCSL> |
| VSCO 2 Community Edition | A solo double bass (the room, a fork, a blunder, check); cello, viola and violin sections playing tremolo (the uneasy layer under a sharp position, mate) | <https://github.com/sgossner/VSCO-2-CE> |

**Recordings of things.** The licence is as each page showed it on 11 November 2026. Those from Freesound are the site's own "HQ preview" encodings (MP3 or Ogg), which can be fetched without an account, not the uploaders' original files; the difference is not audible under the processing here, and the originals can be swapped in by anyone with an account.

| Recording | By | Licence | Source | Used for |
|---|---|---|---|---|
| Plates Set Down.wav | davjanus | CC0 1.0 | [Freesound](https://freesound.org/people/davjanus/sounds/420440/) | The board's plates going over at mate |
| ANI - Champagne flute - Hard 1a | ani_music | CC0 1.0 | [Freesound](https://freesound.org/people/ani_music/sounds/198388/) | The glass tones |
| Wine glass clink deeper.wav | lmr9 | CC0 1.0 | [Freesound](https://freesound.org/people/lmr9/sounds/178178/) | The glass tones |
| clink of glasses | SirMediabert | CC0 1.0 | [Freesound](https://freesound.org/people/SirMediabert/sounds/269395/) | A pin closing, a knuckle cracked, fingers snapped |
| ANI - Wine Glass - Hard | ani_music | CC0 1.0 | [Freesound](https://freesound.org/people/ani_music/sounds/198401/) | The glass tones |
| Door Smash 1 | qubodup | CC0 1.0 | [Freesound](https://freesound.org/people/qubodup/sounds/218890/) | The blow at mate |
| Kirkstall Rock Crumble .wav | rokenjocu | CC0 1.0 | [Freesound](https://freesound.org/people/rokenjocu/sounds/262118/) | The crack running through the board |
| Rock destroy | Bertsz | CC0 1.0 | [Freesound](https://freesound.org/people/Bertsz/sounds/524312/) | A stone taken |
| Rock Smash | NeoSpica | CC0 1.0 | [Freesound](https://freesound.org/people/NeoSpica/sounds/512243/) | A stone taken |
| stone falls and breaks low pitch.aiff | SoundCollectah | CC0 1.0 | [Freesound](https://freesound.org/people/SoundCollectah/sounds/109360/) | A stone taken |
| Foley_Stones_Falls_Debris_Stereo_DR05.wav | Nox_Sound | CC0 1.0 | [Freesound](https://freesound.org/people/Nox_Sound/sounds/550342/) | A stone taken |
| Tumbling Rocks | Fission9 | CC0 1.0 | [Freesound](https://freesound.org/people/Fission9/sounds/488660/) | A stone set down, a stone taken, the crack, a stone patted, a knuckle cracked |
| 75 CC0 breaking/falling/hit - rock_breaking_02 | rubberduck | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | The crack running through the board |
| two large cobblestone blocks | jobel0092 | CC0 1.0 | [Freesound](https://freesound.org/people/jobel0092/sounds/268055/) | A stone set down |
| Small Rock and Stone Hits.wav | lolamadeus | CC0 1.0 | [Freesound](https://freesound.org/people/lolamadeus/sounds/179365/) | The crack running through the board |
| Small Rock and Stone Hits 2.wav | lolamadeus | CC0 1.0 | [Freesound](https://freesound.org/people/lolamadeus/sounds/179360/) | A stone set down, a stone's foot rapped on the board |
| Stone dropping to ground_northern87 | northern87 | CC0 1.0 | [Freesound](https://freesound.org/people/northern87/sounds/369981/) | A stone set down |
| Stone.wav | danielpodlovics | CC0 1.0 | [Freesound](https://freesound.org/people/danielpodlovics/sounds/530354/) | A stone set down, a stone's foot rapped on the board |
| Stone dropping | alegemaate | CC0 1.0 | [Freesound](https://freesound.org/people/alegemaate/sounds/364711/) | A stone set down |
| Moving Granite block.wav | 200221-WeanBekker | CC0 1.0 | [Freesound](https://freesound.org/people/200221-WeanBekker/sounds/543703/) | A stone lifted, a pawn pushed |
| Stone Slab Door Grinding - Heavy Rock Scrape (Mono) | NahuelMartinez | CC0 1.0 | [Freesound](https://freesound.org/people/NahuelMartinez/sounds/844329/) | The slab giving way |
| Scrapes - scrape-3 | AntumDeluge | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/scrapes) | A stone lifted |
| CRWDSing_U Ooh Vowel Sung Near F 02_ShaneVincent_GSC24_XY-AKG214-96k.wav | ShangusBurger | CC0 1.0 | [Freesound](https://freesound.org/people/ShangusBurger/sounds/763894/) | Voices at mate |
| Low_D_Arh.wav | annannienann | CC0 1.0 | [Freesound](https://freesound.org/people/annannienann/sounds/8067/) | Voices at mate |
| Old clock tick-tock | Duasun | CC0 1.0 | [Freesound](https://freesound.org/people/Duasun/sounds/323626/) | The clock |
| hands rubbing together | humga | CC0 1.0 | [Freesound](https://freesound.org/people/humga/sounds/315750/) | A hand on a stone, two hands met, fingers snapped |
| HandsOnConcreteWithDirt.wav | prozaciswack | CC0 1.0 | [Freesound](https://freesound.org/people/prozaciswack/sounds/82723/) | A hand on a stone |
| cloth1 | Kenney | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/50-rpg-sound-effects) | A hand on a stone, a piece chosen, a fingertip on the rail of the case and on a stone |
| Cloth_01 | OwlishMedia | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/202-more-sound-effects) | A hand moving through the air |
| Candle wood wick flame mono 01.wav | roisin.gleeson | CC0 1.0 | [Freesound](https://freesound.org/people/roisin.gleeson/sounds/680476/) | The candles, a hand come too near one |
| Real Heartbeat (DIY Stethoscope recording) | modusmogulus | CC0 1.0 | [Freesound](https://freesound.org/people/modusmogulus/sounds/831630/) | The heartbeat in check |
| Playing card contact 1 | BMacZero | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/playing-card-sounds) | The interface: a press |
| PaperSlide.wav | eyesonlegs | CC0 1.0 | [Freesound](https://freesound.org/people/eyesonlegs/sounds/464302/) | The interface: a card coming up |
| card-shove-2 | Kenney | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips) | The interface: a card put away |
| card-slide-5 | Kenney | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips) | The interface: a card put away |
| book_flip.3 | StarNinjas | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/10-book-page-flips) | The interface: a card coming up |
| pencil_write | AntumDeluge (from the Freesound recording `pencil_write` by NachtmahrTV) | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/pencil-sounds) | The interface: the pointer over a button |
| St Mullion Church Door Internal Shut_sel.wav | gropkcor | CC0 1.0 | [Freesound](https://freesound.org/people/gropkcor/sounds/392240/) | The case's lid coming down on the altar |
| bookClose | Kenney | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/50-rpg-sound-effects) | The case's lid coming down on the altar, a fingertip on the rail of the case |
| front tick.wav | Alexsani | CC0 1.0 | [Freesound](https://freesound.org/people/Alexsani/sounds/117280/) | The case's brass catch letting go |
| stone_rock_or_wood_moved_no_tick | omegagreg (original pauliuw) | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/stonerockorwoodmovednotick) | A drawer of the case run out |
| creak1 | Kenney | CC0 1.0 | [OpenGameArt](https://opengameart.org/content/50-rpg-sound-effects) | A drawer of the case run out |
| 02 Mainz Cathedral western crypt.wav | blaukreuz | CC0 1.0 | [Freesound](https://freesound.org/people/blaukreuz/sounds/131107/) | The air of the room |
| AMB_Wind_Howling_empty Church close to window_48kHz.wav | Tonmeister88 | CC0 1.0 | [Freesound](https://freesound.org/people/Tonmeister88/sounds/557380/) | The air of the room |
| Shirt Whoosh 1.wav | saturdaysoundguy | CC0 1.0 | [Freesound](https://freesound.org/people/saturdaysoundguy/sounds/391448/) | A hand moving through the air |
| Short Whoosh, 13x | Kinoton | CC0 1.0 | [Freesound](https://freesound.org/people/Kinoton/sounds/427979/) | A hand moving through the air |

**The promotional films** (`promo/`, made by `tools/promo/`) are the game itself, filmed, with the game's own sound. Their music is a recording: "Spy Glass" by Kevin MacLeod ([incompetech.com](https://incompetech.com)), licensed under [Creative Commons: By Attribution 4.0](http://creativecommons.org/licenses/by/4.0/). Each film uses a part of it, two of them with one join, and the game's sounds are laid over it; each film's last card credits it. `tools/promo/sources.json` says where it is fetched from, and `python assets/src/sound/fetch.py --list tools/promo/sources.json` gets it again. What is written over the films (the lines, the ways to play, the closing card) is set in the lettering the game uses: Fraunces, Archivo, Figtree and DM Mono. They are put together with Remotion (`tools/promo/film/`).

## Used to build and test, not shipped

| Tool | Version | Licence |
|---|---|---|
| Vite | 8.3.7 | MIT |
| Vitest | 5.1.0 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| @preact/preset-vite | 2.10.6 | MIT |
| @types/three | 0.187.0 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/ws | 8.18.2 | MIT |
| puppeteer-core | 25.17.0 | Apache-2.0. Drives a Chromium already on the machine so that the game can be looked at without a window (`tools/dev/look.mjs`); it downloads no browser |
| Blender | 5.2.3 LTS | GPL-3.0-or-later. Used to build and bake the assets; its output is not covered by the GPL |
| NumPy, SciPy | 2.5.4, 1.18.1 | BSD-3-Clause. The sound builder (`assets/src/sound/`) |
| python-soundfile (libsndfile) | 0.14.0 | BSD-3-Clause (LGPL-2.1 for libsndfile). Reads the recordings and writes the FLAC files |
| LAME | 4.0 | LGPL-2.0-or-later. Encodes the room's loops as MP3 |
| Remotion | 4.0.544 | [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md): free for individuals and for companies of up to three people. Lays the promotional films' shots end to end and draws their titles (`tools/promo/film/`); installed in that folder only, and no part of the game |
| FFmpeg | 9.0.2 | GPL-3.0-or-later (as built here, with libx264). Puts the promotional films' frames and sound together and encodes them (`tools/promo/cut.mjs`); also measures their loudness |

## Studied, not included

These informed the style bible. None of this material is in the repository or will ship with the game.

| Material | Owner | Use |
|---|---|---|
| "Solomon: Deadlock Hero Spotlight" (<https://www.youtube.com/watch?v=H_DpKG583yo>) | Dead Air | Watched for art-direction study |
| Deadlock, its hero Solomon, and Valve's published pages | Valve Corporation | Read for reference. Nothing extracted from the game |
| deadlock.wiki pages | Their contributors | Read for reference |
| Press articles listed in the style bible | Their publishers | Read for reference |

Deadlock is a trademark of Valve Corporation. This project is not affiliated with or endorsed by Valve.
