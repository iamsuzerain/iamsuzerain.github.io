// Writing.jsx
const LOG = [
  { date: '2026-04-23', body: "iran situation isn't resolving. the s&p sure is trading like it's already resolved. still trading through it because sitting out is its own kind of bet, and i don't like those odds. vol is elevated, the thesis holds. staying in." },
];

const POSTS = [
  { date: '2026-04-28', title: 'moving $100k from ibkr to polymarket', tags: ['trading','notes'], read: '3 min', body: 'moved $100k from ibkr to polymarket. the thesis was always hormuz, straits close, oil spikes, markets reprice. but equities aren\'t trading that. ai sentiment is eating the macro signal; every dip gets bought before the geopolitical risk can land. shorting the s&p into that is fighting two variables at once and losing on both. polymarket isolates the one i actually have a view on: if hormuz escalates, the position pays. the ai multiple doesn\'t get a vote. and even a ceasefire doesn\'t close the position. the physical bottleneck doesn\'t clear overnight. ships reroute, insurance reprices, capacity stays constrained for months.' },
  { date: '2026-03-18', title: 'on suzerainty', tags: ['essay'], read: '8 min' },
  { date: '2026-02-04', title: 'the compiler as autobiography', tags: ['compilers','essay'], read: '12 min' },
  { date: '2025-12-30', title: 'notes on kyoto in winter', tags: ['places'], read: '4 min' },
  { date: '2025-11-12', title: 'why personal websites outlast platforms', tags: ['web','essay'], read: '6 min' },
  { date: '2025-09-02', title: 'rust without the ceremony', tags: ['rust','notes'], read: '9 min' },
  { date: '2025-07-21', title: 'small tools, long half-lives', tags: ['notes'], read: '3 min' },
  { date: '2025-05-04', title: 'what a static site generator owes you', tags: ['web'], read: '7 min' },
  { date: '2025-02-18', title: 'on leaving the group chat', tags: ['essay'], read: '5 min' },
];

function Writing() {
  return (
    <section className="sz-reading">
      <div className="sz-kicker">◆ writing / {POSTS.length.toString().padStart(2,'0')}</div>
      <h2 className="sz-h2">what i've published here.</h2>
      <p className="sz-dim">chronological, newest first. nothing is ever quite finished.</p>
      <ol className="sz-posts">
        {POSTS.map((p, i) => (
          <li key={i} className="sz-post">
            <span className="sz-post-date">{p.date}</span>
            <a className="sz-post-title" href="#">{p.title}</a>
            <span className="sz-post-tags">
              {p.tags.map(t => <span key={t} className="sz-tag sz-tag-quiet">{t}</span>)}
            </span>
            <span className="sz-post-read">{p.read}</span>
            {p.body && <p className="sz-post-body">{p.body}</p>}
          </li>
        ))}
      </ol>
      <div className="sz-log">
        {LOG.map((e, i) => (
          <div key={i} className="sz-log-entry">
            <div className="sz-log-date">{e.date}</div>
            <p className="sz-log-body">{e.body}</p>
          </div>
        ))}
      </div>
      <div className="sz-rss">
        <span>▸ subscribe</span>
        <a href="#">↗ rss / atom</a>
        <span className="sz-sep">·</span>
        <a href="#">↗ email digest</a>
      </div>
    </section>
  );
}
window.Writing = Writing;
