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

// ---------- shared daily-return helpers ----------
// perfSeries carries cumulative return as a ratio, so the wealth curve is 1 + v
// and a daily holding-period return is wealth_i / wealth_{i-1} - 1. The
// distribution, rolling, and capture panels below all start from these two.

function pfDailyReturns(perf) {
  const out = [];
  if (!perf) return out;
  for (let i = 1; i < perf.length; i++) {
    const a = 1 + perf[i - 1].v, b = 1 + perf[i].v;
    if (a > 0) out.push({ d: perf[i].d, v: b / a - 1 });
  }
  return out;
}

// Portfolio and benchmark daily returns on one shared date axis, so every
// paired statistic (beta, correlation, capture) compares like with like.
function pfPairedReturns(perf, benchSeries) {
  if (!perf || perf.length < 2 || !benchSeries) return null;
  const bcum = rebaseBenchmark(benchSeries, perf.map(p => p.d));
  if (!bcum) return null;
  const out = [];
  for (let i = 1; i < perf.length; i++) {
    const pa = 1 + perf[i - 1].v, pb = 1 + perf[i].v;
    const ba = 1 + bcum[i - 1], bb = 1 + bcum[i];
    if (pa > 0 && ba > 0) out.push({ d: perf[i].d, p: pb / pa - 1, b: bb / ba - 1 });
  }
  return out;
}

// OLS of portfolio return on benchmark return over an already-paired sample.
// Returns the slope (beta) plus R²; null when either side has no variance.
function pfOls(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let mp = 0, mb = 0;
  for (const x of pairs) { mp += x.p; mb += x.b; }
  mp /= n; mb /= n;
  let cov = 0, vb = 0, vp = 0;
  for (const x of pairs) {
    const dp = x.p - mp, db = x.b - mb;
    cov += dp * db; vb += db * db; vp += dp * dp;
  }
  if (vb === 0 || vp === 0) return null;
  return { beta: cov / vb, r2: (cov * cov) / (vb * vp), corr: cov / Math.sqrt(vb * vp) };
}

// Beta and R² of the portfolio's daily TWR against a benchmark's aligned daily
// returns.
function computeBeta(perf, benchSeries) {
  if (!perf || perf.length < 21) return null;
  const pairs = pfPairedReturns(perf, benchSeries);
  if (!pairs || pairs.length < 20) return null;
  return pfOls(pairs);
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

const PF_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'MAX'];
const PF_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo', 'MAX': 'max' };

// A quarter key ("2025Q3") is a closed window and carries an end date; every
// other range runs to the last point and returns null from pfRangeEnd.
function pfRangeEnd(range) {
  const b = window.szQuarterBounds && window.szQuarterBounds(range);
  return b ? b.end : null;
}

function pfRangeLabel(range) {
  return PF_RANGE_LABEL[range] || (window.szQuarterLabel && window.szQuarterLabel(range)) || range;
}

function pfRangeCutoff(range, dates) {
  const last = dates[dates.length - 1];
  const qb = window.szQuarterBounds && window.szQuarterBounds(range);
  if (qb) return qb.start;
  if (range === 'YTD') return last.slice(0, 4) + '-01-01';
  const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range];
  if (!months) return dates[0];
  const c = new Date(last + 'T00:00:00Z');
  c.setUTCMonth(c.getUTCMonth() - months);
  return c.toISOString().slice(0, 10);
}

// Prepend accumulated multi-year history (nav-history.json `t` = cumulative TWR)
// ahead of the Flex-window perfSeries so the MAX range extends the IBKR curve
// past 12 months. History is rebased multiplicatively to meet perfSeries[0]
// (v = 0 at the seam) continuously — the trailing window is left untouched. A
// length-matched placeholder nav rides along because NavChart reads navSeries
// only for its length when perfSeries is present (values come from perf).
function pfExtendHistory(navSeries, perfSeries, hist) {
  const rows = hist && hist.rows;
  if (!rows || !rows.length || !perfSeries || !perfSeries.length) return { nav: navSeries, perf: perfSeries };
  const seamD = perfSeries[0].d;
  let tSeam = null;                            // history TWR at the seam (exact, else nearest earlier)
  for (const r of rows) { if (r.t == null) continue; if (r.d <= seamD) tSeam = r.t; else break; }
  if (tSeam == null) return { nav: navSeries, perf: perfSeries };
  const f = 1 + tSeam;
  const pre = rows.filter(r => r.d < seamD && r.t != null)
                  .map(r => ({ d: r.d, v: (1 + r.t) / f - 1 }));
  if (!pre.length) return { nav: navSeries, perf: perfSeries };
  return { nav: pre.map(r => ({ d: r.d, v: 0 })).concat(navSeries), perf: pre.concat(perfSeries) };
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
  // A completed quarter also stops early; trailing ranges run to the end.
  const endCut = pfRangeEnd(range);
  let j = perfSeries.length - 1;
  if (endCut) {
    const over = perfSeries.findIndex(p => p.d > endCut);
    if (over > 0) j = over - 1;
  }
  if (j < i + 1) j = Math.min(perfSeries.length - 1, i + 1);
  const base = perfSeries[i].v;
  const perf = perfSeries.slice(i, j + 1).map(p => ({ d: p.d, v: (1 + p.v) / (1 + base) - 1 }));
  return { nav: navSeries.slice(i, j + 1), perf };
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

// ---------- distribution moments ----------
// Sharpe describes a return series as if it were normal. This is the check on
// that assumption: skew says which tail is longer, excess kurtosis how fat both
// are. A short-gamma book typically prints negative skew with fat tails, which
// is precisely the shape an annualized Sharpe flatters.
function pfMoments(rets) {
  const n = rets.length;
  if (n < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (!sd) return null;
  let s3 = 0, s4 = 0;
  for (const r of rets) { const z = (r - mean) / sd; s3 += z ** 3; s4 += z ** 4; }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    n, mean, sd,
    median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    skew: s3 / n,
    kurt: s4 / n - 3,          // excess: 0 is normal
    posDays: rets.filter(r => r > 0).length / n,
    best: sorted[n - 1],
    worst: sorted[0],
  };
}

// Abramowitz & Stegun 7.1.26 — plenty of precision for a reference curve.
function pfErf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const pfNormCdf = (z) => 0.5 * (1 + pfErf(z / Math.SQRT2));

// Histogram of daily returns on bins of equal width, laid out symmetrically about
// zero so the zero line always falls on a bin edge rather than inside a bar.
// `expected` is the count a normal with the same mean/sd would put in each bin —
// the overlay that makes the tails legible.
function pfHistogram(rets, moments, targetBins = 28) {
  if (!rets.length || !moments) return null;
  const maxAbs = Math.max(...rets.map(r => Math.abs(r))) || 0.01;
  const half = Math.max(4, Math.round(targetBins / 2));
  const w = maxAbs / half;
  const bins = [];
  for (let i = -half; i < half; i++) {
    const lo = i * w, hi = lo + w;
    bins.push({
      lo, hi, count: 0,
      expected: moments.n * (pfNormCdf((hi - moments.mean) / moments.sd)
                           - pfNormCdf((lo - moments.mean) / moments.sd)),
    });
  }
  for (const r of rets) {
    let i = Math.floor(r / w) + half;
    if (i < 0) i = 0;
    if (i >= bins.length) i = bins.length - 1;
    bins[i].count++;
  }
  return { bins, w };
}

// ---------- rolling risk ----------
// The tiles report one number per window; this reports how that number moved
// inside the window. A book whose net exposure swings shows it here and nowhere
// else. Window adapts down on short ranges so 1M still plots something honest.
const PF_ROLL_METRICS = {
  beta: { label: 'beta vs spx', zero: 1, fmt: (v) => fmtNum(v, 2), bench: true },
  vol:  { label: 'ann vol',     zero: 0, fmt: (v) => fmtPctBare(v, 1), bench: false },
  corr: { label: 'corr vs spx', zero: 0, fmt: (v) => fmtNum(v, 2), bench: true },
};

// `periods` is the annualization factor for vol: 252 for a trading-day series
// (IBKR), 365 for a calendar-day one (the overview, which includes weekends
// because prediction markets trade them).
function pfRolling(perf, benchSeries, metric, periods = 252) {
  const spec = PF_ROLL_METRICS[metric];
  if (!spec) return null;
  const rows = spec.bench
    ? pfPairedReturns(perf, benchSeries)
    : pfDailyReturns(perf).map(r => ({ d: r.d, p: r.v, b: 0 }));
  if (!rows || rows.length < 40) return null;
  // Half the sample, capped at 60 sessions and floored at 20 — enough points to
  // mean something, few enough that a 3M range still yields a curve.
  const w = Math.max(20, Math.min(60, Math.floor(rows.length / 2)));

  // One slot per perf date, null until the lookback window has filled. The strip
  // must share the chart's date axis: a rolling series is shorter than the window
  // it summarises, and stretching those fewer points across the same pixel width
  // silently slides every date sideways, so a vertical read against the chart and
  // the strips above it lands on the wrong day. Leading nulls keep x = date.
  const series = perf.map(p => ({ d: p.d, v: null }));
  const slotOf = new Map();
  perf.forEach((p, i) => slotOf.set(p.d, i));

  for (let j = w - 1; j < rows.length; j++) {
    const slice = rows.slice(j - w + 1, j + 1);
    let v = null;
    if (metric === 'vol') {
      const m = slice.reduce((a, x) => a + x.p, 0) / w;
      v = Math.sqrt(slice.reduce((a, x) => a + (x.p - m) ** 2, 0) / (w - 1)) * Math.sqrt(periods);
    } else {
      const o = pfOls(slice);
      v = o && (metric === 'beta' ? o.beta : o.corr);
    }
    const slot = slotOf.get(rows[j].d);
    if (v != null && isFinite(v) && slot != null) series[slot].v = v;
  }

  const firstIdx = series.findIndex(p => p.v != null);
  const defined = series.filter(p => p.v != null).length;
  return defined > 2 ? { series, window: w, firstIdx, defined } : null;
}

// Roll over the FULL series, then show the selected window.
//
// Computing the roll on the windowed slice instead would waste history that is
// already loaded: a 3M view would spend its first 30 sessions warming up a
// lookback that could have been filled from February. Because the lookback may
// reach back past the left edge, a short range arrives fully populated, and a
// "60-session beta" means the same thing on every range rather than silently
// shrinking with the window. Daily returns are invariant to pfWindow's rebasing
// (it scales the whole wealth curve by a constant), so the full-series roll and
// the windowed chart describe the same underlying days.
function pfRollingWindowed(fullPerf, winPerf, benchSeries, metric, periods = 252) {
  const full = pfRolling(fullPerf, benchSeries, metric, periods);
  if (!full || !winPerf || !winPerf.length) return null;
  const byDate = new Map(full.series.map(p => [p.d, p.v]));
  const series = winPerf.map(p => ({ d: p.d, v: byDate.has(p.d) ? byDate.get(p.d) : null }));
  const defined = series.filter(p => p.v != null).length;
  if (defined <= 2) return null;
  return {
    series, window: full.window, defined,
    firstIdx: series.findIndex(p => p.v != null),
  };
}

// ---------- up / down capture ----------
// Beta assumes one linear relationship holds in both directions. For a book with
// options on both sides that is the wrong shape, so measure each direction
// separately: how much of SPX's gain the book captured on its up days, and how
// much of its loss on the down days. Down capture below up capture is the
// asymmetry every hedged book is trying to buy.
function pfCapture(perf, benchSeries) {
  const pairs = pfPairedReturns(perf, benchSeries);
  if (!pairs || pairs.length < 20) return null;
  const up = pairs.filter(x => x.b > 0), down = pairs.filter(x => x.b < 0);
  if (up.length < 5 || down.length < 5) return null;
  // Compounded over the subset, the standard capture-ratio definition.
  const comp = (arr, k) => arr.reduce((a, x) => a * (1 + x[k]), 1) - 1;
  const upB = comp(up, 'b'), downB = comp(down, 'b');
  const bull = pfOls(up), bear = pfOls(down);
  return {
    upCapture: upB ? comp(up, 'p') / upB : null,
    downCapture: downB ? comp(down, 'p') / downB : null,
    bullBeta: bull ? bull.beta : null,
    bearBeta: bear ? bear.beta : null,
    upDays: up.length,
    downDays: down.length,
  };
}

// ---------- drawdown episodes ----------
// The underwater strip shows the shape; this names the events. An episode runs
// from the peak that preceded the decline to the day the curve regains it, and
// stays open (recovery null) if the book is still below that peak today.
function pfDrawdownEpisodes(perf, limit = 5) {
  if (!perf || perf.length < 3) return [];
  const dd = drawdownSeries(perf);
  const eps = [];
  let cur = null;
  for (let i = 0; i < dd.length; i++) {
    if (dd[i].v < 0) {
      if (!cur) cur = { start: dd[Math.max(0, i - 1)].d, depth: 0, trough: dd[i].d };
      if (dd[i].v < cur.depth) { cur.depth = dd[i].v; cur.trough = dd[i].d; }
    } else if (cur) {
      cur.recovery = dd[i].d;
      eps.push(cur);
      cur = null;
    }
  }
  if (cur) { cur.recovery = null; eps.push(cur); }
  const last = dd[dd.length - 1].d;
  const days = (a, b) => Math.round(
    (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  for (const e of eps) {
    e.length = days(e.start, e.recovery || last);
    e.toTrough = days(e.start, e.trough);
    e.recoveryDays = e.recovery ? days(e.trough, e.recovery) : null;
  }
  return eps.sort((a, b) => a.depth - b.depth).slice(0, limit);
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
          {/* Vertical, value-keyed: pink where the line runs high, violet where low. */}
          <linearGradient id="pf-nav-stroke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff4fd8"/>
            <stop offset="100%" stopColor="#a78bfa"/>
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
// Slices are shares of gross exposure (see build_allocation): pct is unsigned and
// the set sums to 1, so the ring is always exactly one revolution. A bucket that
// is net short still occupies its share of the ring — it carries that exposure —
// and is called out in the legend rather than being drawn as if it were a long.
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
          // Clamp defensively: a malformed feed must never draw an arc longer
          // than the circumference (that wraps and paints over its neighbours).
          const len = Math.max(0, Math.min(seg.pct || 0, 1)) * C;
          const offset = -acc;
          acc += len;
          const dash = { strokeDasharray: `${len} ${C - len}`, strokeDashoffset: offset };
          const spin = `rotate(-90 ${cx} ${cy})`;
          return (
            <React.Fragment key={i}>
              {/* Long slices are solid. Net-short slices read hollow — the band
                  drops to a ghost and a thin rail runs down its centre — so
                  direction is legible without leaning on the legend alone. */}
              <circle
                cx={cx} cy={cy} r={ring}
                fill="none"
                stroke={seg.color}
                strokeOpacity={seg.short ? 0.26 : 1}
                strokeWidth={thick}
                {...dash}
                transform={spin}
                style={{ transition: 'stroke-dasharray 400ms ease' }}
              />
              {seg.short && (
                <circle
                  cx={cx} cy={cy} r={ring}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="2.5"
                  {...dash}
                  transform={spin}
                  style={{ transition: 'stroke-dasharray 400ms ease' }}
                />
              )}
            </React.Fragment>
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
          <li key={i} title={seg.net != null ? `net ${fmtUSD(seg.net)} · gross ${fmtUSD(seg.gross)}` : undefined}>
            <span className="pf-legend-dot" style={{ background: seg.color }}/>
            <span className="pf-legend-label">
              {seg.label}
              {seg.short && <span className="pf-legend-short">short</span>}
            </span>
            {/* A real but sub-1% slice reads "<1%" rather than rounding to a
                flat 0% — it is present in the book, so say so. */}
            <span className="pf-legend-pct">
              {seg.pct > 0 && seg.pct < 0.005 ? '<1%' : `${(seg.pct * 100).toFixed(0)}%`}
            </span>
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

// ---------- Return distribution (histogram + normal reference) ----------
function ReturnDistribution({ perfSeries }) {
  const [hover, setHover] = usePortState(null);
  const rets = pfDailyReturns(perfSeries).map(r => r.v);
  const m = pfMoments(rets);
  const hist = m && pfHistogram(rets, m);
  if (!hist) return null;

  const W = 920, H = 180, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 24;
  const { bins } = hist;
  const maxCount = Math.max(...bins.map(b => Math.max(b.count, b.expected)), 1);
  const bw = (W - PAD_L - PAD_R) / bins.length;
  const x = (i) => PAD_L + i * bw;
  const y = (c) => PAD_T + (1 - c / maxCount) * (H - PAD_T - PAD_B);
  const base = y(0);
  const zeroX = PAD_L + (bins.findIndex(b => b.lo >= 0)) * bw;

  // Normal reference with the same mean and sd — where the bars overshoot it in
  // the tails and undershoot near the middle is the fat tail, drawn.
  const normPath = smoothPath(
    bins.map((_, i) => x(i) + bw / 2),
    bins.map(b => y(b.expected)));

  const hb = hover != null ? bins[hover] : null;

  return (
    <React.Fragment>
      <div className="pm-chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="pf-navchart" preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}>
          <defs>
            {/* Diverging pair matches .pf-contrib-bar.pos/.neg and the nav-chart
                stroke: pink is the positive/high side, violet the negative/low
                side. Same convention across every chart on the page. */}
            <linearGradient id="pf-hist-pos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff4fd8" stopOpacity="0.85"/>
              <stop offset="100%" stopColor="#ff4fd8" stopOpacity="0.35"/>
            </linearGradient>
            <linearGradient id="pf-hist-neg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.85"/>
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.35"/>
            </linearGradient>
          </defs>
          <line x1={PAD_L} x2={W - PAD_R} y1={base} y2={base} stroke="rgba(229,225,241,0.18)"/>
          {bins.map((b, i) => {
            const h = base - y(b.count);
            return (
              <rect key={i}
                x={x(i) + 0.75} width={Math.max(0.5, bw - 1.5)}
                y={y(b.count)} height={Math.max(0, h)}
                fill={b.lo < 0 ? 'url(#pf-hist-neg)' : 'url(#pf-hist-pos)'}
                opacity={hover == null || hover === i ? 1 : 0.45}
                onMouseEnter={() => setHover(i)}
              />
            );
          })}
          {/* Hit targets wider than the bars themselves. */}
          {bins.map((b, i) => (
            <rect key={`h${i}`} x={x(i)} y={PAD_T} width={bw} height={H - PAD_T - PAD_B}
              fill="transparent" onMouseEnter={() => setHover(i)}/>
          ))}
          <path d={normPath} fill="none" stroke="rgba(94,234,212,0.7)"
            strokeWidth="1.25" strokeDasharray="3 3"/>
          <line x1={zeroX} x2={zeroX} y1={PAD_T} y2={base}
            stroke="rgba(229,225,241,0.28)" strokeDasharray="2 3"/>
        </svg>
        <div className="pf-axis-x">
          <span className="start" style={{ left: '0%' }}>{fmtPctBare(bins[0].lo, 1)}</span>
          <span style={{ left: `${(zeroX / W) * 100}%` }}>0%</span>
          <span className="end" style={{ left: '100%' }}>{fmtPctBare(bins[bins.length - 1].hi, 1)}</span>
        </div>
        {hb && (
          <div className="pm-tooltip" style={{
            left: `${((x(bins.indexOf(hb)) + bw / 2) / W) * 100}%`,
            top: `${(y(hb.count) / H) * 100}%`,
          }}>
            <div className="pm-tt-date">{fmtPctBare(hb.lo, 1)} … {fmtPctBare(hb.hi, 1)}</div>
            <div className={`pm-tt-val ${hb.lo < 0 ? 'neg' : 'pos'}`}>{hb.count} sessions</div>
            <div className="pf-tt-bench" style={{ color: '#5eead4' }}>
              normal {hb.expected.toFixed(1)}
            </div>
          </div>
        )}
      </div>
      <div className="pf-dist-stats">
        <span><b>{fmtNum(m.skew, 2)}</b> skew</span>
        <span><b>{fmtNum(m.kurt, 2)}</b> excess kurtosis</span>
        <span><b>{fmtPctBare(m.posDays, 0)}</b> positive sessions</span>
        <span><b>{fmtPctBare(m.best, 2)}</b> best</span>
        <span><b>{fmtPctBare(m.worst, 2)}</b> worst</span>
        <span><b>{m.n}</b> sessions</span>
      </div>
    </React.Fragment>
  );
}

// ---------- Rolling risk strip ----------
function RollingStrip({ fullSeries, perfSeries, benchSeries, periods = 252 }) {
  const [metric, setMetric] = usePortState('beta');
  const svgRef = usePortRef(null);
  const [hover, setHover] = usePortState(null);

  const available = Object.keys(PF_ROLL_METRICS)
    .filter(k => (benchSeries ? true : !PF_ROLL_METRICS[k].bench));
  const active = available.includes(metric) ? metric : available[0];
  const spec = PF_ROLL_METRICS[active];
  const roll = pfRollingWindowed(fullSeries || perfSeries, perfSeries, benchSeries, active, periods);
  if (!roll) return null;

  const { series, window: win, firstIdx } = roll;
  const W = 920, H = 60, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 12;
  const vals = series.filter(p => p.v != null).map(p => p.v);
  const lo = Math.min(spec.zero, ...vals), hi = Math.max(spec.zero, ...vals);
  const pad = (hi - lo) * 0.12 || 0.01;
  const y0 = lo - pad, y1 = hi + pad;
  // x spans every perf date, including the blank warm-up, so this strip lines up
  // column-for-column with the chart and strips above it.
  const x = (i) => PAD_L + (i / (series.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);
  const drawn = series.map((p, i) => ({ p, i })).filter(o => o.p.v != null);
  const line = smoothPath(drawn.map(o => x(o.i)), drawn.map(o => y(o.p.v)));
  const refY = y(spec.zero);

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(t * (series.length - 1)))));
  }
  // Only the filled part of the axis carries a reading; hovering the warm-up
  // shows the crosshair (so it still tracks the charts above) but no value.
  const hovered = hover != null && series[hover] && series[hover].v != null
    ? series[hover] : null;
  const now = vals.length ? vals[vals.length - 1] : null;

  return (
    <React.Fragment>
      <div className="pf-strip-head">
        <span className="pf-strip-label">rolling {spec.label} · {win}-session</span>
        <div className="pf-strip-toggle">
          <div className="pf-range">
            {available.map(k => (
              <button key={k} type="button"
                className={`pf-range-btn${active === k ? ' active' : ''}`}
                onClick={() => setMetric(k)}>{k}</button>
            ))}
          </div>
          <span className="pf-strip-meta">now {spec.fmt(now)}</span>
        </div>
      </div>
      <div className="pm-chart-wrap">
        <svg ref={svgRef} className="pf-navchart" viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}
          onTouchStart={onMove} onTouchMove={onMove} onTouchEnd={() => setHover(null)}>
          <line x1={PAD_L} x2={W - PAD_R} y1={refY} y2={refY}
            stroke="rgba(229,225,241,0.18)" strokeDasharray="3 5"/>
          {/* Where the lookback window finishes filling — left of it the metric
              simply does not exist yet, rather than being zero. */}
          {firstIdx > 0 && (
            <line x1={x(firstIdx)} x2={x(firstIdx)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(167,139,250,0.22)" strokeDasharray="1 4"/>
          )}
          <path d={line} fill="none" stroke="rgba(167,139,250,0.9)" strokeWidth="1.25"/>
          {hover != null && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
          )}
          {hovered && (
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#a78bfa"
              stroke="#0a0612" strokeWidth="1.5"/>
          )}
        </svg>
        {hovered && (
          <div className="pm-tooltip" style={{
            left: `${(x(hover) / W) * 100}%`,
            top: `${(y(hovered.v) / H) * 100}%`,
          }}>
            <div className="pm-tt-date">{hovered.d}</div>
            <div className="pm-tt-val">{spec.fmt(hovered.v)}</div>
          </div>
        )}
      </div>
    </React.Fragment>
  );
}

// ---------- Drawdown episode table ----------
function DrawdownTable({ episodes }) {
  if (!episodes || !episodes.length) return null;
  return (
    <div className="pf-table-wrap">
      <table className="pf-table">
        <thead>
          <tr>
            <th className="pf-num">depth</th>
            <th>peak</th>
            <th>trough</th>
            <th>recovered</th>
            <th className="pf-num">to trough</th>
            <th className="pf-num">to recover</th>
          </tr>
        </thead>
        <tbody>
          {episodes.map((e, i) => (
            <tr key={i}>
              <td className="pf-num neg">{fmtPctBare(e.depth, 2)}</td>
              <td className="pf-sym">{e.start}</td>
              <td>{e.trough}</td>
              <td>{e.recovery || <span className="pf-dd-open">open</span>}</td>
              <td className="pf-num">{e.toTrough}d</td>
              <td className="pf-num">{e.recoveryDays != null ? `${e.recoveryDays}d` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

// ---------- attribution by instrument type ----------
// The same question the polymarket category panel asks, answered from data the
// Flex statement already carries: every contribution row reports the asset class
// IBKR booked it under, so rolling them up says which instrument type actually
// produced the return. `share` is signed against NET p&l — winners and losers
// offset, so individual shares can exceed 100% while the column sums to 100%.
// Categories whose |P&L| is under this fraction of the largest bar render as a
// 1px speck next to the zero line — plot only material movers, like the
// contribution chart above. The table (portfolio.json) keeps every class.
//
// Both this and the contribution panel are fixed at 12mo and deliberately do
// NOT follow the range selector: IBKR's MTM performance summary is one total
// per symbol for the whole statement window, with no dates on the rows, so
// there is nothing to slice. Snapshot-differencing doesn't rescue it either —
// the window is trailing, so two snapshots differ by the month gained *and*
// the month aged off. Making these range-aware needs dated MTM rows out of the
// Flex query (or attribution rebuilt from trades), not a UI change.
const AC_BAR_FLOOR = 0.01;

function AssetClassBars({ rows }) {
  if (!rows || !rows.length) return null;
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.total)), 1);
  const net = rows.reduce((a, r) => a + r.total, 0);
  const barRows = rows.filter(r => Math.abs(r.total) >= maxAbs * AC_BAR_FLOOR);
  return (
    <div className="pf-contrib pm-cat-bars">
      {barRows.map(r => {
        const w = (Math.abs(r.total) / maxAbs) * 50;
        const pos = r.total >= 0;
        return (
          <div className="pf-contrib-row" key={r.code}
            title={`${r.names} underlying${r.names === 1 ? '' : 's'} · ${r.legs} legs`}>
            <span className="pf-contrib-sym">{r.label}</span>
            <div className="pf-contrib-track">
              <div className="pf-contrib-center"/>
              <div className={`pf-contrib-bar ${pos ? 'pos' : 'neg'}`}
                style={pos ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}/>
            </div>
            <span className={`pf-contrib-val ${pos ? 'pos' : 'neg'}`}>
              {pos ? '+' : ''}{fmtUSD(r.total)}
            </span>
          </div>
        );
      })}
      <div className="pf-contrib-foot">
        <span>
          {rows.length} instrument types
          {barRows.length < rows.length && ` · ${rows.length - barRows.length} near zero`}
        </span>
        <span>net {net >= 0 ? '+' : ''}{fmtUSD(net)}</span>
      </div>
    </div>
  );
}

// ---------- main view ----------
function Portfolio() {
  const [data, setData] = usePortState(null);
  const [err, setErr] = usePortState(null);
  const [bench, setBench] = usePortState(null);
  const [hist, setHist] = usePortState(null);
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
    // Accumulated multi-year history (best-effort) — extends the curve under MAX.
    fetch('data/nav-history.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(h => { if (h && h.rows) setHist(h); })
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

  // Range selector windows the chart, its strips, AND the risk tiles. MAX draws
  // on the accumulated history (nav-history.json) prepended ahead of the Flex
  // window; shorter ranges slice within the trailing year exactly as before.
  const ext = pfExtendHistory(d.navSeries, d.perfSeries, hist);
  const win = pfWindow(ext.nav, ext.perf, range);
  // Completed quarters the (history-extended) curve covers end to end.
  const quarters = (window.szQuarters && ext.perf && ext.perf.length)
    ? window.szQuarters(ext.perf[0].d, ext.perf[ext.perf.length - 1].d)
    : [];
  const PfHistoryPicker = window.HistoryPicker;
  // Plain computations (not hooks) — these run after the early returns above, so a
  // useMemo here would violate the rules of hooks. Both are cheap.
  const winRisk = pfRiskWindow(win.perf) || risk;
  const betaObj = bench && bench.spx ? computeBeta(win.perf, bench.spx.series) : null;
  const alpha = bench && bench.spx ? pfAlphaSeries(win.perf, bench.spx.series) : null;
  const winDd = win.perf && win.perf.length ? drawdownSeries(win.perf) : [];
  const winMaxDd = winDd.length ? Math.min(0, ...winDd.map(p => p.v)) : 0;
  const winCurDd = winDd.length ? winDd[winDd.length - 1].v : 0;
  const alphaNow = alpha && alpha.length ? alpha[alpha.length - 1].v : null;
  // Range-aware like the risk tiles: every panel below re-reads the same window.
  const spxSeries = bench && bench.spx ? bench.spx.series : null;
  const capture = spxSeries ? pfCapture(win.perf, spxSeries) : null;
  const episodes = pfDrawdownEpisodes(win.perf);

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

      {/* Provenance sits above the panels: the analytics stack below now runs
          past the fold, and a note explaining what the numbers are is no use
          underneath them. */}
      <div className="pf-footer pf-note-top">
        <span>source · IBKR Flex Query (daily cron via github actions)</span>
        <span className="sz-sep">·</span>
        <span>not financial advice</span>
        <span className="sz-sep">·</span>
        <span>delayed up to 24h</span>
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
          <span className="pf-panel-title">performance · {pfRangeLabel(range)}</span>
          <div className="pf-range">
            {PF_RANGES.map(r => (
              <button key={r} type="button"
                className={`pf-range-btn${range === r ? ' active' : ''}`}
                onClick={() => setRange(r)}>{r.toLowerCase()}</button>
            ))}
            {PfHistoryPicker && (
              <PfHistoryPicker quarters={quarters} value={range} onPick={setRange}/>
            )}
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
        <RollingStrip fullSeries={ext.perf} perfSeries={win.perf} benchSeries={spxSeries}/>
      </div>

      <div className="pf-row">
        <div className="pf-panel pf-panel-alloc">
          <div className="pf-panel-head">
            <span className="pf-panel-title">allocation</span>
            <span className="pf-panel-meta">share of gross exposure</span>
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

      {/* Second-order risk analytics. These sit below the holdings panels rather
          than beside the headline chart: they interrogate the return series the
          chart already showed, so they read as footnotes to it, not as the lead.
          All three re-read the same window as the range selector above. */}
      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">return distribution · daily</span>
          <span className="pf-panel-meta">vs normal, same mean and sd</span>
        </div>
        <ReturnDistribution perfSeries={win.perf}/>
      </div>

      {capture && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">capture vs spx</span>
            {/* A net-short book prints negative capture — it moves against the
                index rather than damping it — so say what the sign means. */}
            <span className="pf-panel-meta">
              {capture.upDays} up · {capture.downDays} down sessions · negative = moved opposite
            </span>
          </div>
          <div className="pf-stats pf-stats-capture">
            <StatTile label="up capture"
              value={capture.upCapture != null ? fmtPctBare(capture.upCapture, 0) : '—'}
              kicker="of spx gains on its up days"/>
            <StatTile label="down capture"
              value={capture.downCapture != null ? fmtPctBare(capture.downCapture, 0) : '—'}
              kicker="of spx losses on its down days"/>
            <StatTile label="bull beta" value={fmtNum(capture.bullBeta)}
              kicker="slope · spx up days"/>
            <StatTile label="bear beta" value={fmtNum(capture.bearBeta)}
              kicker="slope · spx down days"/>
          </div>
        </div>
      )}

      {episodes.length > 0 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">drawdown episodes · {pfRangeLabel(range)}</span>
            <span className="pf-panel-meta">deepest {episodes.length}, peak to recovery</span>
          </div>
          <DrawdownTable episodes={episodes}/>
        </div>
      )}

      {/* Last on the page because these two are the only panels that ignore the
          range selector — IBKR's mark-to-market summary is one total per symbol
          over the statement window, with no dates to slice (see AC_BAR_FLOOR).
          Everything above re-reads the selected range, so parking the fixed-12mo
          pair at the end keeps that run unbroken. */}
      {d.byAssetClass && d.byAssetClass.length > 0 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">attribution · by instrument type · 12mo</span>
            <span className="pf-panel-meta">mark-to-market p&l per asset class · fixed 12mo, not range-linked</span>
          </div>
          <AssetClassBars rows={d.byAssetClass}/>
        </div>
      )}

      {d.contribution && d.contribution.length > 0 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">contribution to return · 12mo</span>
            <span className="pf-panel-meta">mark-to-market p&l per holding · fixed 12mo, not range-linked</span>
          </div>
          <ContributionBars rows={d.contribution}/>
        </div>
      )}

    </section>
  );
}

window.Portfolio = Portfolio;

// Shared with the overview (Combined.jsx). In the production bundle each
// component file is compiled to its own IIFE and concatenated, so top-level
// declarations do not cross files — window is the channel, the same one
// Chrome.jsx uses for Cursor/useDecode. Callers supply a perfSeries in this
// file's shape ({ d, v } where v is cumulative return as a ratio); the overview
// adapts its dollar series to that shape rather than these re-deriving it.
window.SZ_RISK = {
  ReturnDistribution,
  RollingStrip,
  DrawdownTable,
  pfCapture,
  pfDrawdownEpisodes,
  pfMoments,
  pfDailyReturns,
};
