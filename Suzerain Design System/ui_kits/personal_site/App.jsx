// App.jsx — root view switcher + bootstrap
function App() {
  const [view, setView] = React.useState('hero');
  const views = {
    hero: <Hero setView={setView}/>,
    portfolio: <Portfolio/>,
    polymarket: <Polymarket/>,
    combined: <Combined setView={setView}/>,
    predictfolio: <Predictfolio/>,
    about: <About/>,
  };
  // Data-heavy views fog the city so tables stay readable.
  const dim = view === 'portfolio' || view === 'polymarket' || view === 'combined' || view === 'predictfolio';
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
