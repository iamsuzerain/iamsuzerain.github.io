// Predictfolio.jsx — embedded polymarket profile via predictfolio.com
// Globals: React

const { useState: usePfState, useEffect: usePfEffect, useRef: usePfRef } = React;

const PF_HANDLE = 'ameameameameame';
const PF_URL = `https://predictfolio.com/@${PF_HANDLE}`;

function Predictfolio() {
  const [blocked, setBlocked] = usePfState(false);
  const [loaded, setLoaded] = usePfState(false);
  const iframeRef = usePfRef(null);

  // If iframe never fires onLoad within 4s, assume X-Frame-Options block
  usePfEffect(() => {
    const t = setTimeout(() => {
      if (!loaded) setBlocked(true);
    }, 4000);
    return () => clearTimeout(t);
  }, [loaded]);

  return (
    <section className="pm-wrap">
      <div className="pm-head">
        <div>
          <div className="sz-kicker">◆ predictfolio · polymarket feed</div>
          <h2 className="sz-h2">@{PF_HANDLE}</h2>
          <p className="pm-sub">
            live positions, pnl, and trade activity, streamed from predictfolio.com —
            their analytics layer over polymarket.
          </p>
        </div>
        <div className="pm-actions">
          <a className="sz-btn sz-btn-primary" href={PF_URL} target="_blank" rel="noreferrer">
            ↗ open full profile
          </a>
        </div>
      </div>

      {!blocked ? (
        <div className="pm-frame-wrap">
          <iframe
            ref={iframeRef}
            src={PF_URL}
            className="pm-frame"
            title="predictfolio profile"
            loading="lazy"
            onLoad={() => setLoaded(true)}
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
          />
          {!loaded && (
            <div className="pm-frame-loading">
              <Cursor /> connecting to predictfolio.com…
            </div>
          )}
        </div>
      ) : (
        <div className="pm-fallback">
          <div className="pm-fb-head">
            <span className="pm-fb-dot"/>
            <span>embed blocked by predictfolio.com headers</span>
          </div>
          <h3 className="pm-fb-title">profile available — open externally</h3>
          <p className="pm-fb-body">
            predictfolio.com sets <code>X-Frame-Options: DENY</code>, which prevents it
            from loading inside another site. the profile is public — click below to
            view in a new tab. when their embedding policy changes, the iframe above
            will start working automatically.
          </p>
          <a className="sz-btn sz-btn-primary" href={PF_URL} target="_blank" rel="noreferrer">
            ↗ predictfolio.com/@{PF_HANDLE}
          </a>
        </div>
      )}

      <div className="pm-footer">
        <span>source · predictfolio.com</span>
        <span className="sz-sep">·</span>
        <span>updates in near real-time</span>
        <span className="sz-sep">·</span>
        <span>polymarket wallet public data</span>
      </div>
    </section>
  );
}

window.Predictfolio = Predictfolio;
