// Writing.jsx
const POSTS = [
  { date: '2026-04-28', title: 'moving $100k from ibkr to polymarket', tags: ['trading','notes'], read: '3 min' },
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
          </li>
        ))}
      </ol>
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
