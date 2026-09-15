// App.jsx — root view switcher + bootstrap
// Hash routing (#/view or #/thoughts/slug) so views and posts have shareable URLs.

// Two views used to answer to a route key that was not the word in the nav:
// `combined` was labelled "overview" and `portfolio` was labelled "ibkr". That
// divergence was invisible while the nav was made of buttons; now that the nav
// is real links the URL is on show — in the status bar on hover, in a copied
// address, in the tab a middle-click opens — so the key is the label. The old
// keys stay readable here because they were live URLs: anything already
// bookmarked, or linked from a post, still lands on the right view instead of
// falling through to the hero.
//
// `overview` then became `book`: the page is the whole book, with ibkr and
// polymarket as its parts, and it carries more analysis than either of them —
// "overview" undersold it as a summary to skim on the way to the detail.
const ROUTE_ALIASES = { combined: 'book', overview: 'book', portfolio: 'ibkr' };

function parseRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const raw = parts[0] || 'hero';
  return {
    view: ROUTE_ALIASES[raw] || raw,
    param: parts[1] ? decodeURIComponent(parts[1]) : null,
  };
}

// What each route calls itself in the tab strip. Same words as the nav, so a
// history entry and the link that made it read the same. `hero` is null: the
// landing page is the site, and "suzerain · suzerain" says nothing twice.
const ROUTE_TITLES = {
  hero: null,
  book: 'book',
  ibkr: 'ibkr',
  polymarket: 'polymarket',
  records: 'records',
  politics: 'politics',
  thoughts: 'thoughts',
  about: 'about',
};

// Safe defaults so the shell can paint before content.json lands (or if it fails).
// Only home.log and about.links are indexed/mapped at render; the rest read as
// undefined and render empty until content arrives.
window.CONTENT = window.CONTENT || { about: { links: [] }, home: { log: [] }, projects: [] };
// The log and the post manifest are merged into one stream (see Hero.jsx), so
// both load here rather than inside a view: the hero needs the posts to render
// a post row, and the archive needs the log to render a note. Null until it
// lands; POSTS_ERR distinguishes "still loading" from "never arriving".
window.POSTS = window.POSTS || null;

function App() {
  const [route, setRoute] = React.useState(parseRoute);
  // The tick is read as well as written now: a post names the tab after itself,
  // and it can only do that once the manifest it is named in has landed.
  const [contentTick, bumpContent] = React.useState(0);
  React.useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Load content after first paint, then re-render to fill it in.
  React.useEffect(() => {
    const bump = () => bumpContent(t => t + 1);
    window.szJson('data/content.json')
      .then(data => { window.CONTENT = data; bump(); })
      .catch(() => {});
    window.szJson('data/posts/index.json')
      .then(data => { window.POSTS = data.posts; bump(); })
      .catch(() => { window.POSTS_ERR = true; bump(); });
  }, []);
  const setView = (v) => { window.location.hash = v === 'hero' ? '/' : `/${v}`; };
  // Keys are the words in the nav; the components keep their own names.
  const views = {
    hero: <Hero/>,
    ibkr: <Portfolio/>,
    polymarket: <Polymarket/>,
    book: <Combined setView={setView}/>,
    records: <Records/>,
    politics: <Politics scope={route.param}/>,
    about: <About/>,
    thoughts: <Writing slug={route.param}/>,
  };
  const view = views[route.view] ? route.view : 'hero';
  // Data-heavy views fog the city so tables stay readable.
  const dim = view === 'ibkr' || view === 'polymarket' || view === 'book' || view === 'records' || view === 'politics';
  // Every route is a shareable URL, so every route needs a name. Without this the
  // tab strip, the history menu and every bookmark read "suzerain" and none of
  // them can tell a post from the ibkr charts.
  React.useEffect(() => {
    // A post is titled from the manifest, which arrives after first paint — so
    // until it does the section name stands in. Never the slug: that is a URL,
    // and the reader can already see the URL.
    const post = (view === 'thoughts' && route.param && window.POSTS)
      ? window.POSTS.find(p => p.slug === route.param)
      : null;
    const name = post ? post.title : ROUTE_TITLES[view];
    document.title = name ? `${name} · suzerain` : 'suzerain';
  }, [view, route.param, contentTick]);

  // The key restarts the animation on every route change — including
  // thoughts/<slug> to thoughts/<other-slug>, which is the same view.
  return (
    <Chrome cursorGlow={view==='hero'} dim={dim}>
      <Nav view={view} />
      <div className="sz-view-in" key={`${view}/${route.param || ''}`}>
        {views[view]}
      </div>
    </Chrome>
  );
}

// Render the shell immediately; App loads content.json and re-renders when it lands.
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
