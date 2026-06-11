// Writing.jsx — post list + markdown reader
// Globals: React, Cursor, marked

const { useState: useWrState, useEffect: useWrEffect } = React;

function wrFmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  return `${mo} ${d}, ${y}`;
}

function WrList({ posts }) {
  return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ thoughts</div>
      <h2 className="sz-h2">notes from the desk.</h2>
      <ul className="sz-post-list">
        {posts.map(p => (
          <li key={p.slug} className="sz-post-row">
            <a href={`#/thoughts/${p.slug}`}>
              <span className="sz-post-date">{p.date}</span>
              <span className="sz-post-title">{p.title}</span>
              <span className="sz-post-summary">{p.summary}</span>
            </a>
          </li>
        ))}
      </ul>
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
  const [posts, setPosts] = useWrState(null);
  const [body, setBody] = useWrState(null);
  const [err, setErr] = useWrState(null);

  useWrEffect(() => {
    fetch('data/posts/index.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => setPosts(d.posts))
      .catch(() => setErr('posts unavailable'));
  }, []);

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

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ thoughts</div>
      <h2 className="sz-h2">{err}.</h2>
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
  return post ? <WrPost post={post} body={body} /> : <WrList posts={posts} />;
}

window.Writing = Writing;
