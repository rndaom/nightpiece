/**
 * The beginning and the end of a game: the two players coming to the board, as a queue's match
 * shows them; the end said large over the scene (the verdict), whoever the game was against; and
 * the words for how a game ended that the verdict and the result card (Cards.tsx) are made of.
 * All are made of the interface's usual parts: the seal from the title screen, the seats of the
 * match bar, a plate, the call over the board, a card.
 */
import { batch, effect, signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { App } from '../app/app';
import { type Intro as Coming, type Outcome, outcome, ui } from '../app/store';
import { opposite, type Side } from '../core/game';
import { Seal, Stone } from './glyphs';
import { SIDE } from './words';

/** Whether the player has asked their system for less movement on screen. */
function stillness(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A clock as a player names it: minutes each, plus seconds back a move ("10 + 5"). */
export function controlText(clock: { base: number; increment: number }): string {
  return `${Math.round(clock.base / 60000)} + ${Math.round(clock.increment / 1000)}`;
}

/** The same in words, for a screen reader: "10 minutes each and 5 seconds back a move". */
export function controlWords(clock: { base: number; increment: number }): string {
  const minutes = Math.round(clock.base / 60000);
  const back = Math.round(clock.increment / 1000);
  return `${minutes} minutes each${back > 0 ? ` and ${back} seconds back a move` : ''}`;
}

/** The terms of the game, as its plate says them: "Ranked · 10 + 5", "Friendly · 5 + 3", or "Friendly". */
export function termsOf(intro: Pick<Coming, 'ranked' | 'clock'>): string {
  const kind = intro.ranked ? 'Ranked' : 'Friendly';
  return intro.clock ? `${kind} · ${controlText(intro.clock)}` : kind;
}

/**
 * The players come to the board. The seal from the title screen turns over to show the side
 * this player has (a coin with their king on it), the two of them stand either side of it with
 * the terms of the game between, the side is called out, and their plates go up into the match
 * bar, where they stay. It goes at a click or a key as well, and never stops a move being made.
 */
export function Intro({ app }: { app: App }) {
  const intro = ui.intro.value;
  const id = intro?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    // Anything the player does puts it away, and still does what it was meant to.
    const skip = () => app.skipIntro();
    window.addEventListener('pointerdown', skip, true);
    window.addEventListener('keydown', skip, true);
    return () => {
      window.removeEventListener('pointerdown', skip, true);
      window.removeEventListener('keydown', skip, true);
    };
  }, [id]);
  if (!intro) return null;
  return <Arrival key={intro.id} intro={intro} />;
}

function Arrival({ intro }: { intro: Coming }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Where each plate goes when it settles: onto its own side's seat in the match bar. Measured
    // where it stands, not where its way in has it at this instant.
    for (const side of ['w', 'b'] as const) {
      const plate = root.current?.querySelector<HTMLElement>(`.intro-seat-${side}`);
      const seat = document.querySelector<HTMLElement>(`.match .seat-${side}`);
      if (!plate || !seat) continue;
      plate.style.animation = 'none';
      const from = plate.getBoundingClientRect();
      const to = seat.getBoundingClientRect();
      plate.style.animation = '';
      plate.style.setProperty('--dx', `${(to.left + to.width / 2 - (from.left + from.width / 2)).toFixed(1)}px`);
      plate.style.setProperty('--dy', `${(to.top + to.height / 2 - (from.top + from.height / 2)).toFixed(1)}px`);
      plate.style.setProperty('--k', Math.min(1, to.width / from.width).toFixed(3));
    }
  }, []);
  const { you } = intro;
  // Who sits where as the room now says, should a name have been given a moment after the second player sat down.
  const players = ui.online.value?.players ?? intro.players;
  const terms = termsOf(intro);
  const said = (side: Side) => {
    const p = players[side];
    return `${SIDE[side]}: ${p ? `${p.name}${intro.ranked && p.rating ? `, rated ${p.rating}` : ''}` : 'a player'}${side === you ? ' (you)' : ''}.`;
  };
  return (
    <div class="veil intro" ref={root} role="status" aria-live="polite">
      <p class="unseen">
        {`A ${intro.ranked ? 'ranked' : 'friendly'} game${intro.clock ? `, ${controlWords(intro.clock)}` : ''}.`}{' '}
        {said('w')} {said('b')} {you ? `You play ${SIDE[you]}.` : ''}
      </p>
      <div class="intro-stage" aria-hidden="true">
        <Plate side="w" intro={intro} player={players.w} />
        <span class="intro-seal">
          <Seal back={you ?? 'either'} />
        </span>
        <Plate side="b" intro={intro} player={players.b} />
        <span class="intro-terms">
          <b class="plate plate-gilt">{terms}</b>
        </span>
        {you ? (
          <p class={`call intro-call call-${you}`}>
            <span>You play {SIDE[you]}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One player, on a seat like those in the match bar: their side's coin, their name, their rating, and "You" under this player's own. */
function Plate({ side, intro, player: p }: { side: Side; intro: Coming; player: Coming['players'][Side] }) {
  // A friendly game counts towards nobody's rating, so it is lighter: names alone.
  const rating = intro.ranked && p?.rating ? p.rating : null;
  return (
    <div class={`seat seat-${side} intro-seat intro-seat-${side}`}>
      <span class={`coin coin-${side}`}>
        <Stone kind="k" />
      </span>
      <span class="intro-who">
        {p ? <small>{SIDE[side]}</small> : null}
        <b>{p?.name ?? SIDE[side]}</b>
        {rating || side === intro.you ? (
          <span class="intro-line">
            {rating ? <em>{rating}</em> : null}
            {side === intro.you ? <i class="plate plate-small">You</i> : null}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// -- the end ------------------------------------------------------------------

/** What the result card leads with: who won, as this screen sees it. */
export function headlineOf(o: Outcome, you: Side | null): string {
  if (!o.winner) return 'Draw';
  if (you) return o.winner === you ? 'You win' : 'You lose';
  return `${SIDE[o.winner]} wins`;
}

/** How long a game lasted, as it would be said: "48 s", "4 min 12 s", "1 h 3 min". */
export function lengthOf(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How it ended and when, under the headline: "Void resigned · move 23 · 4 min 12 s". */
export function howOf(o: Outcome, you: Side | null): string {
  const loser = o.winner ? opposite(o.winner) : null;
  const who = loser === you ? 'You' : loser ? SIDE[loser] : '';
  // A draw on time: the side whose flag fell, and the side that could not have mated it.
  const flagged = o.flagged;
  const fell = flagged === null ? '' : flagged === you ? 'you' : SIDE[flagged];
  const could = flagged === null ? '' : opposite(flagged) === you ? 'you' : SIDE[opposite(flagged)];
  const how = {
    checkmate: 'Checkmate',
    resigned: `${who} resigned`,
    time: o.winner ? `${who} ran out of time` : `Draw: ${fell} ran out of time, but ${could} could not have mated`,
    left: `${who} left the game`,
    stalemate: 'Stalemate',
    agreement: 'Drawn by agreement',
    repetition: 'Draw by repetition (claimed)',
    fifty: 'Draw by the fifty-move rule (claimed)',
    fivefold: 'Draw: the position came up five times',
    'seventy-five': 'Draw: seventy-five moves without a capture or a pawn move',
    material: 'Not enough left to checkmate',
    noshow: 'Called off, unrated',
  }[o.cause];
  return [how, o.move === null ? null : `move ${o.move}`, o.duration === null ? null : lengthOf(o.duration)].filter(Boolean).join(' · ');
}

/** The end as the verdict says it: one word, why, and when. */
export interface Said {
  /** "Victory" or "Defeat" to a player, "Ivory wins" to a table or a watcher, or "Draw". */
  word: string;
  /** What colours it: this player won, lost or drew; or, said to nobody in particular, which side won. */
  tone: 'won' | 'lost' | 'drew' | Side;
  /** How it ended, short enough for a plate: "Checkmate", "Void resigned", "Stalemate". */
  reason: string;
  /** Under that: the move and how long it took, and, for a draw on time, why it was not lost. */
  note: string;
}

/** The end of a game, said large over the scene: who won as this screen sees it, and how. */
export function verdictOf(o: Outcome, you: Side | null): Said {
  const loser = o.winner ? opposite(o.winner) : null;
  const who = loser === you ? 'You' : loser ? SIDE[loser] : '';
  const word = o.cause === 'noshow' ? 'Called off' : !o.winner ? 'Draw' : you ? (o.winner === you ? 'Victory' : 'Defeat') : `${SIDE[o.winner]} wins`;
  const tone = !o.winner ? 'drew' : you ? (o.winner === you ? 'won' : 'lost') : o.winner;
  const reason = {
    checkmate: 'Checkmate',
    resigned: `${who} resigned`,
    time: o.winner ? `${who} ran out of time` : 'Out of time',
    left: `${who} left the game`,
    stalemate: 'Stalemate',
    agreement: 'Agreed',
    repetition: 'Threefold repetition',
    fifty: 'Fifty-move rule',
    fivefold: 'Fivefold repetition',
    'seventy-five': 'Seventy-five-move rule',
    material: 'Not enough to mate',
    noshow: 'Unrated',
  }[o.cause];
  // A draw on time: the side whose flag fell, and the side that could not have mated it.
  const flagged = o.cause === 'time' && !o.winner ? o.flagged : null;
  const spared = flagged === null ? null : `${flagged === you ? 'You' : SIDE[flagged]} ran out of time, but ${opposite(flagged) === you ? 'you' : SIDE[opposite(flagged)]} could not have mated`;
  const when = [o.move === null ? null : `Move ${o.move}`, o.duration === null ? null : lengthOf(o.duration)].filter(Boolean).join(' · ');
  return { word, tone, reason, note: [spared, when].filter(Boolean).join(' · ') };
}

/**
 * The verdict being said, if one is: which (so that a second ending is a new one), and whether it
 * has begun to go into the result card. The card waits until it has (see Result in Cards.tsx).
 */
export const verdict = signal<{ id: number; going: boolean } | null>(null);
/** The result card on screen came in from a verdict, which brought its seal to it already turned. */
export const handed = signal(false);

/** How long the verdict is said for before it goes into the card, and how long that takes, in seconds. */
export const VERDICT_HOLDS = 3;
export const VERDICT_GOES = 0.65;

/*
 * A verdict is said once for each ending this page sees happen: as the result card would first
 * come up for it. Not for a game that was already over when it was opened, nor again when the
 * card comes back after the board was looked at, the game reviewed, or the card put away. A move
 * taken back, or a game given up taken up again, and then ended once more, is a new ending.
 */
let armed = false;
let wasOver = false;
let said = 0;
effect(() => {
  const over = ui.status.value.over;
  const showing = over && ui.resultVisible.value && ui.mode.value.kind !== 'lessons';
  // An ending happening, not a page loading on one: the room is up before a game is played to its end.
  if (over && !wasOver && ui.ready.peek()) armed = true;
  if (!over) armed = false;
  wasOver = over;
  if (!showing) {
    batch(() => {
      verdict.value = null;
      handed.value = false;
    });
    return;
  }
  if (armed) {
    armed = false;
    verdict.value = { id: ++said, going: false };
  }
});

/** Begin putting the verdict into the result card, if it is still being said. */
export function settle(id: number): void {
  const v = verdict.peek();
  if (v?.id !== id || v.going) return;
  batch(() => {
    verdict.value = { id, going: true };
    handed.value = true;
  });
}

/**
 * The end of the game, said over the middle of the scene for three seconds: the seal turns to the
 * winner's coin (to half of each for a draw), the word is struck under it between two fine rules,
 * and how it ended is slapped down on a plate. Then the word and the seal go up into the result
 * card, which comes in under them as they arrive. It never stops play or a click: everything goes
 * through it, and a click or a key sends it into the card at once.
 */
export function Verdict() {
  const v = verdict.value;
  const end = outcome.value;
  if (!v || !end) return null;
  return <Proclaimed key={v.id} id={v.id} going={v.going} said={verdictOf(end, ui.you.value)} winner={end.winner} />;
}

function Proclaimed({ id, going, said: s, winner }: { id: number; going: boolean; said: Said; winner: Side | null }) {
  const root = useRef<HTMLDivElement>(null);
  // Set once the way to the card is measured, so that the verdict never sets off for nowhere.
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => settle(id), VERDICT_HOLDS * 1000);
    // Anything the player does puts it into the card, and still does what it was meant to.
    const skip = () => settle(id);
    window.addEventListener('pointerdown', skip, true);
    window.addEventListener('keydown', skip, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', skip, true);
      window.removeEventListener('keydown', skip, true);
    };
  }, [id]);
  useEffect(() => {
    if (!going) return;
    // After the card has been drawn: where the word and the seal land on it.
    const stage = root.current;
    const card = document.querySelector<HTMLElement>('.result');
    if (stage && card && !stillness()) {
      // Measured where the card will stand, not where its way in has it at this instant.
      card.style.animation = 'none';
      aim(stage.querySelector('.verdict-word'), card.querySelector('#result-title'), true);
      aim(stage.querySelector('.verdict-seal'), card.querySelector('.result-head .seal-coin'), false);
      card.style.animation = '';
    }
    setFlying(true);
    const timer = setTimeout(() => {
      if (verdict.peek()?.id === id) verdict.value = null;
    }, VERDICT_GOES * 1000);
    return () => clearTimeout(timer);
  }, [going]);
  const long = [...s.word].length;
  return (
    <div ref={root} class={`verdict verdict-${s.tone} ${flying ? 'verdict-going' : ''}`} aria-hidden="true" style={{ '--letters': long }}>
      <div class="verdict-stage">
        <span class="verdict-seal">
          <Seal back={winner ?? 'either'} />
        </span>
        <p class="verdict-line">
          <i class="verdict-rule" />
          <b class="verdict-word">{s.word}</b>
          <i class="verdict-rule" />
        </p>
        <p class="call verdict-reason">
          <span>{s.reason}</span>
        </p>
        {s.note ? <p class="verdict-note">{s.note}</p> : null}
      </div>
    </div>
  );
}

/**
 * Set the way from a part of the verdict to where it lands on the card: across, down, and how much
 * smaller. A word lands on the words of the headline, measured round its letters, not its line.
 */
function aim(from: Element | null, to: Element | null, text: boolean): void {
  if (!(from instanceof HTMLElement) || !to) return;
  let there = to.getBoundingClientRect();
  if (text) {
    const letters = document.createRange();
    letters.selectNodeContents(to);
    there = letters.getBoundingClientRect();
  }
  const here = from.getBoundingClientRect();
  if (here.width === 0 || there.width === 0) return;
  // A word by the size of its letters (the two words are not the same), a seal by its width.
  const k = text ? parseFloat(getComputedStyle(to).fontSize) / parseFloat(getComputedStyle(from).fontSize) : there.width / here.width;
  from.style.setProperty('--dx', `${(there.left + there.width / 2 - (here.left + here.width / 2)).toFixed(1)}px`);
  from.style.setProperty('--dy', `${(there.top + there.height / 2 - (here.top + here.height / 2)).toFixed(1)}px`);
  from.style.setProperty('--k', (Number.isFinite(k) && k > 0 ? Math.min(1, k) : 0.2).toFixed(3));
}

/**
 * What a ranked game did to this player's rating: the figure before, the figure after counting
 * up to it, and the difference on a chip, in the spirit's colour for a gain and ember for a loss.
 */
export function RatingRow({ before, after }: { before: number; after: number }) {
  const [shown, setShown] = useState(() => (stillness() ? after : before));
  useEffect(() => {
    if (stillness() || before === after) {
      setShown(after);
      return;
    }
    let frame = 0;
    // A moment for the card to come in first, then six tenths of a second, slowing as it arrives.
    const began = performance.now() + 250;
    const step = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - began) / 600));
      setShown(Math.round(before + (after - before) * (1 - (1 - k) ** 3)));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [before, after]);
  const delta = after - before;
  const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'even';
  return (
    <p class={`rating rating-${tone}`} aria-label={`Your rating: ${before} before, ${after} now.`}>
      <span class="rating-word" aria-hidden="true">
        Rating
      </span>
      <span class="rating-figures" aria-hidden="true">
        {before}
        <i>→</i>
        <b>{shown}</b>
      </span>
      <em class="rating-chip" aria-hidden="true">
        {delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0'}
      </em>
    </p>
  );
}
