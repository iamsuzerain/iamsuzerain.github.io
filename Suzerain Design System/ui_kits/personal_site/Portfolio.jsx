// Portfolio.jsx — IBKR Flex Query dashboard (reads data/portfolio.json)
// Globals: React, useDecode

const { useEffect: usePortEffect, useState: usePortState, useMemo: usePortMemo, useRef: usePortRef } = React;

function fmtUSD(n, compact = false) {
  if (n == null || isNaN(n)) return '—';
  if (compact && Math.abs(n) >= 1000) {
    return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  const s = (n * 100).toFixed(2) + '%';
  return (n >= 0 ? '+' : '') + s;
}
function fmtDate(iso) {
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
}
function fmtNum(n, dp = 2) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(dp);
}
// Unsigned percentage (for vol / drawdown / concentration where a +/- prefix
// would read oddly). Negative values keep their sign.
function fmtPctBare(n, dp = 1) {
  if (n == null || isNaN(n)) return '—';
  return (n * 100).toFixed(dp) + '%';
}

// Beta and R² of the portfolio's daily TWR against a benchmark's aligned daily
// returns. Both inputs are cumulative-return ratios per perf date; the wealth
// curve is 1 + v so a daily return is wealth_i / wealth_{i-1} - 1.
function computeBeta(perf, benchSeries) {
  if (!perf || perf.length < 21 || !benchSeries) return null;
  const bcum = rebaseBenchmark(benchSeries, perf.map(p => p.d));
  if (!bcum) return null;
  const rp = [], rb = [];
  for (let i = 1; i < perf.length; i++) {
    const pa = 1 + perf[i - 1].v, pb = 1 + perf[i].v;
    const ba = 1 + bcum[i - 1], bb = 1 + bcum[i];
    if (pa > 0 && ba > 0) { rp.push(pb / pa - 1); rb.push(bb / ba - 1); }
  }
  const n = rp.length;
  if (n < 20) return null;
  const mp = rp.reduce((a, b) => a + b, 0) / n, mb = rb.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vb = 0, vp = 0;
  for (let i = 0; i < n; i++) {
    const dp = rp[i] - mp, db = rb[i] - mb;
    cov += dp * db; vb += db * db; vp += dp * dp;
  }
  if (vb === 0 || vp === 0) return null;
  return { beta: cov / vb, r2: (cov * cov) / (vb * vp) };
}

// Underwater series: decline from the running peak of the wealth curve, as a
// non-positive ratio per date.
function drawdownSeries(perf) {
  let peak = perf.length ? 1 + perf[0].v : 1;
  return perf.map(p => {
    const w = 1 + p.v;
    if (w > peak) peak = w;
    return { d: p.d, v: peak > 0 ? w / peak - 1 : 0 };
  });
}

const PF_RANGES = ['1M', '3M', '6M', 'YTD', '1Y'];
const PF_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo' };

function pfRangeCutoff(range, dates) {
  const last = dates[dates.length - 1];
  if (range === 'YTD') return last.slice(0, 4) + '-01-01';
  const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range];
  if (!months) return dates[0];
  const c = new Date(last + 'T00:00:00Z');
  c.setUTCMonth(c.getUTCMonth() - months);
  return c.toISOString().slice(0, 10);
}

// Slice navSeries + perfSeries to a trailing range and re-base the cumulative
// TWR to the window start, so a 3M view reads as the 3M return rather than 3M of
// the full 12mo curve. Both arrays share dates/length, so one index aligns them.
function pfWindow(navSeries, perfSeries, range) {
  if (!perfSeries || perfSeries.length < 2) return { nav: navSeries, perf: perfSeries };
  const cutoff = pfRangeCutoff(range, perfSeries.map(p => p.d));
  let i = perfSeries.findIndex(p => p.d >= cutoff);
  if (i < 0) i = 0;
  if (i > perfSeries.length - 2) i = perfSeries.length - 2;  // keep >= 2 points
  const base = perfSeries[i].v;
  const perf = perfSeries.slice(i).map(p => ({ d: p.d, v: (1 + p.v) / (1 + base) - 1 }));
  return { nav: navSeries.slice(i), perf };
}

// Cumulative alpha: portfolio TWR minus the benchmark's rebased cumulative
// return, per date (both start at 0 at the window start).
function pfAlphaSeries(perf, benchSeries) {
  if (!perf || perf.length < 2 || !benchSeries) return null;
  const b = rebaseBenchmark(benchSeries, perf.map(p => p.d));
  if (!b) return null;
  return perf.map((p, i) => ({ d: p.d, v: p.v - b[i] }));
}

// Sharpe / annualized vol / max drawdown over a (windowed) TWR series. Mirrors
// the Python build_risk: daily HPRs off the 1+v wealth curve, 252-day annualized,
// rf 0. Returns null for windows with too few points.
function pfRiskWindow(perf) {
  if (!perf || perf.length < 21) return null;
  const wealth = perf.map(p => 1 + p.v);
  const rets = [];
  for (let i = 1; i < wealth.length; i++) if (wealth[i - 1] > 0) rets.push(wealth[i] / wealth[i - 1] - 1);
  const n = rets.length;
  if (n < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const PER = 252;
  const vol = sd * Math.sqrt(PER);
  const sharpe = vol ? (mean * PER) / vol : null;
  const dd = drawdownSeries(perf);
  const maxDrawdown = dd.length ? Math.min(0, ...dd.map(p => p.v)) : 0;
  return { sharpe, vol, maxDrawdown };
}

// ---------- Monotone cubic spline (Fritsch-Carlson) ----------
function smoothPath(xs, ys) {
  const n = xs.length;
  if (n < 2) return `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  if (n === 2) return `M${xs[0].toFixed(2)},${ys[0].toFixed(2)} L${xs[1].toFixed(2)},${ys[1].toFixed(2)}`;
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) delta[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = delta[0];
  for (let i = 1; i < n - 1; i++) m[i] = (delta[i - 1] + delta[i]) / 2;
  m[n - 1] = delta[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(delta[i]) < 1e-10) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i], b = m[i + 1] / delta[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] *= t; m[i + 1] *= t; }
  }
  let path = `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    path += ` C${(xs[i] + dx).toFixed(2)},${(ys[i] + m[i] * dx).toFixed(2)} ${(xs[i + 1] - dx).toFixed(2)},${(ys[i + 1] - m[i + 1] * dx).toFixed(2)} ${xs[i + 1].toFixed(2)},${ys[i + 1].toFixed(2)}`;
  }
  return path;
}

// Align a benchmark's daily closes to the perf series dates (forward-fill) and
// rebase to the first matched close, yielding cumulative % return per perf date.
function rebaseBenchmark(benchSeries, perfDates) {
  if (!benchSeries || benchSeries.length < 2) return null;
  const out = new Array(perfDates.length);
  let j = 0, lastClose = null;
  for (let i = 0; i < perfDates.length; i++) {
    while (j < benchSeries.length && benchSeries[j].d <= perfDates[i]) {
      lastClose = benchSeries[j].v;
      j++;
    }
    out[i] = lastClose;
  }
  // Dates before the benchmark's first close: backfill with the first close.
  const firstKnown = out.find(v => v != null);
  if (firstKnown == null) return null;
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = firstKnown;
  const base = out[0];
  return out.map(v => v / base - 1);
}

const BENCH_STYLES = {
  spx: { color: 'rgba(94,234,212,0.55)', solid: '#5eead4' },
  vt:  { color: 'rgba(250,204,21,0.5)',  solid: '#facc15' },
};

// ---------- Performance chart (deposit-adjusted TWR %) ----------
function NavChart({ series, perfSeries, benchmarks }) {
  const W = 920, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 16, PAD_B = 28;
  const svgRef = usePortRef(null);
  const [hover, setHover] = usePortState(null);

  // Use deposit-adjusted TWR series when available, otherwise fall back to raw NAV %
  const base = series[0].v;
  const perf = perfSeries && perfSeries.length === series.length
    ? perfSeries
    : series.map(p => ({ d: p.d, v: (p.v - base) / base }));

  const overlays = usePortMemo(() => {
    if (!benchmarks) return [];
    const dates = perf.map(p => p.d);
    return Object.entries(benchmarks)
      .map(([key, b]) => {
        const vals = rebaseBenchmark(b.series, dates);
        return vals && { key, label: b.label, vals, style: BENCH_STYLES[key] || BENCH_STYLES.spx };
      })
      .filter(Boolean);
  }, [benchmarks, perfSeries, series]);

  const values = perf.map(p => p.v);
  for (const o of overlays) values.push(...o.vals);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = (max - min) * 0.08 || 0.005;
  const y0 = min - pad, y1 = max + pad;
  const x = (i) => PAD_L + (i / (perf.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);

  const linePath = smoothPath(perf.map((_, i) => x(i)), perf.map(p => y(p.v)));
  const areaPath = linePath + ` L${x(perf.length - 1).toFixed(2)},${y(0).toFixed(2)} L${x(0).toFixed(2)},${y(0).toFixed(2)} Z`;

  const tickEvery = Math.max(1, Math.floor(perf.length / 5));
  const ticks = perf.map((p, i) => ({ i, d: p.d })).filter((_, i) => i % tickEvery === 0);
  const gridLines = [y1, (y0 + y1) / 2, y0];
  const yLabels = [
    { v: y1 },
    { v: y0 },
  ];

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    const idx = Math.max(0, Math.min(perf.length - 1, Math.round(t * (perf.length - 1))));
    setHover(idx);
  }

  const hovered = hover != null ? perf[hover] : null;
  const zeroY = y(0);

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
        <defs>
          <linearGradient id="pf-nav-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.32"/>
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0"/>
          </linearGradient>
          <linearGradient id="pf-nav-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a78bfa"/>
            <stop offset="100%" stopColor="#ff4fd8"/>
          </linearGradient>
        </defs>
        {gridLines.map((v, i) => (
          <line key={i}
            x1={PAD_L} x2={W - PAD_R}
            y1={y(v)} y2={y(v)}
            stroke="rgba(167,139,250,0.08)" strokeDasharray="2 4"/>
        ))}
        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
        <path d={areaPath} fill="url(#pf-nav-fill)"/>
        {overlays.map(o => (
          <path key={o.key}
            d={smoothPath(o.vals.map((_, i) => x(i)), o.vals.map(v => y(v)))}
            fill="none" stroke={o.style.color} strokeWidth="1.25"/>
        ))}
        <path d={linePath} fill="none" stroke="url(#pf-nav-stroke)" strokeWidth="1.75"/>
        <circle cx={x(perf.length - 1)} cy={y(perf[perf.length - 1].v)} r="3.5" fill="#ff4fd8"/>
        <circle cx={x(perf.length - 1)} cy={y(perf[perf.length - 1].v)} r="7" fill="#ff4fd8" opacity="0.25"/>
        {hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#a78bfa" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}
      </svg>
      <div className="pf-axis-y">
        {yLabels.map((yl, i) => (
          <span key={i} style={{ top: `${(y(yl.v) / H) * 100}%` }}>{fmtPct(yl.v)}</span>
        ))}
      </div>
      <div className="pf-axis-x">
        {ticks.map((t, i) => (
          <span key={i}
            className={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : ''}
            style={{ left: `${(x(t.i) / W) * 100}%` }}>{t.d}</span>
        ))}
      </div>
      {hovered && (
        <div className="pm-tooltip" style={{
          left: `${(x(hover) / W) * 100}%`,
          top: `${(y(hovered.v) / H) * 100}%`,
        }}>
          <div className="pm-tt-date">{hovered.d}</div>
          <div className={`pm-tt-val ${hovered.v >= 0 ? 'pos' : 'neg'}`}>{fmtPct(hovered.v)}</div>
          {overlays.map(o => (
            <div key={o.key} className="pf-tt-bench" style={{ color: o.style.solid }}>
              {o.label.toLowerCase()} {fmtPct(o.vals[hover])}
            </div>
          ))}
        </div>
      )}
    </div>
    {overlays.length > 0 && (
      <div className="pf-bench-legend">
        <span><i className="pf-bench-swatch" style={{ background: 'linear-gradient(90deg,#a78bfa,#ff4fd8)' }}/>portfolio</span>
        {overlays.map(o => (
          <span key={o.key}><i className="pf-bench-swatch" style={{ background: o.style.solid }}/>{o.label.toLowerCase()}</span>
        ))}
      </div>
    )}
    </React.Fragment>
  );
}

// ---------- Allocation donut ----------
function AllocDonut({ data }) {
  const R = 64, r = 40, cx = 80, cy = 80;
  const C = 2 * Math.PI * ((R + r) / 2);
  let acc = 0;
  const ring = (R + r) / 2;
  const thick = R - r;

  return (
    <div className="pf-alloc">
      <svg viewBox="0 0 160 160" className="pf-donut">
        <circle cx={cx} cy={cy} r={ring} fill="none" stroke="rgba(167,139,250,0.08)" strokeWidth={thick}/>
        {data.map((seg, i) => {
          const len = seg.pct * C;
          const offset = -acc;
          acc += len;
          return (
            <circle key={i}
              cx={cx} cy={cy} r={ring}
              fill="none"
              stroke={seg.color}
              strokeWidth={thick}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: 'stroke-dasharray 400ms ease' }}
            />
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" fontFamily="JetBrains Mono, monospace"
          fontSize="9" fill="rgba(229,225,241,0.5)" letterSpacing="0.18em">ALLOC</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontFamily="Instrument Serif, serif"
          fontSize="18" fill="#f5f0ff">{data.length}</text>
        <text x={cx} y={cy + 22} textAnchor="middle" fontFamily="JetBrains Mono, monospace"
          fontSize="8" fill="rgba(229,225,241,0.4)" letterSpacing="0.14em">SLICES</text>
      </svg>
      <ul className="pf-legend">
        {data.map((seg, i) => (
          <li key={i}>
            <span className="pf-legend-dot" style={{ background: seg.color }}/>
            <span className="pf-legend-label">{seg.label}</span>
            <span className="pf-legend-pct">{(seg.pct * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Stat tile ----------
function StatTile({ label, value, change, kicker }) {
  const pos = change != null && change >= 0;
  return (
    <div className="pf-stat">
      <div className="pf-stat-label">{label}</div>
      <div className="pf-stat-value">{value}</div>
      {change != null && (
        <div className={`pf-stat-chg ${pos ? 'pos' : 'neg'}`}>
          {pos ? '▲' : '▼'} {fmtPct(change)}
        </div>
      )}
      {kicker && <div className="pf-stat-kicker">{kicker}</div>}
    </div>
  );
}

// ---------- Underwater (drawdown) strip ----------
function DrawdownStrip({ perfSeries }) {
  const svgRef = usePortRef(null);
  const [hover, setHover] = usePortState(null);
  if (!perfSeries || perfSeries.length < 2) return null;
  const W = 920, H = 60, PAD_L = 8, PAD_R = 8, PAD_T = 6, PAD_B = 12;
  const dd = drawdownSeries(perfSeries);
  const min = Math.min(0, ...dd.map(p => p.v));
  const x = (i) => PAD_L + (i / (dd.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - min) / (0 - min || 1)) * (H - PAD_T - PAD_B);
  const line = smoothPath(dd.map((_, i) => x(i)), dd.map(p => y(p.v)));
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
          <linearGradient id="pf-dd-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,79,216,0.02)"/>
            <stop offset="100%" stopColor="rgba(255,79,216,0.22)"/>
          </linearGradient>
        </defs>
        <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)}
          stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
        <path d={area} fill="url(#pf-dd-fill)"/>
        <path d={line} fill="none" stroke="rgba(255,110,196,0.75)" strokeWidth="1.25"/>
        {hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#ff6ec4" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}
      </svg>
      {hovered && (
        <div className="pm-tooltip" style={{
          left: `${(x(hover) / W) * 100}%`,
          top: `${(y(hovered.v) / H) * 100}%`,
        }}>
          <div className="pm-tt-date">{hovered.d}</div>
          <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{fmtPctBare(hovered.v)}</div>
        </div>
      )}
    </div>
  );
}

// ---------- Rolling alpha strip (cumulative TWR minus SPX, zero-centered) ----------
function AlphaStrip({ alpha }) {
  const svgRef = usePortRef(null);
  const [hover, setHover] = usePortState(null);
  if (!alpha || alpha.length < 2) return null;
  const W = 920, H = 60, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 12;
  const vals = alpha.map(p => p.v);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.12 || 0.002;
  const y0 = lo - pad, y1 = hi + pad;
  const x = (i) => PAD_L + (i / (alpha.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);
  const line = smoothPath(alpha.map((_, i) => x(i)), alpha.map(p => y(p.v)));
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
          <linearGradient id="pf-alpha-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(96,165,250,0.22)"/>
            <stop offset="100%" stopColor="rgba(96,165,250,0.02)"/>
          </linearGradient>
        </defs>
        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
        <path d={area} fill="url(#pf-alpha-fill)"/>
        <path d={line} fill="none" stroke="rgba(96,165,250,0.85)" strokeWidth="1.25"/>
        {hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#60a5fa" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}
      </svg>
      {hovered && (
        <div className="pm-tooltip" style={{
          left: `${(x(hover) / W) * 100}%`,
          top: `${(y(hovered.v) / H) * 100}%`,
        }}>
          <div className="pm-tt-date">{hovered.d}</div>
          <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{hovered.v >= 0 ? '+' : ''}{fmtPctBare(hovered.v)}</div>
        </div>
      )}
    </div>
  );
}

// ---------- Positions table ----------
function posTypeLabel(assetClass, subCategory) {
  const ac = (assetClass || '').toUpperCase();
  const sub = (subCategory || '').toUpperCase();
  if (ac === 'CRYPTO') return 'crypto';
  if (ac === 'FOP') return sub === 'C' ? 'fut·call' : sub === 'P' ? 'fut·put' : 'fut';
  if (ac === 'OPT') return sub === 'C' ? 'call' : sub === 'P' ? 'put' : 'opt';
  if (ac === 'STK') {
    if (sub === 'ETF') return 'ETF';
    if (sub === 'ADR') return 'ADR';
    return 'stock';
  }
  return ac.toLowerCase() || '—';
}

function TypeBadge({ assetClass, subCategory }) {
  const label = posTypeLabel(assetClass, subCategory);
  return <span className="pf-type-badge" data-type={label}>{label}</span>;
}

function PositionsTable({ rows }) {
  return (
    <div className="pf-table-wrap">
      <table className="pf-table">
        <thead>
          <tr>
            <th>symbol</th>
            <th>name</th>
            <th className="pf-num">qty</th>
            <th className="pf-num">mkt value</th>
            <th className="pf-num">return</th>
            <th>type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const retPct = p.costBasis !== 0 ? p.unrealized / Math.abs(p.costBasis) : null;
            const up = retPct == null ? true : retPct >= 0;
            return (
              <tr key={p.symbol}>
                <td className="pf-sym">{p.symbol}</td>
                <td className="pf-name">{p.name}</td>
                <td className="pf-num">{p.qty}</td>
                <td className="pf-num">{fmtUSD(p.mktValue)}</td>
                <td className={`pf-num ${up ? 'pos' : 'neg'}`}>
                  {retPct != null ? fmtPct(retPct) : '—'}
                </td>
                <td><TypeBadge assetClass={p.assetClass} subCategory={p.subCategory}/></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- contribution to return (diverging bars) ----------
function ContributionBars({ rows, limit = 12 }) {
  if (!rows || !rows.length) return null;
  const top = rows.slice(0, limit);
  const maxAbs = Math.max(...top.map(r => Math.abs(r.total)), 1);
  const sum = rows.reduce((a, r) => a + r.total, 0);
  return (
    <div className="pf-contrib">
      {top.map(r => {
        const w = (Math.abs(r.total) / maxAbs) * 50;  // % of the half-track
        const pos = r.total >= 0;
        return (
          <div className="pf-contrib-row" key={r.symbol}>
            <span className="pf-contrib-sym" title={r.legs > 1 ? `${r.name} · ${r.legs} contracts` : r.name}>{r.symbol}</span>
            <div className="pf-contrib-track">
              <div className="pf-contrib-center"/>
              <div className={`pf-contrib-bar ${pos ? 'pos' : 'neg'}`}
                style={pos ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}/>
            </div>
            <span className={`pf-contrib-val ${pos ? 'pos' : 'neg'}`}>{pos ? '+' : ''}{fmtUSD(r.total)}</span>
          </div>
        );
      })}
      <div className="pf-contrib-foot">
        <span>{top.length} of {rows.length} holdings</span>
        <span>net {sum >= 0 ? '+' : ''}{fmtUSD(sum)}</span>
      </div>
    </div>
  );
}

// ---------- main view ----------
function Portfolio() {
  const [data, setData] = usePortState(null);
  const [err, setErr] = usePortState(null);
  const [bench, setBench] = usePortState(null);
  const [range, setRange] = usePortState('1Y');

  usePortEffect(() => {
    fetch('data/portfolio.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(setData)
      .catch(e => setErr(String(e)));
    // Benchmark overlay is best-effort; the chart renders fine without it.
    fetch('data/benchmarks.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(b => { if (b && b.benchmarks) setBench(b.benchmarks); })
      .catch(() => {});
  }, []);

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ ibkr</div>
      <h2 className="sz-h2">couldn't load ibkr feed.</h2>
      <p><code>{err}</code></p>
      <p className="sz-dim">the daily IBKR flex fetch may not have run yet. see <code>scripts/ibkr-flex/README.md</code>.</p>
    </section>
  );
  if (!data) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ ibkr</div>
      <h2 className="sz-h2">fetching latest positions<Cursor /></h2>
    </section>
  );

  const d = data;
  const updated = new Date(d.generatedAt);
  const updatedStr = updated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const risk = d.risk;                       // still the source for concentration
  const conc = risk && risk.concentration;   // position-based, not windowed

  // Range selector windows the chart, its strips, AND the risk tiles.
  const win = pfWindow(d.navSeries, d.perfSeries, range);
  // Plain computations (not hooks) — these run after the early returns above, so a
  // useMemo here would violate the rules of hooks. Both are cheap.
  const winRisk = pfRiskWindow(win.perf) || risk;
  const betaObj = bench && bench.spx ? computeBeta(win.perf, bench.spx.series) : null;
  const alpha = bench && bench.spx ? pfAlphaSeries(win.perf, bench.spx.series) : null;
  const winDd = win.perf && win.perf.length ? drawdownSeries(win.perf) : [];
  const winMaxDd = winDd.length ? Math.min(0, ...winDd.map(p => p.v)) : 0;
  const winCurDd = winDd.length ? winDd[winDd.length - 1].v : 0;
  const alphaNow = alpha && alpha.length ? alpha[alpha.length - 1].v : null;

  return (
    <section className="pf-wrap">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ ibkr · flex query feed</div>
          <h2 className="sz-h2">${Math.round(d.account.nav).toLocaleString()}<span className="pf-currency">{d.account.currency}</span></h2>
          <div className="pf-sub">
            account {d.account.id} <span className="sz-sep">·</span>
            cash {fmtUSD(d.account.cash)} <span className="sz-sep">·</span>
            buying power {fmtUSD(d.account.buyingPower)}
          </div>
        </div>
        <div className="pf-updated">
          <span className="pf-dot"/>
          <span>auto-updated {updatedStr}</span>
        </div>
      </div>

      <div className="pf-stats">
        <StatTile label="mtd"  value={fmtUSD(d.pnl.mtd.abs)}  change={d.pnl.mtd.pct}  kicker="month to date"/>
        <StatTile label="qtd"  value={fmtUSD(d.pnl.qtd.abs)}  change={d.pnl.qtd.pct}  kicker="quarter to date"/>
        <StatTile label="ytd"  value={fmtUSD(d.pnl.ytd.abs)}  change={d.pnl.ytd.pct}  kicker="year to date"/>
        {d.pnl['1y'] && <StatTile label="1y" value={fmtUSD(d.pnl['1y'].abs)} change={d.pnl['1y'].pct} kicker="trailing 12mo · twr"/>}
      </div>

      {risk && (
        <div className="pf-stats pf-stats-risk">
          <StatTile label="sharpe"  value={fmtNum(winRisk.sharpe)}          kicker="risk-adjusted · rf 0"/>
          <StatTile label="ann vol" value={fmtPctBare(winRisk.vol)}         kicker="annualized · twr"/>
          <StatTile label="max dd"  value={fmtPctBare(winRisk.maxDrawdown)} kicker="peak-to-trough"/>
          <StatTile label="beta"    value={betaObj ? fmtNum(betaObj.beta) : '—'}
                    kicker={betaObj ? `vs spx · r² ${fmtNum(betaObj.r2)}` : 'vs spx'}/>
        </div>
      )}

      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">performance · {PF_RANGE_LABEL[range]}</span>
          <div className="pf-range">
            {PF_RANGES.map(r => (
              <button key={r} type="button"
                className={`pf-range-btn${range === r ? ' active' : ''}`}
                onClick={() => setRange(r)}>{r.toLowerCase()}</button>
            ))}
          </div>
        </div>
        <NavChart series={win.nav} perfSeries={win.perf} benchmarks={bench}/>
        <div className="pf-strip-head">
          <span className="pf-strip-label">underwater · drawdown from peak</span>
          <span className="pf-strip-meta">max {fmtPctBare(winMaxDd)} · now {fmtPctBare(winCurDd)}</span>
        </div>
        <DrawdownStrip perfSeries={win.perf}/>
        {alpha && (
          <>
            <div className="pf-strip-head">
              <span className="pf-strip-label">alpha vs spx · cumulative</span>
              <span className="pf-strip-meta">now {alphaNow >= 0 ? '+' : ''}{fmtPctBare(alphaNow)}</span>
            </div>
            <AlphaStrip alpha={alpha}/>
          </>
        )}
      </div>

      <div className="pf-row">
        <div className="pf-panel pf-panel-alloc">
          <div className="pf-panel-head">
            <span className="pf-panel-title">allocation</span>
            <span className="pf-panel-meta">by asset class</span>
          </div>
          <AllocDonut data={d.allocation}/>
        </div>
        <div className="pf-panel pf-panel-pos">
          <div className="pf-panel-head">
            <span className="pf-panel-title">top positions</span>
            <span className="pf-panel-meta">{conc ? `top ${fmtPctBare(conc.top)} · top-3 ${fmtPctBare(conc.top3)}` : `${d.positions.length} shown`} · by weight</span>
          </div>
          <PositionsTable rows={d.positions}/>
        </div>
      </div>

      {d.contribution && d.contribution.length > 0 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">contribution to return · 12mo</span>
            <span className="pf-panel-meta">mark-to-market p&l per holding</span>
          </div>
          <ContributionBars rows={d.contribution}/>
        </div>
      )}

      <div className="pf-footer">
        <span>source · IBKR Flex Query (daily cron via github actions)</span>
        <span className="sz-sep">·</span>
        <span>not financial advice</span>
        <span className="sz-sep">·</span>
        <span>delayed up to 24h</span>
      </div>
    </section>
  );
}

window.Portfolio = Portfolio;
