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
// Span-aware x-axis label: 'day' -> "Jun 12" (short windows), 'month' -> "Jun"
// (within one year), 'monthyear' -> "Jun 26" (crosses years).
function cmbAxisLabel(iso, mode) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  if (mode === 'day') return `${mo} ${d}`;
  if (mode === 'month') return mo;
  return `${mo} ${String(y).slice(2)}`;
}
function cmbFullDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  return `${mo} ${d}, ${y}`;
}
function cmbShortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
  return `${mo} ${d}`;
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

  // Alpha vs the S&P: total return minus SPX return, both on the same benchmark
  // notional, so the $ and percentage-point deltas reconcile.
  const spxB = bench.find(b => b.key === 'spx');
  let vsSpx = null;
  if (spxB && notional) {
    const spxLast = spxB.vals[spxB.vals.length - 1];
    vsSpx = {
      dollars: +(last.v - spxLast).toFixed(2),
      pts: +(((last.v - spxLast) / notional) * 100).toFixed(2),
    };
  }

  return {
    series: cmbDownsample(series, 400),
    total: last.v,
    ibkr: last.ibkr,
    pm: last.pm,
    bdExtra: extra,
    pmAvailable: pmPts.length > 0,
    bench: bench.map(b => ({ key: b.key, label: b.label })),
    benchNotional: notional,
    vsSpx,
  };
}

// ---------- total pnl sparkline (violet→magenta) with pinned log markers ----------
function CmbChart({ series, log, bench, benchNotional, ddNotional }) {
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
  const spanDays = series.length > 1 ? cmbEpochDay(series[series.length - 1].d) - cmbEpochDay(series[0].d) : 0;
  const axisMode = spanDays <= 95 ? 'day'
    : (series[0].d.slice(0, 4) === series[series.length - 1].d.slice(0, 4) ? 'month' : 'monthyear');

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
          {/* Vertical, value-keyed: pink where the line runs high, violet where low. */}
          <linearGradient id="cmb-nav-stroke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff4fd8"/>
            <stop offset="100%" stopColor="#a78bfa"/>
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
            <circle cx={x(hover)} cy={y(hp.v)} r="4" fill="#a78bfa" stroke="#f5f0ff" strokeWidth="1.5"/>
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
            style={{ left: `${(x(t.i) / W) * 100}%` }}>{cmbAxisLabel(t.d, axisMode)}</span>
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
          <span key={b.key}><i className="pf-bench-swatch" style={{ background: CMB_BENCH[b.key] }}/>{b.label.toLowerCase()}{(ddNotional != null ? ddNotional : benchNotional) ? ` · on ${cmbUSDk(ddNotional != null ? ddNotional : benchNotional)}` : ''}</span>
        ))}
      </div>
    )}
    <CmbDrawdownStrip series={series} notional={ddNotional != null ? ddNotional : benchNotional}
      markers={markers} cur={cur} onPick={setAnnot}/>
    <CmbAlphaStrip series={series} markers={markers} cur={cur} onPick={setAnnot}/>
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

// Risk/return analytics for the combined book, off the reconstructed equity
// curve (window-start capital base + cumulative combined P&L). data.series is
// calendar-daily (cmbSampleDaily fills every day), so we annualize by 365 — not
// the 252 the IBKR tab uses on its trading-day perfSeries. rf assumed 0.
function cmbRisk(series, notional) {
  if (!series || series.length < 21 || !notional || notional <= 0) return null;
  const PER = 365;
  const eq = series.map(p => notional + p.v);
  const rp = [];
  for (let i = 1; i < eq.length; i++) if (eq[i - 1] > 0) rp.push(eq[i] / eq[i - 1] - 1);
  const n = rp.length;
  if (n < 20) return null;
  const mean = rp.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rp.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const vol = sd * Math.sqrt(PER);
  const sharpe = vol ? (mean * PER) / vol : null;

  let peak = eq[0], maxDD = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? e / peak - 1 : 0;
    if (dd < maxDD) maxDD = dd;
  }

  // Beta vs SPX, if the benchmark line is present (spx equity = notional + $spx).
  let beta = null, r2 = null;
  if (series[0].spx != null) {
    const beq = series.map(p => notional + (p.spx || 0));
    const a = [], b = [];
    for (let i = 1; i < eq.length; i++) {
      if (eq[i - 1] > 0 && beq[i - 1] > 0) { a.push(eq[i] / eq[i - 1] - 1); b.push(beq[i] / beq[i - 1] - 1); }
    }
    const m = a.length;
    if (m >= 20) {
      const ma = a.reduce((x, y) => x + y, 0) / m, mb = b.reduce((x, y) => x + y, 0) / m;
      let cov = 0, vb = 0, va = 0;
      for (let i = 0; i < m; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; vb += db * db; va += da * da; }
      if (vb > 0 && va > 0) { beta = cov / vb; r2 = (cov * cov) / (vb * va); }
    }
  }
  return { sharpe, vol, maxDD, beta, r2 };
}

// Diamond event marker, shared by the main chart and the strips so a log entry
// reads at the same x across all three (see .cmb-annot-sq styling).
function CmbAnnotDot({ cx, cy, active, onClick, size = 5 }) {
  const s = active ? size + 1 : size;
  return (
    <g className={`cmb-annot${active ? ' active' : ''}`} onClick={onClick}>
      <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent"/>
      <rect className="cmb-annot-sq" x={cx - s / 2} y={cy - s / 2} width={s} height={s}
        transform={`rotate(45 ${cx} ${cy})`}/>
    </g>
  );
}

// ---------- combined underwater (drawdown) strip ----------
// Drawdown is a portfolio-level idea, so we rebuild an equity curve from the
// window-start capital base (benchNotional) plus cumulative combined P&L, then
// measure the % decline from its running peak. Straight-line to match CmbChart.
function CmbDrawdownStrip({ series, notional, markers, cur, onPick }) {
  const svgRef = useCmbRef(null);
  const [hover, setHover] = useCmbState(null);
  if (!series || series.length < 2 || !notional || notional <= 0) return null;

  let peak = notional + series[0].v;
  const dd = series.map(p => {
    const eq = notional + p.v;
    if (eq > peak) peak = eq;
    return { d: p.d, v: peak > 0 ? eq / peak - 1 : 0 };
  });
  const min = Math.min(0, ...dd.map(p => p.v));
  const maxDD = min, curDD = dd[dd.length - 1].v;
  const pct = (v) => (v * 100).toFixed(1) + '%';

  const W = 920, H = 60, PAD_L = 8, PAD_R = 8, PAD_T = 6, PAD_B = 12;
  const x = (i) => PAD_L + (i / (dd.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - min) / (0 - min || 1)) * (H - PAD_T - PAD_B);
  const line = dd.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const area = line + ` L${x(dd.length - 1).toFixed(2)},${y(0).toFixed(2)} L${x(0).toFixed(2)},${y(0).toFixed(2)} Z`;

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    const idx = Math.max(0, Math.min(dd.length - 1, Math.round(t * (dd.length - 1))));
    setHover(idx);
  }
  const hovered = hover != null ? dd[hover] : null;

  return (
    <>
      <div className="pf-strip-head">
        <span className="pf-strip-label">underwater · drawdown from peak</span>
        <span className="pf-strip-meta">max {pct(maxDD)} · now {pct(curDD)}</span>
      </div>
      <div className="pm-chart-wrap">
        <svg
          ref={svgRef}
          className="pf-navchart"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
          onTouchEnd={() => setHover(null)}
        >
          <defs>
            <linearGradient id="cmb-dd-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,79,216,0.02)"/>
              <stop offset="100%" stopColor="rgba(255,79,216,0.22)"/>
            </linearGradient>
          </defs>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)}
            stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
          <path d={area} fill="url(#cmb-dd-fill)"/>
          <path d={line} fill="none" stroke="rgba(255,110,196,0.75)" strokeWidth="1.25"/>
          {(markers || []).map((m, k) => m.i < dd.length && (
            <CmbAnnotDot key={k} cx={x(m.i)} cy={y(dd[m.i].v)}
              active={cur && cur.i === m.i} onClick={onPick ? () => onPick(m) : undefined}/>
          ))}
          {hovered && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
                stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
              <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#ff6ec4" stroke="#f5f0ff" strokeWidth="1.5"/>
            </g>
          )}
        </svg>
        {hovered && (
          <div className="pm-tooltip cmb-tooltip" style={{
            left: `${(x(hover) / W) * 100}%`,
            top: `${(y(hovered.v) / H) * 100}%`,
          }}>
            <div className="pm-tt-date">{cmbFullDate(hovered.d)}</div>
            <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{pct(hovered.v)}</div>
          </div>
        )}
      </div>
    </>
  );
}

// ---------- range windowing ----------
const CMB_RANGES = ['1M', '3M', '6M', 'YTD', '1Y'];
const CMB_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo' };

function cmbRangeCutoff(range, last) {
  if (range === 'YTD') return last.slice(0, 4) + '-01-01';
  const m = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range];
  if (!m) return null;
  const c = new Date(last + 'T00:00:00Z');
  c.setUTCMonth(c.getUTCMonth() - m);
  return c.toISOString().slice(0, 10);
}

// Benchmark $ line for a window: forward-fill raw closes onto `dates`, base to the
// first (window-start) close, and scale by the window-start equity. This is the
// index's actual return over the window on the capital held at the window start —
// not a constant offset of the stale 1y line.
function cmbBenchWindow(benchSeries, notional, dates) {
  if (!benchSeries || !benchSeries.length) return null;
  let j = 0, lastClose = null;
  const out = new Array(dates.length);
  for (let i = 0; i < dates.length; i++) {
    while (j < benchSeries.length && benchSeries[j].d <= dates[i]) { lastClose = benchSeries[j].v; j++; }
    out[i] = lastClose;
  }
  const firstKnown = out.find(v => v != null);
  if (firstKnown == null) return null;
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = firstKnown;
  const base = out[0];
  if (!base) return null;
  return out.map(v => +(notional * (v / base - 1)).toFixed(2));
}

// Slice the combined $ series to a trailing range and rebase the P&L streams
// (v/ibkr/pm) to the window start. Benchmark lines (spx/vt) are *rebuilt* from raw
// closes on the window-start equity, so they track the selected timeframe rather
// than the 1y-ago capital/base. Returns the window-start equity as `notional`,
// which also keeps the drawdown strip's % correct for the sub-window.
function cmbWindow(series, notional, range, benchmarks) {
  if (!series || series.length < 2) return { series, notional };
  const last = series[series.length - 1].d;
  const cutoff = cmbRangeCutoff(range, last);
  let i = cutoff ? series.findIndex(p => p.d >= cutoff) : 0;
  if (i < 0) i = 0;
  if (i > series.length - 2) i = series.length - 2;
  const s0 = series[i];
  const winNotional = (notional || 0) + (s0.v || 0);
  const out = series.slice(i).map(p => {
    const q = { d: p.d };
    for (const k of ['v', 'ibkr', 'pm']) if (p[k] != null) q[k] = +(p[k] - s0[k]).toFixed(2);
    return q;
  });
  const dates = out.map(p => p.d);
  for (const key of ['spx', 'vt']) {
    let vals = null;
    if (benchmarks && benchmarks[key] && benchmarks[key].series) {
      vals = cmbBenchWindow(benchmarks[key].series, winNotional, dates);
    }
    if (vals) {
      out.forEach((p, k) => { p[key] = vals[k]; });
    } else if (s0[key] != null) {  // fallback: keep the line visible via subtraction
      out.forEach((p, k) => { p[key] = +(series[i + k][key] - s0[key]).toFixed(2); });
    }
  }
  return { series: out, notional: winNotional };
}

// ---------- combined rolling alpha strip (total $ minus SPX $, zero-centered) ----------
function CmbAlphaStrip({ series, markers, cur, onPick }) {
  const svgRef = useCmbRef(null);
  const [hover, setHover] = useCmbState(null);
  if (!series || series.length < 2 || series[0].spx == null) return null;
  const alpha = series.map(p => ({ d: p.d, v: +(p.v - (p.spx || 0)).toFixed(2) }));
  const last = alpha[alpha.length - 1].v;
  const vals = alpha.map(p => p.v);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const W = 920, H = 60, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 12;
  const x = (i) => PAD_L + (i / (alpha.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);
  const line = alpha.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const zeroY = y(0);
  const area = line + ` L${x(alpha.length - 1).toFixed(2)},${zeroY.toFixed(2)} L${x(0).toFixed(2)},${zeroY.toFixed(2)} Z`;

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    const idx = Math.max(0, Math.min(alpha.length - 1, Math.round(t * (alpha.length - 1))));
    setHover(idx);
  }
  const hovered = hover != null ? alpha[hover] : null;

  return (
    <>
      <div className="pf-strip-head">
        <span className="pf-strip-label">alpha vs spx · cumulative</span>
        <span className="pf-strip-meta">now {cmbSigned(last)}</span>
      </div>
      <div className="pm-chart-wrap">
        <svg
          ref={svgRef}
          className="pf-navchart"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
          onTouchEnd={() => setHover(null)}
        >
          <defs>
            <linearGradient id="cmb-alpha-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(96,165,250,0.22)"/>
              <stop offset="100%" stopColor="rgba(96,165,250,0.02)"/>
            </linearGradient>
          </defs>
          <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
            stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
          <path d={area} fill="url(#cmb-alpha-fill)"/>
          <path d={line} fill="none" stroke="rgba(96,165,250,0.85)" strokeWidth="1.25"/>
          {(markers || []).map((m, k) => m.i < alpha.length && (
            <CmbAnnotDot key={k} cx={x(m.i)} cy={y(alpha[m.i].v)}
              active={cur && cur.i === m.i} onClick={onPick ? () => onPick(m) : undefined}/>
          ))}
          {hovered && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
                stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
              <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#60a5fa" stroke="#f5f0ff" strokeWidth="1.5"/>
            </g>
          )}
        </svg>
        {hovered && (
          <div className="pm-tooltip cmb-tooltip" style={{
            left: `${(x(hover) / W) * 100}%`,
            top: `${(y(hovered.v) / H) * 100}%`,
          }}>
            <div className="pm-tt-date">{cmbFullDate(hovered.d)}</div>
            <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{cmbSigned(hovered.v)}</div>
          </div>
        )}
      </div>
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

// ---------- Monthly P&L, split by book ----------
// Each month's contribution per series = the change in that series' cumulative
// (deposit-adjusted) P&L between the month's last observation and the prior
// month's. `total` is the net of both books; `spx` is the benchmark's dollar
// return on the same notional, present only when the benchmark overlay loaded.
// Grouped bars around a shared zero line so signs read directly.
function cmbMonthly(series) {
  if (!series || series.length < 2) return [];
  const end = new Map();                    // 'YYYY-MM' -> {ibkr, pm, spx}
  for (const p of series) end.set(p.d.slice(0, 7), { ibkr: p.ibkr || 0, pm: p.pm || 0, spx: p.spx });
  const keys = [...end.keys()].sort();
  const out = [];
  let prev = { ibkr: series[0].ibkr || 0, pm: series[0].pm || 0, spx: series[0].spx };
  for (const k of keys) {
    const e = end.get(k);
    const row = { ym: k, ibkr: e.ibkr - prev.ibkr, pm: e.pm - prev.pm };
    row.total = row.ibkr + row.pm;
    if (e.spx != null && prev.spx != null) row.spx = e.spx - prev.spx;
    out.push(row);
    prev = e;
  }
  return out;
}

// Rendered as hairline stem + dot (lollipop), not filled bars, to sit with the
// site's thin-stroke / dot-marker language. Marks are light enough that colors
// stay full-solid — so white reads white, not gray.
const CMB_BAR_META = [
  { key: 'ibkr',  label: 'ibkr',       color: '#a78bfa' },
  { key: 'pm',    label: 'polymarket', color: '#ff4fd8' },
  { key: 'total', label: 'total',      color: '#f5f0ff' },
  { key: 'spx',   label: 'spx',        color: '#5eead4' },
];

function CmbMonthlyBars({ series }) {
  const svgRef = useCmbRef(null);
  const [hover, setHover] = useCmbState(null);
  const months = cmbMonthly(series);
  if (months.length < 2) return null;
  const hasSpx = months.some(m => m.spx != null);
  const bars = CMB_BAR_META.filter(b => b.key !== 'spx' || hasSpx);
  const nb = bars.length;
  const W = 920, H = 200, PAD_L = 8, PAD_R = 8, PAD_T = 14, PAD_B = 22;
  const maxAbs = Math.max(...months.flatMap(m => bars.map(b => Math.abs(m[b.key] || 0))), 1);
  const slot = (W - PAD_L - PAD_R) / months.length;
  const step = Math.max(4, Math.min(10, (slot * 0.6) / nb));
  const bw = Math.max(2, Math.min(4, step * 0.6));   // thin bar width
  const midY = PAD_T + (H - PAD_T - PAD_B) / 2;
  const scale = ((H - PAD_T - PAD_B) / 2) / maxAbs;
  const cx = (i) => PAD_L + slot * (i + 0.5);
  const stemX = (i, j) => cx(i) + (j - (nb - 1) / 2) * step;

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const idx = Math.max(0, Math.min(months.length - 1, Math.floor((px - PAD_L) / slot)));
    setHover(idx);
  }
  const hovered = hover != null ? months[hover] : null;
  const mLabel = (ym) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][+ym.slice(5, 7) - 1];

  return (
    <React.Fragment>
    <div className="pm-chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="pf-navchart"
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onTouchStart={onMove}
        onTouchMove={onMove}
        onTouchEnd={() => setHover(null)}
      >
        <line x1={PAD_L} x2={W - PAD_R} y1={midY} y2={midY}
          stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
        {months.map((m, i) => (
          <g key={m.ym} opacity={hover == null || hover === i ? 1 : 0.3}>
            {bars.map((b, j) => {
              const v = m[b.key];
              if (v == null) return null;
              const x = stemX(i, j);
              const h = Math.max(0.5, Math.abs(v) * scale);
              // spx is a benchmark, not a book — mute its solid fill so it reads
              // as a passive reference behind the violet/pink books rather than
              // competing as a fourth series.
              return (
                <rect key={b.key}
                  x={x - bw / 2} y={v >= 0 ? midY - h : midY}
                  width={bw} height={h} rx="1"
                  fill={b.color} fillOpacity={b.key === 'spx' ? 0.5 : 1}/>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="pf-axis-x">
        {months.map((m, i) => (
          <span key={m.ym} style={{ left: `${(cx(i) / W) * 100}%` }}>{mLabel(m.ym)}</span>
        ))}
      </div>
      {hovered && (
        <div className="pm-tooltip" style={{ left: `${(cx(hover) / W) * 100}%`, top: '6%' }}>
          <div className="pm-tt-date">{hovered.ym}</div>
          <div className="pf-tt-bench" style={{ color: '#a78bfa' }}>ibkr {cmbSigned(hovered.ibkr)}</div>
          <div className="pf-tt-bench" style={{ color: '#ff4fd8' }}>poly {cmbSigned(hovered.pm)}</div>
          {hovered.spx != null && (
            <div className="pf-tt-bench" style={{ color: '#5eead4' }}>spx {cmbSigned(hovered.spx)}</div>
          )}
          <div className={`pm-tt-val ${hovered.total >= 0 ? 'pos' : 'neg'}`}>total {cmbSigned(hovered.total)}</div>
        </div>
      )}
    </div>
    <div className="pf-bench-legend">
      {bars.map(b => (
        <span key={b.key}>
          <i className="pf-bench-swatch" style={{ background: b.color, opacity: b.key === 'spx' ? 0.5 : 1 }}/>{b.label}
        </span>
      ))}
    </div>
    </React.Fragment>
  );
}

function Combined({ setView }) {
  const [data, setData] = useCmbState(null);
  const [err, setErr] = useCmbState(null);
  const [range, setRange] = useCmbState('1Y');

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
      let polyNav = null, polyDate = null;
      try {
        const r = await fetch('data/polymarket-breakdown.json', { cache: 'no-store' });
        if (r.ok) { const bd = await r.json(); polyNav = bd.balances ? bd.balances.nav : null; polyDate = bd.generatedAt || null; }
      } catch {}
      const ibkrNav = (portfolio.account && portfolio.account.nav != null) ? portfolio.account.nav : null;
      const ibkrDate = (portfolio.generatedAt || '').slice(0, 10) || null;

      const built = cmbBuild(portfolio, pmRows, bdExtra, benchmarks, pmTransfers);
      built.log = log;
      built.benchmarks = benchmarks;  // raw closes, for rebuilding benchmark $ per range
      if (ibkrNav != null && polyNav != null) {
        // Both NAVs are daily-cron snapshots. Show the *older* input date so the
        // "as of" never overstates how fresh the bar is.
        const dates = [ibkrDate, polyDate].filter(Boolean);
        const asOf = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
        built.deploy = { ibkr: ibkrNav, poly: polyNav, asOf };
      } else {
        built.deploy = null;
      }
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

  const go = (v) => setView ? () => setView(v) : undefined;
  const pct1 = (v) => (v * 100).toFixed(1) + '%';
  // Range selector windows the chart, its strips, AND the risk panel.
  const win = cmbWindow(data.series, data.benchNotional, range, data.benchmarks);
  const risk = cmbRisk(win.series, win.notional);
  // Endpoint of the rebased window = each stream's P&L over the selected range,
  // so the headline + summary tiles track the timeframe on the chart.
  const wLast = (win.series && win.series.length) ? win.series[win.series.length - 1] : { v: 0, ibkr: 0, pm: 0 };
  const wTotal = wLast.v || 0, wIbkr = wLast.ibkr || 0, wPm = wLast.pm || 0;
  const wSpxD = wLast.spx != null ? +(wLast.v - wLast.spx).toFixed(2) : null;
  const wSpxPts = (wSpxD != null && win.notional) ? (wSpxD / win.notional) * 100 : null;
  const pos = wTotal >= 0;
  const rangeSub = range === '1Y' ? 'trailing 12mo' : CMB_RANGE_LABEL[range];
  const rangeNote = data.bdExtra ? `${CMB_RANGE_LABEL[range]} · trading + rewards` : `${CMB_RANGE_LABEL[range]} trading`;

  return (
    <section className="pf-wrap cmb-view">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ overview · ibkr + polymarket</div>
          <h2 className="sz-h2 pm-headline">
            <span>{pos ? '+' : ''}{cmbUSD(wTotal)}</span>
            <span className="pf-currency">{range === '1Y' ? 'trailing 12mo pnl' : `${CMB_RANGE_LABEL[range]} pnl`}</span>
          </h2>
          <div className="pf-sub">
            deposit-adjusted brokerage + prediction-market trading{data.bdExtra ? ' + rewards' : ''}, {rangeSub}
            {!data.pmAvailable && <span> <span className="sz-sep">·</span> polymarket unavailable, showing ibkr only</span>}
          </div>
        </div>
      </div>

      <div className="pf-stats">
        <CmbStat label="ibkr" value={cmbSigned(wIbkr)} tone={wIbkr >= 0 ? 'pos' : 'neg'} onClick={go('portfolio')} note="deposit-adjusted"/>
        <CmbStat label="polymarket" value={cmbSigned(wPm)} tone={wPm >= 0 ? 'pos' : 'neg'} onClick={go('polymarket')} note={rangeNote}/>
        {wSpxD != null && (
          <CmbStat label="vs spx" value={cmbSigned(wSpxD)}
            tone={wSpxD >= 0 ? 'pos' : 'neg'}
            note={`${wSpxPts >= 0 ? '+' : ''}${wSpxPts.toFixed(1)}% on notional`}/>
        )}
      </div>

      {data.series.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">total pnl · {CMB_RANGE_LABEL[range]}</span>
            <div className="pf-range">
              {CMB_RANGES.map(r => (
                <button key={r} type="button"
                  className={`pf-range-btn${range === r ? ' active' : ''}`}
                  onClick={() => setRange(r)}>{r.toLowerCase()}</button>
              ))}
            </div>
          </div>
          <CmbChart series={win.series} log={data.log} bench={data.bench}
            benchNotional={data.benchNotional} ddNotional={win.notional}/>
        </div>
      )}

      {risk && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">risk · {range === '1Y' ? 'trailing 12mo' : CMB_RANGE_LABEL[range]}</span>
            <span className="pf-panel-meta">combined equity · 365d annualized</span>
          </div>
          <div className="cmb-risk-grid">
            <CmbStat label="sharpe"  value={risk.sharpe != null ? risk.sharpe.toFixed(2) : '—'} note="risk-adjusted · rf 0"/>
            <CmbStat label="ann vol" value={risk.vol != null ? pct1(risk.vol) : '—'} note="annualized · 365d"/>
            <CmbStat label="max dd"  value={pct1(risk.maxDD)} tone={risk.maxDD < 0 ? 'neg' : undefined} note="peak-to-trough"/>
            <CmbStat label="beta"    value={risk.beta != null ? risk.beta.toFixed(2) : '—'}
              note={risk.beta != null && risk.r2 != null ? `vs spx · r² ${risk.r2.toFixed(2)}` : 'vs spx'}/>
          </div>
        </div>
      )}

      {data.deploy && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">capital deployment{data.deploy.asOf ? ` · as of ${cmbShortDate(data.deploy.asOf)}` : ''}</span>
            <span className="pf-panel-meta">ibkr nav vs polymarket nav</span>
          </div>
          <CmbDeployBar ibkr={data.deploy.ibkr} poly={data.deploy.poly}/>
        </div>
      )}

      {cmbMonthly(win.series).length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">monthly pnl · {CMB_RANGE_LABEL[range]}</span>
            <span className="pf-panel-meta">ibkr · polymarket · total · vs spx</span>
          </div>
          <CmbMonthlyBars series={win.series}/>
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
