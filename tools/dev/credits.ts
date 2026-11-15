/**
 * The page of credits and licences, and the typefaces' licences beside the fonts.
 *
 * The page is made from the three files a reader of the repository has (CREDITS.md, LICENSE and
 * LICENSE-ASSETS.md), so that what the game says of itself cannot drift from them. The build
 * writes it as credits.html with its own stylesheet, and writes each typeface's licence, as its
 * package carries it, into the folder the fonts are built into. The dev server answers for the
 * same addresses.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** The typefaces the game bundles: the name its font files begin with, and the package that carries its licence. */
export const TYPEFACES: { file: string; name: string; from: string }[] = [
  { file: 'fraunces', name: 'Fraunces', from: '@fontsource-variable/fraunces' },
  { file: 'archivo', name: 'Archivo', from: '@fontsource-variable/archivo' },
  { file: 'figtree', name: 'Figtree', from: '@fontsource-variable/figtree' },
  { file: 'dm-mono', name: 'DM Mono', from: '@fontsource/dm-mono' },
];

/** Where a typeface's licence is put: beside its font files, under a name that sorts with them. */
export function licenceFile(typeface: { file: string }): string {
  return `assets/${typeface.file}-LICENSE.txt`;
}

export const PAGE = 'credits.html';
export const SHEET = 'credits.css';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The files of the repository that the page holds itself, and the files shipped with the game: a link to one goes there. */
const PLACES: Record<string, string> = {
  LICENSE: '#licence',
  'CREDITS.md': '#credits',
  'LICENSE-ASSETS.md': '#assets',
  'engine/COPYING.txt': 'engine/COPYING.txt',
};

function anchor(href: string, inner: string): string {
  const to = PLACES[href] ?? href;
  // Only an address on the web or a place the page knows is made a link; anything else is left as it was written.
  if (!/^https?:\/\//.test(to) && !(href in PLACES)) return inner;
  const away = /^https?:\/\//.test(to) ? ' rel="noopener noreferrer"' : '';
  return `<a href="${escape(to)}"${away}>${inner}</a>`;
}

/** One line of Markdown's running text: code, links, bold and italic. */
export function inline(text: string): string {
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = text;
  // Code first, so that nothing inside it is read as anything else.
  s = s.replace(/`([^`]+)`/g, (_, code: string) => keep(code in PLACES ? anchor(code, `<code>${escape(code)}</code>`) : `<code>${escape(code)}</code>`));
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => keep(anchor(url, escape(url.replace(/^https?:\/\//, '')))));
  s = escape(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, words: string, href: string) => anchor(href.replace(/&amp;/g, '&'), words));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * As much of Markdown as the three files use: headings, paragraphs, lists and tables. Headings are
 * set `deeper` levels down, so that each file's title can stand under the page's own.
 */
export function markdown(source: string, deeper = 0): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length + deeper);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      out.push(
        '<div class="table"><table><thead><tr>' +
          head.map((c) => `<th scope="col">${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*-\s+/, ''));
      out.push('<ul>' + items.map((item) => `<li>${inline(item)}</li>`).join('') + '</ul>');
      continue;
    }
    const words: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6})\s/.test(lines[i]!) && !lines[i]!.trim().startsWith('|') && !/^\s*-\s+/.test(lines[i]!)) words.push(lines[i++]!.trim());
    out.push(`<p>${inline(words.join(' '))}</p>`);
  }
  return out.join('\n');
}

export interface Sources {
  credits: string;
  licence: string;
  assets: string;
}

/** The three files, read from the repository's root. */
export function readSources(root: string): Sources {
  const read = (name: string) => readFileSync(path.join(root, name), 'utf8');
  return { credits: read('CREDITS.md'), licence: read('LICENSE'), assets: read('LICENSE-ASSETS.md') };
}

/** A typeface's licence, as its package carries it. */
export function readLicence(root: string, typeface: { from: string }): string {
  return readFileSync(path.join(root, 'node_modules', typeface.from, 'LICENSE'), 'utf8');
}

/**
 * The page. `sheets` are the stylesheets it is given, the page's own last; `base` is the address
 * the game is served from. Nothing is written into the page but links to them: no style and no
 * script, so that it needs no allowance of its own from the server's policy.
 */
export function creditsPage(sources: Sources, name: string, sheets: string[], base = '/'): string {
  const shipped = [
    ...TYPEFACES.map((t) => `<li><a href="${base}${licenceFile(t)}">${escape(t.name)}</a>: the SIL Open Font License 1.1, with the typeface's own notice</li>`),
    `<li><a href="${base}engine/COPYING.txt">Stockfish</a>: the GNU General Public License, version 3, and <a href="${base}engine/SOURCE.txt">where its source is</a></li>`,
  ];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#090b07" />
    <link rel="icon" type="image/svg+xml" href="${base}favicon.svg" />
${sheets.map((sheet) => `    <link rel="stylesheet" href="${base}${escape(sheet)}" />`).join('\n')}
    <title>Credits and licences · ${escape(name)}</title>
  </head>
  <body class="credits">
    <main>
      <nav><a class="back" href="${base}">Back to ${escape(name)}</a></nav>
      <article id="credits">
${markdown(sources.credits)}
      </article>
      <article id="shipped">
<h1>Licences sent with the game</h1>
<p>The full text of each licence that asks to travel with what it covers is served beside the files themselves.</p>
<ul>${shipped.join('')}</ul>
      </article>
      <article id="licence">
<h1>Licence for the code</h1>
<pre>${escape(sources.licence.trim())}</pre>
      </article>
      <article id="assets">
${markdown(sources.assets)}
      </article>
    </main>
  </body>
</html>
`;
}

/** The page's own look: the game's ink and paper, and its lettering where the game's stylesheet has been given to the page too. */
export const CREDITS_STYLE = `html { height: auto; overflow: auto; color-scheme: dark; background: #090b07; }
body.credits { height: auto; margin: 0; overflow: visible; background: #090b07; color: rgba(247, 234, 210, 0.82); font: 500 15px/1.55 'Figtree Variable', system-ui, 'Segoe UI', Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
body.credits::after { display: none; }
.credits main { max-width: 940px; margin: 0 auto; padding: 28px 20px 72px; padding-left: max(20px, env(safe-area-inset-left)); padding-right: max(20px, env(safe-area-inset-right)); }
.credits nav { margin: 0 0 26px; }
.credits a { color: #f7ead2; text-decoration: underline dashed rgba(247, 234, 210, 0.42); text-underline-offset: 3px; overflow-wrap: anywhere; }
.credits a:hover, .credits a:focus-visible { color: #59e5cc; text-decoration-color: #59e5cc; }
.credits a:focus-visible { outline: 2px solid #59e5cc; outline-offset: 3px; }
.credits a.back { font-weight: 600; }
.credits article { padding: 0 0 22px; margin: 0 0 34px; border-bottom: 1px solid rgba(247, 234, 210, 0.12); }
.credits article:last-child { border-bottom: 0; margin-bottom: 0; }
.credits h1, .credits h2, .credits h3 { color: #f7ead2; font-family: 'Fraunces Variable', Georgia, 'Times New Roman', serif; letter-spacing: -0.012em; line-height: 1.1; text-wrap: balance; }
.credits h1 { margin: 0 0 14px; font-size: 34px; font-weight: 900; }
.credits h2 { margin: 34px 0 10px; font-size: 24px; font-weight: 800; }
.credits h3 { margin: 26px 0 8px; font-size: 18px; font-weight: 700; }
.credits p, .credits ul { margin: 0 0 12px; }
.credits ul { padding-left: 20px; }
.credits li { margin: 0 0 5px; }
.credits strong { color: #f7ead2; font-weight: 700; }
.credits code { font: 400 0.88em/1.3 'DM Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace; color: #f3dba4; overflow-wrap: anywhere; }
.credits pre { margin: 0; padding: 16px; overflow-x: auto; white-space: pre-wrap; background: #10130d; border: 1px solid rgba(247, 234, 210, 0.12); color: rgba(247, 234, 210, 0.82); font: 400 12.5px/1.6 'DM Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace; }
.credits .table { margin: 0 0 16px; overflow-x: auto; }
.credits table { width: 100%; border-collapse: collapse; font-size: 13.5px; line-height: 1.4; }
.credits th { padding: 7px 10px 7px 0; text-align: left; vertical-align: bottom; color: rgba(247, 234, 210, 0.68); border-bottom: 1px solid rgba(247, 234, 210, 0.27); font: 800 10.5px/1.2 'Archivo Variable', 'Arial Black', 'Helvetica Neue', Arial, sans-serif; letter-spacing: 0.1em; text-transform: uppercase; }
.credits td { padding: 7px 10px 7px 0; vertical-align: top; border-bottom: 1px solid rgba(247, 234, 210, 0.06); }
.credits th:last-child, .credits td:last-child { padding-right: 0; }
@media (max-width: 640px) {
  .credits main { padding-top: 20px; }
  .credits h1 { font-size: 27px; }
  .credits h2 { font-size: 21px; }
  .credits table { min-width: 560px; }
}
`;

/** Writes the page, its stylesheet and the typefaces' licences into the build, and answers for them on the dev server. */
export function creditsPlugin(name: string, root = process.cwd()): Plugin {
  let base = '/';
  return {
    name: 'nightpiece-credits',
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asked = (req.url ?? '').split('?')[0]!;
        const at = asked.startsWith(base) ? asked.slice(base.length) : null;
        const send = (type: string, body: string) => {
          res.statusCode = 200;
          res.setHeader('content-type', type);
          res.end(body);
        };
        if (at === PAGE) return send('text/html; charset=utf-8', creditsPage(readSources(root), name, [SHEET], base));
        if (at === SHEET) return send('text/css; charset=utf-8', CREDITS_STYLE);
        const typeface = TYPEFACES.find((t) => licenceFile(t) === at);
        if (typeface) return send('text/plain; charset=utf-8', readLicence(root, typeface));
        next();
      });
    },
    generateBundle(_, bundle) {
      // The stylesheet that names the game's fonts is given to the page as well, so that it is set in the game's lettering.
      const fonts = Object.values(bundle)
        .filter((file) => file.type === 'asset' && file.fileName.endsWith('.css') && String(file.source).includes('@font-face'))
        .map((file) => file.fileName);
      for (const typeface of TYPEFACES) this.emitFile({ type: 'asset', fileName: licenceFile(typeface), source: readLicence(root, typeface) });
      this.emitFile({ type: 'asset', fileName: SHEET, source: CREDITS_STYLE });
      this.emitFile({ type: 'asset', fileName: PAGE, source: creditsPage(readSources(root), name, [...fonts, SHEET], base) });
    },
  };
}
