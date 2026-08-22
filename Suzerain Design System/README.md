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

**Two registers, kept separate.** Every rule below depends on this one.

- **Interface** — nav, headings, buttons, table columns, stat kickers, meta rows. Lowercase, always: `home` · `overview` · `ibkr` · `polymarket` · `thoughts` · `about` · `qty` · `roi` · `profit by source` · `peak-to-trough` · `annualized · twr`. Not sentence case — *lower* case. A capital in the chrome reads as a slip.
- **Prose** — log entries, post bodies, summaries, the bio. Ordinary sentence case with ordinary punctuation, because it is ordinary writing: "Probably one of my weakest trading weeks of the year. Didn't recognize the oncoming train after FOMC caused a vanna push…"

Don't blend them. Lowercase prose reads affected at paragraph length; sentence-case chrome reads like a dashboard someone bought.

**The motto register, and its fence.** A third voice exists on the site and appears exactly twice: `i am suzerain. i'm here to write the future.` in the hero, and `the morning will come when the world is mine` on the about page. Sincere, grandiose, in character — the suzerain conceit speaking in its own voice rather than the author speaking about themselves.

It is allowed in a masthead or an epigraph and nowhere else. The test is whether the page underneath has to answer for the claim: the hero line sits on top of a live P&L, so the charts are the receipt — if you are bad at writing the future, the drawdown says so. A grand line in the chrome, the footer or an error state answers to nothing, which is why it curdles. The old footer prescription (`built with violets and spite`) failed this way: it read as a costume break, the author stepping out of the persona to wink at the reader. Sovereignty doesn't do bits about its own mood.

Put another way — a claim about **purpose** can go in the masthead. A claim about **temperament** goes nowhere. Everything outside those two lines stays flat: `ibkr · polymarket · volatility`, `no such post.`, `couldn't reach polymarket.`

**Headings take a terminal period.** The site's most consistent tic and the one most worth keeping:

`i am suzerain.` · `i'm here to write the future.` · `notes from the desk.` · `no such post.` · `couldn't reach polymarket.` · `couldn't build overview feed.`

The period closes the statement and stops a lowercase heading reading as a fragment. One outlier ships today: `ENDORSEMENTS.` on the politics view, the only ALL-CAPS heading on the site.

**In-progress states drop the period and take a blinking block cursor**, not an ellipsis: `fetching positions▋` · `merging feeds▋` · `loading▋`. That's `<Cursor/>`, which renders `▋`. There is not one `…` in the site's copy.

**Failures say what failed and stop.** No apology, no exclamation, no error code in the reader's face: `couldn't reach polymarket.` — not "Error: unable to connect", not "Oops!". There are **zero** exclamation marks on the site. Keep it that way.

**Proper nouns go lowercase too.** `ibkr`, `polymarket`, `spx`, `btc`, `discord`, `reddit`. Type them the way the site types them, not the way they brand themselves.

**Punctuation:** Em-dashes over parentheses — they carry more rhythm. Parentheses survive for a real gloss (`(vol, drawdown, beta)`). Watch for ` - ` creeping in as a substitute dash; three have already.

**Emoji:** None, and the site holds the line — there isn't one anywhere in the source. Use the glyphs below.

**Glyphs, ranked by the work they actually do:**

| glyph | uses | job |
|---|---|---|
| `·` | 116 | the separator, between every meta field |
| `→` | 28 | active nav prefix, direction |
| `◆` | 19 | annotation marker on a chart |
| `±` | 8 | tolerance |
| `↗` | 7 | external link |
| `▋` | 2 | in-progress cursor |

`◇ ▸ × ∴ § ↑` appear once or twice each. `∴` and `§` were listed as core ornaments and never earned it — don't reach for them.

**Numbers & dates:** ISO in the interface, always. Dates render through `toLocaleDateString('en-CA')` → `2026-08-18`; axis ticks are ISO fragments (`2026-08`, `08-18`). Prose is exempt and should be — "Tracker live since April 2026" is right in a bio. Versions are bare: `v0.5`.

There is no count convention. The nav carries no counts at all. Don't invent one.

### Examples

| Do | Don't |
|---|---|
| `ibkr · polymarket · volatility` | `Made with ❤️` |
| `couldn't reach polymarket.` | `Error: connection failed!` |
| `fetching positions▋` | `Loading, please wait…` |
| `thoughts` | `My Blog Posts (4)` |
| `↗ reddit` | `Follow me on Reddit!` |
| `peak-to-trough` | `Peak To Trough` |

### Sample copy

Real lines from the site, not illustrations.

> _hero:_ **i am suzerain.** · i'm here to write the future. · tracker live since 2026 · footer: `ibkr · polymarket · volatility`

> _about:_ heading `the morning will come when the world is mine`, then prose — "Trader since 2017. Tracker live since April 2026. Theta, volatility, prediction markets."

> _log entry:_ EOQ. Despite making 5 figures on geopolitical and election predictions, we ended up with a massive drawdown on Polymarket due to touch options on oil, a tradfi position.

> _states:_ `no such post.` · `couldn't build overview feed.` · `fetching positions▋`

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
- Both caption tiers clear 4.5:1 on glass (7.2:1 / 4.8:1) — they carry the 9–12px uppercase labels over the city photo. `#3d334f` is a divider color: never body text, never a label. The one sanctioned exception is `.sz-sep`, the inert `·` between meta fields, where it is punctuation rather than something to read.

**Series** (benchmark overlays — categorical, outside the brand ramp)
- `spx #5eead4` · `qqq #60a5fa` · `vti #4ade80` · `iwm #a3e635` · `vt #22d3ee` · `aor #facc15` · `bnd #94a3b8` · `tlt #cbd5e1` · `gld #fbbf24` · `btc #f97316`
- Ten hues, defined once in `SZ_BENCHES` (`ui_kits/personal_site/Chrome.jsx`) and grouped equity / bonds & blends / alternatives. They sit deliberately outside violet and magenta: a benchmark is the thing the book is measured *against*, so it must not wear the book's colors — a teal line is never yours.
- This is the one place the site leaves the ink/violet/magenta world, and it is a closed list. Adding an eleventh benchmark means adding a hue here, not picking one at the call site.

_Warm white fg over cool violet ink — prevents the page feeling clinical or Matrix-green._

### Type

- **Display / mono:** `JetBrains Mono` — 300/400/500/600. Used for headlines, nav, buttons, code, micro-labels. This is the brand voice.
- **Body:** `Inter Tight` — 300/400/500. Used for long-form reading.
- **Principle:** mono for anything the eye _scans_, sans for anything the eye _reads_.

**Scale.** Three tiers doing three different jobs — the site is not one ramp, and reading it as one is how the middle of it went unused.

- **Mono micro-labels — 9 / 10 / 11 / 12 px.** Uppercase, tracked `0.08–0.16em`, in `--fg-3` or `--fg-4`. The largest tier by volume: 67 of the site's 99 fixed size declarations, and 10px alone is 28 of them. Anything the eye *scans* lives here — axis ticks, stat kickers, legend keys, table headers, meta rows. 8px exists once, on the range-picker caret, where it is an ornament rather than a word; treat 9px as the floor for anything with letters in it.
- **Reading — 13 / 15 / 16 / 17 px.** Body is 15. 13px is the hinge: mono where it labels, Inter Tight where it reads.
- **Display — 18 / 22 / 26 / 30 / 44 px, plus two fluid heads.** `.sz-h2` is the fixed 44px section head. The hero name is `clamp(48px, 11vw, 120px)` and its tagline `clamp(22px, 5vw, 32px)` — the only fluid type on the site, and the only thing that goes above 44.

**The heading tier is for authored markdown, not for the interface.** No hand-written component on the site sets 20, 24, 32 or 60px — every `<h1>`/`<h2>` in the JSX carries a class that overrides them. But `.sz-post-body` styles post headings for color and margin *without* setting a size, so a `##` in a blog post falls through to the bare `h2` rule and renders at `--fs-2xl` (32px). That path is live today. `###` (24px) and `#` (60px) are unused so far but one post away from rendering.

One thing to fix before it bites: `h1` is 60px while `.sz-h2` — the post's own title — is 44px. A `#` in a post body would outrank the title above it.

84px is gone. It was the top of the old ramp and rendered nowhere in any form.

The `--fs-*` tokens are referenced only by the semantic element rules inside `colors_and_type.css`; `index.html` writes px directly. The tokens are the vocabulary, not yet the mechanism.

**Letter-spacing.** Three bands, one of which is honest drift.

- **Display:** `-0.01` to `-0.04em`, `-0.02` the common case (tight, grotesk-feeling). 10 uses.
- **Reading:** `0` to `0.02em`. Effectively neutral; 15px body sits at `0.01em`.
- **Mono caps labels:** a band from `0.04` to `0.18em`, 56 uses — and no rule decides which. 11px alone ships at `0.04`, `0.06`, `0.1`, `0.12` and `0.16em` in different components. `0.1em` is the plurality (13 uses); `--tracking-mono` (`0.14em`) is the documented value and only the fifth most common (7).

The band is not a scale, and it does not track size — it is what eleven components each picking a number looks like. **New work: use `0.1em`.** `--tracking-mono` stays at `0.14em` because two shipped rules reference it and moving it would shift them; if that ever gets reconciled, `0.1em` is the target.

### Spacing

**2-px grid, 4-px preferred:** `2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 24 · 32 · 36 · 40`. The four that carry the site are `8` and `16` (22 uses each) and `14` and `10` (19 each) — dense-data spacing, not the airy 4–8–16–24 ramp the token block describes. Odd values are a hairline nudge, not a step: 20 of 238 spacing declarations use 1/3/5/7px, and each one is nudging a border or a glyph into place.

Whitespace is still the luxury, but at *page* level — 32/40px between sections, `max-width: 760px` on reading measure, and the hero left to breathe. Inside a data panel, tight is correct: a table that cannot show you twelve rows at once has failed at the only thing it does. Never cram the page; do crowd the grid.

The spacing tokens are now **named by value** — `--s-8` is 8px, `--s-14` is 14px. They used to be named by step index, so `--s-2` meant 8px and the ramp implied the in-between values didn't exist. `--s-10` (128px) is gone; nothing on the site is that far apart.

### Backgrounds

The hero and about views sit over a **full-bleed city-window photo** (`assets/window-view.jpg`) — a rain-slick night skyline seen from an apartment window — behind a blurred glass wash, with a slow drifting cloud-glow and a rain/trickle layer for depth. On data-heavy views (portfolio, polymarket, combined) the photo is dimmed back (`.sz-dim`) so tables stay legible. It's the _one_ big image — everything else is texture.

Supporting layers, lightest first:
1. **Flat ink** — `#0a0612`. The base beneath everything.
2. **Dot matrix** — 24px grid of `rgba(167,139,250,0.06)` dots. Barely visible; texture without competing.
3. **Violet aurora glow** — a soft radial `rgba(167,139,250,0.18)` in one corner.

**Never**: a _second_ competing full-bleed image, gradient meshes as a primary reading surface, or neon-arcade saturation. Keep photography cool and violet-shifted — see _Imagery color vibe_.

### Cards & borders

Cards are `var(--ink-3)` fills with `1px solid var(--ink-4)` borders and a `3px` radius — just enough to not be brutalist, nowhere near "friendly." Shadows are almost never used on cards; elevation comes from the `inner-glow` (a 1px inset violet line at 15% alpha).

**Radii:** two, and only two. `--r-1` (**3px**) on every cornered surface — panels, cards, badges, menus, buttons, code — and `--r-pill` on the few capsules. That is 23 uses against 1.

`--r-0`, `--r-3` (8px) and `--r-4` (12px) have been removed — nothing in the design system referenced them. `--r-2` (4px) survives because `preview/_card.css` frames the preview cards with it; it is chrome, not a site value.

Note there is no 2px radius: `--r-1` is **3**, and a badge sitting inside a panel inside a menu is why all three share one value rather than stepping.

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
- **Footer:** a single mono line of plain nouns — `ibkr · polymarket · volatility`. No copyright line, no build boast, no "made with". The footer names what the site is about and stops.
- **Single column.** Sidebars are allowed once per page max, and must be ≤ 240px.

---

## Iconography

**Primary system:** [Lucide](https://lucide.dev) — thin-stroke line icons (1.5px stroke, 24×24 default). Loaded from CDN via `<script src="https://unpkg.com/lucide@latest">` or imported as individual SVGs into `assets/icons/`.

**Size scale:** 14 (inline-with-text), 16 (button), 20 (nav), 24 (default), 32 (feature). Never smaller than 14.

> The personal site ships **no icons at all** — no Lucide, no `assets/icons/`. Every mark on it is a unicode glyph from the list below, set in JetBrains Mono. This section is the rule for kits that need icons; it is not a description of the site.

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
