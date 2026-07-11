// Hero.jsx
// Log entries may carry a link: {text, href} — the first occurrence of
// `text` in the body becomes an anchor (used to point at full posts).
function logBody(entry) {
  const l = entry.link;
  if (!l || !l.text || !entry.body.includes(l.text)) return entry.body;
  const i = entry.body.indexOf(l.text);
  return (
    <React.Fragment>
      {entry.body.slice(0, i)}
      <a href={l.href}>{l.text}</a>
      {entry.body.slice(i + l.text.length)}
    </React.Fragment>
  );
}

function Hero({ setView }) {
  const c = window.CONTENT.home;
  return (
    <section className="sz-hero">
      <div className="sz-hero-meta">▸ status · online · {new Date().toLocaleDateString('en-CA')}</div>
      <h1 className="sz-hero-name">{c.name}<Cursor /></h1>
      <p className="sz-hero-tag">{c.tag}</p>
      <p className="sz-hero-sub">{c.sub}</p>
      <div className="sz-hero-cta">
        <button className="sz-btn" style={{ borderColor: 'transparent' }} onClick={() => setView('combined')}>▸ overview</button>
        <button className="sz-btn sz-btn-ghost" onClick={() => setView('portfolio')}>ibkr →</button>
        <button className="sz-btn sz-btn-ghost" onClick={() => setView('polymarket')}>polymarket →</button>
      </div>
      <div className="sz-log">
        {c.log.map((entry, i) => (
          <div key={i} className="sz-log-entry">
            <span className="sz-log-date">{entry.date}</span>
            <p className="sz-log-body">{logBody(entry)}</p>
          </div>
        ))}
      </div>

      <div className="sz-hero-footer">
        <span>ibkr </span>
        <span className="sz-sep">·</span>
        <span>polymarket </span>
        <span className="sz-sep">·</span>
        <span>volatility</span>
      </div>
    </section>
  );
}
window.Hero = Hero;
