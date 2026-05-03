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
          <p className="sz-log-body">moved $100k from ibkr to polymarket. the thesis was always hormuz, straits close, oil spikes, markets reprice. but equities aren't trading that. ai sentiment is eating the macro signal; every dip gets bought before the geopolitical risk can land. shorting the s&p into that is fighting two variables at once and losing on both. polymarket isolates the one i actually have a view on: if hormuz escalates, the position pays. the ai multiple doesn't get a vote. and even a ceasefire doesn't close the position. the physical bottleneck doesn't clear overnight. ships reroute, insurance reprices, capacity stays constrained for months.</p>
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
