// Hero.jsx
function Hero({ setView }) {
  return (
    <section className="sz-hero">
      <div className="sz-hero-meta">▸ status · online · 2026-04-23</div>
      <h1 className="sz-hero-name">i am suzerain.<Cursor /></h1>
      <p className="sz-hero-tag">i'm here to write the future.</p>
      <p className="sz-hero-sub">tracker live since 2026</p>
      <div className="sz-hero-cta">
        <button className="sz-btn sz-btn-primary" onClick={() => setView('portfolio')}>▸ portfolio</button>
        <button className="sz-btn sz-btn-ghost" onClick={() => setView('polymarket')}>polymarket →</button>
      </div>
      <div className="sz-log">
        <div className="sz-log-entry">
          <span className="sz-log-date">2026-04-28</span>
          <p className="sz-log-body">moved $100k from ibkr to polymarket. trying to fade this ai bubble has been a losing trade — the market just keeps believing. binary outcomes on a prediction market are a cleaner expression of the thesis anyway. if you think something resolves yes or no, just bet it directly instead of constructing a position that decays while you wait to be right.</p>
        </div>
        <div className="sz-log-entry">
          <span className="sz-log-date">2026-04-23</span>
          <p className="sz-log-body">iran situation isn't resolving. the s&p sure is trading like it's already resolved. still trading through it because sitting out is its own kind of bet, and i don't like those odds. vol is elevated, the thesis holds. staying in.</p>
        </div>
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
