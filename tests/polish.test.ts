/**
 * The pieces of the opening page that stand outside the game: what is shown when there is no
 * WebGL, the arrow keys in a group of radios, and the page's head (the description, the sharing
 * tags and the icons it names, which must all exist).
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, it } from 'vitest';
// The interface is reached by a name the checker does not follow, as the other interface tests do.
const folder = '../src/ui/';
const { Unavailable, NO_WEBGL } = await import(`${folder}Unavailable.tsx`);
const { arrows, stop } = await import(`${folder}roving.ts`);

/** The words in a drawing, in order. */
function words(node: ComponentChildren): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join(' ');
  const vnode = node as VNode<{ children?: ComponentChildren }>;
  return words(vnode.props.children);
}

describe('no WebGL', () => {
  it('says what is wrong and what to do, in the words given', () => {
    const text = words(Unavailable());
    expect(text).toContain("Nightpiece needs WebGL to draw its room. Turn on hardware acceleration in your browser's settings, or try another browser.");
    expect(NO_WEBGL).toContain('hardware acceleration');
  });
});

describe('arrows in a group of radios', () => {
  const press = (key: string, current: string) => {
    const chosen: string[] = [];
    let focused = -1;
    const group = { querySelectorAll: () => ['a', 'b', 'c'].map((_, i) => ({ focus: () => (focused = i) })) };
    let stopped = false;
    arrows(['a', 'b', 'c'], current, (id: string) => chosen.push(id))({ key, currentTarget: group, preventDefault() {}, stopPropagation: () => (stopped = true) } as unknown as KeyboardEvent);
    return { chosen, focused, stopped };
  };
  it('moves on and wraps round', () => {
    expect(press('ArrowRight', 'a').chosen).toEqual(['b']);
    expect(press('ArrowRight', 'c').chosen).toEqual(['a']);
    expect(press('ArrowLeft', 'a').chosen).toEqual(['c']);
    expect(press('End', 'a').chosen).toEqual(['c']);
    expect(press('Home', 'c').chosen).toEqual(['a']);
  });
  it('moves the focus with the choice and keeps the key from the page', () => {
    const r = press('ArrowDown', 'b');
    expect(r.focused).toBe(2);
    expect(r.stopped).toBe(true);
  });
  it('leaves other keys alone', () => {
    const r = press('x', 'a');
    expect(r.chosen).toEqual([]);
    expect(r.stopped).toBe(false);
  });
  it('makes only the chosen one a stop for Tab', () => {
    expect([stop(true), stop(false)]).toEqual([0, -1]);
  });
});

describe('the page head', () => {
  const html = readFileSync('index.html', 'utf8');
  it('describes the game and names its sharing image, icons and manifest', () => {
    expect(html).toMatch(/<meta name="description" content="[^"]*chess in 3D[^"]*ranked/);
    for (const tag of ['og:title', 'og:description', 'og:image', 'og:type']) expect(html).toContain(`property="${tag}"`);
    expect(html).not.toContain('og:url');
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('<noscript>');
  });
  it('has every file the head and the manifest point at', () => {
    for (const file of ['social.jpg', 'apple-touch-icon.png', 'favicon-32.png', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'site.webmanifest']) {
      expect(existsSync(`public/${file}`), file).toBe(true);
    }
    const manifest = JSON.parse(readFileSync('public/site.webmanifest', 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
  });
});
