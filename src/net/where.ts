/** Where the game's server is: the one named when the game was built, or else the one that served the page. */
export function serverUrl(): string {
  const named = import.meta.env.VITE_GAME_SERVER as string | undefined;
  if (named) return named;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** An address on the same server for an ordinary request, such as `/api/lobby`. */
export function apiUrl(path: string): string {
  const url = new URL(serverUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '') + path;
  url.search = url.hash = '';
  return url.href;
}
