/**
 * The game on a phone: what the page's head and the stylesheets promise a touch screen. The
 * frames themselves are taken by hand (tools/dev/look.mjs at phone sizes); these keep what was
 * found there from coming undone.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hud = readFileSync('src/ui/hud.css', 'utf8');
const panels = readFileSync('src/ui/panels.css', 'utf8');

/** Each rule of a stylesheet, with the conditions (@media and the like) it stands under. */
function rules(css: string): { selector: string; body: string; under: string[] }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string; under: string[] }[] = [];
  const stack: string[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') {
      const head = text.slice(start, i).trim();
      if (head.startsWith('@')) {
        stack.push(head);
        start = i + 1;
      } else {
        const end = text.indexOf('}', i);
        out.push({ selector: head, body: text.slice(i + 1, end), under: [...stack] });
        i = end;
        start = i + 1;
      }
    } else if (c === '}') {
      stack.pop();
      start = i + 1;
    }
    i++;
  }
  return out;
}

describe('the page on a phone', () => {
  const html = readFileSync('index.html', 'utf8');
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? '';

  it('reaches into the notch and round corners, and leaves the player free to zoom', () => {
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
  });

  it('keeps clear of the notch and the home bar', () => {
    expect(hud).toContain('env(safe-area-inset-top');
    expect(hud).toContain('env(safe-area-inset-bottom');
    const match = rules(hud).find((r) => r.selector === '.match' && r.under.length === 0);
    expect(match?.body).toContain('var(--safe-top)');
  });

  it('never stops the board being played with a finger, nor the page from bouncing', () => {
    const scene = rules(hud).find((r) => r.selector === '#scene');
    expect(scene?.body).toMatch(/touch-action:\s*none/);
    const page = rules(hud).find((r) => r.selector.replace(/\s+/g, ' ') === 'html, body');
    expect(page?.body).toMatch(/overscroll-behavior:\s*none/);
  });
});

describe('the interface on a touch screen', () => {
  const all = [...rules(hud), ...rules(panels)];

  it('offers a draw on a phone as everywhere else', () => {
    const hidden = all.filter((r) => /\.slot-spare\b/.test(r.selector) && /display:\s*none/.test(r.body));
    expect(hidden).toEqual([]);
  });

  it('only shows what a resting pointer does where there is a pointer to rest', () => {
    // These three say again what the thing looks like anyway, so a finger leaves nothing behind.
    const restating = /\.switch-off:hover|\.moves \.latest:hover|\.moves \.viewed:hover/;
    const loose = all.filter((r) => r.selector.includes(':hover') && !restating.test(r.selector) && !r.under.some((u) => u.includes('(hover: hover)')));
    expect(loose.map((r) => r.selector)).toEqual([]);
  });

  it('sets a field large enough that a phone does not zoom in to it', () => {
    const coarse = rules(hud).filter((r) => r.under.some((u) => u.includes('(pointer: coarse)')));
    const field = coarse.find((r) => r.selector.split(',').some((s) => s.trim() === '.who input'));
    const size = Number(/font-size:\s*(\d+)px/.exec(field?.body ?? '')?.[1] ?? 0);
    expect(size).toBeGreaterThanOrEqual(16);
  });

  it('names no keys where there is no keyboard', () => {
    const coarse = rules(hud).filter((r) => r.under.some((u) => u.includes('(pointer: coarse)')));
    const hides = coarse.find((r) => r.selector.includes('.slot kbd') && /display:\s*none/.test(r.body));
    expect(hides?.selector).toContain('.tip');
  });

  it('gives a phone on its side the phone layout', () => {
    expect(hud).toContain('@media (max-width: 760px), (max-height: 500px) and (orientation: landscape)');
  });
});
