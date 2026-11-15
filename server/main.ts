/**
 * The game's server: a small web server for the built game, and a WebSocket
 * endpoint at /ws that runs the rooms.
 *
 *     npm run build
 *     npm run serve                 (http://127.0.0.1:8787, this machine only)
 *     npm run serve -- --host 0.0.0.0 --port 8787     (reachable from the network you are on)
 *
 * It listens on this machine only unless told otherwise. Putting it on the
 * public internet is a decision for whoever runs it.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, type Stats, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIPv6 } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { BRAND } from '../src/app/brand.ts';
import { parseClientMessage, type ServerMessage } from '../src/net/protocol.ts';
import { type Connection, Lobby } from './rooms.ts';
import { Scores } from './scores.ts';
import { RoomStore } from './store.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * The kinds of file that travel a good deal smaller squeezed: the page, the code, the engine and
 * the models (the room's model goes at about a quarter of its size). Pictures and sound are
 * packed already and are sent as they are.
 */
const SQUEEZED = new Set(['.html', '.js', '.css', '.json', '.wasm', '.glb', '.svg', '.txt', '.webmanifest', '.xml']);
/** Below this a file fits in one packet either way, and squeezing it saves nothing. */
const SQUEEZE_FROM = 1400;
/** How much squeezed copy is kept in memory at most. The whole built game squeezes to a fraction of this. */
const SQUEEZE_KEPT = 96 * 1024 * 1024;

type Coding = 'br' | 'gzip';

/** The best way of squeezing that a browser says it can undo, or null if it names none we use. */
export function codingFor(accepts: string | string[] | undefined): Coding | null {
  const offered = new Set<string>();
  for (const part of (Array.isArray(accepts) ? accepts.join(',') : (accepts ?? '')).split(',')) {
    const [name, ...rest] = part.toLowerCase().split(';').map((piece) => piece.trim());
    const refused = rest.some((r) => /^q\s*=\s*0(\.0*)?$/.test(r));
    if (name && !refused) offered.add(name);
  }
  return offered.has('br') ? 'br' : offered.has('gzip') ? 'gzip' : null;
}

/**
 * Squeezed copies of the game's files, made the first time each is asked for and kept: a file is
 * squeezed once for however many visitors, and again only when it changes (its mark changes with it).
 */
class Squeezer {
  private kept = new Map<string, { mark: string; body: Promise<Buffer>; size: number }>();
  private total = 0;

  copy(file: string, mark: string, size: number, coding: Coding): Promise<Buffer> {
    const key = `${coding} ${file}`;
    const have = this.kept.get(key);
    if (have && have.mark === mark) return have.body;
    if (have) this.forget(key);
    const body = new Promise<Buffer>((resolve, reject) => {
      const done = (error: Error | null, out: Buffer) => (error ? reject(error) : resolve(out));
      let raw: Buffer;
      try {
        raw = readFileSync(file);
      } catch (error) {
        reject(error);
        return;
      }
      if (coding === 'br') brotliCompress(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 6, [zlib.BROTLI_PARAM_SIZE_HINT]: size } }, done);
      else gzip(raw, { level: 6 }, done);
    });
    const entry = { mark, body, size: 0 };
    this.kept.set(key, entry);
    body.then(
      (out) => {
        if (this.kept.get(key) !== entry) return;
        entry.size = out.length;
        this.total += out.length;
        // Over the limit, the copies made longest ago go first.
        for (const old of this.kept.keys()) {
          if (this.total <= SQUEEZE_KEPT || old === key) break;
          this.forget(old);
        }
      },
      () => {
        if (this.kept.get(key) === entry) this.kept.delete(key);
      },
    );
    return body;
  }

  private forget(key: string): void {
    const entry = this.kept.get(key);
    if (!entry) return;
    this.total -= entry.size;
    this.kept.delete(key);
  }
}

/**
 * What the game's own pages may do, sent with every answer. Everything comes from the server
 * itself, and only these exceptions are made, each one found needed by loading the game in a
 * browser under a stricter rule and watching what it refused:
 * - script 'wasm-unsafe-eval': the chess engine is WebAssembly, which a browser compiles only with this;
 * - img data: the room's grain and a few marks in the stylesheets are small pictures written into them;
 * - style, by hash: the card shown to a visitor without JavaScript carries its own look, and that
 *   one block of style (and nothing else written into the page) is allowed by the hash of its text.
 * No other site may frame the game, be sent its address, or be posted to.
 */
export function contentSecurityPolicy(styleHashes: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `style-src 'self'${styleHashes.map((hash) => ` '${hash}'`).join('')}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The hashes of the blocks of style written into a page, as a Content-Security-Policy names them. */
export function inlineStyleHashes(page: string): string[] {
  return [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => `sha256-${createHash('sha256').update(m[1]!).digest('base64')}`);
}

/** The headers every answer carries, beside its policy. */
const SECURITY_HEADERS: Record<string, string> = {
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
};

/** How many messages a connection may send in a burst, and how many more it earns each second. */
const BURST = 40;
const PER_SECOND = 10;
/** How often each connection is sent a word to show the line is still up, in milliseconds. */
const TICK_EVERY = 15000;
/**
 * How many connections one address may hold at once when the server is run from the command line.
 * Room for a household or an office behind one address, and for a room full of watchers; not for a flood.
 */
const PER_ADDRESS = 60;
/** A connection that has this much waiting to be sent to it is not reading what it is sent: it is dropped. */
const MOST_UNSENT = 256 * 1024;
/** How often a connection's `sync` is answered, at most, in milliseconds. More are not answered. */
const SYNC_EVERY = 1000;
/**
 * Rooms written down by the server that ran before are taken up again only if it stopped this
 * recently. A new version is put up in seconds; a server down for longer than this has lost its
 * players, and a game taken up after so long would only be lost by whoever did not come back.
 */
const ROOMS_KEPT_FOR = 60 * 60 * 1000;
/**
 * How often the server writes that it is still running, while there are rooms: a clock left
 * running at a crash is charged up to about then, and the rooms are known to be that fresh.
 */
const ALIVE_EVERY = 2000;
/** How often the rooms are written down afresh (if anything has changed), and the journal begun again; and sooner if it has grown this large. */
const CHECKPOINT_EVERY = 30 * 1000;
const JOURNAL_MOST = 8 * 1024 * 1024;

/**
 * The address a connection is counted by. An IPv6 visitor is usually given a whole block of
 * addresses (a /64) and could take a new one for every connection, so the block is what counts.
 */
export function addressKey(address: string): string {
  let a = address.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return mapped[1]!;
  if (!isIPv6(a)) return a;
  a = a.toLowerCase();
  // An address that ends in the dotted IPv4 form has its last two groups written that way.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [x, y, z, w] = dotted.slice(1).map(Number) as [number, number, number, number];
    a = a.slice(0, dotted.index) + ((x << 8) | y).toString(16) + ':' + ((z << 8) | w).toString(16);
  }
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = tail === null ? front : [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g || '0', 16).toString(16))
    .join(':')}::/64`;
}

/** Say in one line, to whoever runs the server, that something went wrong: what and where in the code, never what a visitor sent or who they are. */
function report(what: string, error: unknown): void {
  const e = error instanceof Error ? error : null;
  const at = e?.stack?.split('\n').find((line) => line.trim().startsWith('at '))?.trim() ?? '';
  const line = `${what}: ${e ? `${e.name}: ${e.message}` : 'something that was not an error was thrown'}${at ? ` (${at})` : ''}`;
  console.error(line.replace(/\s+/g, ' ').slice(0, 300));
}

/** A file to be sent, if the path names one. A folder stands for the page inside it. */
function find(file: string): { file: string; stats: Stats } | null {
  try {
    let stats = statSync(file);
    if (stats.isDirectory()) {
      file = path.join(file, 'index.html');
      stats = statSync(file);
    }
    return stats.isFile() ? { file, stats } : null;
  } catch {
    // Not there, or gone since it was looked for (a rebuild under a running server).
    return null;
  }
}

/**
 * Whether a file's name was made from its contents by the bundler, so that a browser may keep it
 * for ever. Only the bundler's own output folder holds such files; a name elsewhere that merely
 * looks like one (the engine's loader does) must be asked for again each visit.
 */
function namedByContents(root: string, file: string): boolean {
  const relative = path.relative(root, file).split(path.sep).join('/');
  return /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css|woff2?)$/.test(relative);
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Folder of the built game to serve. If it does not exist, only /ws works. */
  root?: string;
  /** Web addresses, other than the server's own, whose pages may open a game connection (for example "https://example.org"). */
  allowOrigins?: string[];
  /** How often each connection is sent a word to show the line is up, in milliseconds. */
  tick?: number;
  /** The file the ranked scores are kept in. Left out, they last as long as the server does. */
  scoresFile?: string;
  /**
   * The server stands behind a proxy that passes on the visitor's address (as hosts that run
   * it for you do). Then the address the proxy names is the one counted, not the proxy's own.
   */
  behindProxy?: boolean;
  /** How many connections one address may hold at once. Left out, there is no limit. */
  perAddress?: number;
  /**
   * The file the rooms are kept in, with a journal of their changes beside it (see server/store.ts):
   * every change is written down before anyone is told of it, and the rooms are taken up again when
   * the server next starts (if it stopped within the last hour). Left out, games end with the server.
   */
  roomsFile?: string;
  /** Words no player's name may contain, in small letters. */
  blockedNames?: string[];
  /** A file of more such words, one to a line (a line starting with # is a note), read once at the start. It need not exist. */
  blockedNamesFile?: string;
  /** How many rooms there may be at once. */
  maxRooms?: number;
}

export interface Running {
  server: Server;
  lobby: Lobby;
  port: number;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions = {}): Promise<Running> {
  const root = path.resolve(options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist'));
  const scores = new Scores(options.scoresFile ?? null);
  // Words the operator will not have in a name: those given, and those in the file, so that more can be added without a change to the code.
  const blockedNames = [...(options.blockedNames ?? [])];
  if (options.blockedNamesFile) {
    try {
      for (const line of readFileSync(options.blockedNamesFile, 'utf8').split(/\r?\n/)) {
        const word = line.trim().toLowerCase();
        if (word && !word.startsWith('#')) blockedNames.push(word);
      }
    } catch {
      // No list: no words beyond the few the game reserves.
    }
  }
  const lobby = new Lobby(Date.now, scores, { ...(options.maxRooms ? { maxRooms: options.maxRooms } : {}), blockedNames });
  // The games that were being played when the server last stopped, if it stopped lately; and from
  // now on, every change to them written down as it happens.
  const store = options.roomsFile ? new RoomStore(options.roomsFile) : null;
  if (store) {
    const saved = store.load();
    // A little in the future is a clock set differently on this machine, not a reason to lose every game.
    const age = saved ? Date.now() - Number(saved.savedAt) : Number.NaN;
    if (saved && Math.abs(age) < ROOMS_KEPT_FOR) {
      const taken = lobby.restore(saved);
      console.log(`${taken === 1 ? 'One game' : `${taken} games`} taken up again from before the restart.`);
    }
    lobby.track();
    // The rooms as taken up are the start of the new journal: what was read is not read again. If
    // it cannot be written, it is tried again every few seconds (below), and said.
    store.checkpoint(lobby.save());
  }
  /**
   * What the rooms say to their connections is held back while they are acting on something, until
   * what changed has been written down: a move the server has said it accepted is never one a
   * crash can take back. Then it goes out, in the order it was said.
   */
  let acting = 0;
  const outbox: (() => void)[] = [];
  const later = (deliver: () => void) => (acting > 0 ? outbox.push(deliver) : deliver());
  // The ratings are not written here: a game counted carries what it did to them in its room, and
  // they are put right from that if the server stops before they are written (`Lobby.restore`).
  const writeDown = () => {
    if (!store) return;
    store.write(lobby.changes(), Date.now());
    if (store.bytes > JOURNAL_MOST) store.checkpoint(lobby.save());
  };
  const act = (what: () => void) => {
    acting++;
    try {
      what();
    } finally {
      if (--acting === 0) {
        try {
          writeDown();
        } catch (error) {
          report('The rooms could not be written down', error);
        }
        for (const deliver of outbox.splice(0)) deliver();
      }
    }
  };
  const held = new Map<string, number>();
  const perAddress = options.perAddress ?? Number.POSITIVE_INFINITY;
  const header = (request: IncomingMessage, name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value.join(',') : value;
  };
  const addressOf = (request: IncomingMessage): string => {
    if (options.behindProxy) {
      // A host with several proxies in a row names the visitor here. The list below would end with
      // one of its own proxies, and every visitor would then be counted as the same few addresses.
      const real = header(request, 'x-real-ip')?.trim();
      if (real) return addressKey(real);
      // Otherwise the last address in the list is the one the nearest proxy saw; the earlier ones are whatever the visitor claimed.
      const named = header(request, 'x-forwarded-for')?.split(',').pop()?.trim();
      if (named) return addressKey(named);
    }
    return addressKey(request.socket.remoteAddress || 'unknown');
  };
  /** The headers every answer carries; and, for a page the visitor reached over HTTPS (as the proxy in front says), a word to keep to HTTPS. */
  let page = '';
  try {
    page = readFileSync(path.join(root, 'index.html'), 'utf8');
  } catch {
    // Nothing built yet: no page, and nothing written into it to allow.
  }
  const headers = { ...SECURITY_HEADERS, 'content-security-policy': contentSecurityPolicy(inlineStyleHashes(page)) };
  const secured = (request: IncomingMessage): Record<string, string> =>
    options.behindProxy && header(request, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https'
      ? { ...headers, 'strict-transport-security': 'max-age=31536000' }
      : headers;

  const squeezer = new Squeezer();
  const server = createServer((request, response) => {
    const safe = secured(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, safe).end();
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400, safe).end();
      return;
    }
    // Only ever a file inside the built game's folder.
    let file = path.resolve(root, '.' + path.posix.normalize('/' + relative));
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403, safe).end();
      return;
    }
    // An address that is not a file is the game itself, which reads the room from the address.
    const found = find(file) ?? (path.extname(relative) ? null : find(path.join(root, 'index.html')));
    if (!found) {
      response.writeHead(404, { ...safe, 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    // A mark that changes when the file does, so that a browser asking again is told "you have it" and sent nothing.
    const etag = `W/"${found.stats.size.toString(16)}-${Math.round(found.stats.mtimeMs).toString(16)}"`;
    const kind = path.extname(found.file).toLowerCase();
    const squeezes = SQUEEZED.has(kind) && found.stats.size >= SQUEEZE_FROM;
    const headers: Record<string, string> = {
      ...safe,
      'content-type': TYPES[kind] ?? 'application/octet-stream',
      'cache-control': namedByContents(root, found.file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
    };
    // Whatever stands between the server and a browser must not hand one browser's squeezed copy to another that cannot undo it.
    if (squeezes) headers.vary = 'accept-encoding';
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers).end();
      return;
    }
    const whole = () => {
      response.writeHead(200, { ...headers, 'content-length': found.stats.size });
      if (request.method === 'HEAD') response.end();
      // `pipeline` closes the file however the transfer ends. A plain pipe leaves it open when the
      // browser goes away part of the way through, and a server that runs out of files stops.
      else pipeline(createReadStream(found.file), response, () => {});
    };
    const coding = squeezes ? codingFor(request.headers['accept-encoding']) : null;
    if (!coding) {
      whole();
      return;
    }
    squeezer.copy(found.file, etag, found.stats.size, coding).then(
      (body) => {
        if (response.destroyed) return;
        response.writeHead(200, { ...headers, 'content-encoding': coding, 'content-length': body.length });
        response.end(request.method === 'HEAD' ? undefined : body);
      },
      // The file went, or would not squeeze: it is sent as it is, or reported missing, as it would have been.
      () => {
        if (response.destroyed) return;
        if (find(found.file)) whole();
        else response.writeHead(404, { ...safe, 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      },
    );
  });
  // A visitor who opens a connection and then says nothing, or very slowly, is not waited for long.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;

  const sockets = new WebSocketServer({
    server,
    path: '/ws',
    // Messages are a line of JSON; nothing legitimate is anywhere near this size.
    maxPayload: 2048,
    // A page on some other site must not be able to open a connection from a visitor's browser.
    // Programs that are not browsers send no origin and are let through.
    verifyClient: ({ origin, req }, answer) => {
      let allowed = !origin || options.allowOrigins?.includes(origin) === true;
      if (!allowed) {
        try {
          allowed = new URL(origin).host === req.headers.host;
        } catch {
          allowed = false;
        }
      }
      if (!allowed) return answer(false, 403, 'Forbidden');
      if ((held.get(addressOf(req)) ?? 0) >= perAddress) return answer(false, 429, 'Too many connections');
      answer(true);
    },
  });
  sockets.on('connection', (socket, request) => {
    const address = addressOf(request);
    held.set(address, (held.get(address) ?? 0) + 1);
    const connection: Connection = {
      address,
      send(message: ServerMessage) {
        later(() => {
          if (socket.readyState !== socket.OPEN) return;
          // A connection that does not read what it is sent would have it piled up here without end.
          if (socket.bufferedAmount > MOST_UNSENT) return socket.terminate();
          socket.send(JSON.stringify(message));
        });
      },
      close(code, reason) {
        later(() => socket.close(code, reason));
      },
    };
    let lastSync = Number.NEGATIVE_INFINITY;
    let alive = true;
    let budget = BURST;
    const refill = setInterval(() => (budget = Math.min(BURST, budget + PER_SECOND)), 1000);
    // A page cannot see the pings below, so it is also sent a word it can see: if those stop
    // coming, it knows the line has gone quiet and makes a new one.
    const tick = setInterval(() => connection.send({ t: 'tick' }), options.tick ?? TICK_EVERY);
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 25000);
    socket.on('pong', () => (alive = true));
    socket.on('message', (data, isBinary) => {
      // A client that floods is dropped; one that sends nonsense is ignored.
      if (--budget < 0) return socket.close(1008, 'Too many messages');
      if (isBinary) return;
      const message = parseClientMessage(String(data));
      if (!message) return;
      // Asking for the whole room over and over costs the server far more than it costs the asker: once a second is plenty.
      if (message.t === 'sync') {
        const now = Date.now();
        if (now - lastSync < SYNC_EVERY) return;
        lastSync = now;
      }
      try {
        act(() => lobby.handle(connection, message));
      } catch (error) {
        // Something the server did not expect: this connection goes, the server and everyone else carry on.
        report('A message could not be handled', error);
        socket.close(1011, 'Something went wrong');
      }
    });
    socket.on('close', () => {
      clearInterval(refill);
      clearInterval(heartbeat);
      clearInterval(tick);
      const left = (held.get(address) ?? 1) - 1;
      if (left > 0) held.set(address, left);
      else held.delete(address);
      try {
        act(() => lobby.leave(connection));
      } catch (error) {
        report('A connection could not be closed cleanly', error);
      }
    });
    socket.on('error', () => socket.terminate());
  });
  // The socket server repeats the web server's errors as its own. They are dealt with below, once.
  sockets.on('error', () => {});

  const sweeping = setInterval(() => {
    try {
      act(() => lobby.sweep());
    } catch (error) {
      report('The rooms could not be swept', error);
    }
  }, 60000);
  // Clocks that have run out, and players who have gone and not come back.
  const timing = setInterval(() => {
    try {
      act(() => lobby.tick());
    } catch (error) {
      report('The clocks could not be looked at', error);
    }
  }, 1000);
  // While there are rooms, a word every two seconds that the server is still running; and whatever
  // has been written, put on the disk.
  // A journal that could not be begun, or written to, is begun again as soon as it can be.
  const living = setInterval(() => {
    if (!store) return;
    try {
      if (store.wanting) store.checkpoint(lobby.save());
    } catch (error) {
      report('The rooms could not be written', error);
    }
    if (lobby.roomCount > 0) store.alive(Date.now());
    store.sync();
  }, ALIVE_EVERY);
  const checkpointing = setInterval(() => {
    if (!store || store.bytes === 0) return;
    try {
      store.checkpoint(lobby.save());
    } catch (error) {
      report('The rooms could not be written', error);
    }
  }, CHECKPOINT_EVERY);

  /** The last word before the server stops: the ratings, and every room as it stands this moment. Nothing is written after it. */
  const stopWriting = () => {
    scores.flush();
    if (!store) return;
    try {
      const saved = lobby.save();
      store.checkpoint(saved);
      if (saved.rooms.length > 0) console.log(`${saved.rooms.length === 1 ? 'One game' : `${saved.rooms.length} games`} written down, to be taken up again after the restart.`);
    } catch (error) {
      report('The rooms could not be written', error);
    }
    store.close();
  };

  return new Promise((resolve, reject) => {
    const stopTimers = () => {
      for (const timer of [sweeping, timing, living, checkpointing]) clearInterval(timer);
    };
    const failed = (error: Error) => {
      stopTimers();
      store?.close();
      reject(error);
    };
    server.once('error', failed);
    server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => {
      // Started: from now on an error is said and lived through, not a reason the start failed.
      server.off('error', failed);
      server.on('error', (error) => report('The web server had a problem', error));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 8787);
      resolve({
        server,
        lobby,
        port,
        close: () =>
          new Promise<void>((done) => {
            stopTimers();
            stopWriting();
            for (const client of sockets.clients) client.terminate();
            sockets.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

/** Whether this file is what was run, and not merely imported. Both paths are followed through any links on the way. */
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Run from the command line. */
if (isEntryPoint()) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const host = arg('host') ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(arg('port') ?? process.env.PORT ?? 8787);
  const allowOrigins = (arg('allow-origin') ?? process.env.ALLOW_ORIGIN)?.split(',').map((s) => s.trim());
  // Where the ranked scores are kept: a folder that outlives a restart, if the host gives one.
  const dataDir = arg('data') ?? process.env.DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../data');
  const behindProxy = process.argv.includes('--behind-proxy') || process.env.BEHIND_PROXY === '1';
  const perAddress = Number(arg('per-address') ?? process.env.PER_ADDRESS ?? PER_ADDRESS);
  const maxRooms = Number(arg('max-rooms') ?? process.env.MAX_ROOMS ?? 0) || undefined;
  startServer({
    host,
    port,
    scoresFile: path.join(dataDir, 'scores.json'),
    roomsFile: path.join(dataDir, 'rooms.json'),
    // Words the operator will not have in a name: one to a line, in small letters, in a file beside the scores.
    blockedNamesFile: path.join(dataDir, 'blocked-names.txt'),
    behindProxy,
    perAddress,
    ...(maxRooms ? { maxRooms } : {}),
    ...(allowOrigins ? { allowOrigins } : {}),
  }).then(
    (running) => {
      // Asked to stop (a new version is being put up): write the scores, and the games being played, first.
      // Everything is written down at once, before the connections are let go; a download still
      // going is not waited for long.
      for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.once(signal, () => {
          setTimeout(() => process.exit(0), 3000).unref();
          void running.close().then(() => process.exit(0));
        });
      const everywhere = host === '0.0.0.0' || host === '::';
      console.log(`${BRAND.name} is being served at http://${everywhere ? 'localhost' : host}:${running.port}/`);
      console.log(everywhere ? 'It can be reached from other machines on this network.' : 'It can be reached from this machine only.');
    },
    (error: unknown) => {
      console.error('The server could not start:', error);
      process.exit(1);
    },
  );
}
