# Suzerain — Design System

> A personal site design system. Minimalist cyberpunk: deep violet ink, magenta heat, quiet precision. More _lo-fi future-noir_ than neon arcade.

---

## Brand context

**Suzerain** is the personal online presence of a single person — not a SaaS product, not a company. The name carries weight (a suzerain is a sovereign that holds authority over a vassal state without absorbing it) — fitting for a personal domain where the owner runs the whole thing, their way.

The aesthetic takes cues from **lo-fi cyberpunk illustration**: rain-slick Tokyo alleyways, apartment-window cityscapes at 3:06 AM, neon kanji reflected in glass, a cat in silhouette. Not the aggressive Blade Runner/_Cyberpunk 2077_ version — the _Shinkai-adjacent, ChilledCow, "synthwave at 2am"_ version. Intimate. Quiet. Considered.

### Sources referenced
- **Mood board** — `assets/reference/mood-board.png` (user-provided, anime lo-fi cyberpunk interior/exterior scene)
- No codebase, no Figma. The system is defined from scratch against the mood board + user direction (`minimalist, cyberpunk, violet`, intensity ≈ 20/100).

### Products represented
1. **Personal website** — hero, about, projects, writing index, contact. See `ui_kits/personal_site/`.

---

## Content fundamentals

**Voice:** First person. Dry. Competent. A little terse — the way a senior engineer writes their own notes. Never marketing-speak. Never "we're passionate about…"

**Casing:** Sentence case everywhere. Headings, buttons, nav. Never title case. Never ALL CAPS except for tiny mono labels (`→ SELECTED`, `◆ NOTE`), where caps become a visual flag rather than shouting.

**Punctuation:**
- Em-dashes over parentheses — they carry more rhythm.
- Lowercase sentences in mono labels. No terminal period on micro-copy.
- Ellipsis for in-progress states: `compiling…`, `loading…`

**Emoji:** None. Use unicode glyphs as typographic ornaments instead: `◆ ◇ ▸ → ∴ §`. An unadorned `—` does more work than any emoji.

**Numbers & dates:** ISO-ish. `2026-04-23` beats "April 23rd." `v0.4.1` beats "version 0.4.1." Counts use a `/` pair: `03 / 12` reads better than "3 of 12."

### Examples

| Do | Don't |
|---|---|
| `about — a few things I make and think about` | `About Me 🙂` |
| `writing / 04 posts` | `My Blog Posts (4)` |
| `↗ mastodon` | `Follow me on Mastodon!` |
| `built with violets and spite` | `Made with ❤️` |
| `currently — rewriting the compiler` | `What I'm working on right now 🚀` |

### Sample copy

> _hero:_ **suzerain** — a small sovereign territory on the open web. notes, projects, things unfinished.

> _project card:_ `ginkgo` — a tiny static site generator in rust. built because hugo's mental model never stuck. v0.3 ships when it ships.

> _404:_ the page you're looking for is in another castle. or maybe never existed. ◆

---

## Visual foundations

### Palette

**Ink** (surfaces, backgrounds)
- `#050309` void · `#0a0612` base · `#120c1f` raised · `#1a1230` card · `#241a3f` border

**Violet** (primary scale — the voice of the brand)
- `50 #f3f0ff` … `300 #b9a0ff` · **`400 #a78bfa` PRIMARY** · `500 #8b5cf6` · `700 #6d28d9` · `900 #2e1065`

**Magenta** (data only — never interaction)
- `300 #ff8de4` · **`400 #ff4fd8` HOT** · `500 #e11d87`
- On the personal site, pink means *drawn P&L* and nothing else: `--mark-pos` (gains) against `--mark-neg` violet (losses). Hover, selection and focus are all violet. A pink pixel is data, never "you can click this".

**Foreground** (text)
- `#f5f0ff` primary · `#c4b5d4` secondary · `#a99bc0` tertiary · `#8b7aa8` quietest · `#3d334f` divider
- Both caption tiers clear 4.5:1 on glass (7.2:1 / 4.8:1) — they carry 10–11px uppercase labels over the city photo. `#3d334f` is a divider colour and must never be used for text.

_Warm white fg over cool violet ink — prevents the page feeling clinical or Matrix-green._

### Type

- **Display / mono:** `JetBrains Mono` — 300/400/500/600. Used for headlines, nav, buttons, code, micro-labels. This is the brand voice.
- **Body:** `Inter Tight` — 300/400/500. Used for long-form reading.
- **Principle:** mono for anything the eye _scans_, sans for anything the eye _reads_.

**Scale:** 11 / 13 / 15 / 17 / 20 / 24 / 32 / 44 / 60 / 84 px. Body is 15. Display caps at 84 (used once per page, for the name).

**Letter-spacing:**
- Display: `-0.02em` (tight, grotesk-feeling)
- Mono caps labels: `0.14em` (wide, flagged)
- Everything else: `0`

### Spacing

4-px base grid: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128`. Generous whitespace is the main luxury of this design. Never cram.

### Backgrounds

The hero and about views sit over a **full-bleed city-window photo** (`assets/window-view.jpg`) — a rain-slick night skyline seen from an apartment window — behind a blurred glass wash, with a slow drifting cloud-glow and a rain/trickle layer for depth. On data-heavy views (portfolio, polymarket, combined) the photo is dimmed back (`.sz-dim`) so tables stay legible. It's the _one_ big image — everything else is texture.

Supporting layers, lightest first:
1. **Flat ink** — `#0a0612`. The base beneath everything.
2. **Dot matrix** — 24px grid of `rgba(167,139,250,0.06)` dots. Barely visible; texture without competing.
3. **Violet aurora glow** — a soft radial `rgba(167,139,250,0.18)` in one corner.

**Never**: a _second_ competing full-bleed image, gradient meshes as a primary reading surface, or neon-arcade saturation. Keep photography cool and violet-shifted — see _Imagery color vibe_.

### Cards & borders

Cards are `var(--ink-3)` fills with `1px solid var(--ink-4)` borders and `2–4px` radius — just enough to not be brutalist, nowhere near "friendly." Shadows are almost never used on cards; elevation comes from the `inner-glow` (a 1px inset violet line at 15% alpha).

**Radii:** `0 / 2 / 4 / 8 / 12 / pill`. Default is `4px`. Use `0` for terminal-style panels. Use `pill` only for tags/badges.

### Hover, press, focus

- **Hover (links):** color shifts from `violet-300` → `magenta-400`. Border-bottom appears. No size change.
- **Hover (buttons):** `background-color` crossfades one shade lighter. The primary button grows a `glow-violet` shadow at 35% alpha.
- **Hover (cards):** border → `violet-400` at 50% alpha. `translateY(-1px)` is permitted but not required.
- **Press:** `scale(0.98)` over 80ms. No flash.
- **Focus-visible:** `1px` violet outline with `3px` offset. Never a 2px rounded outline — too web-forms.

### Motion

- **Easing:** `cubic-bezier(0.22, 1, 0.36, 1)` for most things (a precise ease-out). Spring-like feels wrong here.
- **Durations:** 120 / 220 / 420 / 800 ms. Most interactions use 220.
- **Signature moves:**
  1. **Cursor glow** — a 200px soft violet radial gradient tracks the cursor on the hero only. Opacity 0.2.
  2. **Decode-in text** — on load or reveal, display text scrambles through a few mono glyphs before resolving (~400ms). Used on the name and section headers only. Not body copy.
  3. **Blink cursor** — a magenta `▋` that blinks `1s` at the end of the hero tagline.

**Never**: parallax, bounce easings, entrance animations on every element, sticky nav that hides on scroll.

### Transparency & blur

A deliberate motif here — the frosted glass _is_ the interface sitting over the city photo. The nav strip, the reading panels (about, log, post body), and the data cards / stat tiles all use `backdrop-filter: blur()` over semi-transparent ink (`rgba(10,6,18,0.45–0.7)`). Keep it to these surfaces; no blurred modals, and never so heavy that text loses contrast against the photo.

### Imagery color vibe

If photography is used, it should be **cool, slightly desaturated, violet-shifted in shadows**. Grain welcome (fine, ~3% noise). Warm skin tones are OK — they become the single warm element in the frame.

### Layout rules

- **Max content width:** 720px for reading, 1080px for project grids, 1200px absolute max.
- **Side margins:** 48px desktop, 20px mobile. Generous.
- **Nav:** single row, left-aligned, mono-cased lowercase. No logo in the nav (the page _is_ the logo). Active state = `→` prefix.
- **Footer:** a single mono line. `© 2026 · suzerain · built with violets and spite`
- **Single column.** Sidebars are allowed once per page max, and must be ≤ 240px.

---

## Iconography

**Primary system:** [Lucide](https://lucide.dev) — thin-stroke line icons (1.5px stroke, 24×24 default). Loaded from CDN via `<script src="https://unpkg.com/lucide@latest">` or imported as individual SVGs into `assets/icons/`.

**Size scale:** 14 (inline-with-text), 16 (button), 20 (nav), 24 (default), 32 (feature). Never smaller than 14.

**Color:** `currentColor`. Icons inherit text color. Violet/magenta hover comes from the parent link rule, not the icon.

**Stroke:** always 1.5 or 2, never 1. Keeps them visible at small size on dark backgrounds.

**Fill:** rare. A filled icon is a _state indicator_ (the star is filled = starred). Default is line.

### Unicode glyphs (used as typographic marks)

These are part of the iconography and appear throughout the system:

| Glyph | Use |
|---|---|
| `◆` | section mark, selected state |
| `◇` | unselected, empty state |
| `▸` | prompt prefix (`▸ status:` ) |
| `→` | active nav item, link outbound |
| `↗` | external link |
| `▋` | blinking cursor |
| `·` | separator (`2026 · suzerain`) |
| `§` | footnote, meta |
| `∴` | therefore / conclusion |

**Emoji:** never. Not in UI, not in copy, not in commit messages (aspirationally).

**Custom SVG logos** (in `assets/`)
- `logo-sigil.svg` — the mark alone (gradient)
- `logo-sigil-mono.svg` — single-color variant
- `logo-wordmark.svg` — sigil + "suzerain" + cursor block

---

## Index

```
/
├── README.md                 — this file
├── SKILL.md                  — cross-compatible skill definition
├── assets/
│   ├── logo-sigil.svg        — gradient mark
│   ├── logo-sigil-mono.svg   — mono mark
│   ├── logo-wordmark.svg     — mark + wordmark
│   ├── window-view.jpg       — city-window hero photo
│   └── reference/
│       └── mood-board.png    — user-provided mood reference
├── preview/                  — Design System tab preview cards (16; import the canonical CSS)
│   ├── palette-ink.html
│   ├── palette-violet.html
│   ├── palette-magenta.html
│   ├── type-display.html
│   ├── type-body.html
│   ├── type-mono-labels.html
│   ├── spacing.html
│   ├── radii.html
│   ├── shadows-glows.html
│   ├── buttons.html
│   ├── fields.html
│   ├── cards.html
│   ├── nav.html
│   ├── badges.html
│   ├── logo.html
│   └── glyphs.html
├── screenshots/              — rendered captures of the live site
├── uploads/                  — scratch reference material
└── ui_kits/
    └── personal_site/        — the live site (gh-pages deploy root)
        ├── README.md
        ├── index.html        — click-thru prototype + all view styles
        ├── colors_and_type.css — design tokens + semantic styles (canonical copy; site + previews both import this)
        ├── App.jsx           — root view switcher, hash routing, bootstrap
        ├── Chrome.jsx        — shared layout / cursor glow / rain / grid bg
        ├── Nav.jsx
        ├── Hero.jsx          — landing hero + activity log/feed
        ├── About.jsx
        ├── Portfolio.jsx     — IBKR portfolio view
        ├── Polymarket.jsx    — Polymarket P&L view
        ├── Combined.jsx      — combined IBKR + Polymarket overview
        ├── Writing.jsx       — thoughts index + post reader
        ├── data/             — content.json, portfolio.json, polymarket-*.json, benchmarks.json, posts/
        └── scripts/          — data refreshers (ibkr-flex, polymarket-pnl, betmoar-breakdown, benchmarks) + new-post.py
```

---

## Notes & caveats

- The project was started without a codebase or Figma, so every visual decision is **proposed, not inherited**. Everything here is negotiable in a second pass.
- **Fonts are Google-served** (JetBrains Mono, Inter Tight). If you want locally hosted TTFs for production, drop them into `fonts/` and adjust `@font-face`.
- **One photographic asset ships:** `assets/window-view.jpg`, the city-window hero backdrop. Hero and about sit directly on it; data views dim it back. Beyond this single image, texture comes from the dot-matrix + aurora tokens, not stock imagery.
