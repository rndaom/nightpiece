/**
 * The settings: how the picture is drawn, how loud it is, how the camera
 * behaves, and how much help a beginner gets.
 */
import type { ComponentChildren } from 'preact';
import type { App } from '../app/app';
import { type Aids, qualityIsChosen, ui } from '../app/store';
import type { Quality } from '../scene/post';
import { Icon } from './glyphs';
import { arrows, stop } from './roving';

/** Auto lets the game choose, and lower it by itself when the picture is drawn too slowly; the others are the player's own choice, which is kept. */
const QUALITIES: { id: Quality | 'auto'; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const QUALITY_IDS = QUALITIES.map((q) => q.id);
const QUALITY_WORD: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** The help a beginner may want, in the order it matters. `danger` only means something while `moves` is on. */
const AIDS: [keyof Aids, string][] = [
  ['moves', 'Show legal moves'],
  ['danger', 'Mark unsafe squares'],
  ['hints', 'Hints'],
  ['warn', 'Warn before a blunder'],
  ['explain', 'Explain new rules'],
];

const VOLUMES = [
  ['master', 'Master'],
  ['music', 'Ambience'],
  ['effects', 'Effects'],
] as const;

function anyAid(): boolean {
  return Object.values(ui.aids.value).some(Boolean);
}

/** A switch: a checkbox that looks like what it does. */
function Switch(props: { id: string; on: boolean; onChange: (on: boolean) => void; children: ComponentChildren; note?: string; under?: boolean; disabled?: boolean }) {
  return (
    <label class={`switch ${props.under ? 'switch-under' : ''} ${props.disabled ? 'switch-off' : ''}`} for={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.on}
        disabled={props.disabled}
        aria-disabled={props.disabled ? true : undefined}
        onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)}
      />
      <i aria-hidden="true" />
      <span>
        {props.children}
        {props.note ? <small>{props.note}</small> : null}
      </span>
    </label>
  );
}

export function Settings({ app }: { app: App }) {
  if (!ui.settingsOpen.value) return null;
  // Read even while the quality is the game's own choice, so that the panel is drawn again when that changes.
  const quality = ui.quality.value;
  const chosen: Quality | 'auto' = qualityIsChosen() && quality ? quality : 'auto';
  const choose = (id: Quality | 'auto') => (id === 'auto' ? app.setQualityAuto() : app.setQuality(id));
  return (
    <section class="card settings" aria-label="Settings">
      <header class="card-head">
        <h2 class="plate plate-small">Settings</h2>
        <button type="button" class="pill pill-icon" aria-label="Close the settings" onClick={() => (ui.settingsOpen.value = false)}>
          <Icon name="close" />
        </button>
      </header>
      <div class="settings-body">
        <div class="group" role="radiogroup" aria-label="Picture quality">
          <h3>Picture</h3>
          <div class="chips" onKeyDown={arrows(QUALITY_IDS, chosen, choose)}>
            {QUALITIES.map((q) => (
              <button
                key={q.id}
                type="button"
                role="radio"
                aria-checked={chosen === q.id}
                tabIndex={stop(chosen === q.id)}
                class={`chip ${chosen === q.id ? 'on' : ''}`}
                onClick={() => choose(q.id)}
              >
                {q.label}
              </button>
            ))}
          </div>
          {chosen === 'auto' && ui.quality.value ? <p class="level-hint">Chosen for this machine: {QUALITY_WORD[ui.quality.value]}. Lowered by itself if the game runs slowly.</p> : null}
        </div>
        <div class="group" role="group" aria-label="Sound">
          <h3>Sound</h3>
          {VOLUMES.map(([key, label]) => {
            const value = Math.round(ui.volume.value[key] * 100);
            return (
              <label class="level" for={`setting-volume-${key}`} key={key}>
                <span>{label}</span>
                <input
                  id={`setting-volume-${key}`}
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={value}
                  style={{ '--fill': `${value}%` }}
                  onInput={(e) => app.setVolume(key, Number((e.currentTarget as HTMLInputElement).value) / 100)}
                />
                <output for={`setting-volume-${key}`}>{value}</output>
              </label>
            );
          })}
        </div>
        <div class="group" role="group" aria-label="Camera">
          <h3>Camera</h3>
          <Switch id="setting-cinematic" on={ui.cinematic.value} onChange={(on) => app.setCinematic(on)}>
            <b>Cinematic camera</b>
          </Switch>
          <Switch id="setting-follow" on={ui.followTurn.value} onChange={(on) => app.setFollowTurn(on)} note="Two at this screen">
            <b>Turn the view to whoever is to move</b>
          </Switch>
          <p class="ways-on">
            <button type="button" class="link" onClick={() => app.setBare(true)}>
              Hide the interface
            </button>
            <span class="put-away">
              <kbd>P</kbd>
            </span>
          </p>
        </div>
        <div class="group" role="group" aria-label="Help">
          <h3>Help</h3>
          {AIDS.map(([key, label]) => (
            <Switch
              key={key}
              id={`setting-aid-${key}`}
              on={ui.aids.value[key]}
              onChange={(on) => app.setAid(key, on)}
              under={key === 'danger'}
              disabled={key === 'danger' && !ui.aids.value.moves}
            >
              {label}
            </Switch>
          ))}
          <Switch id="setting-aid-labels" on={ui.aids.value.labels} onChange={(on) => app.setAid('labels', on)}>
            Piece symbols in Top view
          </Switch>
          <p class="ways-on">
            <button type="button" class="link" onClick={() => app.setAllAids(!anyAid())}>
              {anyAid() ? 'Turn all off' : 'Turn all on'}
            </button>
            {ui.seen.value.length > 0 ? (
              <button type="button" class="link" onClick={() => app.forgetExplained()}>
                Explain the rules again
              </button>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  );
}
