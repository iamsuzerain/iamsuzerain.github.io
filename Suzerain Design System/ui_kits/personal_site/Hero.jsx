// Hero.jsx
function Hero({ setView }) {
  const c = window.CONTENT.home;
  return (
    <section className="sz-hero">
      <div className="sz-hero-meta">▸ status · online{c.log[0] ? ` · ${c.log[0].date}` : ''}</div>
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
            <p className="sz-log-body">{entry.body}</p>
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
