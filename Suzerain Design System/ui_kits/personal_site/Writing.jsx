// Writing.jsx — the thoughts archive + markdown reader
// Globals: React, Cursor, marked, window.CONTENT + window.POSTS (App.jsx),
// window.buildStream + window.StreamEntry (Hero.jsx).
// The list is the whole stream — notes and posts in one column, the same rows
// the hero log shows, minus the glass card and the cut at three.

const { useState: useWrState, useEffect: useWrEffect } = React;

function wrFmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  return `${mo} ${d}, ${y}`;
}

function WrList({ stream }) {
  const WrStreamEntry = window.StreamEntry;
  return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ thoughts</div>
      <h2 className="sz-h2">notes from the desk.</h2>
      <div className="sz-stream">
        {stream.map(entry => (
          <WrStreamEntry key={`${entry.date}/${entry.slug || ''}`} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function WrPost({ post, body }) {
  return (
    <section className="sz-prose">
      <a className="sz-post-back" href="#/thoughts">← thoughts</a>
      <div className="sz-kicker">◆ {wrFmtDate(post.date)}</div>
      <h2 className="sz-h2">{post.title}</h2>
      {body == null
        ? <p className="sz-dim">loading<Cursor /></p>
        : <div className="sz-post-body" dangerouslySetInnerHTML={{ __html: marked.parse(body) }} />}
    </section>
  );
}

function Writing({ slug }) {
  const [body, setBody] = useWrState(null);
  const [err, setErr] = useWrState(null);

  // The manifest is fetched once by App.jsx — the hero needs it too, so it
  // can't live here. App re-renders the tree when it lands.
  const posts = window.POSTS;

  // Only fetch slugs that exist in the manifest — the slug comes from the URL.
  const post = posts && slug ? posts.find(p => p.slug === slug) : null;

  useWrEffect(() => {
    setBody(null);
    if (!post) return;
    let cancelled = false;
    fetch(`data/posts/${post.slug}.md`, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('post ' + r.status); return r.text(); })
      .then(t => { if (!cancelled) setBody(t); })
      .catch(() => { if (!cancelled) setErr('post not found'); });
    return () => { cancelled = true; };
  }, [post && post.slug]);

  const fail = err || (window.POSTS_ERR ? 'posts unavailable' : null);
  if (fail) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ thoughts</div>
      <h2 className="sz-h2">{fail}.</h2>
      <a className="sz-post-back" href="#/thoughts">← thoughts</a>
    </section>
  );
  if (!posts) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ thoughts</div>
      <h2 className="sz-h2">loading<Cursor /></h2>
    </section>
  );
  if (slug && !post) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ thoughts</div>
      <h2 className="sz-h2">no such post.</h2>
      <a className="sz-post-back" href="#/thoughts">← thoughts</a>
    </section>
  );
  return post
    ? <WrPost post={post} body={body} />
    : <WrList stream={window.buildStream(window.CONTENT.home.log, posts)} />;
}

window.Writing = Writing;
