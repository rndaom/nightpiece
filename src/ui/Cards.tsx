/**
 * The cards of text that stand beside the board (a lesson, a rule explained,
 * the online room, how the game ended) and the two questions that stop play
 * (what a pawn becomes, and whether a blunder was meant).
 */
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { App } from '../app/app';
import { assisted, outcome, ui } from '../app/store';
import { opposite, type PromotionKind, type Side } from '../core/game';
import { type Clock, FRIENDLY_CONTROLS, type Seat, sameControl, type TimeControl } from '../net/protocol';
import { describeClaim, describeStatus, EXPLAIN } from '../learn/explain';
import { costliest } from '../learn/story';
import { copyText } from './clipboard';
import { Icon, Seal, Stone } from './glyphs';
import { Graph } from './Graph';
import { controlText, controlWords, handed, headlineOf, howOf, RatingRow, verdict } from './Match';
import { arrows, stop } from './roving';
import { KIND, numbered, SIDE, VERDICT_WORD } from './words';

/**
 * The screens on which the lesson card is docked at the foot, over the keys, and the board is
 * framed above it (see `World.keepClearBetween`): narrower than the board's side columns can be
 * given (see hud.css and `World.clearance`, which say the same). A phone on its side has columns.
 */
const DOCKED = '(max-width: 899px) and (min-height: 501px)';
/**
 * The screens on which the end of the game is docked at the foot and the board framed above it:
 * a tablet's width, which would otherwise leave it over the board's edge. On a phone the card
 * stands over the foot of the board by design (the board is looked at again with "View board"),
 * and a rule being explained is framed for on every docked screen, like a lesson.
 */
const TABLET = '(min-width: 761px) and (max-width: 899px) and (min-height: 501px)';

/**
 * Tell the camera how much of the foot of the picture the card of text takes (a lesson, a rule
 * explained, how the game ended), so that the board is framed above it and no square is hidden.
 * Measured, not guessed: the card is as tall as its words, and a lesson folded away is much less.
 * `shown` is whether the card is standing, `state` anything that changes how tall it is, and
 * `screens` the media query for the screens it is docked on.
 */
function useFraming(app: App, shown: boolean, state: unknown, card: { current: HTMLElement | null }, screens = DOCKED): void {
  const seen = cardSeen(shown);
  useEffect(() => {
    const rail = seen ? card.current?.closest('.rail-left') : null;
    if (!rail || typeof matchMedia !== 'function') return;
    const docked = matchMedia(screens);
    const tell = () => {
      // The head is cleared as far down as the keys in the corner reach.
      const corner = document.querySelector('.rail-right .corner')?.getBoundingClientRect().bottom ?? 0;
      if (docked.matches) app.world.keepClearBetween(corner > 0 ? corner + 6 : 0, Math.max(0, window.innerHeight - rail.getBoundingClientRect().top));
      else app.world.keepClearBetween(0, 0);
    };
    tell();
    docked.addEventListener('change', tell);
    window.addEventListener('resize', tell);
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(tell) : null;
    watch?.observe(rail);
    return () => {
      docked.removeEventListener('change', tell);
      window.removeEventListener('resize', tell);
      watch?.disconnect();
      app.world.keepClearBetween(0, 0);
    };
  }, [app, seen, state]);
}

/**
 * Whether a card that is standing can be seen: not while the interface is put away to look at the
 * board alone, nor while the choice of game is up (both leave it in place, unseen; see hud.css).
 * Only a card that is seen keeps the board framed above it.
 */
export function cardSeen(shown: boolean): boolean {
  return shown && !ui.bare.value && !ui.menuOpen.value;
}

/** The lesson being taught: what it says, what it thought of the last try, and the way on. */
export function Lesson({ app }: { app: App }) {
  const l = ui.lesson.value;
  // On a narrow screen the card can be folded to the step's instruction, and the board has the room.
  const [folded, setFolded] = useState(false);
  const card = useRef<HTMLElement>(null);
  useFraming(app, l !== null, folded, card);
  if (!l) return null;
  const finished = l.state === 'finished';
  const waiting = l.state === 'task' || l.state === 'wrong';
  const fold = folded && !finished;
  return (
    <section class={`card lesson ${fold ? 'lesson-folded' : ''}`} aria-label="Lesson" ref={card}>
      <header class="card-head">
        <h2 class="plate plate-small">{finished ? 'The lessons' : `Lesson ${l.lesson} of ${l.lessons}`}</h2>
        {finished ? null : (
          <span class="steps" role="img" aria-label={`Step ${l.number} of ${l.of}`}>
            <i style={{ width: `${(l.number / l.of) * 100}%` }} />
          </span>
        )}
      </header>
      <h3>{l.title}</h3>
      <p class="lesson-say" id="lesson-say">
        {l.say}
      </p>
      {l.ask ? <p class="lesson-ask">{l.ask}</p> : null}
      {l.line ? (
        <p class={`said ${l.state === 'done' ? 'said-good' : 'said-again'}`} role="status" aria-live="polite">
          {l.line}
        </p>
      ) : null}
      <div class="lesson-foot">
        {finished ? (
          <div class="choices">
            <button type="button" class="btn" onClick={() => app.startComputer('first', 'w')}>
              Play my first game
            </button>
            <button type="button" class="pill" onClick={() => app.startLessons()}>
              Start again
            </button>
          </div>
        ) : (
          <div class="choices">
            {waiting ? (
              <button type="button" class="pill" disabled={l.state === 'wrong'} onClick={() => app.showMe()}>
                Show me
              </button>
            ) : (
              <button type="button" class="btn" onClick={() => app.nextStep()}>
                {l.number === l.of ? 'Finish' : 'Next'}
              </button>
            )}
          </div>
        )}
        <p class="ways-on">
          {l.number > 1 || finished ? (
            <button type="button" class="link" onClick={() => app.previousStep()}>
              Back
            </button>
          ) : null}
          {waiting ? (
            <button type="button" class="link" onClick={() => app.nextStep()}>
              Skip
            </button>
          ) : null}
          <button type="button" class="link" aria-label="Leave the lessons" onClick={() => (ui.menuOpen.value = true)}>
            Leave<span class="lesson-rest"> the lessons</span>
          </button>
        </p>
        {finished || !l.ask ? null : (
          <button type="button" class="link lesson-fold" aria-expanded={!folded} aria-controls="lesson-say" onClick={() => setFolded(!folded)}>
            {folded ? 'More' : 'Less'}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Whether a rule is on screen. Once the game is over its own card has the column. And a rule is
 * about the game as it stands, not a position being looked back at.
 */
function explaining(): boolean {
  return ui.explain.value !== null && ui.viewing.value === null && !(ui.status.value.over && ui.resultVisible.value);
}

/** Whether the card for how the game ended is on screen: while the end is being said over the scene it waits, and comes in as it settles (Verdict in Match.tsx). */
function ended(): boolean {
  const said = verdict.value;
  return ui.status.value.over && outcome.value !== null && ui.resultVisible.value && !(said && !said.going);
}

/**
 * Tells the camera what the rule being explained, or the end of the game, takes of the foot of
 * the picture on a narrow screen (see `useFraming`). It draws nothing; it stands in the column
 * beside the cards, which it measures.
 */
export function Docking({ app }: { app: App }) {
  const mark = useRef<HTMLElement>(null);
  const result = ended();
  useFraming(app, result || explaining(), result ? outcome.value : ui.explain.value, mark, result ? TABLET : DOCKED);
  return <i hidden ref={mark} />;
}

/** A rule explained in plain words, the first time it comes up. */
export function Explain({ app }: { app: App }) {
  const topic = ui.explain.value;
  // Once the game is over its own card has the column. And a rule is about the game as it stands, not a position being looked back at.
  if (!topic || !explaining()) return null;
  const { title, text } = EXPLAIN[topic];
  return (
    <section class="card explain" aria-label="A rule explained">
      <h3>{title}</h3>
      <p>{text}</p>
      <div class="choices">
        <button type="button" class="btn" onClick={() => app.dismissExplain()}>
          Got it
        </button>
      </div>
      <p class="ways-on">
        <button type="button" class="link" onClick={() => app.dismissExplain(true)}>
          Stop explaining the rules
        </button>
      </p>
    </section>
  );
}

/** Asked before a move the engine thinks is a blunder. */
export function Warning({ app }: { app: App }) {
  const w = ui.warning.value;
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (w) keep.current?.focus();
  }, [w]);
  if (!w) return null;
  return (
    <div class="veil">
      <section class="card dialog dialog-warn" role="alertdialog" aria-modal="true" aria-labelledby="warning-title" aria-describedby="warning-text">
        <h2 id="warning-title">Are you sure?</h2>
        <p id="warning-text">{w.text}</p>
        <div class="choices">
          <button ref={keep} type="button" class="btn" onClick={() => app.answerWarning(false)}>
            Take it back
          </button>
          <button type="button" class="pill" onClick={() => app.answerWarning(true)}>
            Play it anyway
          </button>
        </div>
        <p class="ways-on">
          <button
            type="button"
            class="link"
            onClick={() => {
              app.setAid('warn', false);
              app.answerWarning(false);
            }}
          >
            Stop warning me
          </button>
        </p>
      </section>
    </div>
  );
}

/** Asked before the game is given up, or a draw is offered, since either can end it. */
export function Ask({ app }: { app: App }) {
  const asking = ui.asking.value;
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);
  if (!asking) return null;
  const kind = ui.mode.value.kind;
  const turn = ui.status.value.turn;
  const draw = asking !== 'resign';
  const claim = ui.canClaim.value;
  let title: string;
  let text = '';
  let yes: string;
  if (asking === 'claim') {
    // The claim says why it may be made, in the words of the rule.
    title = kind === 'table' ? `Claim a draw for ${SIDE[turn]}` : 'Claim a draw';
    text = claim ? describeClaim(claim) : '';
    yes = 'Claim a draw';
  } else if (!draw) {
    title = kind === 'table' ? `Resign for ${SIDE[turn]}?` : 'Resign?';
    yes = 'Resign';
    if (kind === 'online') text = 'This cannot be undone.';
  } else if (kind === 'table') {
    title = 'Agree a draw?';
    yes = 'Agree a draw';
  } else {
    title = 'Offer a draw?';
    yes = 'Offer a draw';
    if (kind === 'computer') text = 'The computer accepts only if it is not winning.';
  }
  return (
    <div class="veil">
      <section class={`card dialog ${draw ? '' : 'dialog-warn'}`} role="alertdialog" aria-modal="true" aria-labelledby="ask-title" aria-describedby={text ? 'ask-text' : undefined}>
        <h2 id="ask-title">{title}</h2>
        {text ? <p id="ask-text">{text}</p> : null}
        <div class="choices">
          <button ref={keep} type="button" class="btn" onClick={() => app.answerAsk(false)}>
            Keep playing
          </button>
          <button type="button" class="pill" onClick={() => app.answerAsk(true)}>
            {yes}
          </button>
        </div>
        {!draw && (claim || ui.canDraw.value) ? (
          <p class="ways-on">
            <button type="button" class="link" onClick={() => app.askDraw()}>
              {claim ? 'Claim a draw instead' : kind === 'table' ? 'Agree a draw instead' : 'Offer a draw instead'}
            </button>
          </p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Copies the game, written out as other chess programs read it, and says for a moment that it
 * has. A word in the result card; a small square button over the list of moves.
 */
export function CopyMoves({ app, small = false }: { app: App; small?: boolean }) {
  const [said, setSaid] = useState<'copied' | 'failed' | null>(null);
  const copy = async () => {
    setSaid((await copyText(app.record())) ? 'copied' : 'failed');
    setTimeout(() => setSaid(null), 2500);
  };
  const label = said === 'copied' ? 'Copied' : said === 'failed' ? 'Could not copy' : 'Copy moves';
  if (small) {
    return (
      <button type="button" class={`copy-moves ${said === 'copied' ? 'on' : ''}`} aria-label="Copy moves (PGN)" title={label} onClick={() => void copy()}>
        <Icon name={said === 'copied' ? 'check' : 'copy'} />
        <span class="unseen" aria-live="polite">
          {said ? label : ''}
        </span>
      </button>
    );
  }
  return (
    <button type="button" class="link" onClick={() => void copy()}>
      <span aria-live="polite">{label}</span>
    </button>
  );
}

/** The link to an online room, with a button that copies it. */
function ShareLink() {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const link = location.href;
  const copy = async () => {
    if (await copyText(link)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
    // Copied or not, the link is left selected: where there is no clipboard at all, it is ready to copy by hand.
    field.current?.select();
  };
  return (
    <div class="share">
      <input ref={field} type="text" readOnly value={link} aria-label="Link to this game" onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
      <button type="button" class={`pill ${copied ? 'on' : ''}`} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'link'} />
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}

/** Minutes and seconds; tenths too in the last ten seconds. */
function clockText(ms: number): string {
  const left = Math.max(0, ms);
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  const text = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return left < 10000 ? `${text}.${Math.floor((left % 1000) / 100)}` : text;
}

/**
 * What a side's clock shows `now` (performance.now): the time the server last gave, less what
 * has gone since if that clock is running. Before the first move neither runs, though both
 * players are at the board, and both show their whole time.
 */
export function clockShown(clock: (Clock & { at: number }) | null, side: Side, now: number): number | null {
  if (!clock) return null;
  return clock.left[side] - (clock.running === side ? now - clock.at : 0);
}

/** The two players of an online game: their names, their ratings in a ranked one, and their clocks if it has them. */
function Players() {
  const o = ui.online.value;
  // Drawn again a few times a second while a clock is running, so that it is seen to run.
  const [, tick] = useState(0);
  const running = o?.clock?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [running]);
  if (!o || (!o.clock && !o.players.w && !o.players.b)) return null;
  const you = o.seat === 'w' || o.seat === 'b' ? o.seat : null;
  // The opponent above, the player below, as they sit at the board.
  const order: Side[] = you === 'w' ? ['b', 'w'] : ['w', 'b'];
  return (
    <ul class="players">
      {order.map((side) => {
        const p = o.players[side];
        const clock = o.clock;
        const left = clockShown(clock, side, performance.now());
        const delta = o.change?.[side];
        return (
          <li key={side} class={`${clock?.running === side ? 'on' : ''} ${left !== null && left < 30000 ? 'low' : ''} ${side === you ? 'you' : ''}`}>
            <span class={`coin coin-${side}`} aria-hidden="true">
              <Stone kind="k" />
            </span>
            <b>{p?.name ?? SIDE[side]}</b>
            {side === you ? <i class="plate plate-small players-you">You</i> : null}
            {o.ranked && p ? (
              <small>
                {p.rating}
                {delta ? <em class={delta > 0 ? 'up' : 'down'}>{delta > 0 ? `+${delta}` : delta}</em> : null}
              </small>
            ) : null}
            {left !== null ? <time>{clockText(left)}</time> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The clocks a friendly room may be played with, and none first. */
const CONTROL_CHOICES: (TimeControl | null)[] = [null, ...FRIENDLY_CONTROLS];

/**
 * The room's clock, chosen by either player between games: none, or one of a few. The chosen one
 * is pressed on like any other choice; the other player sees it change, and is told.
 */
function ClockPick({ app }: { app: App }) {
  const o = ui.online.value;
  if (!o?.choosable || (o.seat !== 'w' && o.seat !== 'b')) return null;
  const current = CONTROL_CHOICES.find((c) => sameControl(c, o.control)) ?? null;
  const live = o.link === 'open';
  return (
    <div class="clock-pick">
      <span class="clock-pick-icon" aria-hidden="true">
        <Icon name="clock" />
      </span>
      <div class="chips" role="radiogroup" aria-label="Clock" onKeyDown={live ? arrows(CONTROL_CHOICES, current, (c) => app.setClock(c)) : undefined}>
        {CONTROL_CHOICES.map((c) => {
          const on = sameControl(c, current);
          return (
            <button
              key={c ? controlText(c) : 'off'}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={c ? controlWords(c) : 'No clock'}
              tabIndex={stop(on)}
              disabled={!live}
              class={`chip ${on ? 'on' : ''}`}
              onClick={() => app.setClock(c)}
            >
              {c ? controlText(c).replace(/ /g, '') : 'Off'}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** How many others are waiting for a match, as the player who is waiting is told. */
export function othersWaiting(q: { waiting: number }): number {
  return Math.max(0, (ui.lobby.value?.waiting ?? q.waiting) - 1);
}

/** What the way to a match says about who is there: anyone waiting to be matched this moment, or else anyone playing. */
export function lobbyWords(): string {
  const lobby = ui.lobby.value;
  const ranked = 'Ranked · 10 minutes each';
  if (!lobby) return ranked;
  if (lobby.waiting > 0) return `${ranked} · ${lobby.waiting === 1 ? 'one player' : `${lobby.waiting} players`} waiting now`;
  if (lobby.playing > 0) return `${ranked} · ${lobby.playing} playing now`;
  return ranked;
}

/** Waiting for a ranked match, said beside the board while something else is played. */
export function Queue({ app }: { app: App }) {
  const q = ui.queue.value;
  const turned = ui.turned.value;
  if ((!q && (!turned || turned.away)) || ui.menuOpen.value) return null;
  if (!q && turned) {
    // Turned away: what the server said, and when the player may look again if they must wait.
    return (
      <section class="card queue" aria-label="Looking for a match">
        <p aria-live="polite">{turnedWords(turned)}</p>
        <div class="choices">
          {turned.until === null ? (
            <button type="button" class="pill" onClick={() => app.findMatch()}>
              Try again
            </button>
          ) : null}
          <button type="button" class="pill" onClick={() => app.dismissTurned()}>
            {turned.until === null ? 'Not now' : 'OK'}
          </button>
        </div>
      </section>
    );
  }
  if (!q) return null;
  const stuck = !q.up && ui.unreachable.value;
  const others = othersWaiting(q);
  // Alone in the line, and nothing in particular on the board: the computer passes the time, and the match comes to them when it is found.
  const idle = q.up && others === 0 && ui.mode.value.kind === 'table';
  const { level, side } = ui.computer.value;
  return (
    <section class="card queue" aria-label="Looking for a match">
      <p aria-live="polite">
        {q.up
          ? others > 0
            ? `Looking for an opponent. ${others === 1 ? 'One other is' : `${others} others are`} waiting.`
            : "Looking for an opponent. Nobody else is waiting yet; you'll be taken to the game when someone joins."
          : stuck
            ? UNREACHABLE
            : 'Reaching the server…'}
      </p>
      <div class="choices">
        {stuck ? (
          <button type="button" class="btn" onClick={() => app.retryServer()}>
            Try again
          </button>
        ) : null}
        {idle ? (
          <button type="button" class="btn" onClick={() => app.startComputer(level, side)}>
            Play the computer meanwhile
          </button>
        ) : null}
        {q.up && others === 0 ? (
          <button type="button" class="pill" onClick={() => app.startOnline()}>
            Invite a friend instead
          </button>
        ) : null}
        <button type="button" class="pill" onClick={() => app.cancelMatch()}>
          Stop looking
        </button>
      </div>
    </section>
  );
}

/** What is said when the server has not been reached for some seconds. */
export const UNREACHABLE = "Can't reach the game server right now.";

/** The hour and minute of a moment today, as a clock shows it: "21:14". */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Why the server turned the player away from the queue, in its words; and, if they must wait,
 * when they may look again by the clock, in place of the server's "in so many minutes".
 */
export function turnedWords(turned: { reason: string; until: number | null }): string {
  if (turned.until === null) return turned.reason;
  const why = turned.reason.replace(/\s*You can look for another in [^.]*\.\s*$/, '');
  return `${why} You can queue again at ${clockTime(turned.until)}.`;
}

/** The best players, and where this one stands. */
export function Ranks({ app }: { app: App }) {
  if (!ui.ranksOpen.value) return null;
  const ranks = ui.ranks.value;
  const mine = ranks?.you ?? ui.player.value.card;
  const row = (p: { name: string; rating: number; wins: number; losses: number; draws: number }, place: string, me: boolean) => (
    <tr key={place} class={me ? 'me' : ''}>
      <td>{place}</td>
      <th scope="row">{p.name}</th>
      <td>{p.rating}</td>
      <td>
        {p.wins}–{p.losses}–{p.draws}
      </td>
    </tr>
  );
  const listed = ranks && mine ? ranks.top.some((p) => p.name === mine.name && p.rating === mine.rating && p.wins === mine.wins && p.losses === mine.losses) : false;
  return (
    <div class="veil veil-over" onClick={(e) => e.target === e.currentTarget && app.showRanks(false)}>
      <section class="card dialog ranks" role="dialog" aria-modal="true" aria-labelledby="ranks-title">
        <h2 id="ranks-title">Rankings</h2>
        {!ranks && ui.unreachable.value ? (
          <>
            <p role="status">{UNREACHABLE}</p>
            <div class="choices">
              <button type="button" class="pill" onClick={() => app.retryServer()}>
                Try again
              </button>
            </div>
          </>
        ) : !ranks ? (
          <p>Asking the server…</p>
        ) : ranks.top.length === 0 ? (
          <p>Nobody has finished a ranked game yet. Find a match and be the first.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">Player</th>
                <th scope="col">Rating</th>
                <th scope="col">Won–lost–drawn</th>
              </tr>
            </thead>
            <tbody>
              {ranks.top.map((p, i) => row(p, String(i + 1), !!mine && listed && p.name === mine.name && p.rating === mine.rating && p.wins === mine.wins && p.losses === mine.losses))}
              {mine && !listed && mine.wins + mine.losses + mine.draws > 0 ? row(mine, '—', true) : null}
            </tbody>
          </table>
        )}
        <div class="choices">
          <button type="button" class="btn" onClick={() => app.showRanks(false)}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * How long a line that was in the room may be down and still be called a brief interruption (a new
 * version of the server being put up takes seconds) before the player is told the server cannot be
 * reached. In an object so that tests can be patient for less long.
 */
export const interruption = { longest: 60000 };
/** When the line to a room last dropped after it had been in. Looked at as the room's card is drawn, which each attempt to reconnect brings about. */
let dropped: { room: string; at: number } | null = null;

/** A friendly clock waiting for its player, who is away: said with how long it will wait, counted down. */
function Waiting({ who, left, at }: { who: string; left: number; at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {who} away. Their clock is paused, <time>{clockText(left - (performance.now() - at))}</time> left.
    </>
  );
}

/** A ranked game's first move, which is not waited for long: who is to make it, counted down. */
function FirstMove({ you, side, left, at }: { you: Seat; side: Side; left: number; at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);
  const time = <time>{clockText(left - (performance.now() - at))}</time>;
  if (you === side) return <>You are {SIDE[side]}. Make your first move within {time}, or the game is called off.</>;
  if (you === 'spectator') return <>{SIDE[side]} has {time} to make a first move, or the game is called off.</>;
  return <>You are {SIDE[opposite(side)]}. Your opponent has {time} to make a first move, or the game is called off.</>;
}

/** Who is in the online room, and what the player should do about it. */
export function Room({ app }: { app: App }) {
  const o = ui.online.value;
  // Once the game is over its own card says everything this one would, and the column (on a phone, the screen) is the result's.
  // A room with no game to be had says so on a card of its own (Closed).
  if (!o || o.closed || (ui.status.value.over && ui.resultVisible.value)) return null;
  const you = o.seat;
  const both = o.taken.w && o.taken.b;
  const played = ui.history.value.length;
  const over = ui.status.value.over;
  // A ranked game's clocks stand still before the first move until a few seconds after both are
  // at the board; and after the server has restarted, until the player to move is back (a few seconds at most).
  const still = o.ranked && o.clock !== null && o.clock.running === null && !over && o.ended === null;
  // Among friends, the player to move is away: their clock waits for them a while, then runs.
  const turn = ui.status.value.turn;
  const awayToMove = !o.ranked && o.clock !== null && !over && played > 0 && !o.present[turn] && o.taken[turn] && you !== turn;
  const held = awayToMove ? (o.clock?.held ?? null) : null;
  // A ranked game whose side to move has yet to make its first move: it is counted down to.
  const first = o.ranked && o.clock && !over && o.ended === null && you !== null ? (o.clock.first ?? null) : null;
  let line: string | VNode;
  let share = false;
  let stuck = false;
  if (o.link === 'lost' && you !== null) {
    if (dropped?.room !== o.room) dropped = { room: o.room, at: Date.now() };
  } else dropped = null;
  const brief = dropped !== null && Date.now() - dropped.at < interruption.longest;
  if (o.link === 'displaced') {
    line = 'Opened in another window.';
  } else if (you === null && o.note) {
    line = `You could not be let in. ${o.note}`;
  } else if (o.stuck && brief) {
    // In the room a moment ago: the line has dropped, and is being tried again.
    line = 'The connection was interrupted. Reconnecting…';
  } else if ((o.link !== 'open' || you === null) && o.stuck) {
    line = UNREACHABLE;
    stuck = true;
  } else if (o.link === 'connecting' || you === null) {
    line = 'Joining…';
  } else if (o.link === 'lost') {
    line = 'Reconnecting…';
  } else if (awayToMove) {
    const who = you === 'spectator' ? `${SIDE[turn]} is` : 'Opponent';
    line = held && o.clock ? <Waiting who={who} left={held.left} at={o.clock.at} /> : `${who} away. Their clock is running.`;
  } else if (o.ended === 'noshow' && played >= 2) {
    // Later in a game, only both players staying away calls it off.
    line = 'Both players were away too long, so the game was called off. It is not rated: neither rating changes.';
  } else if (o.ended === 'noshow') {
    line =
      you === 'spectator'
        ? 'This game was called off before both players had moved. It is not rated.'
        : !o.taken[opposite(you)]
          ? 'Your opponent did not arrive, so the game was called off. It is not rated: neither rating changes.'
          : 'The game was called off before both players had moved. It is not rated: neither rating changes.';
  } else if (still && played > 0) {
    line = 'The server restarted. The clocks start again in a moment.';
  } else if (o.ranked && you !== 'spectator' && !o.taken[opposite(you)]) {
    line = `You are ${SIDE[you]}. Waiting for your opponent to sit down.`;
  } else if (o.ranked && you !== 'spectator' && !o.present[opposite(you)] && !over) {
    // Until both have moved nothing is at stake: one who stays away has the game called off, not lost.
    line = played >= 2 ? 'Opponent disconnected. If they are not back within a minute, the game is yours.' : 'Opponent disconnected. If they are not back within a minute, the game is called off.';
  } else if (still && both) {
    line = you === 'spectator' ? 'The clocks start in a moment.' : `You are ${SIDE[you]}. The clocks start in a moment.`;
  } else if (first && o.clock) {
    line = <FirstMove you={you} side={first.side} left={first.left} at={o.clock.at} />;
  } else if (you === 'spectator') {
    line = 'Watching.';
    share = !both;
  } else if (!o.taken[opposite(you)]) {
    // Come by a link to a room nobody had opened: whatever game it was for is not on the server, and nobody is on their way.
    line = o.firstHere
      ? 'This is a new game, and you are the first one here. Send this link to your opponent. If you were sent it for a game, that game is no longer on the server.'
      : `You are ${SIDE[you]}. Send this link to your opponent.`;
    share = true;
  } else if (!o.present[opposite(you)]) {
    line = 'Opponent disconnected.';
  } else {
    line = `You are ${SIDE[you]}.`;
  }
  // Once a game is over, another can be asked for here as well as on the card that ended it,
  // which the player may have put away to look at the board.
  const seated = you === 'w' || you === 'b' ? you : null;
  const rematch = seated !== null && o.link === 'open' && ui.status.value.over && !ui.resultVisible.value;
  // A draw that has been offered and not yet answered. It is answered here, or by playing on.
  const offer = ui.status.value.over ? null : o.offer;
  const answerable = offer !== null && seated !== null && offer !== seated && o.link === 'open';
  return (
    <section class={`card room ${answerable ? 'room-asked' : ''}`} aria-label="Online game">
      <header class="card-head">
        <h2 class="plate plate-small">{o.ranked ? 'Ranked game' : `Room ${o.room}`}</h2>
        {o.watching > 0 ? <span class="card-aside">{o.watching} watching</span> : null}
      </header>
      <p aria-live={held || first ? 'off' : 'polite'}>{line}</p>
      {stuck ? (
        <div class="choices">
          <button type="button" class="btn" onClick={() => app.retryServer()}>
            Try again
          </button>
          <button type="button" class="pill" onClick={() => app.leaveRoom()}>
            Back
          </button>
        </div>
      ) : null}
      <Players />
      {/* Between games: before the first move of one, or once it is over. */}
      {played === 0 || over ? <ClockPick app={app} /> : null}
      {o.ended === 'noshow' && seated ? (
        <div class="choices">
          <button type="button" class="btn" disabled={ui.queue.value !== null} onClick={() => app.findMatch()}>
            {ui.queue.value ? 'Looking for an opponent…' : 'Find another match'}
          </button>
        </div>
      ) : null}
      {share ? <ShareLink /> : null}
      <div class="offer" role="status">
        {offer === null ? null : answerable ? (
          <>
            <p>
              <b>{SIDE[offer]} offers a draw.</b>
            </p>
            <div class="choices">
              <button type="button" class="btn" onClick={() => app.answerDraw(true)}>
                Agree a draw
              </button>
              <button type="button" class="pill" onClick={() => app.answerDraw(false)}>
                Decline
              </button>
            </div>
          </>
        ) : offer === seated ? (
          <p>
            <b>Draw offered.</b>{' '}
            <button type="button" class="link" disabled={o.link !== 'open'} onClick={() => app.answerDraw(false)}>
              Withdraw
            </button>
          </p>
        ) : (
          <p>
            <b>{SIDE[offer]} has offered a draw.</b>
          </p>
        )}
      </div>
      {rematch && seated && o.ranked ? (
        <div class="choices">
          <button type="button" class="pill" disabled={ui.queue.value !== null} onClick={() => app.anotherMatch()}>
            {ui.queue.value ? 'Looking for an opponent…' : 'Find another match'}
          </button>
        </div>
      ) : rematch && seated ? (
        <div class="choices">
          <button type="button" class="pill" disabled={o.again[seated]} onClick={() => app.newGame()}>
            {o.again[seated] ? 'Asked for another game' : 'Play again'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** What the room's card says when there is no game to be had in it: a plain card with the way back. */
function closedTitle(why: string): string {
  if (/called off/.test(why)) return 'Called off';
  if (/restarted/.test(why)) return 'Not recovered';
  return 'Game over';
}

/**
 * A room with no game in it to be had: called off, over and put away, or lost when the server
 * restarted. Said plainly over the board, with the way back to the choice of game (and to the
 * queue, for a ranked game called off), so that nobody is left before an empty board.
 */
export function Closed({ app }: { app: App }) {
  const why = ui.online.value?.closed ?? null;
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (why) back.current?.focus();
  }, [why]);
  if (!why) return null;
  return (
    <div class="veil">
      <section class="card dialog" role="alertdialog" aria-modal="true" aria-labelledby="closed-title" aria-describedby="closed-text">
        <h2 id="closed-title">{closedTitle(why)}</h2>
        <p id="closed-text">{why}</p>
        <div class="choices">
          <button ref={back} type="button" class="btn" onClick={() => app.leaveRoom()}>
            Back to the menu
          </button>
          <button
            type="button"
            class="pill"
            onClick={() => {
              app.leaveRoom();
              app.findMatch();
            }}
          >
            Find a match
          </button>
        </div>
      </section>
    </div>
  );
}

export function Promotion({ app }: { app: App }) {
  const request = ui.promotion.value;
  if (!request) return null;
  const choices: PromotionKind[] = ['q', 'r', 'b', 'n'];
  const side: Side = request.side;
  return (
    <div class="veil">
      <section class="card dialog" role="dialog" aria-modal="true" aria-labelledby="promotion-title">
        <h2 id="promotion-title">Promote to</h2>
        <div class="crowns">
          {choices.map((k) => (
            <button key={k} type="button" class={`crown ${k === 'q' ? 'crown-first' : ''}`} onClick={() => app.choosePromotion(k)}>
              <span class={`coin coin-${side} coin-large`} aria-hidden="true">
                <Stone kind={k} />
              </span>
              <b>{KIND[k]}</b>
            </button>
          ))}
        </div>
        <p class="ways-on">
          <button type="button" class="link" onClick={() => app.choosePromotion(null)}>
            Go back
          </button>
        </p>
      </section>
    </div>
  );
}

/** How the finished game went: the graph of it, and the move that decided it, which can be gone back to. */
function Story({ app }: { app: App }) {
  const history = ui.history.value;
  const s = ui.status.value;
  // Read so that this is drawn again when the engine's opinion of the last moves arrives.
  void ui.appraised.value;
  if (history.length < 4) return null;
  const you = ui.you.value;
  const loser = s.winner ? opposite(s.winner) : null;
  const worst = loser ? costliest(history, (e) => app.verdicts.get(e), loser) : null;
  const lead = you === loser ? 'Where it went wrong' : you && you === s.winner ? 'Where it was won' : 'The turning point';
  return (
    <figure class="story">
      <figcaption>
        <span>
          <i class="key key-w" aria-hidden="true" />
          Ivory ahead
        </span>
        <span>
          <i class="key key-b" aria-hidden="true" />
          Void ahead
        </span>
      </figcaption>
      <Graph app={app} />
      {worst ? (
        <p class="story-turn">
          {lead}:{' '}
          {/* The position the move was made in: there the board shows what would have been better. */}
          <button type="button" class="link" onClick={() => app.view(worst.ply - 1)}>
            {numbered(worst.ply, worst.move, ui.start.value)}
          </button>
          <em class={`tagword tagword-${worst.verdict.kind}`}>{VERDICT_WORD[worst.verdict.kind]}</em>
        </p>
      ) : null}
    </figure>
  );
}

/**
 * How the game ended, beside the board so that the position that ended it stays in view (the
 * board is framed to leave it room): the seal turned to the winner's coin, who won, how and when,
 * what it did to the player's rating, the graph of the game once it may be looked over, and the
 * ways on.
 */
export function Result({ app }: { app: App }) {
  const s = ui.status.value;
  const end = outcome.value;
  if (!ended() || !end) return null;
  const you = ui.you.value;
  const o = ui.online.value;
  const ranked = o?.ranked === true;
  // Online, another game in the same room needs both players to ask for it; a ranked game has no
  // other in its room, and the next is against whoever the queue finds.
  const asked = o && you && !ranked ? o.again[you] : false;
  const theyAsked = o && you && !ranked ? o.again[opposite(you)] : false;
  const watching = o !== null && you === null;
  const mood = s.winner === null ? 'drew' : you === null ? 'won' : s.winner === you ? 'won' : 'lost';
  // The one ending a beginner takes for something else is explained, as the board shows it.
  const why = end.cause === 'stalemate' && ui.aids.value.explain ? describeStatus(s, you).detail : null;
  const looking = ui.queue.value !== null;
  return (
    <section class={`card result result-${mood} ${handed.value ? 'result-handed' : ''}`} role="dialog" aria-labelledby="result-title" aria-describedby="result-how">
      <header class="card-head result-head">
        <Seal back={s.winner ?? 'either'} turned />
      </header>
      <h2 id="result-title">{headlineOf(end, you)}</h2>
      <p id="result-how" class="result-how">
        {howOf(end, you)}
      </p>
      {why ? <p class="result-why">{why}</p> : null}
      {end.rating ? <RatingRow before={end.rating.before} after={end.rating.after} /> : null}
      {/* The engine's view of the game, only once the game may be looked over (see `assisted`). */}
      {assisted.value ? <Story app={app} /> : null}
      {asked || theyAsked ? (
        <p class="said said-good" aria-live="polite">
          {asked ? 'Waiting for your opponent to agree to another game.' : 'Your opponent would like another game.'}
        </p>
      ) : null}
      {ranked && !watching ? (
        <div class="choices">
          <button type="button" class="btn" disabled={looking} onClick={() => app.anotherMatch()}>
            {looking ? 'Looking for an opponent…' : 'Find another match'}
          </button>
          <button type="button" class="pill" onClick={() => app.leaveRoom()}>
            Leave
          </button>
        </div>
      ) : watching ? (
        <div class="choices">
          <button type="button" class="pill" onClick={() => app.leaveRoom()}>
            Leave
          </button>
        </div>
      ) : (
        <>
          {/* The clock for the next game, chosen here as well as on the room's card. */}
          {o ? <ClockPick app={app} /> : null}
          <div class="choices">
            <button type="button" class="btn" disabled={asked} onClick={() => app.newGame()}>
              {o ? 'Play again' : 'New game'}
            </button>
            {ui.canTakeBack.value ? (
              <button type="button" class="pill" onClick={() => void app.takeBack()}>
                Take back
              </button>
            ) : null}
          </div>
        </>
      )}
      <p class="ways-on">
        {ui.history.value.length > 0 ? (
          <button type="button" class="link" onClick={() => app.view(0)}>
            Review game
          </button>
        ) : null}
        <button type="button" class="link" onClick={() => (ui.resultVisible.value = false)}>
          View board
        </button>
        {ui.history.value.length > 0 ? <CopyMoves app={app} /> : null}
      </p>
    </section>
  );
}
