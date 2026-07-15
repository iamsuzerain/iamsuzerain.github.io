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
    fetch('data/content.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => { window.CONTENT = data; bumpContent(t => t + 1); })
      .catch(() => {});
  }, []);
  const setView = (v) => { window.location.hash = v === 'hero' ? '/' : `/${v}`; };
  const views = {
    hero: <Hero setView={setView}/>,
    portfolio: <Portfolio/>,
    polymarket: <Polymarket/>,
    combined: <Combined setView={setView}/>,
    about: <About/>,
    thoughts: <Writing slug={route.param}/>,
  };
  const view = views[route.view] ? route.view : 'hero';
  // Data-heavy views fog the city so tables stay readable.
  const dim = view === 'portfolio' || view === 'polymarket' || view === 'combined';
  return (
    <Chrome cursorGlow={view==='hero'} dim={dim}>
      <Nav view={view} setView={setView} />
      {views[view]}
    </Chrome>
  );
}

// Render the shell immediately; App loads content.json and re-renders when it lands.
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
