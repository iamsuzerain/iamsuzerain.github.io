// App.jsx — root view switcher + bootstrap
// Hash routing (#/view or #/thoughts/slug) so views and posts have shareable URLs.
function parseRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  return { view: parts[0] || 'hero', param: parts[1] ? decodeURIComponent(parts[1]) : null };
}

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
  const [, bumpContent] = React.useState(0);
  React.useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Load content after first paint, then re-render to fill it in.
  React.useEffect(() => {
    const bump = () => bumpContent(t => t + 1);
    fetch('data/content.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => { window.CONTENT = data; bump(); })
      .catch(() => {});
    fetch('data/posts/index.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => { window.POSTS = data.posts; bump(); })
      .catch(() => { window.POSTS_ERR = true; bump(); });
  }, []);
  const setView = (v) => { window.location.hash = v === 'hero' ? '/' : `/${v}`; };
  const views = {
    hero: <Hero/>,
    portfolio: <Portfolio/>,
    polymarket: <Polymarket/>,
    combined: <Combined setView={setView}/>,
    politics: <Politics scope={route.param}/>,
    about: <About/>,
    thoughts: <Writing slug={route.param}/>,
  };
  const view = views[route.view] ? route.view : 'hero';
  // Data-heavy views fog the city so tables stay readable.
  const dim = view === 'portfolio' || view === 'polymarket' || view === 'combined' || view === 'politics';
  // The key restarts the animation on every route change — including
  // thoughts/<slug> to thoughts/<other-slug>, which is the same view.
  return (
    <Chrome cursorGlow={view==='hero'} dim={dim}>
      <Nav view={view} setView={setView} />
      <div className="sz-view-in" key={`${view}/${route.param || ''}`}>
        {views[view]}
      </div>
    </Chrome>
  );
}

// Render the shell immediately; App loads content.json and re-renders when it lands.
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
