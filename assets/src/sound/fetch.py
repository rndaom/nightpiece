"""
Gets the recordings that build.py makes the game's sounds from, into assets/src/sound/cache/.

  python assets/src/sound/fetch.py [--list other/sources.json]

sources.json lists every recording build.py opened: where it is kept, and the SHA-256 it had.
(`--list` reads another such list instead: the promotional film's music keeps its own, tools/promo/sources.json.)
Each is fetched only if it is not already here, and is kept only if it is the same file. Some
come out of a zip of many; the one wanted is found in it by what it contains, not by its name.
The recordings are not kept in git (about 120 MB); CREDITS.md says whose they are.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def get(url: str) -> bytes:
    # A path with spaces or a '#' in it has to be spelt out for the request.
    parts = urllib.parse.urlsplit(url)
    url = urllib.parse.urlunsplit(parts._replace(path=urllib.parse.quote(urllib.parse.unquote(parts.path))))
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (sound fetch script)'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def main() -> int:
    rows = json.load(open(sys.argv[sys.argv.index('--list') + 1] if '--list' in sys.argv else os.path.join(HERE, 'sources.json')))
    cache = sys.argv[sys.argv.index('--to') + 1] if '--to' in sys.argv else CACHE
    zips: dict[str, bytes] = {}
    got = had = failed = 0
    for row in rows:
        dest = os.path.join(cache, row['file'])
        if os.path.exists(dest) and sha(open(dest, 'rb').read()) == row['sha256']:
            had += 1
            continue
        try:
            url = row['url']
            if urllib.parse.urlsplit(url).path.lower().endswith('.zip'):
                if url not in zips:
                    zips[url] = get(url)
                with zipfile.ZipFile(io.BytesIO(zips[url])) as z:
                    data = next((d for d in (z.read(name) for name in z.namelist() if not name.endswith('/')) if sha(d) == row['sha256']), None)
                if data is None:
                    raise ValueError('none of the files in the zip is the one wanted')
            else:
                data = get(url)
                if sha(data) != row['sha256']:
                    raise ValueError('what was fetched is not the file that was used')
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            open(dest, 'wb').write(data)
            got += 1
            print('fetched', row['file'], flush=True)
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f'could not fetch {row["file"]} from {row["url"]}: {error}', flush=True)
    print(f'{got} fetched, {had} already here, {failed} could not be had')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
