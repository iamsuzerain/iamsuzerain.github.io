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

## Views

Landing is the log (`Hero`); the nav switches between `about`, `portfolio`, `polymarket`, and `combined`. No routing library; a single `view` state in the root.
