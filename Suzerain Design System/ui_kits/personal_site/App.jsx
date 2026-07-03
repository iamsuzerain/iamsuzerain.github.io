// App.jsx — root view switcher + bootstrap
// Hash routing (#/view or #/thoughts/slug) so views and posts have shareable URLs.
function parseRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  return { view: parts[0] || 'hero', param: parts[1] ? decodeURIComponent(parts[1]) : null };
}

function App() {
  const [route, setRoute] = React.useState(parseRoute);
  React.useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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

fetch('data/content.json', { cache: 'no-store' })
  .then(r => r.json())
  .then(data => { window.CONTENT = data; })
  .catch(() => { window.CONTENT = { about: {}, home: { log: [] }, projects: [] }; })
  .finally(() => ReactDOM.createRoot(document.getElementById('root')).render(<App/>));
