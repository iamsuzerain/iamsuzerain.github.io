# Personal Site UI Kit

Interactive recreation of the Suzerain personal site. Open `index.html` to use the click-through prototype.

## Components

These are the components loaded by `index.html` (via `<script type="text/babel">`) and switched through its `view` state:

- `Chrome.jsx` — page shell: grid background, cursor glow, blinking cursor, decode-in text hook
- `Nav.jsx` — horizontal mono nav with active `→` indicator
- `Hero.jsx` — landing log/feed (the default `hero` view)
- `About.jsx` — prose page, max-width reading column
- `Portfolio.jsx` — IBKR portfolio view (chart + holdings)
- `Polymarket.jsx` — Polymarket P&L view
- `Combined.jsx` — combined IBKR + Polymarket overview
- `Writing.jsx` — `thoughts` view: post list + markdown reader (self-fetches `data/posts/`)
- `App.jsx` — root: hash router + view switcher; loads `content.json` and mounts the tree

## Views

No routing library — `App` parses `window.location.hash` (`#/view`, or `#/thoughts/<slug>` for a post) into a `{ view, param }` and re-parses on `hashchange`, so views and posts have shareable URLs. Landing is the log (`Hero`); the nav switches between `about`, `portfolio`, `polymarket`, `combined`, and `thoughts`.

The shell paints immediately with placeholder content; `App` fetches `content.json` after first paint and re-renders to fill in `Hero`/`About`.
