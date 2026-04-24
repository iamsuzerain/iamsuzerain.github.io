---
name: suzerain-design
description: Use this skill to generate well-branded interfaces and assets for Suzerain, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

Suzerain is a personal site brand — minimalist cyberpunk with violet ink, magenta heat, and quiet precision. Lo-fi future-noir, not neon arcade.

Key files:
- `README.md` — brand voice, visual foundations, iconography
- `colors_and_type.css` — design tokens and semantic element styles (import first)
- `preview/` — small card examples of every token and component
- `assets/` — logo (sigil, wordmark, mono variant)
- `ui_kits/personal_site/` — click-through React recreation of the site

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. Import `colors_and_type.css` to inherit the full token system.

If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts or production code.

Core rules:
- Fonts: JetBrains Mono (display/mono) + Inter Tight (body). Mono for scanning, sans for reading.
- Palette: ink backgrounds (#0a0612 base), violet-400 (#a78bfa) primary, magenta-400 (#ff4fd8) for heat.
- Voice: lowercase, first-person, terse, dry. Em-dashes over parentheses. No emoji ever — use unicode glyphs (◆ ◇ ▸ → ↗ ▋) instead.
- Motion: subtle, 220ms ease-out. No bounce, no parallax.
- Hover: shift from violet-300 to magenta-400. Active nav items prefix with `→`.
