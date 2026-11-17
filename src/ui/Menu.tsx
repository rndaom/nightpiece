/**
 * The choice of game: the lessons, the computer, a friend online, or two at
 * this screen. It stands down the left of the picture like a playbill, and
 * the board stays in view beside it. When nothing has been started yet it is
 * also the title screen.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { App } from '../app/app';
import { BRAND } from '../app/brand';
import type { SavedSummary } from '../app/saved';
import { ui } from '../app/store';
import type { Side } from '../core/game';
import { LEVELS } from '../engine/uci';
import { NAME_LENGTH } from '../net/protocol';
import { reached } from '../net/visits';
import { lobbyWords, othersWaiting, turnedWords, UNREACHABLE } from './Cards';
import { Emblem, Icon, type IconName, Stone } from './glyphs';
import { arrows, stop } from './roving';

const SIDE_CHOICES: { id: Side | 'either'; label: string }[] = [
  { id: 'w', label: 'Ivory' },
  { id: 'b', label: 'Void' },
  { id: 'either', label: 'Either' },
];
const SIDE_IDS = SIDE_CHOICES.map((c) => c.id);
const LEVEL_IDS = LEVELS.map((l) => l.id);

/** How long ago something was, in the words a person would use. */
function ago(at: number): string {
  const minutes = Math.max(0, (Date.now() - at) / 60000);
  if (at <= 0 || minutes < 2) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} minutes ago`;
  const hours = minutes / 60;
  if (hours < 1.5) return 'an hour ago';
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = Math.round(hours / 24);
  return days <= 1 ? 'yesterday' : `${days} days ago`;
}

/** A game left unfinished, in a line. */
function describeSaved(saved: SavedSummary): string {
  const moves = `${saved.moves} ${saved.moves === 1 ? 'move' : 'moves'}`;
  if (saved.kind === 'table') return `Two at this screen · ${moves} · ${ago(saved.at)}`;
  const level = LEVELS.find((l) => l.id === saved.level)?.label;
  return `${level ? `Computer, ${level}` : 'Computer'} · ${moves} · ${ago(saved.at)}`;
}

export function Menu({ app }: { app: App }) {
  return ui.menuOpen.value ? <Playbill app={app} /> : null;
}

/** One way to play that needs no choosing: a name, sometimes a line about it, and it starts. */
function Way(props: { icon: IconName; name: string; line?: string; disabled?: boolean; onUse: () => void }) {
  return (
    <li>
      <button type="button" class="way" disabled={props.disabled} onClick={props.onUse}>
        <span class="way-icon" aria-hidden="true">
          <Icon name={props.icon} />
        </span>
        <b>{props.name}</b>
        {props.line ? <small>{props.line}</small> : null}
        <span class="way-go" aria-hidden="true">
          <Icon name="arrow" />
        </span>
      </button>
    </li>
  );
}

/** The name the player goes by online, how they stand, and the way to the rankings. */
function Who({ app }: { app: App }) {
  const { name, card } = ui.player.value;
  const said = ui.nameSaid.value;
  // What was last given, so that Return and then the field being left do not give it twice.
  const given = useRef<string | null>(null);
  const give = (field: HTMLInputElement) => {
    if (field.value === given.current) return;
    given.current = field.value;
    app.rename(field.value);
    // The field shows the name as it was kept: what could not be kept is seen to go.
    field.value = ui.player.value.name;
  };
  return (
    <div class="who">
      <label>
        <span>
          Your name online
          {said ? (
            <em class={`who-said who-said-${said}`} role="status">
              {said === 'saved' ? 'Saved' : "That name isn't available."}
            </em>
          ) : null}
        </span>
        <input
          type="text"
          value={name}
          maxLength={NAME_LENGTH}
          placeholder={card?.name ?? 'Chosen for you'}
          autocomplete="off"
          autocapitalize="words"
          enterkeyhint="done"
          spellcheck={false}
          aria-invalid={said === 'refused' ? true : undefined}
          onInput={() => {
            given.current = null;
            if (ui.nameSaid.value) ui.nameSaid.value = null;
          }}
          onBlur={(e) => give(e.currentTarget as HTMLInputElement)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // Return keeps the name, and a phone puts its keyboard away.
            if (e.key === 'Enter') {
              give(e.currentTarget as HTMLInputElement);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          onFocus={(e) => {
            // A phone's keyboard comes up over the foot of the list, where the field is: once it is up, the field is brought into the part still seen.
            const field = e.currentTarget as HTMLInputElement;
            setTimeout(() => field.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
          }}
        />
      </label>
      <button type="button" class="pill" onClick={() => app.showRanks(true)}>
        <Icon name="ranks" />
        {card ? `Rankings · ${card.rating}` : 'Rankings'}
      </button>
    </div>
  );
}

/** The bill itself. It is made afresh each time the choice of game is opened, so what was only looked at last time is forgotten. */
function Playbill({ app }: { app: App }) {
  // The level and side being looked at. They become the player's choice only when Play is pressed.
  const [chosen, setChosen] = useState(ui.computer.value);
  const level = LEVELS.find((l) => l.id === chosen.level) ?? LEVELS[1]!;
  const noEngine = ui.engine.value === 'failed';
  const opening = ui.opening.value;
  const saved = ui.saved.value;
  const queue = ui.queue.value;
  const turned = ui.turned.value;
  // With a game to carry on, the computer's strengths and sides stay folded away until they are asked for.
  const [unfolded, setUnfolded] = useState(false);
  // On a phone held upright they are folded away as well, so that the list is short and the room is seen above it.
  const [narrow] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 760px) and (orientation: portrait)').matches);
  const open = unfolded || (!saved && !narrow);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The button that unfolded them is gone; the keyboard goes on from the strength that is chosen.
    if (unfolded) panel.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [unfolded]);
  // At the opening there is no game to go back to: closing the choice starts one at this screen.
  const close = () => (opening ? app.startTable() : (ui.menuOpen.value = false));
  return (
    <div class={`veil veil-bill ${opening ? 'veil-opening' : ''}`} onClick={(e) => e.target === e.currentTarget && !opening && close()}>
      <section class="bill" role="dialog" aria-modal="true" aria-labelledby="menu-title">
        {opening ? (
          <header class="title">
            <h2 id="menu-title" aria-label={BRAND.name}>
              <span aria-hidden="true">{BRAND.words[0]}</span>
              <span aria-hidden="true">{BRAND.words[1]}</span>
              <i class="seal" aria-hidden="true">
                <Emblem />
              </i>
            </h2>
          </header>
        ) : (
          <header class="bill-head">
            <h2 id="menu-title">New game</h2>
          </header>
        )}
        <div class="bill-body">
          <ul class={`ways ${saved ? 'ways-many' : ''} ${saved && open ? 'ways-open' : ''}`}>
            {saved ? <Way icon="play" name="Carry on" line={describeSaved(saved)} onUse={() => app.resume()} /> : null}
            <Way icon="book" name="Learn the game" onUse={() => app.startLessons()} />
            {open ? null : <Way icon="engine" name="Play the computer" onUse={() => setUnfolded(true)} />}
            <li class="way-group" hidden={!open}>
              <div class="way way-static">
                <span class="way-icon" aria-hidden="true">
                  <Icon name="engine" />
                </span>
                <b id="computer-title">Play the computer</b>
              </div>
              <div class="way-more" ref={panel}>
                <div
                  class="chips"
                  role="radiogroup"
                  aria-label="How strong the computer plays"
                  onKeyDown={arrows(LEVEL_IDS, level.id, (id) => setChosen((c) => ({ ...c, level: id })))}
                >
                  {LEVELS.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      role="radio"
                      aria-checked={l.id === level.id}
                      tabIndex={stop(l.id === level.id)}
                      class={`chip ${l.id === level.id ? 'on' : ''}`}
                      onClick={() => setChosen((c) => ({ ...c, level: l.id }))}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <p class="level-hint" aria-live="polite">
                  {level.hint}.
                </p>
                <div class="sides" role="radiogroup" aria-label="Your side" onKeyDown={arrows(SIDE_IDS, chosen.side, (id) => setChosen((was) => ({ ...was, side: id })))}>
                  {SIDE_CHOICES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={c.id === chosen.side}
                      tabIndex={stop(c.id === chosen.side)}
                      aria-label={`Play ${c.label}`}
                      class={`sidepick ${c.id === chosen.side ? 'on' : ''}`}
                      onClick={() => setChosen((was) => ({ ...was, side: c.id }))}
                    >
                      <span class={`coin coin-${c.id === 'either' ? 'either' : c.id}`} aria-hidden="true">
                        <Stone kind="k" />
                      </span>
                      {c.label}
                    </button>
                  ))}
                </div>
                {noEngine ? <p class="notice">The chess engine did not load last time. Starting a game will try again.</p> : null}
                <button type="button" class="btn btn-wide" onClick={() => app.startComputer(level.id, chosen.side)}>
                  Play
                </button>
              </div>
            </li>
            {queue ? (
              <Way
                icon="close"
                name="Stop looking"
                line={
                  queue.up
                    ? othersWaiting(queue) > 0
                      ? `Looking for an opponent · ${othersWaiting(queue)} more waiting`
                      : "Nobody else yet · you'll be taken to the game when someone joins"
                    : ui.unreachable.value
                      ? `${UNREACHABLE} Still trying.`
                      : 'Reaching the server…'
                }
                onUse={() => app.cancelMatch()}
              />
            ) : turned ? (
              // Turned away by the server: why, and if there is a wait, when it is over. The way opens again by itself then.
              <Way icon="match" name="Find a match" line={turnedWords(turned)} disabled={turned.until !== null} onUse={() => app.findMatch()} />
            ) : (
              <Way icon="match" name="Find a match" line={lobbyWords()} onUse={() => app.findMatch()} />
            )}
            {queue && !queue.up && ui.unreachable.value ? <Way icon="match" name="Try again" line="Try the game server again now" onUse={() => app.retryServer()} /> : null}
            <Way icon="link" name="Play a friend, online" onUse={() => app.startOnline()} />
            <Way
              icon="two"
              name="Two at this screen"
              onUse={() => {
                reached('table');
                app.startTable();
              }}
            />
          </ul>
          <Who app={app} />
          <footer class="bill-foot">
            <button type="button" class="link" onClick={close}>
              {opening ? 'Just show me the board' : 'Back to the game'}
            </button>
            <button
              type="button"
              class={`pill ${ui.settingsOpen.value ? 'on' : ''}`}
              aria-expanded={ui.settingsOpen.value}
              onClick={() => (ui.settingsOpen.value = !ui.settingsOpen.value)}
            >
              <Icon name="settings" />
              Settings
            </button>
          </footer>
          {/* Whose work the game is made with, and under what terms: a page of its own, so the game is not left. */}
          <p class="bill-credits">
            <a class="link" href={`${import.meta.env.BASE_URL}credits.html`} target="_blank" rel="noopener">
              Credits and licences
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
