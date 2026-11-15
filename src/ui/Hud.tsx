/**
 * The interface layer drawn over the 3D scene: printed matter laid on the
 * picture. Cream paper on green-black, block capitals on plates with hard
 * shadows, a heavy soft serif for names. It is kept small and to the edges,
 * so that the board has the picture.
 *
 * This file is the frame during play: who is playing and whose move it is
 * (top), what the player can do (bottom), the record of moves, and what is
 * called out as it happens. The cards of text are in Cards.tsx, the choice
 * of game in Menu.tsx, the settings in Settings.tsx.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { App } from '../app/app';
import { BRAND } from '../app/brand';
import { assisted, type Mode, type Online, ui } from '../app/store';
import { CAMERA_MODES, type CameraMode } from '../camera/rig';
import { opposite, type PieceState, START_FEN, VALUE, type Kind, type MoveEvent, type Side, type Status } from '../core/game';
import { LEVELS } from '../engine/uci';
import { describeClaimable, describeDrawNear, describeStatus } from '../learn/explain';
import { OPENING_PLIES, openingOf } from '../learn/openings';
import { Ask, Closed, CopyMoves, Docking, Explain, Lesson, Promotion, Queue, Ranks, Result, Room, Warning } from './Cards';
import { Emblem, Icon, type IconName, Stone } from './glyphs';
import { Graph } from './Graph';
import { Intro, Verdict, verdict } from './Match';
import { Menu } from './Menu';
import { Settings } from './Settings';
import { callOut, HOW, KIND, numbered, sayMove, SIDE, VERDICT_MARK, VERDICT_WORD, worth } from './words';

/** What the player is waiting for, when it is not their move. */
function waitingFor(s: Status, mode: Mode, you: Side | null, online: Online | null): string | null {
  if (s.over || you === null || s.turn === you) return null;
  if (mode.kind === 'computer') return ui.thinking.value ? 'The computer is thinking' : null;
  if (mode.kind === 'online' && online?.taken[s.turn]) return 'Waiting for your opponent';
  return null;
}

/** Who sits behind a side, in a word or two. Nothing where there is nothing worth saying. */
function seatOf(side: Side, mode: Mode, you: Side | null, online: Online | null): string {
  if (mode.kind === 'computer') return side === you ? 'You' : `Computer · ${LEVELS.find((l) => l.id === mode.level)?.label ?? ''}`;
  if (mode.kind === 'online') {
    if (side === you) return 'You';
    if (!online || !online.taken[side]) return 'Seat open';
    if (!online.present[side]) return 'Away';
    return you ? 'Opponent' : 'Player';
  }
  return '';
}

const ORDER: Kind[] = ['q', 'r', 'b', 'n', 'p'];

/** The stones a side has taken, strongest first, each kind once with a count. */
function Spoils({ kinds }: { kinds: Kind[] }) {
  if (kinds.length === 0) return null;
  const count = (k: Kind) => kinds.filter((x) => x === k).length;
  const words = ORDER.filter((k) => count(k) > 0).map((k) => `${count(k)} ${KIND[k]}${count(k) > 1 ? 's' : ''}`);
  return (
    <span class="spoils" role="img" aria-label={`Taken: ${words.join(', ')}`}>
      {ORDER.filter((k) => count(k) > 0).map((k) => (
        <i key={k}>
          <Stone kind={k} />
          {count(k) > 1 ? <b>{count(k)}</b> : null}
        </i>
      ))}
    </span>
  );
}

/** Who is ahead on the stones still standing, in pawns. */
function standing(pieces: PieceState[]): { side: Side | null; by: number } {
  let w = 0;
  let b = 0;
  for (const p of pieces) {
    if (p.kind === 'k') continue;
    if (p.side === 'w') w += VALUE[p.kind];
    else b += VALUE[p.kind];
  }
  return { side: w === b ? null : w > b ? 'w' : 'b', by: Math.abs(w - b) };
}

function Seat({ side, lead, status: s, lost }: { side: Side; lead: { side: Side | null; by: number }; status: Status; lost: Record<Side, Kind[]> }) {
  const you = ui.you.value;
  const mode = ui.mode.value;
  const active = !s.over && s.turn === side;
  const online = ui.online.value;
  const seat = seatOf(side, mode, you, online);
  // Online, who sits there by name, and their rating where it means something.
  const player = mode.kind === 'online' && online?.taken[side] ? online.players[side] : null;
  // Thinking is something happening now, not in a position being looked back at.
  const thinking = ui.viewing.value === null && active && mode.kind === 'computer' && side !== you && ui.thinking.value;
  const state = s.over ? (s.winner === side ? 'won' : s.winner ? 'lost' : 'drew') : active ? 'on' : 'off';
  // This player's own seat, when this screen plays one side: lit a little more when it is their move.
  const own = you === side && mode.kind !== 'table';
  return (
    <div class={`seat seat-${side} seat-${state} ${own ? 'seat-you' : ''}`}>
      <span class={`coin coin-${side}`} aria-hidden="true">
        <Stone kind="k" />
      </span>
      <span class="seat-name">
        <b>{SIDE[side]}</b>
        {player ? (
          <small class="seat-player" title={player.name}>
            <span>{player.name}</span>
            {online?.ranked && player.rating ? <em>{player.rating}</em> : null}
            {online && !online.present[side] ? <span class="seat-away">Away</span> : null}
          </small>
        ) : seat || thinking ? (
          <small>
            {seat}
            {thinking ? <span class="dots" aria-label=", thinking" /> : null}
          </small>
        ) : null}
      </span>
      <span class="seat-spoils">
        {/* What this side has taken is what the other has lost. */}
        <Spoils kinds={lost[side === 'w' ? 'b' : 'w']} />
        {lead.side === side ? (
          <b class="lead" title={`${SIDE[side]} is ahead by ${lead.by} ${lead.by === 1 ? 'pawn' : 'pawns'} of material`}>
            +{lead.by}
          </b>
        ) : null}
      </span>
    </div>
  );
}

/** Where the game stands, as a line that leans toward whoever is ahead. */
function Scales({ app, lead, status: s }: { app: App; lead: { side: Side | null; by: number }; status: Status }) {
  const history = ui.history.value;
  const viewing = ui.viewing.value;
  void ui.appraised.value;
  // What the engine made of it, in hundredths of a pawn in Ivory's favour: now, or at the move being looked back at.
  let cp: number | null = null;
  if (viewing === null) {
    const judged = ui.balance.value;
    if (judged && judged.ply <= history.length) cp = judged.cp;
  } else {
    const e = history[viewing - 1];
    const verdict = e ? app.verdicts.get(e) : null;
    if (e && verdict) cp = e.side === 'w' ? verdict.after : -verdict.after;
  }
  let share: number;
  if (s.over) share = s.winner === 'w' ? 1 : s.winner === 'b' ? 0 : 0.5;
  else if (cp !== null) share = 0.5 + 0.5 * Math.tanh(cp / 420);
  else share = 0.5 + 0.5 * Math.tanh(((lead.side === 'b' ? -1 : 1) * lead.by) / 9);
  // Never quite all one colour while the game is on.
  if (!s.over) share = Math.min(0.94, Math.max(0.06, share));
  return (
    <div class="scales" aria-hidden="true">
      <i style={{ width: `${(share * 100).toFixed(1)}%` }} />
      <b style={{ left: `${(share * 100).toFixed(1)}%` }} />
    </div>
  );
}

/** Where a look back has got to, as a player would say it: "After 12. Nf3", "After 12… Nf6". */
function lookingAt(ply: number, history: MoveEvent[], start: { side: Side; moveNumber: number }): string {
  const e = history[ply - 1];
  return e ? `After ${numbered(ply, e, start)}` : 'Before the first move';
}

/** The top of the screen: the two sides, whose move it is, and how it stands. */
export function MatchBar({ app }: { app: App }) {
  // While an earlier position is being looked at, the bar describes that position.
  const viewing = ui.viewing.value;
  const live = viewing === null;
  const s = live ? ui.status.value : app.board.status();
  const lost = live ? ui.captured.value : app.board.captured();
  const you = ui.you.value;
  const history = ui.history.value;
  const start = ui.start.value;
  const plies = viewing ?? history.length;
  let { headline, detail } = describeStatus(s, you);
  // A game the server ended against a player whose time ran out, or who went away: nobody resigned, whatever the board's own record says.
  const ended = ui.online.value?.ended;
  if (live && s.over && s.winner && (ended === 'time' || ended === 'left')) {
    const loser = opposite(s.winner);
    headline = ended === 'time' ? (loser === you ? 'Out of time' : `${SIDE[loser]} out of time`) : loser === you ? 'You left' : `${SIDE[loser]} left`;
  }
  // A ranked game called off before both players had moved: nothing is at stake, and nothing is played on.
  const calledOff = live && !s.over && ended === 'noshow';
  if (calledOff) {
    headline = 'Called off';
    detail = 'Not rated.';
  }
  // What most needs saying under the headline: a check, then a draw this player may claim, then one about to be claimable, then who is being waited for.
  const near = ui.drawNear.value;
  const claim = ui.canClaim.value;
  const claimant = you ?? s.turn;
  const claimNote = claim ? describeClaimable(claim, claimant === you ? 'you' : SIDE[claimant]) : null;
  const note = live
    ? (calledOff && detail) || (!s.over && detail) || claimNote || (near && describeDrawNear(near)) || waitingFor(s, ui.mode.value, you, ui.online.value)
    : lookingAt(viewing, history, start);
  const number = start.moveNumber + Math.floor((plies + (start.side === 'b' ? 1 : 0)) / 2);
  // A lesson's board is set up to show one thing, so who is ahead on it says nothing.
  const lesson = ui.mode.value.kind === 'lessons';
  // Nor is the game weighed while an online one is being played.
  const weighed = !lesson && assisted.value;
  const lead = lesson ? { side: null, by: 0 } : standing(app.board.pieces());
  const tone = !live ? 'review' : s.over || calledOff ? 'end' : s.inCheck ? 'alert' : 'plain';
  // The player's own move, when this screen plays one side: the diamond and the plate are lit a little more.
  const yours = live && !s.over && !calledOff && you !== null && s.turn === you && ui.mode.value.kind !== 'table';
  return (
    <header class="match" aria-label="The game">
      <Seat side="w" lead={lead} status={s} lost={lost} />
      <div class={`turn turn-${tone} ${s.over ? '' : `turn-${s.turn}`} ${yours ? 'turn-yours' : ''}`}>
        <span class="turn-number" title="Move number">
          <small>Move</small>
          <b>{number}</b>
        </span>
        <p class="turn-word" role="status" aria-live="polite">
          <b>{live ? headline : 'Looking back'}</b>
          {note ? <span>{note}</span> : null}
        </p>
      </div>
      <Seat side="b" lead={lead} status={s} lost={lost} />
      {weighed ? <Scales app={app} lead={lead} status={s} /> : null}
    </header>
  );
}

/** One square key on the bar at the bottom: a drawing, the key that does the same, and a few words when asked. */
function Slot(props: { icon: IconName; label: string; tip?: string; keys?: string; on?: boolean; disabled?: boolean; small?: boolean; view?: boolean; cycle?: boolean; spare?: boolean; claim?: boolean; onUse: () => void }) {
  return (
    <button
      type="button"
      class={`slot ${props.small ? 'slot-small' : ''} ${props.view ? 'slot-view' : ''} ${props.cycle ? 'slot-cycle' : ''} ${props.spare ? 'slot-spare' : ''} ${props.claim ? 'slot-claim' : ''} ${props.on ? 'on' : ''}`}
      aria-label={props.keys ? `${props.label} (key ${props.keys})` : props.label}
      aria-pressed={props.on === undefined ? undefined : props.on}
      disabled={props.disabled}
      onClick={props.onUse}
    >
      <span class="slot-face">
        <Icon name={props.icon} />
      </span>
      {props.keys ? <kbd aria-hidden="true">{props.keys}</kbd> : null}
      {/* The card is centred by the box that holds it, so it lies on whole pixels. */}
      <span class="tip" aria-hidden="true">
        <span class="tip-card">
          <b>{props.label}</b>
          {props.tip ?? null}
        </span>
      </span>
    </button>
  );
}

const CAMERA_ICON: Record<CameraMode, IconName> = { top: 'top', side: 'side', shoulder: 'shoulder', eyes: 'eyes', orbit: 'orbit' };

/** The bottom of the screen: what the player can do, and where they are looking from. */
export function ActionBar({ app }: { app: App }) {
  const kind = ui.mode.value.kind;
  const online = kind === 'online';
  // A hint is the engine's advice: not offered against another person somewhere else, nor in a lesson, which has its own.
  const hints = ui.aids.value.hints && (kind === 'table' || kind === 'computer') && ui.engine.value !== 'failed';
  const camera = ui.cameraMode.value;
  const claim = ui.canClaim.value;
  const at = CAMERA_MODES.findIndex((m) => m.id === camera);
  return (
    <nav class="bar" aria-label="Game">
      <div class="bar-group">
        {hints ? (
          <Slot icon="hint" label="Hint" keys="H" tip="Press again to see where." disabled={!ui.canHint.value} onUse={() => void app.hint()} />
        ) : null}
        <Slot
          icon="back"
          label="Take back"
          keys={'⌫'}
          tip={online ? 'Not allowed online.' : undefined}
          disabled={!ui.canTakeBack.value}
          onUse={() => void app.takeBack()}
        />
        {kind === 'lessons' ? null : claim ? (
          // Where a draw may be claimed, the same button claims it.
          <Slot
            claim
            icon="draw"
            label="Claim draw"
            keys="D"
            tip={claim === 'threefold' ? 'The position has come up three times.' : 'Fifty moves without a capture or a pawn move.'}
            onUse={() => app.askDraw()}
          />
        ) : (
          <Slot
            spare
            icon="draw"
            label="Draw"
            keys="D"
            tip={kind === 'computer' ? 'Accepted only if it is not winning.' : undefined}
            disabled={!ui.canDraw.value}
            onUse={() => app.askDraw()}
          />
        )}
        {kind === 'lessons' ? null : (
          <Slot
            icon="resign"
            label="Resign"
            keys="R"
            disabled={!ui.canResign.value}
            onUse={() => app.askResign()}
          />
        )}
      </div>
      <i class="bar-rule" aria-hidden="true" />
      <div class="bar-group" role="group" aria-label="Camera">
        <Slot small icon="flip" label="Flip" keys="F" onUse={() => app.flip()} />
        {CAMERA_MODES.map((m) => (
          <Slot key={m.id} small view icon={CAMERA_ICON[m.id]} label={m.label} keys={m.key} on={m.id === camera} onUse={() => app.setCamera(m.id)} />
        ))}
        {/* Where there is no room for a key to each view (a phone), one key goes round them. */}
        <Slot small cycle icon={CAMERA_ICON[camera]} label={`View: ${CAMERA_MODES[at]?.label ?? ''}. Press for the next.`} onUse={() => app.setCamera(CAMERA_MODES[(at + 1) % CAMERA_MODES.length]!.id)} />
      </div>
    </nav>
  );
}

/** The record of the game, as a player would write it down. Any move in it can be gone back to and looked at. */
/**
 * A move typed instead of clicked, for a player at a keyboard: "Nf3", "exd5", "O-O", or the two
 * squares. Enter plays it; what is wrong with it, if anything, is said underneath.
 */
function TypeMove({ app }: { app: App }) {
  const [said, setSaid] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  return (
    <form
      class="type-move"
      onSubmit={(ev) => {
        ev.preventDefault();
        const input = field.current;
        if (!input) return;
        const answer = app.typeMove(input.value);
        setSaid(answer);
        if (answer === null) input.value = '';
      }}
    >
      <label class="unseen" for="type-move">
        Type a move and press Enter
      </label>
      <input
        ref={field}
        id="type-move"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        enterkeyhint="go"
        maxLength={12}
        placeholder="Type a move"
        aria-describedby={said ? 'type-move-said' : undefined}
        onInput={() => setSaid(null)}
        onKeyDown={(ev) => {
          if (ev.key !== 'Escape') return;
          // Esc gives the keys back to the board.
          ev.currentTarget.value = '';
          ev.currentTarget.blur();
          setSaid(null);
        }}
      />
      <kbd aria-hidden="true">M</kbd>
      {said ? (
        <p id="type-move-said" class="type-move-said" role="alert">
          {said}
        </p>
      ) : null}
    </form>
  );
}

function Record({ app }: { app: App }) {
  const history = ui.history.value;
  const viewing = ui.viewing.value;
  // Read so that the record is drawn again when the engine's opinion of a move arrives.
  void ui.appraised.value;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    // The latest move is kept in sight, or the one being looked back at.
    if (viewing === null) el.scrollTop = el.scrollHeight;
    else el.querySelector('.viewed')?.scrollIntoView?.({ block: 'nearest' });
  }, [history.length, viewing]);

  // One row per full move. A game set up with Void to move starts half way through its first row.
  const start = ui.start.value;
  const lead = start.side === 'b' ? 1 : 0;
  const rows: [MoveEvent | undefined, MoveEvent | undefined][] = [];
  for (let i = -lead; i < history.length; i += 2) rows.push([history[i], history[i + 1]]);
  const last = history[history.length - 1];
  const lessons = ui.mode.value.kind === 'lessons';
  // An online game being played is not judged, named or drawn: that is for after it.
  const counsel = assisted.value;
  // What chess players call the way this game began, if it began from the usual position and has a name.
  const opening = useMemo(
    () => (lessons || !counsel || app.game.startFen() !== START_FEN ? null : openingOf(history.slice(0, OPENING_PLIES).map((e) => e.san))),
    [history, lessons, counsel],
  );

  const cell = (e: MoveEvent | undefined, blank: string) => {
    if (!e) return <span>{blank}</span>;
    const ply = history.indexOf(e) + 1;
    const verdict = counsel ? app.verdicts.get(e)?.kind : undefined;
    const mark = verdict ? VERDICT_MARK[verdict] : '';
    const marked = mark ? (
      <em class={`mark mark-${verdict}`} title={verdict ? VERDICT_WORD[verdict] : undefined}>
        {mark}
      </em>
    ) : null;
    const state = `${viewing === null && e === last ? 'latest' : ''} ${ply === viewing ? 'viewed' : ''}`;
    // A lesson's moves are its own to step through.
    if (lessons)
      return (
        <span class={state}>
          {e.san}
          {marked}
        </span>
      );
    return (
      <button type="button" class={`move ${state}`} aria-label={`${sayMove(e)} Look at the board after it.`} aria-current={ply === viewing ? 'step' : undefined} onClick={() => app.view(ply)}>
        {e.san}
        {marked}
      </button>
    );
  };

  const at = viewing ?? history.length;
  return (
    <section class={`record ${viewing === null ? '' : 'record-looking'}`} aria-label="Moves played">
      <header class="record-head">
        <h2 class="record-title">Moves</h2>
        {history.length > 0 && !lessons ? (
          <span class="record-keys">
            <span class="stepper" role="group" aria-label="Look back through the game">
              <button type="button" aria-label="The position the game began from (Home)" disabled={at === 0} onClick={() => app.view(0)}>
                <Icon name="first" />
              </button>
              <button type="button" aria-label="One move back (left arrow)" disabled={at === 0} onClick={() => app.stepView(-1)}>
                <Icon name="prev" />
              </button>
              <button type="button" aria-label="One move on (right arrow)" disabled={at >= history.length} onClick={() => app.stepView(1)}>
                <Icon name="next" />
              </button>
              <button type="button" aria-label="The game as it stands (Escape)" disabled={viewing === null} onClick={() => app.view(null)}>
                <Icon name="last" />
              </button>
            </span>
            <CopyMoves app={app} small />
          </span>
        ) : null}
      </header>
      {opening ? (
        <p class="record-opening" title="What chess players call the way this game began">
          {opening.name}
        </p>
      ) : null}
      {/* Looking back, or once the game is over, the whole of it is drawn as well as listed. */}
      {!lessons && counsel && (viewing !== null || ui.status.value.over) ? <Graph app={app} width={206} height={40} /> : null}
      {rows.length === 0 ? (
        <p class="record-empty">No moves yet.</p>
      ) : (
        <ol class="moves" ref={list}>
          {rows.map(([white, black], i) => (
            <li key={i}>
              <span class="n">{start.moveNumber + i}</span>
              {cell(white, '…')}
              {cell(black, '')}
            </li>
          ))}
        </ol>
      )}
      {viewing === null && !lessons && !ui.status.value.over ? <TypeMove app={app} /> : null}
      {viewing === null ? null : (
        <button type="button" class="pill record-back" onClick={() => app.view(null)}>
          Back to the game
        </button>
      )}
    </section>
  );
}

interface Said {
  id: number;
  e: MoveEvent;
}

/** How long a line stays in the feed, and how many are kept. */
const FEED_SECONDS = 9;
const FEED_ROWS = 4;

/** Each move in plain words as it lands, for a few seconds: the game read aloud. */
function Feed({ app }: { app: App }) {
  const landed = ui.landed.value;
  const plies = ui.history.value.length;
  void ui.appraised.value;
  const [rows, setRows] = useState<Said[]>([]);
  const next = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const known = useRef(plies);

  useEffect(() => {
    if (!landed) return setRows([]);
    const id = next.current++;
    setRows((was) => [...was, { id, e: landed }].slice(-FEED_ROWS));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setRows((was) => was.filter((r) => r.id !== id));
    }, FEED_SECONDS * 1000);
    timers.current.add(timer);
  }, [landed]);
  // A move taken back takes its line with it.
  useEffect(() => {
    if (plies < known.current) setRows((was) => was.filter((r) => ui.history.value.includes(r.e)));
    known.current = plies;
  }, [plies]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  if (rows.length === 0) return null;
  const history = ui.history.value;
  const usual = app.game.startFen() === START_FEN;
  // In an online game being played a move is said, not judged or named.
  const counsel = assisted.value;
  return (
    <ol class="feed" aria-label="What just happened" aria-live="polite">
      {rows.map(({ id, e }) => {
        const verdict = counsel ? app.verdicts.get(e)?.kind : undefined;
        // The move that reached a named opening says its name.
        const ply = history.indexOf(e) + 1;
        const named = counsel && usual && ply > 0 && ply <= OPENING_PLIES ? openingOf(history.slice(0, ply).map((m) => m.san)) : null;
        const tag = verdict && VERDICT_WORD[verdict] ? <em class={`tagword tagword-${verdict}`}>{VERDICT_WORD[verdict]}</em> : null;
        // A stone taken is not said but shown: who took, and what, with the cut between them.
        if (e.captured)
          return (
            <li key={id} class={`kill kill-${e.side}`}>
              <span class="unseen">{sayMove(e)}</span>
              <span class="kill-by" aria-hidden="true">
                <span class={`coin coin-${e.side}`}>
                  <Stone kind={e.piece.kind} />
                </span>
                <span class="kill-name">
                  <b>{KIND[e.piece.kind]}</b>
                  <small>
                    <em class="kill-worth">+{VALUE[e.captured.kind]}</em>
                    {e.san}
                  </small>
                </span>
                <i class="kill-mark">
                  <Icon name="take" />
                </i>
              </span>
              <span class="kill-lost" aria-hidden="true">
                <b>{KIND[e.captured.kind]}</b>
                <span class={`coin coin-${opposite(e.side)}`}>
                  <Stone kind={e.captured.kind} />
                </span>
              </span>
              {tag}
            </li>
          );
        return (
          <li key={id} class={`feed-${e.side}`}>
            <span class={`coin coin-${e.side} coin-tiny`} aria-hidden="true">
              <Stone kind={e.promotion ?? e.piece.kind} />
            </span>
            <span class="feed-text">
              {sayMove(e)}
              {named && named.ply === ply ? <i>{named.name}</i> : null}
            </span>
            {tag}
          </li>
        );
      })}
    </ol>
  );
}

/** What a beginner must not miss, called out over the board for a moment as it happens. */
function Announcer() {
  const landed = ui.landed.value;
  const [call, setCall] = useState<{ id: number; word: string; tone: string; side: Side } | null>(null);
  const next = useRef(1);
  useEffect(() => {
    const said = landed ? callOut(landed) : null;
    if (!landed || !said) return setCall(null);
    const id = next.current++;
    setCall({ id, ...said, side: landed.side });
    const timer = setTimeout(() => setCall((was) => (was?.id === id ? null : was)), said.tone === 'end' ? 3400 : 2100);
    return () => clearTimeout(timer);
  }, [landed]);
  // A game given up is not a move, but it is as much to be seen.
  const status = ui.status.value;
  const gaveUp = status.result === 'resigned' && status.winner ? opposite(status.winner) : null;
  useEffect(() => {
    if (!gaveUp) return;
    const id = next.current++;
    // The server gives up for a player whose time has run out, or who has gone: that is what is said.
    const ended = ui.online.value?.ended;
    const word = ended === 'time' ? `${SIDE[gaveUp]} out of time` : ended === 'left' ? `${SIDE[gaveUp]} left` : `${SIDE[gaveUp]} resigns`;
    setCall({ id, word, tone: 'end', side: gaveUp });
    const gone = () => setCall((was) => (was?.id === id ? null : was));
    const timer = setTimeout(gone, 3400);
    // Taken back before its time is up, it goes with the resignation and does not stay over the game.
    return () => {
      clearTimeout(timer);
      gone();
    };
  }, [gaveUp]);
  // Nor is a draw the players have agreed.
  const agreed = status.result === 'draw' && status.drawReason === 'agreement';
  useEffect(() => {
    if (!agreed) return;
    const id = next.current++;
    setCall({ id, word: 'Draw agreed', tone: 'end', side: 'w' });
    const gone = () => setCall((was) => (was?.id === id ? null : was));
    const timer = setTimeout(gone, 3400);
    return () => {
      clearTimeout(timer);
      gone();
    };
  }, [agreed]);
  // Nothing is called out over a position being looked back at. It stays where it is while that goes on,
  // so that coming back to the game does not call its last move out a second time.
  const looking = ui.viewing.value !== null;
  useEffect(() => {
    if (looking) setCall(null);
  }, [looking]);
  if (!call || looking) return null;
  // How a game ended is said again, larger, by the verdict: as that comes, this makes way for it.
  const yielding = call.tone === 'end' && verdict.value !== null;
  // The words are already announced by the status line; this is the same thing for the eye.
  return (
    <p key={call.id} class={`call call-${call.tone} call-${call.side} ${yielding ? 'call-yield' : ''}`} aria-hidden="true">
      <span>{call.word}</span>
    </p>
  );
}

/** The stone under the pointer: what it is, what it is worth and how it moves. */
function Inspect() {
  const p = ui.pointed.value;
  const hint = ui.hint.value;
  if (!p && !hint) return null;
  return (
    <aside class="inspect" aria-hidden={hint ? undefined : true}>
      {hint ? (
        <p class="hintcard" role="status" aria-live="polite">
          <b class="plate plate-small plate-gilt">{hint.label ?? 'Hint'}</b>
          <span>
            {hint.text}
            {hint.stage === 1 ? <em> Press H again to see where.</em> : null}
          </span>
        </p>
      ) : null}
      {p ? (
        <div class={`named named-${p.side}`}>
          <span class={`coin coin-${p.side} coin-large`}>
            <Stone kind={p.kind} />
          </span>
          <p>
            <b>
              {SIDE[p.side]} {KIND[p.kind]}
            </b>
            <small>
              {p.square} {'·'} {worth(p.kind)}
            </small>
            {ui.aids.value.explain ? <span>{HOW[p.kind]}</span> : null}
          </p>
        </div>
      ) : null}
    </aside>
  );
}

/** The corner buttons: the way to another game, and to the settings. */
function Corner() {
  return (
    <nav class="corner" aria-label="Menu">
      <button type="button" class={`pill ${ui.menuOpen.value ? 'on' : ''}`} aria-expanded={ui.menuOpen.value} onClick={() => (ui.menuOpen.value = true)}>
        New game
      </button>
      <button
        type="button"
        class={`pill pill-icon ${ui.settingsOpen.value ? 'on' : ''}`}
        aria-label="Settings"
        aria-expanded={ui.settingsOpen.value}
        onClick={() => (ui.settingsOpen.value = !ui.settingsOpen.value)}
      >
        <Icon name="settings" />
      </button>
    </nav>
  );
}

/** Covers the scene until it is ready, so the first thing seen is the finished room. */
function Curtain() {
  return (
    <div class={`curtain ${ui.ready.value ? 'gone' : ''}`} aria-hidden={ui.ready.value}>
      <Emblem />
      <p>{BRAND.name}</p>
      <i />
    </div>
  );
}

export function Hud({ app }: { app: App }) {
  const opening = ui.opening.value;
  const lessons = ui.mode.value.kind === 'lessons';
  return (
    <div
      class={`hud ${opening ? 'hud-opening' : ''} ${ui.menuOpen.value ? 'hud-menu' : ''} ${ui.viewing.value !== null ? 'hud-looking' : ''} ${ui.status.value.over && ui.resultVisible.value && !lessons ? 'hud-result' : ''} ${ui.bare.value ? 'hud-bare' : ''}`}
    >
      {opening ? null : (
        <>
          <MatchBar app={app} />
          <div class="rail rail-left">
            <h1 class="brandmark">
              <Emblem />
              <span>{BRAND.name}</span>
            </h1>
            {ui.notice.value ? (
              <p class="notice" role="alert">
                {ui.notice.value}
              </p>
            ) : null}
            <Queue app={app} />
            <Room app={app} />
            <Lesson app={app} />
            <Explain app={app} />
            <Result app={app} />
            <Docking app={app} />
          </div>
          <div class="rail rail-right">
            <Corner />
            {lessons || ui.settingsOpen.value ? null : <Feed app={app} />}
          </div>
          <Record app={app} />
          <ActionBar app={app} />
          <Inspect />
          {lessons ? null : <Announcer />}
          <Intro app={app} />
          {lessons ? null : <Verdict />}
        </>
      )}
      <Promotion app={app} />
      <Warning app={app} />
      <Ask app={app} />
      <Closed app={app} />
      <Menu app={app} />
      <Ranks app={app} />
      <Settings app={app} />
      <Curtain />
      {ui.bare.value ? (
        // Said for a moment, and then only the way back stays: a small plate to tap, for a hand with no keyboard.
        <p class="bare-note" role="status">
          <span class="bare-say">
            <kbd>P</kbd> or <kbd>Esc</kbd> brings the interface back
          </span>
          <button type="button" class="pill bare-show" onClick={() => app.setBare(false)}>
            Show
          </button>
        </p>
      ) : null}
    </div>
  );
}
