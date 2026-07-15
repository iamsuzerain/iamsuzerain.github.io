// Combined.jsx — IBKR + Polymarket cumulative P&L, merged on a trailing-1y axis.
// Globals: React, Cursor

const {
  useState: useCmbState,
  useEffect: useCmbEffect,
  useRef: useCmbRef,
} = React;

const CMB_WALLETS = (window.SZ_ID.wallets && window.SZ_ID.wallets.length)
  ? window.SZ_ID.wallets
  : [window.SZ_ID.wallet];
const cmbPnlUrl = (w) =>
  `https://user-pnl-api.polymarket.com/user-pnl?user_address=${w}&interval=all&fidelity=1d`;

// Cumulative-PnL series can start at different times per wallet. Union the
// timestamps, carry forward each wallet's last known value, sum at each t.
function cmbSumPnlSeries(seriesList) {
  const sorted = seriesList.map(s => [...(s || [])].sort((a, b) => a.t - b.t));
  const tSet = new Set();
  for (const s of sorted) for (const r of s) tSet.add(r.t);
  const allTs = [...tSet].sort((a, b) => a - b);
  const cursors = new Array(sorted.length).fill(0);
  const last = new Array(sorted.length).fill(0);
  const out = [];
  for (const t of allTs) {
    for (let i = 0; i < sorted.length; i++) {
      while (cursors[i] < sorted[i].length && sorted[i][cursors[i]].t <= t) {
        last[i] = sorted[i][cursors[i]].p;
        cursors[i]++;
      }
    }
    let sum = 0;
    for (const v of last) sum += v;
    out.push({ t, p: sum });
  }
  return out;
}

const CMB_DAY_MS = 86400000;
const CMB_C_TOTAL = '#8b5cf6';  // saturated violet (violet-500) — the aggregate line
const CMB_C_IBKR  = '#a78bfa';  // brand purple — brokerage
const CMB_C_PM    = '#ff4fd8';  // brand pink — prediction markets
const CMB_BENCH = { spx: '#5eead4', vt: '#facc15' };  // matches the portfolio tab

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
    return { i: best, date: entry.date, body: entry.body, link: entry.link, v: series[best].v };
  }).filter(Boolean);
}

// Mirror Hero.jsx: an entry's link {text, href} turns the first occurrence of
// `text` in the body into an anchor, so a marker caption can point at a post.
function cmbCaptionBody(entry) {
  const l = entry && entry.link;
  if (!l || !l.text || !l.href || !entry.body.includes(l.text)) return entry.body;
  const i = entry.body.indexOf(l.text);
  return (
    <>
      {entry.body.slice(0, i)}
      <a className="cmb-annot-cap-link" href={l.href}>{l.text}</a>
      {entry.body.slice(i + l.text.length)}
    </>
  );
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

// All-source polymarket income beyond trading (lp + maker + yield + sponsored +
// uma), windowed to ~12mo. betmoar's totals are lifetime, so we diff against the
// oldest history snapshot that's <= 365d ago. Without a baseline that old, we
// use lifetime totals (correct as long as no rewards/fees pre-date the window).
// betmoar breakdown is primary; CLOB rewards json is the fallback.
async function cmbFetchBdExtra() {
  let current = null;
  try {
    const r = await fetch('data/polymarket-breakdown.json', { cache: 'no-store' });
    if (r.ok) {
      const bd = await r.json();
      if (bd.totals) current = bd.totals;
    }
  } catch {}
  if (!current) {
    try {
      const r = await fetch('data/polymarket-rewards.json', { cache: 'no-store' });
      if (r.ok) {
        const rw = await r.json();
        if (rw.totals) return Math.round(rw.totals.makerRebates || 0) + Math.round(rw.totals.liquidityRewards || 0);
      }
    } catch {}
    return 0;
  }

  let baseline = null;
  try {
    const r = await fetch('data/polymarket-breakdown-history.json', { cache: 'no-store' });
    if (r.ok) {
      const hist = await r.json();
      const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const rows = (hist.rows || []).filter(x => x.d && x.d <= cutoff);
      if (rows.length) baseline = rows[rows.length - 1];
    }
  } catch {}

  // Polymarket's user-pnl-api series (used as `pm` line) excludes trading fees,
  // so subtract betmoar's implied `fees` here.
  const delta = (k) => (current[k] || 0) - (baseline ? (baseline[k] || 0) : 0);
  return delta('lp') + delta('yield') + delta('maker') + delta('sponsored') + delta('uma') - delta('fees');
}

// Benchmark $ line: IBKR starting NAV parked in the index for the window.
// Approximate by construction — the real capital base moved during the year.
function cmbBenchDollars(benchSeries, notional, start, end) {
  const pts = (benchSeries || []).map(p => ({ day: cmbEpochDay(p.d), v: p.v }));
  const closes = cmbSampleDaily(pts, start, end);
  const firstIdx = closes.findIndex(v => v !== 0);
  if (firstIdx === -1) return null;
  const base = closes[firstIdx];
  return closes.map((c, i) => notional * ((i < firstIdx ? base : c) / base - 1));
}

function cmbBuild(portfolio, pmRows, bdExtra, benchmarks, pmTransfers) {
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

  // Benchmark notional = IBKR NAV at window start + IBKR→Polymarket transfers
  // made *before* the window start (content.json pmTransfers). Transfers inside
  // the window are already counted in startNAV; once the rolling window passes
  // a transfer date the money leaves startNAV but is still part of the capital
  // base, so the ledger adds it back. Only needs editing when money moves.
  const startNAV = (portfolio.navSeries && portfolio.navSeries.length) ? portfolio.navSeries[0].v : 0;
  const priorTransfers = (pmTransfers || [])
    .filter(t => t && t.date && cmbEpochDay(t.date) <= start)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  const notional = startNAV + priorTransfers;
  const bench = [];
  if (benchmarks && notional) {
    for (const [key, b] of Object.entries(benchmarks)) {
      const vals = cmbBenchDollars(b.series, notional, start, today);
      if (vals) bench.push({ key, label: b.label, vals });
    }
  }
  // Spread all-source polymarket income (maker/lp/yield/…) linearly across the
  // window so the pm + total lines reconcile with the all-sources figure. Only
  // applied when polymarket has data; intra-window points are estimates.
  const extra = pmPts.length > 0 ? (bdExtra || 0) : 0;
  const denom = Math.max(1, ibkr.length - 1);
  const series = [];
  for (let k = 0; k < ibkr.length; k++) {
    const day = start + k;
    const ramp = extra * (k / denom);
    const pt = {
      d: cmbFromEpochDay(day),
      v: +((ibkr[k] - ibkrBase) + (pm[k] - pmBase) + ramp).toFixed(2),
      ibkr: +(ibkr[k] - ibkrBase).toFixed(2),
      pm: +((pm[k] - pmBase) + ramp).toFixed(2),
    };
    for (const b of bench) pt[b.key] = +b.vals[k].toFixed(2);
    series.push(pt);
  }

  const last = series[series.length - 1] || { v: 0, ibkr: 0, pm: 0 };
  return {
    series: cmbDownsample(series, 400),
    total: last.v,
    ibkr: last.ibkr,
    pm: last.pm,
    bdExtra: extra,
    pmAvailable: pmPts.length > 0,
    bench: bench.map(b => ({ key: b.key, label: b.label })),
    benchNotional: notional,
  };
}

// ---------- total pnl sparkline (violet→magenta) with pinned log markers ----------
function CmbChart({ series, log, bench, benchNotional }) {
  const benches = bench || [];
  const W = 920, H = 240, PAD_L = 8, PAD_R = 8, PAD_T = 20, PAD_B = 32;
  const svgRef = useCmbRef(null);
  const [hover, setHover] = useCmbState(null);
  const [annot, setAnnot] = useCmbState(null);
  const markers = cmbMarkers(series, log).sort((a, b) => a.i - b.i);
  const cur = annot || (markers.length ? markers[markers.length - 1] : null);
  const curIdx = cur ? markers.findIndex(m => m.i === cur.i) : -1;

  const all = [];
  for (const p of series) {
    all.push(p.v, p.ibkr, p.pm);
    for (const b of benches) if (p[b.key] != null) all.push(p[b.key]);
  }
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
    <>
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
          <linearGradient id="cmb-nav-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.32"/>
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0"/>
          </linearGradient>
          <linearGradient id="cmb-nav-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a78bfa"/>
            <stop offset="100%" stopColor="#ff4fd8"/>
          </linearGradient>
        </defs>

        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="rgba(229,225,241,0.2)" strokeDasharray="2 4"/>

        {/* component lines — faint, recessed beneath the aggregate */}
        <path d={linePath('ibkr')} fill="none" stroke={CMB_C_IBKR} strokeWidth="1" opacity="0.3"/>
        <path d={linePath('pm')} fill="none" stroke={CMB_C_PM} strokeWidth="1" opacity="0.3"/>
        {benches.map(b => (
          <path key={b.key} d={linePath(b.key)} fill="none"
            stroke={CMB_BENCH[b.key] || '#5eead4'} strokeWidth="1" opacity="0.45"/>
        ))}

        <path d={areaPath} fill="url(#cmb-nav-fill)"/>
        <path d={totalPath} fill="none" stroke="url(#cmb-nav-stroke)" strokeWidth="1.75"/>
        <circle cx={x(series.length - 1)} cy={y(lastPt.v)} r="3.5" fill="#ff4fd8"/>
        <circle cx={x(series.length - 1)} cy={y(lastPt.v)} r="7" fill="#ff4fd8" opacity="0.25"/>

        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hp.ibkr)} r="2.5" fill={CMB_C_IBKR} opacity="0.6"/>
            <circle cx={x(hover)} cy={y(hp.pm)} r="2.5" fill={CMB_C_PM} opacity="0.6"/>
            <circle cx={x(hover)} cy={y(hp.v)} r="4" fill="#a78bfa" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}

        {/* log event markers — click to pin to the caption below */}
        {markers.map((m, k) => {
          const active = cur && cur.i === m.i;
          const s = active ? 6 : 5;
          const cx = x(m.i), cy = y(m.v);
          return (
            <g key={k} className={`cmb-annot${active ? ' active' : ''}`}
              onClick={() => setAnnot(m)}>
              <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent"/>
              <rect className="cmb-annot-sq" x={cx - s / 2} y={cy - s / 2} width={s} height={s}
                transform={`rotate(45 ${cx} ${cy})`}/>
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
          {benches.map(b => hp[b.key] != null && (
            <div key={b.key} className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_BENCH[b.key] }}/>{b.label.toLowerCase()}<span className={`cmb-tt-num ${hp[b.key] >= 0 ? 'pos' : 'neg'}`}>{cmbSigned(hp[b.key])}</span></div>
          ))}
        </div>
      )}

    </div>
    {benches.length > 0 && (
      <div className="pf-bench-legend">
        <span><i className="pf-bench-swatch" style={{ background: 'linear-gradient(90deg,#a78bfa,#ff4fd8)' }}/>total</span>
        {benches.map(b => (
          <span key={b.key}><i className="pf-bench-swatch" style={{ background: CMB_BENCH[b.key] }}/>{b.label.toLowerCase()}{benchNotional ? ` · on ${cmbUSDk(benchNotional)}` : ''}</span>
        ))}
      </div>
    )}
    {cur && (
      <div className="cmb-annot-cap">
        <div className="cmb-annot-cap-head">
          <button className="cmb-annot-nav" disabled={curIdx <= 0}
            onClick={() => setAnnot(markers[curIdx - 1])} aria-label="previous entry">←</button>
          <div className="cmb-annot-cap-date">{cmbFullDate(cur.date)}</div>
          <button className="cmb-annot-nav" disabled={curIdx >= markers.length - 1}
            onClick={() => setAnnot(markers[curIdx + 1])} aria-label="next entry">→</button>
        </div>
        <p className="cmb-annot-cap-body">{cmbCaptionBody(cur)}</p>
      </div>
    )}
    </>
  );
}

function CmbStat({ label, value, tone, onClick, note }) {
  const cls = tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : '';
  return (
    <div className={`pf-stat${onClick ? ' cmb-stat-link' : ''}`} onClick={onClick}>
      <div className="pf-stat-label">{label}{onClick && <span className="cmb-stat-arrow"> ↗</span>}</div>
      <div className={`pf-stat-value ${cls}`}>{value}</div>
      {note && <div className="pf-stat-kicker">{note}</div>}
    </div>
  );
}

// ---------- capital deployment: IBKR vs Polymarket tug-of-war ----------
// A single rope. The flag (divider) sits at IBKR's share of total NAV, so the
// heavier book pushes the marker into the lighter book's territory. A faint
// center tick marks the 50/50 neutral point the flag is pulled away from.
function CmbDeployBar({ ibkr, poly }) {
  const total = (ibkr || 0) + (poly || 0);
  if (total <= 0) return null;
  const ibkrPct = ibkr / total;
  const polyPct = poly / total;
  const dividerLeft = +(ibkrPct * 100).toFixed(2);
  const leader = ibkr >= poly ? 'ibkr' : 'polymarket';

  return (
    <div className="cmb-deploy">
      <div className="cmb-deploy-ends">
        <div className="cmb-deploy-end">
          <span className="cmb-deploy-dot" style={{ background: CMB_C_IBKR }}/>
          <span className="cmb-deploy-name">ibkr</span>
          <span className="cmb-deploy-val">{cmbUSDk(ibkr)}</span>
          <span className="cmb-deploy-pct">{(ibkrPct * 100).toFixed(1)}%</span>
        </div>
        <div className="cmb-deploy-end cmb-deploy-end-r">
          <span className="cmb-deploy-pct">{(polyPct * 100).toFixed(1)}%</span>
          <span className="cmb-deploy-val">{cmbUSDk(poly)}</span>
          <span className="cmb-deploy-name">polymarket</span>
          <span className="cmb-deploy-dot" style={{ background: CMB_C_PM }}/>
        </div>
      </div>
      <div className="cmb-deploy-track">
        <div className="cmb-deploy-fill cmb-deploy-fill-ibkr" style={{ width: `${dividerLeft}%` }}/>
        <div className="cmb-deploy-fill cmb-deploy-fill-poly" style={{ left: `${dividerLeft}%`, width: `${100 - dividerLeft}%` }}/>
        <div className="cmb-deploy-center"/>
        <div className="cmb-deploy-flag" style={{ left: `${dividerLeft}%` }}>
          <span className="cmb-deploy-knob"/>
        </div>
      </div>
      <div className="cmb-deploy-foot">
        <span>total deployed <b>{cmbUSD(total)}</b></span>
        <span>{leader} leads by {cmbUSDk(Math.abs(ibkr - poly))}</span>
      </div>
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

      // Polymarket: try live API per wallet (summed), fall back to the daily snapshot cron.
      let pmRows = [];
      try {
        const perWallet = await Promise.all(
          CMB_WALLETS.map(w =>
            fetch(cmbPnlUrl(w), { signal: AbortSignal.timeout(10000) })
              .then(r => r.ok ? r.json() : [])
              .then(j => Array.isArray(j) ? j : [])
          )
        );
        const summed = cmbSumPnlSeries(perWallet);
        if (summed.length) pmRows = summed;
      } catch {}
      if (!pmRows.length) {
        try {
          const sRes = await fetch('data/polymarket-pnl.json', { cache: 'no-store' });
          if (sRes.ok) { const snap = await sRes.json(); pmRows = snap.rows || []; }
        } catch {}
      }

      // Dated log entries → chart annotations; pmTransfers is the manually
      // maintained ledger of IBKR→Polymarket moves (used for the benchmark notional).
      let log = [], pmTransfers = [];
      try {
        const cRes = await fetch('data/content.json', { cache: 'no-store' });
        if (cRes.ok) {
          const content = await cRes.json();
          log = (content.home && content.home.log) || [];
          pmTransfers = content.pmTransfers || [];
        }
      } catch {}

      // Benchmark overlay is best-effort; the chart renders fine without it.
      let benchmarks = null;
      try {
        const bRes = await fetch('data/benchmarks.json', { cache: 'no-store' });
        if (bRes.ok) { const bj = await bRes.json(); benchmarks = bj.benchmarks || null; }
      } catch {}

      const bdExtra = await cmbFetchBdExtra();

      // Current NAV split for the capital-deployment bar. IBKR NAV is on the
      // daily flex cron; Polymarket NAV (open positions + idle USDC) rides the
      // betmoar breakdown snapshot. Bar renders only when both are present.
      let polyNav = null;
      try {
        const r = await fetch('data/polymarket-breakdown.json', { cache: 'no-store' });
        if (r.ok) { const bd = await r.json(); polyNav = bd.balances ? bd.balances.nav : null; }
      } catch {}
      const ibkrNav = (portfolio.account && portfolio.account.nav != null) ? portfolio.account.nav : null;

      const built = cmbBuild(portfolio, pmRows, bdExtra, benchmarks, pmTransfers);
      built.log = log;
      built.deploy = (ibkrNav != null && polyNav != null) ? { ibkr: ibkrNav, poly: polyNav } : null;
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
            deposit-adjusted brokerage + prediction-market trading{data.bdExtra ? ' + rewards' : ''}, trailing 12mo
            {!data.pmAvailable && <span> <span className="sz-sep">·</span> polymarket unavailable, showing ibkr only</span>}
          </div>
        </div>
      </div>

      <div className="pf-stats">
        <CmbStat label="total" value={cmbSigned(data.total)} tone={pos ? 'pos' : 'neg'} note="trailing 12mo"/>
        <CmbStat label="ibkr" value={cmbSigned(data.ibkr)} tone={data.ibkr >= 0 ? 'pos' : 'neg'} onClick={go('portfolio')} note="deposit-adjusted"/>
        <CmbStat label="polymarket" value={cmbSigned(data.pm)} tone={data.pm >= 0 ? 'pos' : 'neg'} onClick={go('polymarket')} note={data.bdExtra ? '12mo · trading + rewards' : '12mo trading'}/>
      </div>

      {data.series.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">total pnl · 12mo</span>
            <span className="pf-panel-meta">{data.bdExtra ? 'daily · USD · rewards spread linearly' : 'daily · USD'}{data.bench && data.bench.length ? ' · vs spx + vt' : ''}</span>
          </div>
          <CmbChart series={data.series} log={data.log} bench={data.bench} benchNotional={data.benchNotional}/>
        </div>
      )}

      {data.deploy && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">capital deployment · now</span>
            <span className="pf-panel-meta">ibkr nav vs polymarket nav</span>
          </div>
          <CmbDeployBar ibkr={data.deploy.ibkr} poly={data.deploy.poly}/>
        </div>
      )}

      <div className="pf-footer">
        <span>ibkr flex (daily cron) + polymarket user-pnl (live + daily snapshot)</span>
        <span className="sz-sep">·</span>
        <span>not financial advice</span>
        <span className="sz-sep">·</span>
        <span>polymarket here is 12mo, all sources (rewards spread linearly); the polymarket tab shows all-time</span>
      </div>
    </section>
  );
}

window.Combined = Combined;
