// Nav.jsx — horizontal mono nav
const { useState: useNavState } = React;

// The nav sticks at top:16px inside a stage padded 24px, so it detaches at 8px
// of scroll. Past that it is floating over content instead of over the hero and
// needs to firm up. React.* rather than the destructured hooks in Chrome.jsx —
// the production build wraps each component in its own IIFE, so those aren't
// in scope here even though they are when Babel runs the sources directly.
function useStuck(threshold = 8) {
  const [stuck, setStuck] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return stuck;
}

// True while the reader is scrolling down past the first screen, false as soon
// as they scroll back up. The class it sets only has styles at the phone
// breakpoint, where the sticky nav costs a sixth of the screen; on desktop it
// toggles on an element with no rule for it. The 6px dead band keeps a resting
// thumb's jitter from flickering the nav.
function useScrollingDown(after = 160) {
  const [down, setDown] = React.useState(false);
  React.useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y < after) setDown(false);
      else if (y > last + 6) setDown(true);
      else if (y < last - 6) setDown(false);
      else return;
      last = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [after]);
  return down;
}

// Views are hash routes, so every nav destination already has a URL. Rendering
// them as <a href> rather than <button onClick> costs nothing and hands back the
// things people expect a link to do: middle-click and cmd-click to a new tab,
// right-click to copy the address, the destination in the status bar on hover.
// The hash assignment a click used to make is what the browser does natively on
// following the href, and App's hashchange listener routes it either way.
function navHref(id) { return id === 'hero' ? '#/' : '#/' + id; }

function Nav({ view }) {
  const stuck = useStuck();
  const scrollingDown = useScrollingDown();
  // On a phone the items share one row that scrolls sideways, so the current
  // view can sit off the right edge; center it in the strip (the browser clamps
  // at either end), which keeps it clear of the edge fade. A no-op wherever the
  // row fits, which is every desktop width.
  const itemsRef = React.useRef(null);
  // Again once the web fonts land: on a cold load the first pass measures the
  // fallback face, and the mono swap widens every label enough to push the last
  // item back under the fade.
  React.useEffect(() => {
    let live = true;
    const center = () => {
      const strip = itemsRef.current;
      const active = live && strip && strip.querySelector('.sz-nav-item.active');
      if (!active || strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft = active.offsetLeft - strip.offsetLeft
        - (strip.clientWidth - active.offsetWidth) / 2;
    };
    center();
    if (document.fonts) document.fonts.ready.then(center);
    return () => { live = false; };
  }, [view]);
  // Whatever view is mounted publishes its $/% switch into Chrome.jsx's slot;
  // the nav hosts it so the control rides the scroll rather than sitting in a
  // panel head the reader has long since scrolled past. Null on views without
  // one. Unguarded because Chrome.jsx always loads first — a hook can't be
  // called conditionally anyway.
  const unit = window.useUnitSlot();
  const NavUnitToggle = window.UnitToggle;
  const items = [
    { id: 'hero', label: 'home' },
    { id: 'book', label: 'book' },
    { id: 'ibkr', label: 'ibkr' },
    { id: 'polymarket', label: 'polymarket' },
    { id: 'politics', label: 'politics' },
    { id: 'thoughts', label: 'thoughts' },
    { id: 'about', label: 'about' },
  ];
  return (
    <nav className={`sz-nav ${stuck ? 'sz-nav-stuck' : ''} ${scrollingDown ? 'sz-nav-away' : ''}`}>
      <a className="sz-brand" href={navHref('hero')}>
        <svg width="22" height="22" viewBox="0 0 64 64" fill="none" aria-hidden>
          <defs>
            <linearGradient id="ng" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#c4b5fd"/>
              <stop offset="0.5" stopColor="#a78bfa"/>
              <stop offset="1" stopColor="#ff4fd8"/>
            </linearGradient>
            <clipPath id="nav-moon">
              <circle cx="32" cy="32" r="24"/>
            </clipPath>
          </defs>
          <circle cx="32" cy="32" r="24" stroke="#a78bfa" strokeWidth="1.5" fill="none"/>
          <g clipPath="url(#nav-moon)" transform="rotate(-15 32 32)">
            <rect x="-8" y="-8" width="40" height="80" fill="url(#ng)"/>
          </g>
        </svg>
        <span>suzerain</span>
        <Cursor />
      </a>
      <div className="sz-nav-items" ref={itemsRef}>
        {items.slice(1).map((it) => (
          <a
            key={it.id}
            className={`sz-nav-item ${view === it.id ? 'active' : ''}`}
            href={navHref(it.id)}
            aria-current={view === it.id ? 'page' : undefined}
          >
            {view === it.id && <span className="sz-nav-arrow">→ </span>}
            {it.label}
          </a>
        ))}
      </div>
      {unit && NavUnitToggle && (
        <div className="sz-nav-unit">
          {unit.note && <span className="sz-nav-unit-note">{unit.note}</span>}
          <NavUnitToggle value={unit.value} onChange={unit.onChange}/>
        </div>
      )}
    </nav>
  );
}

window.Nav = Nav;
