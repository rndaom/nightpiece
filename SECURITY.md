# Security

## Reporting a vulnerability

Please report a vulnerability privately, not in a public issue. Use GitHub's private vulnerability reporting: on the repository at <https://github.com/rndaom/nightpiece>, open the **Security** tab and choose **Report a vulnerability**. Say what you found, how to reproduce it, and what it lets someone do.

You will get an answer as soon as the author can give one. Please give a reasonable time to fix a problem before saying anything about it in public.

## What is in scope

- The game's server in `server/`: its WebSocket protocol, the rooms, seats and clocks, ratings, rate and connection limits, and the headers it sends.
- The game in the browser (`src/`), including anything that lets one player affect another's browser.
- The live game at <https://nightpiece-production.up.railway.app>, so far as it runs this code. Please do not run load tests, or anything that disturbs other players, against it.

Out of scope: weaknesses in third-party libraries (report those to their authors, though a way they can be used against this game is in scope), and the Stockfish engine itself.

## Bounty

There is no bounty. Reports are welcome and will be credited if you wish.
