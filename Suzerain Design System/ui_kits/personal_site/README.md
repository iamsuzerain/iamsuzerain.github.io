# Personal Site UI Kit

Interactive recreation of the Suzerain personal site. Open `index.html` to use the click-through prototype.

## Components

- `Chrome.jsx` — page shell: grid background, cursor glow, blinking cursor, decode-in text hook
- `Nav.jsx` — horizontal mono nav with active `→` indicator
- `Hero.jsx` — landing: big wordmark, tagline, status line
- `About.jsx` — prose page, max-width reading column
- `Projects.jsx` — project list with filter tags and inner-glow cards
- `Writing.jsx` — writing index with mono date column, tag row
- `Contact.jsx` — terminal-style contact panel + social links

## Sections

Hero → About → Projects → Writing → Contact. Each is a view switched via nav. No routing library; a single `view` state in the root.
