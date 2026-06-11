// Nav.jsx — horizontal mono nav
const { useState: useNavState } = React;

function Nav({ view, setView }) {
  const items = [
    { id: 'hero', label: 'home' },
    { id: 'combined', label: 'overview' },
    { id: 'portfolio', label: 'ibkr' },
    { id: 'polymarket', label: 'polymarket' },
    { id: 'about', label: 'about' },
  ];
  return (
    <nav className="sz-nav">
      <button className="sz-brand" onClick={() => setView('hero')}>
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
      </button>
      <div className="sz-nav-items">
        {items.slice(1).map((it) => (
          <button
            key={it.id}
            className={`sz-nav-item ${view === it.id ? 'active' : ''}`}
            onClick={() => setView(it.id)}
          >
            {view === it.id && <span className="sz-nav-arrow">→ </span>}
            {it.label}
          </button>
        ))}
      </div>
      <div className="sz-nav-meta">◆ {new Date().getFullYear()} · {(window.CONTENT && window.CONTENT.version) || 'v0.5'}</div>
    </nav>
  );
}

window.Nav = Nav;
