// Hero.jsx — landing log, and the stream row both it and the archive render.
// The log and the posts are one dated stream, not two. A log entry carrying a
// `slug` IS that post's blurb, so the pair collapses into a single row — title
// from the manifest, body from the log — instead of the note sitting directly
// above a near-identical post row in the archive. A post with no log entry
// falls back to its summary; a log entry with no slug is a standalone note.
// buildStream/StreamEntry go on window for Writing.jsx, which renders the same
// rows as the full archive. This file loads before it, so they're in place.
const HOME_ENTRIES = 3;

// Notes may carry a link: {text, href} — the first occurrence of `text` in the
// body becomes an anchor. Notes only: an entry with a slug is already wrapped
// in an anchor by StreamEntry, and anchors can't nest.
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

function buildStream(log, posts) {
  const all = posts || [];
  const claimed = {};
  const rows = (log || []).map((e) => {
    const post = e.slug ? all.find(p => p.slug === e.slug) : null;
    if (!post) return e;
    claimed[post.slug] = true;
    return { date: e.date, body: e.body, slug: post.slug, title: post.title };
  });
  all.forEach((p) => {
    if (!claimed[p.slug]) rows.push({ date: p.date, body: p.summary, slug: p.slug, title: p.title });
  });
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function StreamEntry({ entry }) {
  const inner = (
    <React.Fragment>
      <span className="sz-log-date">{entry.date}</span>
      <div>
        {entry.title && <h3 className="sz-log-title">{entry.title}</h3>}
        <p className="sz-log-body">{logBody(entry)}</p>
      </div>
    </React.Fragment>
  );
  return entry.slug
    ? <a className="sz-log-entry" href={`#/thoughts/${entry.slug}`}>{inner}</a>
    : <div className="sz-log-entry">{inner}</div>;
}

// No CTA row under the sub. It was overview / ibkr / polymarket, which is three
// of the seven destinations the nav already carries — and the nav is on screen
// at the same moment, one line above it.
function Hero() {
  const c = window.CONTENT.home;
  const stream = buildStream(c.log, window.POSTS);
  const shown = stream.slice(0, HOME_ENTRIES);
  const older = stream.length - shown.length;
  return (
    <section className="sz-hero">
      <div className="sz-hero-meta">▸ status · online · {new Date().toLocaleDateString('en-CA')}</div>
      <h1 className="sz-hero-name">{c.name}<Cursor /></h1>
      <p className="sz-hero-tag">{c.tag}</p>
      <p className="sz-hero-sub">{c.sub}</p>
      <div className="sz-log">
        {shown.map(entry => <StreamEntry key={`${entry.date}/${entry.slug || ''}`} entry={entry} />)}
        {older > 0 && <a className="sz-log-more" href="#/thoughts">{older} older →</a>}
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
window.buildStream = buildStream;
window.StreamEntry = StreamEntry;
