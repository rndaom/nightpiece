# The hands' manners

A design for the small things the hands do that are not chess: the knuckle crack, the tipped king, the scuffle at a stalemate. Written 14 November 2026. Steps 1 to 4 of section 8 (the table, the three props, the endings and setting down) are built; the rest is not.

The aim is the thing Valve's games have and most do not: characters that answer what you do, in ways you notice on your tenth game and tell someone about. It is not a Valve game and takes nothing of theirs; it takes the method.

## 1. What is already there

The hands are not starting from nothing. `src/hands/puppeteer.ts` has a gesture engine, and every gesture in it gives way the instant a piece is to be moved or thought about.

| Already built | When |
|---|---|
| Stir: fingers gather, light comes up | The turn comes round |
| Drum fingers in the air; rock from side to side (weigh) | To move, and idle |
| Stretch; close the fingers one by one (furl); turn the hand over and look at it | Waiting, and idle |
| Point at the king, twice; the other side starts back | Check |
| Close on themselves, and shake for a heavy stone (wince) | A stone lost |
| Open in a fan, lit (flourish); sink (sag) while the other side comes in and drums (perk) | Strong move, blunder. Never in a plain game |
| Rise, open and shut on it; start back, go limp and fade; turn up and offer | Won, lost, drawn |

What is missing is what this document adds: props (the hands touch nothing but pieces), the two players' hands dealing with *each other*, endings that differ by how the game ended, memory, and things a player can set off by trying.

## 2. What is taken from Valve, and from where

Only what a source states is listed. Where the lesson is my reading of it, it says so.

| Their practice | Source | What it becomes here |
|---|---|---|
| A rule database: facts about the world are matched against rules, **the most specific rule that fits wins**, general ones are the fallback, and every response can be interrupted | Elan Ruskin, GDC 2012, "Rule Databases for Contextual Dialog and Game Logic" (known from summaries of the talk, not the slides) | Section 4. Checkmate is answered generally; a smothered mate has its own answer, and gets it because it is more specific |
| Co-op gestures between two characters: high five, hug, rock paper scissors, each with an achievement. The animators went for "robots trying to imitate human motions" | Portal 2 (Portal wiki, Gesture; Wolpaw to PC Gamer) | The handshake, the scuffle, rock paper scissors. Ours is apparitions keeping up human manners, and failing to |
| The hands are simulated things in the world, not a cursor; a toy is built once with honest physics and left to be found | Half-Life: Alyx (Valve's AMA; the piano and the marker are from press) | The plumb weight, the candle, the captives in the drawer. Section 6 |
| Paired exchanges between two particular characters; one that cannot finish simply stops after its first line | Deadlock's response rules (Deadlock wiki) | A hand left offered when the other does not come. Sections 5.6 and 5.7 |
| Personality readable from the silhouette alone | TF2 (Mitchell, SIGGRAPH 2007) | Every manner must read as an outline from the far camera. Anything that needs finger detail to be understood is cut |
| Playtest the jokes; testers seldom laugh aloud | Wolpaw on Portal 2 | Section 9: judged from frames first, then by the author, then by someone who has not seen it |

Not found, so not relied on: any stated Valve rule on how rare a rare line should be. The rarities below are mine.

## 3. Rules every manner keeps

1. **It never costs a move.** No manner sets `busy`, queues input, holds the result card or delays a rematch. A click, a hover or a key ends it within 0.3 seconds, and the hand that was fooling is already on its way to the piece.
2. **It never covers what is being read.** No hand goes over the board on the other player's turn except as outline (the smoked-glass state a hand in thought already has). Nothing passes lower than 3.4 over the squares, the height the pointing hand keeps, so no finger comes below a king's crown. What happens lower happens off the squares: behind the back rank, on the rail, at the corners.
3. **It tells nothing a player could not see.** Section 4.2. In a plain game (ranked, online) a manner may be set off only by what is on the board, in the record, on the clocks, or offered aloud. This is enforced by the types, not by care.
4. **Deadpan.** The hands are solemn things that briefly are not, and then pretend they were. Every joke ends with the hands back at rest with their dignity on. No manner winks at the player, and none uses words.
5. **The same on both screens.** Chance is drawn from the room's name, the ply and the manner's own name, so two players online see the same scuffle without a byte sent, the film scripts can film it twice, and the tests can name what they expect.
6. **Never twice running.** A manner that has just played cannot be chosen again until something else has. Rare ones are spent: once seen in a sitting, a Seldom manner drops to a tenth of its chance.
7. **Pleased with itself, never cruel.** The winner's hands may gloat a little: a brush of the fingers, a pat for the stone that did it. They do not jeer at the loser's hands or touch them. Most of the comedy is spent on draws, on waiting, on rules that look absurd, and on the hands' own vanity.
8. **No linear motion, no new draw calls where it can be helped, and nothing on the 'low' tier that costs a frame.**

Rarity, as used below:

| Word | Meaning |
|---|---|
| Always | A ritual. The event itself is rare enough (a resignation, an en passant, a stalemate) |
| Often | 1 in 5 |
| Sometimes | 1 in 12 |
| Seldom | 1 in 40 |
| Once | At most once in a sitting, and then 1 in 12 |

Nothing here is to be met in every game. A budget sits over everything that is not a ritual: none within twelve plies of the last, and no more than two in a game. So most games have none, some have one small one, few have two, and the rituals come only when the thing they answer does: most players will play for an evening before they see a king tipped, and for a week before the scuffle.

## 4. How it is built

### 4.1 One table

A new file, `src/hands/manners.ts`, holds every manner as a row. It replaces nothing: the director goes on telling the stage what happened, and the stage asks the table what the hands make of it.

```ts
interface Manner<F extends Told> {
  name: string;                       // 'tip-the-king'
  at: Moment;                         // when the table is asked
  when: Array<(f: F) => boolean>;     // every one must hold; how many there are is how specific it is
  rarity: 'always' | 'often' | 'sometimes' | 'seldom' | 'once';
  rest?: number;                      // plies before it may play again
  play(cast: Cast, f: F, ok: () => boolean): Promise<void>;
}
```

`Moment` is one of: `sit` (the hands have arrived), `wait` (an idle tick, with the seconds waited), `think` (the pointer has done something), `set` (a piece is about to be set down, so the carry itself can differ), `after` (a move has landed), `offer` (a draw offered, refused or taken back), `end` (the game is over).

Choosing is Ruskin's rule: of the rows whose every condition holds, the one with the most conditions wins; a tie is settled by the seeded draw. So `end` + `mate` plays the claim that exists now; `end` + `mate` + `by a knight` + `king hemmed in by its own` plays the smothered mate, and nothing has to be told to stand aside for it.

### 4.2 Fairness, by type

Two kinds of fact:

- `Told`: the position, the record, the clocks, the result and why, a draw offer, which piece a hand is over (already sent to the other screen), seconds waited, results earlier in the sitting.
- `Judged extends Told`: the engine's verdict and the motifs (fork, pin, sacrifice).

A manner written against `Told` can run anywhere. One written against `Judged` is not offered to the table at all while `plain` is set, and cannot read a verdict by mistake because the field is not on the type it was given. A fuzz test plays 300 random plain games and fails if any `Judged` row was so much as considered.

### 4.3 Scenes across the board

`gesture()` runs one arm. A handshake needs two players' arms and has to fall apart cleanly if either is called away. `Stage` gets a `scene(arms, steps)` that takes a token on every arm in it; `ok()` is true only while all of them still hold theirs. When one is overtaken, the others get a short way out of their own, written per scene (the hand left hanging, section 5.7), and then go to rest.

### 4.4 What has to be made

| Thing | Where | Note |
|---|---|---|
| Seven poses | `hand.ts`, `POSES` | `flat` (paper), `scissors`, `thumb` (fist, thumb up), `cocked` (index caught under the thumb, to flick), `pinch`, `wag` (index up, the rest shut), `clasp` (for a handshake) |
| Hand to hand | `puppeteer.ts` | A target that is another hand's palm (`toWorld(PALM_FOCUS)`), followed while it moves |
| Hand to wood | `puppeteer.ts` | A resting place on the case's rail, fingertips down, so drumming has something to sound on |
| A toppled stone | `pieces.ts` | A piece laid over about the rim of its foot and rocked to rest; stood again by `reset`, `relight` and a take-back |
| Three recordings | `assets/src/sound/build.py` | Knuckles (dry, close, three to five), a finger snap, fingertips on wood. Everything else is in the bank already: `touch`, `glass`, `stoneSet`, `tick` |
| No switch | | The manners are part of the game. A browser that asks for reduced motion gets the rituals only, without being asked |

## 5. The catalogue

Each entry: what sets it off, what is seen beat by beat, what is heard, and whether it may be told in a plain game. Times are targets, as in the style bible. "Ivory" and "Void" are the two sides; "the mover" and "the waiter" are whoever is and is not to move.

### 5.1 Sitting down

**Knuckles.** *Sit; Often; Ivory only; Told.*
Before the first move, once the hands are drawn in.

| At | What |
|---|---|
| 0.00 | Both of Ivory's hands leave their corners and drift in to meet over the middle of their own edge, a square behind the back rank and 2.4 up. Outline only on the way, so the back rank is not hidden |
| 0.55 | The fingers lace, index first, one after another, 40 ms apart |
| 0.85 | The laced hands turn palm outward and push toward the board a quarter of a square. The fingers bend back 8 degrees past flat |
| 0.95 to 1.15 | Three to five cracks, 40 to 70 ms apart, not evenly. Both plumb weights swing forward from the push and are left to swing |
| 1.20 | Every stone on Ivory's back rank glances up at the sound: an eye flick, the king's last |
| 1.35 | The hands part and go home, slowly, the weights still settling |

Void's answer, a quarter of the times it plays: Void's right hand, without leaving its corner, presses its index down with its thumb. One crack, late and small. Then nothing.

Gives way at once if Ivory chooses a stone: the hands simply part.

**The grudge.** *Sit; Told; needs an earlier game in the sitting.*
The hands remember the last result. The loser of the last game is the one who cracks its knuckles, whichever side it has; its first reach of the game is a tenth quicker. A side that has lost three running arrives already drumming. Nothing is said; someone will notice in their fourth game.

### 5.2 Thinking

**Second thought.** *Think; Told (the hover is already shown to the other player).*
A stone held in thought for a second and a half or more, and then let go for another. As the hand leaves, its fingers close a little toward the first stone, stop, and the index wags once, 5 degrees each way in 180 ms. The stone that was passed over lets its eye dim and its head drop for 400 ms. Small enough to miss.

**The feint.** *Think; Sometimes; the computer's hands only; never in a lesson, never online.*
The computer's hand goes first to another stone that could have moved, hovers half a second, begins to close, stops, opens, and goes to the one it means. It makes the computer seem to be deciding. It is never the engine's second choice, only any stone with a legal move, so it tells nothing.

**J'adoube.** *Think; Told; set off by the player.*
The same stone chosen and let go twice in one turn. The second time the hand does not just leave: it pinches the stone's head and squares it to the front, a turn of a few degrees, with the sound of a finger on stone. The stone blinks. A fourth time, and the stone leans away from the hand as it comes and narrows its eye.

**This or that.** *Think; Told; set off by the player.*
The pointer going back and forth between two stones three times in four seconds. The hand stops following, hangs between them, and its index ticks from one to the other, twice, like someone counting out. Then it follows again.

**Counting.** *Think; Told.*
A stone held in thought for six seconds without moving. The fingers over it tap down in turn, index to little, once, as if counting moves ahead. Every six seconds after, not sooner.

**You are in check.** *Think; Told (it is said on the screen already).*
Three tries in one turn at a move that leaves the king in check. The other hand, the one not in use, points at its own king and taps the air over it twice. It is the hand reminding its player, a little wearily. The third time it happens in a game the hand does not point; it only lifts one finger.

### 5.3 Waiting

**The ladder of impatience.** *Wait; Told (elapsed time is on the clock).*
The waiter's hands, as the mover takes longer. Each rung plays once per turn, and the ladder starts again from the bottom when the move is made. The mover's own hands do none of this.

| Waited | What the waiter's hand does |
|---|---|
| 15 s | Drums in the air, once. As now |
| 30 s | Seldom: comes down onto the rail of the case and drums on the wood, little finger to index, three rounds. It is heard. The nearest two stones glance at it |
| 50 s | Lifts, turns its wrist over and looks at the cord, where a watch would be. The plumb weight hangs and turns. It looks back at the board |
| 75 s | Lies down flat along the rail. One finger taps, once every two seconds |
| 120 s | Still lying there. The tapping has stopped. The fingers twitch now and then, as a sleeper's do. When the move comes at last the hand starts awake, as at a check but a third as large, and is back at rest and attentive before the piece is set down |

In a ranked game the ladder stops at the second rung. A player in time trouble should not be needled.

**The clock.** *Wait; Told; ranked only.*
Under twenty seconds, the mover's free hand grows restless: its fingers adjust twice as often (`restless`, which is there already). Under ten, it has hold of the rail. The waiter's hands, meanwhile, are stiller than they have been all game.

**Captives.** *Wait; Seldom; Told; needs a stone taken.*
The waiter's hand goes to its own drawer, takes up the greatest stone it has taken, turns it in its fingers to look at it, and stands it back, straighter than it was. Across the board, the hand that lost that stone curls its fingers a little.

**The candle.** *Wait; Seldom, and Once for the second part; Told.*
The hands rest over the candles at the corners. One lowers itself palm down toward its flame, fingers spread, as hands do at a fire; the flame leans from the draught. It goes a little too low. It snatches back, shakes its fingers out twice, and goes back to rest.

And for the rest of that game it rests a hand's breadth further from the candle than it did. That is the part that is the joke.

**The weight.** *Wait; Sometimes; Told.*
After any gesture that leaves a plumb weight swinging hard, the hand holds dead still and waits for it to stop, tilting very slightly after it. One time in three the other hand comes across underneath and stops it with one finger.

**Lace and steeple.** *Wait; Seldom, and only after twenty seconds' thought.*
The two idles the style bible lists that were never built: the mover's two hands meet and steeple, and part; the waiter's lace and unlace. They need the hands to meet, which Knuckles needs as well.

The steeple is made low, before the player's own end of the case, where it stands in front of nothing: palms facing, thumbs uppermost, and all five fingertips of each hand on the other's. Each finger bends just as far as brings it to its fellow, so the long ones bow a little and the short ones are nearly straight. They press together twice and part.

### 5.4 How a piece is set down

These change the carry, so they are chosen before the hand reaches. All of them leave the stone exactly on its square, upright, as `carry` promises.

**The push.** *Set; Often; Told.* A pawn going one square in the first six plies is not picked up. One finger behind it slides it forward. Stone dragged on stone, short.

**The slide.** *Set; Sometimes; Told.* A rook, bishop or queen going five squares or more down a clear line is slid, not carried: fingertips on its head, low, the ribbon flat behind it. Heard as one long drag.

**Squaring up.** *Set; Seldom; Told; never in a lesson.* The stone comes down a twelfth of a square off its centre and a few degrees round. The hand is a third of the way home when it stops, comes back, and nudges the stone square with one finger. Every chess player alive does this. On any interruption the stone is simply where it should be.

**The pat.** *Set; Often after castling; Told.* The hand that carried the king taps it once on the crown before it goes. The king's eye closes for a moment. Castling long, two taps.

**The empty square.** *Set; Always; Told.* En passant. The capturing hand brings its pawn over the square it is going to, which has nothing on it, and stops. It taps the empty square once with the pawn's foot, as if to say that this is, in fact, the rule. Then it sets the pawn down, and the other hand takes away the pawn that was beside it. For anyone who has ever had this move explained to them.

**The snap.** *Set; Always; Told.* Promotion. The hand sets the pawn on the last rank, lifts clear, and snaps its fingers. The pawn changes on the snap, not before, so that the snap is what did it.

**Really?** *After; Always; Told.* A pawn made into anything but a queen. The other side's hand turns over slowly, palm up, and holds it there a beat. For a bishop, both of them.

**The trophy.** *Set; Always; Told.* A queen taken. The hand that lifts her away stops at the top of its carry and holds her up for 400 ms, lit, before it stands her in the drawer. If the queens are traded on the next move, the second one is taken briskly and with no ceremony at all.

**Small takes great.** *After; Always; Told.* A pawn takes a rook or a queen. The hand, on its way home, pats the pawn. The pawn's eye goes wide.

**The exchange quickens.** *Set; Told.* A capture answered by a capture on the same square, and that by another. Each is played 15 per cent faster than the one before, to a limit of three. It is the scuffle in small, and nobody will know why exchanges feel the way they do.

**No choice.** *Set; Told.* The only legal move. The reach is slower, the stone is set down without the fingers springing open, and they hang a moment after.

### 5.5 Check

**It wears off.** *After; Told.* Checks given on consecutive moves by the same side.

| Check | The side giving it | The side in it |
|---|---|---|
| First | Points, twice, as now | Starts back, as now |
| Second | Points once, from nearer home | Starts back half as far |
| Third | Does not leave rest. One finger lifts and falls | One finger twitches |
| Fourth on | Nothing | Drums |

Any move that is not a check sets it back to the first.

**Not me.** *After; Always; Told (the cracks already run from whatever gives check).* A discovered check. The hand that moved does not point at the king. It jerks a thumb back at the stone that was behind.

**Both.** *After; Always; Told.* A double check. Both hands point, one from each checker's side.

**By a pawn.** *After; Often; Told.* A king checked by a pawn. Its side starts back as usual, and then one hand flicks its fingers toward the pawn, as at a fly.

### 5.6 The draw offer

**Offered.** *Offer; Always; Told (`drawOffer` is in the room's state).* While an offer stands, the right hand of the side that made it stays at its corner but turned palm up and open toward the other player. It is the pose the hands end a draw in now. It covers nothing.

**Refused.** *Offer; Always.* The offered hand hangs a beat longer than is comfortable. Then its fingers close, little finger first, one at a time, and it turns back over. The hand that refused does nothing at all, which is ruder.

**Taken back.** *Offer; Always.* The same, quicker, and it is the offering hand's own idea.

### 5.7 Endings

Every way a game can end gets its own picture. All of them run under the result card and stop for any click.

**Tip the king.** *End; resigned by a player; Always; Told.*

| At | What |
|---|---|
| 0.00 | The losing side's hand on its king's side goes to the king and hangs over it. Three threads run from its fingertips, as in thought |
| 0.35 | The threads go out, one at a time, 90 ms apart |
| 0.65 | The index comes down on the crown and rests there |
| 0.90 | It pushes. The king goes over toward the enemy, about the rim of its foot, and comes down on its side |
| 1.25 | It rocks, three times, each smaller, and is still. Stone on stone, low, three knocks falling away |
| 1.40 | That side's stones have turned their heads to look. Their lights go out, from the king outward, as they do now |
| 1.60 | The hand draws back, goes limp and fades, as it does now. The winner's hands dip their fingers once: acknowledged |

The king falls toward the opponent if that square is free; otherwise toward the nearest free one; and if it is hemmed in on every side it only leans against its neighbour, which glances at it before it goes dark.

`RESIGN_PAUSE` goes from 1.1 to 1.8 seconds so the card comes up as the king stops rocking.

**Time.** *End; the server's `ended: 'time'`; Always; Told.* No king is tipped. The mover's hand stops where it is: over a stone, if it was over one, fingers still reaching. It holds for 600 ms, entirely still, with only the weight swinging. Then it drops like something whose string was cut and comes apart from there.

**Gone.** *End; `ended: 'left'` or `'noshow'`; Always; Told.* The absent player's hands unravel from the fingertips back, wherever they were, in the middle of whatever they were doing. The player who is left has the room to themselves. After two seconds their right hand lifts and gives a small, slow wave at the place the others were.

**Mate, by what gave it.** *End; Told.* The claim that exists now is the fallback. More specific rows, each Always because each is rare:

- *The back rank.* The winner's hand, before it rises, sweeps flat along the rank above the stones that shut their king in.
- *Smothered.* A knight's mate on a king with no empty square beside it. The king's own stones turn their heads away from it. The winner's hand pats the knight.
- *By a pawn.* The pawn is lifted a hair and set down again: a small hop.
- *By castling.* Both of the winner's hands turn palm up and dip. A bow.
- *Early* (before White's eighth move). The winner's hand does not rise at all. It brushes its thumb across its fingertips twice: that is that. The mated king turns its head and looks back at its own player's hands.
- *Laid down.* One mate in five of the plain kind: the winner's hand, last of all, comes back and lays the mated king gently on its side. Respect, not triumph.

**Stalemate: the scuffle.** *End; Always; Told.* As shaped earlier. Which side starts it is read from the board: if the side that gave stalemate was five points or more ahead, it is furious and the other is smug; if not, both are merely aggrieved.

| At | What |
|---|---|
| 0.00 | Both right hands leave their corners for the middle of the board, 3.4 up |
| 0.45 | They stop a hand's length apart, facing, fingers a little spread. Nobody moves for 350 ms. Every stone on the board has turned to look |
| 0.80 | The smug one wiggles its fingers: goodbye. (Even material: one flicks the other's fingertips, `cocked`.) A single glass tick |
| 1.05 | The other draws back a sixth of a square, and swats. Flat hand, from the wrist only |
| 1.30 to 2.50 | Seven to nine swats, by turns, 150 ms apart at first and 110 at the end. Small, fast, sideways, fingers loose, wrists doing all of it: two children who have been told not to hit. The plumb weights go everywhere. Motes come off as in fast flight. It sounds like a wind chime, since they are glass |
| 2.50 | Both stop dead, mid-swat. 500 ms. The stones are all still looking. One pawn shifts where it stands |
| 3.00 | They withdraw, slowly, with dignity. One straightens its cord on the way |
| 3.80 | At rest, each turned a little away from the other. They stay that way until the next game |

Throughout, both left hands stay exactly where they are. One time in four they do not, and it is four hands for the last half second.

Three versions, by the seeded draw, never the same twice running: this one; one where the second swat misses, and the miss is what starts it; and one where they stop early because a plumb weight has wound itself round the other's wrist, and has to be unwound, carefully, before anyone can leave.

**Repetition: rock, paper, scissors.** *End; threefold or fivefold; Always; Told.* The same position three times. Both right hands go to the middle. Three pumps, and they throw: rock and rock. Three pumps: paper and paper. Three pumps: scissors and scissors. The same thing, three times. They hold it, then both turn palm up and go home.

Fivefold: five rounds, each quicker than the last, the last two a blur.

**Fifty moves: asleep.** *End; fifty-move or seventy-five-move; Always; Told (`DrawNear` already counts the plies).* This one starts before the end. From forty moves without a capture or a pawn moved, the corner candles burn a little lower with each move and the hands rest lower with them. At the draw all four hands are lying on the rails, fingers slack, and the stones' eyes are nearly shut. One hand twitches. Then it starts awake, turns one way and the other, and pinches out its candle, which has burned down. A thread of smoke.

The candles are tall again at the next game.

**Too little left.** *End; insufficient; Always; Told.* Each side's hand turns over and shakes itself out, three times, as one shakes an empty purse. A single mote falls from each. The two kings turn their heads and look at one another.

**Agreed: the handshake.** *End; agreement; Always; Told.* The offered hand is already open (5.6). The other side's right hand goes to the middle of the board; the offered one comes to meet it. They clasp, thumbs over. One pump, down and up, in half a second, and the glass tones that ring from the two kings now are struck on the pump. They let go and withdraw.

If an offer was refused earlier in the same game, the pump is very short, and both hands let go first.

If a player clicks away before the hands meet, the one that had further to come stops, hangs there offered, closes, and goes home. Left hanging.

### 5.8 Found on the board

Patterns in the record that both players can see, each with its own row. These are the ones people will post about.

**The Bongcloud.** *After; Always; Told.* The king moved to its second rank on its side's second move. The hand sets him down and pats him. Across the board, both of the other side's hands turn slowly palm up.

If the other side then does the same: all four hands lift, and each player's right gives a thumb, up. Once a sitting, if that.

**The copycat.** *After; Once; Told.* Void has mirrored Ivory's first four moves. Ivory's right hand gives a small wave from side to side, as one tests a mirror. Void's right gives exactly the same wave, 300 ms late.

**Home again.** *After; Sometimes; Told.* A knight set down on the square it started the game on, having left it. The hand lets go and gives a small flick of the fingers: never mind.

**A third queen.** *After; Always; Told.* A side that has two queens makes another. After the snap, the other side's hands go limp for a second, though nothing is over.

### 5.9 Set off by the player

**The wave.** *Think; Told; this screen only.* The pointer shaken over one's own resting hand (three reversals in under a second). The hand waves back with its fingers only. Not again for twenty seconds.

**The weight, pulled.** *Think; this screen only.* A click on a plumb weight sets it swinging. The hand looks at it. See *The weight*, above.

**Back.** *Wait; this screen only.* The page left for more than a minute and come back to, with the game still on. The player's own hands start awake, as from the bottom rung of the ladder, and smooth themselves.

None of these is sent to the other player, and none can touch the other player's hands.

## 6. Props, and why they matter

The best of the list is not gesture but contact: a hand on the rail, on the candle, on a captive, on its own cord, on the other player's hand. The hands have, until now, touched only pieces. Three small pieces of work open all of it:

- **The rail.** A place on the case's edge where a hand can rest with its fingertips down. It gives the drumming something to sound on and the sleeper somewhere to lie.
- **The other hand.** A hand's palm as a target that moves. It gives the steeple, the lace, the knuckles, the handshake, the scuffle and rock paper scissors.
- **The toppled stone.** It gives the tipped king and the king laid down.

## 7. What is deliberately left out

- Words, voices, captions, achievements, or anything in the interface that says a manner happened.
- Anything set off by the engine's opinion in a plain game. The flourish, the sag and the perk stay as they are: out of ranked.
- The winner mocking the loser.
- Anything seasonal.
- Anything during the opening of the case, which is its own set piece.
- A manner for every move. Most moves should have none.

## 8. Order of building

Each step is seen and judged before the next.

1. **The table**, the two kinds of fact, the seeded draw, the budget, and the tests. Nothing is seen to change: the gestures there now become its first rows.
2. **The three props** (section 6), each proved with one manner: drumming on the rail, the steeple, the tipped king.
3. **The endings**: tip the king, time, gone, the handshake with offered and refused, the scuffle, rock paper scissors, asleep, too little left.
4. **Setting down**: the empty square, the snap, really?, the trophy, the pat, the push, squaring up, and check wearing off.
5. **Waiting and thinking**: the ladder, knuckles, the candle, captives, second thought, j'adoube, the feint.
6. **Found on the board**, the mates by kind, and what the player sets off.

**Built, 14 November: steps 1 and 2.** The table (`src/hands/manners.ts`, `tests/manners.test.ts`); fingers set down on wood, hands set down on each other, and a stone laid over (`src/hands/topple.ts`), proved by the drumming on the rail, the steeple and the tipped king (`tests/manners-hands.test.ts`). Still as they were, and not yet rows of the table: the gestures the hands had before (the point at a check, the start back, the closed fist), which go on being asked for by the director directly. Not yet made: the sounds of their own (the rail is heard with the sound of a stone touched, the steeple with glass), the stones' glance at the drumming, the threads going out one by one before the king is tipped, and the winner's dip of the hand to it.

**Built, 14 November: step 3, the endings.** Seven new rows of the table (`out-of-time`, `gone`, `scuffle`, `rock-paper-scissors`, `asleep`, `empty-purse`, `handshake`), every one Always, chosen by `Stage.over` from how the game ended (the director now tells it the result, the reason for a draw, and whether a server ended it). The scenes are in `src/hands/endings.ts`. Each borrows arms through `Puppeteer.act`, works in each player's own terms so that one script played by both players mirrors across the board, starts only once no stone is still being set down, and stops for a take-back or a new game. A hand can now turn from the wrist alone (`Arm.aim`). There are two new moods, `sulking` (after the scuffle) and `gone`, whose hands are unmade from the fingertips back. The draw offer is shown: the offering hand is turned palm up at its corner while the offer stands, and when it is refused or taken back the fingers close, little finger first (`Puppeteer.offer`, `answer`; `world.setOffer`, called from the app for the computer, the shared table and online). On an agreed draw the kings now ring on the handshake's pump and not before it. The swats sound as glass, a different note each time. Tests: `tests/endings.test.ts` checks that no hand touches a stone, that fingers keep above the crowns over the middle of the board, that both screens play the same thing, that four hands are on the rails at once, that the palms meet in the middle, that a refused offer makes the handshake's pump short, and that everything stops for a take-back.

Not built, or built smaller than written above:
- **Time.** The hands freeze and drop, but the weight is not seen to swing on its own while they hold still.
- **Scuffle.** There are two versions, the plain one and the second swat missing. The weight wound round a wrist and the four-hands variant are left out. The stones do not turn to look, and no pawn shifts.
- **Asleep.** There are no candles burning down and no candle pinched out. The sleep does not begin before the fiftieth move, and the stones' eyes do not close.
- **Too little left.** No mote falls, and the kings do not look at each other.
- **Handshake.** "Left hanging" is not built. A click before the hands meet sends both home.
- **Sounds.** These still borrow glass from the bank.
- **Frames.** Every ending has been filmed headless, from the Shoulder and Eyes cameras and from above (`tmp/hands/endings-frames.mjs`). That is how their placing was settled. Hands meeting over the middle hang lower than first written, so they are in the picture from behind either player: 2.95 for flat hands, 3.45 for hands held on edge, kept above the crowns. The wave and the empty purse are done with the left hand, since the Shoulder camera hangs over the player's right. How the motion reads, and whether it is funny, has not been judged: that needs the running game.
- **First touch.** A page's first click or key no longer stands the game again if it is over (`App.wakeSound`), so it does not cut short the ending being played.

**Built, 15 November: step 4, setting down.** Eleven new rows of the table: `empty-square`, `snap`, `trophy`, `pat`, `push` and `squaring-up` are chosen at the set, `really` and the three steps of `check-again`, `check-thrice` and `check-on` after it. The table is now told the move itself, the stone taken the move before, how many checks in a row the side has given, and whether the game is a lesson; a take-back lets a ritual be played again at the ply it was taken back to. What happens inside the move (`Stage.playMove`, `Puppeteer.carry` with its new `rap`, `show`, `pat` and `askew`, and `push`, `squareUp`, `snap`) is played with it; really? and the checks are gestures after it, and a click sends them home. Squaring up leaves the stone exactly where it should be on any interruption. Tests: `tests/setting-down.test.ts` plays each one on the real hand and stones, and checks the order of the empty square (the tap, then the set, then the pawn taken away), that the pawn changes on the snap and not before, that really? turns both hands for a bishop and keeps above the crowns, that the trophy is held still and lit and the second queen is not, the taps of the pat, that a pushed pawn's foot never leaves the board and the finger is behind it, that a stone squared up is off by a twelfth and turned, then exact, and never in a lesson, and the check ladder from the pointing to the drumming, set back by a quiet move or a take-back.

Not built, or built smaller than written above:
- **The empty square.** The tap is heard with the sound of a stone set down, softer. The other hand waits for the pawn to be set before it reaches.
- **The snap.** It is heard as glass. The promotion's own light still comes at the set, before the snap.
- **The push.** It is not heard as a drag; there is no drag sound yet.
- **The pat.** The king's eye closes on each tap. The rook's hand stays a little longer on the board while the king's hand pats.
- **Really?** On the player's own turn the turned hands may come over the far corner, above the crowns.
- **The trophy.** The held queen is lit by the hand, not by her own glow. The brisk second queen is the plain carry, not a quicker one.
- **It wears off.** The second check's point comes from nearer home but is the same point, once. The drumming is the drumming of step 2.
- **Frames.** Each was filmed headless from the Shoulder and Eyes cameras and from above (`tmp/hands3/setdown.mjs`). From the far cameras the snap, the pat, the trophy and squaring up read as outlines; the push and the twitch of one finger are small and read only from the Shoulder. Whether the timing is funny has not been judged: that needs the running game.

**Changed, 15 November: the next player is never kept waiting.** A move is done with, and the next may be played, once its stones are on their squares and what it took is off the board, as for a move set down plainly. A manner never makes the other player wait on it, and on their screen their clock may be running. So each manner is one of three kinds:
- **After the stone is down, it goes on as the game does.** Squaring up, the pat and the snap are played after the move is done with, and so is the taken stone's way to the drawer, with the trophy held up on the way. The next player's turning to a stone, their move, or a take-back cuts them short at once: the stone squared up stands exactly on its square, the king is patted no more, the pawn changes at once and nothing is heard, and the hand goes home (`Stage.tails`, `Puppeteer.letBe`). Against the computer, which has no clock to save, the computer lets them finish before it reaches for its stone. They cost the next player nothing: squaring up costs the twelfth of a second it takes to set a stone down a little off, the others nothing at all.
- **Before the stone is down, and not against a clock.** The empty square's rap, and the taken pawn lifted only after it, and the push, which is slower to the square than a carry, would make the next player wait (by half a second, and by nine tenths, at the hands' own pace). In a game against a clock (a ranked game, or a friendly one with a clock) neither is chosen: the pawn is taken in passing, and stepped, as any other move. Whether a game is against a clock is the same on every screen at the board, and so is what is chosen. Without a clock, they are played as before, and that wait is the game's.
- **After it, as it was.** Really? and the checks were already gestures after the move.

And what is part of a move is chosen alike on every screen. It goes by the room's seed, the ply and the game's own moves, and by nothing a screen has to itself: the budget is counted from the manners the game's moves were set down with, which a screen that comes to the game late counts again from its moves (`Stage.seatTaken`); a `seldom` row's chance is not made less by its having been seen before in the sitting; and a player who has asked for less motion is shown only the rituals, while their screen counts what it does not show them as spent, as the other screen does. Only what goes by each screen's own time (sitting down, waiting and thinking: the drumming and the steeple) goes by what that screen has seen and timed, and those may differ between screens as the time each keeps does; they spend only what the moves have left of the budget. Tests: `tests/setting-down.test.ts` ("the next player is not kept waiting"), `tests/manners-screens.test.ts` (a screen come to the game late, after a game of its own, sets the stones down as the one that saw it all), and the table's own in `tests/manners.test.ts`.

## 9. How it is judged

- **By the table's tests:** the most specific row wins; nothing repeats; the budget holds; 300 random plain games never consult a `Judged` row; the same room and ply give the same manner on two clients.
- **By frames, without the screen:** each manner filmed by script from the five cameras and both seats, as the hands were, and read on a sheet: does it read as an outline from the far camera, does anything pass below 3.4, is the board covered on the wrong turn.
- **By interruption:** each manner cut short by a click at five points in its length. The stone must be on its square and the hand on its way within 0.3 seconds, every time.
- **By the author**, in the running game.
- **By someone who has not seen it.** Valve's own finding is that testers seldom laugh aloud, so the test is not whether they laugh but whether, afterwards, they mention it.

## 10. Decided, 14 November

1. **The winner's hands** may gloat a little, at my judgement: rule 7.
2. **The ladder of impatience in ranked** stops at drumming on the rail, as written.
3. **No switch.** The manners are simply part of the game.
4. **Nothing spammy.** These are things met now and then, not every game: the rarities and the budget in section 3 were tightened for it, and tightened again when the first three were built (two in a game at most; the steeple and the drumming on the rail are Seldom, not Often: a game with three or four long thinks has one of them about one time in seven, a slow game with ten about two in five, and a player who has seen one is unlikely to see it again that sitting).
5. **The feint** is still the first to cut if it reads as a stutter.
