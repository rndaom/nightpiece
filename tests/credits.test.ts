/**
 * The credits and licences as the game shows them: a page made from the repository's own three
 * files, reached from the choice of game, and each typeface's licence sent beside its fonts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, inlineStyleHashes } from '../server/main.ts';
import { BRAND } from '../src/app/brand.ts';
import { CREDITS_STYLE, creditsPage, creditsPlugin, inline, licenceFile, markdown, PAGE, readLicence, readSources, SHEET, TYPEFACES } from '../tools/dev/credits.ts';

const sources = readSources('.');
const page = creditsPage(sources, BRAND.name, ['assets/libs-abc.css', SHEET]);

describe('the running text of the three files, as a page', () => {
  it('sets code, bold, italic and links', () => {
    expect(inline('**Bold**, *slanted* and `a_file.py`.')).toBe('<strong>Bold</strong>, <em>slanted</em> and <code>a_file.py</code>.');
    expect(inline('[Freesound](https://freesound.org/people/x/sounds/1/)')).toBe('<a href="https://freesound.org/people/x/sounds/1/" rel="noopener noreferrer">Freesound</a>');
    expect(inline('<https://github.com/mrdoob/three.js>')).toBe('<a href="https://github.com/mrdoob/three.js" rel="noopener noreferrer">github.com/mrdoob/three.js</a>');
  });

  it('leaves alone what only looks like markup', () => {
    expect(inline('2 < 3 & "so on"')).toBe('2 &lt; 3 &amp; &quot;so on&quot;');
    expect(inline('`*.png` and `<b>`')).toBe('<code>*.png</code> and <code>&lt;b&gt;</code>');
    expect(inline('Fraunces-Italic[SOFT,WONK,opsz,wght].ttf')).toBe('Fraunces-Italic[SOFT,WONK,opsz,wght].ttf');
  });

  it('sends a link to one of the three files to its place on the page, and one to a shipped file to the file', () => {
    expect(inline('[LICENSE](LICENSE) and [CREDITS.md](CREDITS.md)')).toBe('<a href="#licence">LICENSE</a> and <a href="#credits">CREDITS.md</a>');
    expect(inline('`engine/COPYING.txt`')).toBe('<a href="engine/COPYING.txt"><code>engine/COPYING.txt</code></a>');
    // A file of the repository that the game does not carry is named, not linked.
    expect(inline('[notes](docs/notes.md)')).toBe('notes');
  });

  it('sets headings, lists, paragraphs and tables', () => {
    const html = markdown('# One\n\nA line\nrun on.\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n## Two', 1);
    expect(html).toBe(
      '<h2>One</h2>\n<p>A line run on.</p>\n<ul><li>a</li><li>b</li></ul>\n' +
        '<div class="table"><table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>\n' +
        '<h3>Two</h3>',
    );
  });
});

describe('the page of credits and licences', () => {
  it('holds the three files whole', () => {
    // Every row of every table in CREDITS.md is a row of the page.
    const rows = sources.credits.split('\n').filter((l) => l.startsWith('|') && !/^\|[\s:|-]+$/.test(l));
    expect(rows.length).toBeGreaterThan(70);
    expect(page.match(/<tr>/g)!.length).toBe(rows.length);
    for (const name of ['three.js', 'chess.js', 'Preact', 'Stockfish 19', 'Versilian Studios', 'davjanus', 'Kinoton']) expect(page, name).toContain(name);
    // The code's licence, word for word.
    expect(page).toContain('Permission is hereby granted, free of charge');
    expect(page).toContain('THE SOFTWARE IS PROVIDED &quot;AS IS&quot;');
    // The licence for the art, the sound and the name.
    expect(page).toContain('all rights reserved');
    expect(page).toContain(`the name &quot;${BRAND.name}&quot;`);
  });

  it('leaves no markup of the files showing', () => {
    const text = page.replace(/<pre>[\s\S]*?<\/pre>/g, '').replace(/<[^>]+>/g, '');
    expect(text).not.toMatch(/\*\*|\]\(|^#|\|---|`/m);
  });

  it('links each typeface\'s licence and the engine\'s, where the build puts them', () => {
    for (const typeface of TYPEFACES) expect(page).toContain(`<a href="/${licenceFile(typeface)}">${typeface.name}</a>`);
    expect(page).toContain('href="/engine/COPYING.txt"');
    expect(page).toContain('href="/engine/SOURCE.txt"');
    expect(page).toContain(`<a class="back" href="/">Back to ${BRAND.name}</a>`);
  });

  it('names every typeface the credits name as bundled', () => {
    const bundled = sources.credits.split('### Typefaces')[1]!.split('Two more are not part of the game')[0]!;
    for (const typeface of TYPEFACES) expect(bundled).toContain(`| ${typeface.name} |`);
    expect(bundled.split('\n').filter((l) => /SIL Open Font License/.test(l)).length).toBe(TYPEFACES.length);
  });

  it('needs no allowance from the server\'s policy: nothing is written into it but links', () => {
    expect(page).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=|<base/i);
    expect(inlineStyleHashes(page)).toEqual([]);
    expect(contentSecurityPolicy()).toContain("style-src 'self'");
    expect(page).toContain(`<link rel="stylesheet" href="/${SHEET}" />`);
    // Its own look is given last, over the game's stylesheet that names the fonts.
    expect(page.indexOf('assets/libs-abc.css')).toBeLessThan(page.indexOf(`/${SHEET}`));
    expect(CREDITS_STYLE).toContain('body.credits');
  });
});

describe('the typefaces\' licences', () => {
  it('are the Open Font License, each with its typeface\'s own notice', () => {
    for (const typeface of TYPEFACES) {
      const text = readLicence('.', typeface);
      expect(text, typeface.name).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text, typeface.name).toContain(`The ${typeface.name} Project Authors`);
      expect(text, typeface.name).toContain('PERMISSION & CONDITIONS');
    }
  });

  it('are packages the game is built with', () => {
    const pack = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    const fonts = Object.keys(pack.dependencies).filter((name) => name.startsWith('@fontsource'));
    expect(TYPEFACES.map((t) => t.from).sort()).toEqual(fonts.sort());
  });

  it('are written by the build beside the fonts, with the page and its stylesheet', () => {
    const emitted = new Map<string, string>();
    const plugin = creditsPlugin(BRAND.name, '.');
    const bundle = {
      'assets/libs-x.css': { type: 'asset', fileName: 'assets/libs-x.css', source: '@font-face{font-family:"Figtree Variable"}' },
      'assets/index-y.css': { type: 'asset', fileName: 'assets/index-y.css', source: '.hud{}' },
      'assets/figtree-latin-wght-normal-D_ZTVpCC.woff2': { type: 'asset', fileName: 'assets/figtree-latin-wght-normal-D_ZTVpCC.woff2', source: new Uint8Array(4) },
    };
    const emit = { emitFile: (file: { fileName: string; source: string }) => void emitted.set(file.fileName, file.source) };
    (plugin.generateBundle as unknown as (this: typeof emit, options: unknown, bundle: unknown) => void).call(emit, {}, bundle);
    for (const typeface of TYPEFACES) {
      expect(licenceFile(typeface)).toMatch(/^assets\/[a-z-]+-LICENSE\.txt$/);
      expect(emitted.get(licenceFile(typeface))).toBe(readLicence('.', typeface));
    }
    expect(emitted.get(SHEET)).toBe(CREDITS_STYLE);
    const built = emitted.get(PAGE)!;
    expect(built).toContain('href="/assets/libs-x.css"');
    expect(built).not.toContain('index-y.css');
    expect(emitted.size).toBe(TYPEFACES.length + 2);
  });
});

describe('the way to the page', () => {
  it('is a link at the foot of the choice of game, which opens beside the game and does not end it', () => {
    const menu = readFileSync('src/ui/Menu.tsx', 'utf8');
    const link = /<a class="link" href=\{`\$\{import\.meta\.env\.BASE_URL\}credits\.html`\} target="_blank" rel="noopener">\s*Credits and licences\s*<\/a>/;
    expect(menu).toMatch(link);
    expect(PAGE).toBe('credits.html');
  });
});
