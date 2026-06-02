// Combined.jsx — IBKR + Polymarket cumulative P&L, merged on a trailing-1y axis.
// Globals: React, Cursor

const {
  useState: useCmbState,
  useEffect: useCmbEffect,
  useRef: useCmbRef,
} = React;

const CMB_WALLET = '0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a';
const CMB_PNL_URL =
  `https://user-pnl-api.polymarket.com/user-pnl?user_address=${CMB_WALLET}&interval=all&fidelity=1d`;

const CMB_DAY_MS = 86400000;
const CMB_C_TOTAL = '#8b5cf6';  // saturated violet (violet-500) — the aggregate line
const CMB_C_IBKR  = '#a78bfa';  // brand purple — brokerage
const CMB_C_PM    = '#ff4fd8';  // brand pink — prediction markets

function cmbUSD(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function cmbSigned(n) {
  return (n >= 0 ? '+' : '') + cmbUSD(n);
}
function cmbUSDk(n) {
  if (Math.abs(n) >= 1000) return (n < 0 ? '-' : '') + '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
  return '$' + Math.round(n);
}
function cmbEpochDay(iso) {
  return Math.floor(new Date(iso + 'T00:00:00Z').getTime() / CMB_DAY_MS);
}
function cmbFromEpochDay(n) {
  return new Date(n * CMB_DAY_MS).toISOString().slice(0, 10);
}
function cmbMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  return `${mo} ${String(y).slice(2)}`;
}
function cmbFullDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  return `${mo} ${d}, ${y}`;
}

// Forward-fill step series onto every day in [start, end]. 0 before the first point.
function cmbSampleDaily(points, start, end) {
  const out = [];
  let i = 0, last = 0;
  for (let day = start; day <= end; day++) {
    while (i < points.length && points[i].day <= day) { last = points[i].v; i++; }
    out.push(last);
  }
  return out;
}

function cmbDownsample(arr, target = 150) {
  if (arr.length <= target) return arr;
  const step = Math.floor(arr.length / target);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

// Map each dated log entry onto the nearest chart point so it can be pinned to
// the total line. Entries outside the visible window are dropped.
function cmbMarkers(series, log) {
  if (!series.length || !log || !log.length) return [];
  const days = series.map(p => cmbEpochDay(p.d));
  const start = days[0], end = days[days.length - 1];
  return log.map(entry => {
    if (!entry || !entry.date) return null;
    const d = cmbEpochDay(entry.date);
    if (d < start || d > end) return null;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < days.length; i++) {
      const diff = Math.abs(days[i] - d);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return { i: best, date: entry.date, body: entry.body, v: series[best].v };
  }).filter(Boolean);
}

// IBKR cumulative $ P&L. The TWR curve (perfSeries) gives the *shape*; we anchor
// the endpoint to pnl["1y"].abs — IBKR's authoritative deposit-adjusted dollar P&L
// (ChangeInNAV) — so this matches the Portfolio tab exactly. Without anchoring,
// startNAV * TWR drifts from the headline once there are cash flows.
function cmbIbkrPoints(portfolio) {
  const nav = portfolio.navSeries || [];
  const perf = portfolio.perfSeries || [];
  if (!nav.length) return [];
  const startNAV = nav[0].v;
  const oneY = portfolio.pnl && portfolio.pnl['1y'] ? portfolio.pnl['1y'].abs : null;

  const shape = (perf.length === nav.length && perf.length)
    ? perf.map(p => ({ d: p.d, v: p.v }))
    : nav.map(p => ({ d: p.d, v: startNAV ? (p.v - startNAV) / startNAV : 0 }));

  const last = shape[shape.length - 1].v;
  const toDollars = (oneY != null && last)
    ? (v) => oneY * (v / last)
    : (v) => startNAV * v;

  return shape.map(p => ({ day: cmbEpochDay(p.d), v: toDollars(p.v) }));
}

// Polymarket raw user-pnl rows: [{ t: unixSeconds, p: dollars }] → daily $ points.
function cmbPmPoints(rows) {
  return (rows || []).map(r => ({ day: Math.floor(r.t / 86400), v: r.p }));
}

function cmbBuild(portfolio, pmRows) {
  const today = Math.floor(Date.now() / CMB_DAY_MS);

  const ibkrPts = cmbIbkrPoints(portfolio);
  const pmPts = cmbPmPoints(pmRows);

  // Window = IBKR's actual trailing-year series start, so the IBKR endpoint isn't
  // clipped by rebasing and stays equal to pnl["1y"].abs.
  const start = ibkrPts.length ? ibkrPts[0].day : today - 365;

  const ibkr = cmbSampleDaily(ibkrPts, start, today);
  const pm = cmbSampleDaily(pmPts, start, today);

  // Rebase each to its value at the window start so the chart shows P&L over the year.
  const ibkrBase = ibkr[0], pmBase = pm[0];
  const series = [];
  for (let k = 0; k < ibkr.length; k++) {
    const day = start + k;
    series.push({
      d: cmbFromEpochDay(day),
      v: +((ibkr[k] - ibkrBase) + (pm[k] - pmBase)).toFixed(2),
      ibkr: +(ibkr[k] - ibkrBase).toFixed(2),
      pm: +(pm[k] - pmBase).toFixed(2),
    });
  }

  const last = series[series.length - 1] || { v: 0, ibkr: 0, pm: 0 };
  return {
    series: cmbDownsample(series, 150),
    total: last.v,
    ibkr: last.ibkr,
    pm: last.pm,
    pmAvailable: pmPts.length > 0,
  };
}

// ---------- multi-series chart: total (bright) over ibkr + pm components ----------
function CmbChart({ series, log }) {
  const W = 920, H = 240, PAD_L = 8, PAD_R = 8, PAD_T = 20, PAD_B = 32;
  const svgRef = useCmbRef(null);
  const [hover, setHover] = useCmbState(null);
  const [annot, setAnnot] = useCmbState(null);
  const markers = cmbMarkers(series, log);

  const all = [];
  for (const p of series) { all.push(p.v, p.ibkr, p.pm); }
  const min = Math.min(...all, 0), max = Math.max(...all);
  const pad = (max - min) * 0.08 || 1;
  const y0 = min - pad, y1 = max + pad;
  const x = (i) => PAD_L + (i / (series.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);

  const linePath = (key) =>
    series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');
  const totalPath = linePath('v');
  const areaPath = totalPath + ` L${x(series.length - 1).toFixed(2)},${y(0).toFixed(2)} L${x(0).toFixed(2)},${y(0).toFixed(2)} Z`;
  const zeroY = y(0);

  const tickEvery = Math.max(1, Math.floor(series.length / 6));
  const ticks = series.map((p, i) => ({ i, d: p.d })).filter((_, i) => i % tickEvery === 0);

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(t * (series.length - 1))));
    setHover(idx);
  }

  const hp = hover != null ? series[hover] : null;
  const lastPt = series[series.length - 1];

  return (
    <div className="pm-chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="pf-navchart pm-chart-svg"
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onTouchStart={onMove}
        onTouchMove={onMove}
        onTouchEnd={() => setHover(null)}
      >
        <defs>
          <linearGradient id="cmb-total-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CMB_C_TOTAL} stopOpacity="0.18"/>
            <stop offset="100%" stopColor={CMB_C_TOTAL} stopOpacity="0"/>
          </linearGradient>
        </defs>

        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="rgba(229,225,241,0.2)" strokeDasharray="2 4"/>

        {/* component lines, faint, beneath the aggregate */}
        <path d={linePath('ibkr')} fill="none" stroke={CMB_C_IBKR} strokeWidth="1.25" opacity="0.5"/>
        <path d={linePath('pm')} fill="none" stroke={CMB_C_PM} strokeWidth="1.25" opacity="0.5"/>

        {/* total */}
        <path d={areaPath} fill="url(#cmb-total-fill)"/>
        <path d={totalPath} fill="none" stroke={CMB_C_TOTAL} strokeWidth="2"/>
        <circle cx={x(series.length - 1)} cy={y(lastPt.v)} r="3.5" fill={CMB_C_TOTAL}/>
        <circle cx={x(series.length - 1)} cy={y(lastPt.v)} r="7" fill={CMB_C_TOTAL} opacity="0.22"/>

        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hp.ibkr)} r="3" fill={CMB_C_IBKR}/>
            <circle cx={x(hover)} cy={y(hp.pm)} r="3" fill={CMB_C_PM}/>
            <circle cx={x(hover)} cy={y(hp.v)} r="4" fill={CMB_C_TOTAL} stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}

        {/* log annotations pinned to the total line */}
        {markers.map((m, k) => {
          const active = annot && annot.i === m.i;
          return (
            <g key={k} className="cmb-annot"
              onMouseEnter={() => setAnnot(m)}
              onMouseLeave={() => setAnnot(null)}
              onClick={() => setAnnot(a => (a && a.i === m.i) ? null : m)}>
              <circle cx={x(m.i)} cy={y(m.v)} r="11" fill="transparent"/>
              <text x={x(m.i)} y={y(m.v)} dy="0.32em" textAnchor="middle"
                className={`cmb-annot-glyph${active ? ' active' : ''}`}>◆</text>
            </g>
          );
        })}
      </svg>

      <div className="pf-axis-zero" style={{ left: `${(PAD_L / W) * 100}%`, top: `${(zeroY / H) * 100}%` }}>$0</div>
      <div className="pf-axis-x">
        {ticks.map((t, i) => (
          <span key={i}
            className={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : ''}
            style={{ left: `${(x(t.i) / W) * 100}%` }}>{cmbMonth(t.d)}</span>
        ))}
      </div>

      {hp && (
        <div className="pm-tooltip cmb-tooltip" style={{
          left: `${(x(hover) / W) * 100}%`,
          top: `${(y(hp.v) / H) * 100}%`,
        }}>
          <div className="pm-tt-date">{cmbFullDate(hp.d)}</div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_TOTAL }}/>total<span className={`cmb-tt-num ${hp.v >= 0 ? 'pos' : 'neg'}`}>{cmbSigned(hp.v)}</span></div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_IBKR }}/>ibkr<span className={`cmb-tt-num ${hp.ibkr >= 0 ? 'pos' : 'neg'}`}>{cmbSigned(hp.ibkr)}</span></div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_PM }}/>polymarket<span className={`cmb-tt-num ${hp.pm >= 0 ? 'pos' : 'neg'}`}>{cmbSigned(hp.pm)}</span></div>
        </div>
      )}

      {annot && (
        <div className="cmb-annot-tip" style={{
          left: `${(x(annot.i) / W) * 100}%`,
          top: `${(y(annot.v) / H) * 100}%`,
        }}>
          <div className="cmb-annot-date">▸ {cmbFullDate(annot.date)}</div>
          <div className="cmb-annot-body">{annot.body}</div>
        </div>
      )}
    </div>
  );
}

function CmbLegend() {
  const items = [
    { c: CMB_C_TOTAL, label: 'total' },
    { c: CMB_C_IBKR, label: 'ibkr' },
    { c: CMB_C_PM, label: 'polymarket' },
  ];
  return (
    <div className="cmb-legend">
      {items.map((it) => (
        <span key={it.label} className="cmb-legend-item">
          <span className="cmb-legend-dot" style={{ background: it.c }}/>{it.label}
        </span>
      ))}
    </div>
  );
}

function CmbStat({ label, value, tone, onClick }) {
  const cls = tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : '';
  return (
    <div className={`pf-stat${onClick ? ' cmb-stat-link' : ''}`} onClick={onClick}>
      <div className="pf-stat-label">{label}{onClick && <span className="cmb-stat-arrow"> ↗</span>}</div>
      <div className={`pf-stat-value ${cls}`}>{value}</div>
    </div>
  );
}

function Combined({ setView }) {
  const [data, setData] = useCmbState(null);
  const [err, setErr] = useCmbState(null);

  useCmbEffect(() => {
    let cancelled = false;
    async function load() {
      const pRes = await fetch('data/portfolio.json', { cache: 'no-store' });
      if (!pRes.ok) throw new Error('portfolio ' + pRes.status);
      const portfolio = await pRes.json();

      // Polymarket: try live API first; fall back to the daily snapshot cron.
      let pmRows = [];
      try {
        const pmRes = await fetch(CMB_PNL_URL);
        if (pmRes.ok) pmRows = await pmRes.json();
      } catch {}
      if (!pmRows.length) {
        try {
          const sRes = await fetch('data/polymarket-pnl.json', { cache: 'no-store' });
          if (sRes.ok) { const snap = await sRes.json(); pmRows = snap.rows || []; }
        } catch {}
      }

      // Dated log entries → chart annotations.
      let log = [];
      try {
        const cRes = await fetch('data/content.json', { cache: 'no-store' });
        if (cRes.ok) { const content = await cRes.json(); log = (content.home && content.home.log) || []; }
      } catch {}

      const built = cmbBuild(portfolio, pmRows);
      built.log = log;
      return built;
    }
    load()
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(String(e.message || e)); });
    return () => { cancelled = true; };
  }, []);

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ overview</div>
      <h2 className="sz-h2">couldn't build overview feed.</h2>
      <p><code>{err}</code></p>
      <p className="sz-dim">needs <code>data/portfolio.json</code> (daily IBKR cron). polymarket is fetched live.</p>
    </section>
  );
  if (!data) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ overview · live</div>
      <h2 className="sz-h2">merging feeds<Cursor /></h2>
    </section>
  );

  const pos = data.total >= 0;
  const go = (v) => setView ? () => setView(v) : undefined;

  return (
    <section className="pf-wrap">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ overview · ibkr + polymarket</div>
          <h2 className="sz-h2 pm-headline">
            <span className={pos ? 'pos' : 'neg'}>{pos ? '+' : ''}{cmbUSD(data.total)}</span>
            <span className="pf-currency">trailing 12mo pnl</span>
          </h2>
          <div className="pf-sub">
            deposit-adjusted brokerage + prediction-market profit
            {!data.pmAvailable && <span> <span className="sz-sep">·</span> polymarket unavailable, showing ibkr only</span>}
          </div>
        </div>
      </div>

      <div className="pf-stats">
        <CmbStat label="total" value={cmbSigned(data.total)} tone={pos ? 'pos' : 'neg'}/>
        <CmbStat label="ibkr" value={cmbSigned(data.ibkr)} tone={data.ibkr >= 0 ? 'pos' : 'neg'} onClick={go('portfolio')}/>
        <CmbStat label="polymarket" value={cmbSigned(data.pm)} tone={data.pm >= 0 ? 'pos' : 'neg'} onClick={go('polymarket')}/>
      </div>

      {data.series.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">total pnl · 12mo</span>
            <span className="pf-panel-meta">daily · USD</span>
          </div>
          <CmbLegend/>
          <CmbChart series={data.series} log={data.log}/>
        </div>
      )}

      <div className="pf-footer">
        <span>ibkr flex (daily cron) + polymarket user-pnl (live + daily snapshot)</span>
        <span className="sz-sep">·</span>
        <span>not financial advice</span>
        <span className="sz-sep">·</span>
        <span>twr $ vs. raw $ — summed, not identical methodology</span>
      </div>
    </section>
  );
}

window.Combined = Combined;
