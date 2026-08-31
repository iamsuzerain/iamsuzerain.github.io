// Portfolio.jsx — IBKR Flex Query dashboard (reads data/portfolio.json)
// Globals: React, useDecode

const { useEffect: usePortEffect, useState: usePortState, useMemo: usePortMemo } = React;

// Chart machinery (Chart.jsx, loaded ahead of this file). The panels below own
// their own bodies — overlays, warm-up rules, distribution bins — but the box,
// the scales, the hover math and the gradient stops are shared with the
// polymarket and overview views.
const {
  szSmoothPath: smoothPath, szFrame, szScales, szDomain, szAreaPath, szTicks,
  useChartHover, SzChartSvg, SzChartDefs, SzRule, SzCrosshair, SzTooltip,
  SzAxisX, SzKeyReadout, SzStripHead, SzToggle,
} = window;

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

// The Sharpe tile's kicker. The interval, not the rf it was charged: a lone
// Sharpe reads as a measurement when it is really an estimate, and on this
// book's sample the band runs 0.67–5.08 — which is the thing a reader most
// needs and least expects. Falls back to naming what the Sharpe is measured
// against when there is no interval to print (too few sessions, or a risk
// block written before the field existed).
function pfCiLabel(r) {
  return (r && r.sharpeLo != null && r.sharpeHi != null)
    ? `95% ci ${fmtNum(r.sharpeLo)} – ${fmtNum(r.sharpeHi)}`
    : 'excess of cash';
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

// Drawn-mark polarity. Mirrors --mark-pos / --mark-neg in colors_and_type.css:
// gains are PINK and losses are VIOLET on shapes, which is the opposite of the
// green/red that --pos/--neg give the numbers. Easy to invert by accident.
const PF_MARK_POS = '#ff4fd8';
const PF_MARK_NEG = '#a78bfa';

const PF_RANGES = ['1M', '3M', 'QTD', '6M', 'YTD', '1Y', 'MAX'];
const PF_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', 'QTD': 'qtd', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo', 'MAX': 'max' };

// Windowing is shared with the polymarket + overview views (Chrome.jsx), so a
// range picked on any of the three spans the same days.
const pfRangeEnd = (range) => window.szRangeEnd(range);

function pfRangeLabel(range) {
  return PF_RANGE_LABEL[range] || (window.szQuarterLabel && window.szQuarterLabel(range)) || range;
}

// Unlike the other two callers, MAX resolves to the first date rather than null
// — pfWindow feeds the result straight to findIndex.
function pfRangeCutoff(range, dates) {
  const cut = window.szRangeCutoff(range, dates[dates.length - 1]);
  return cut == null ? dates[0] : cut;
}

// Prepend accumulated multi-year history (nav-history.json `t` = cumulative TWR)
// ahead of the Flex-window perfSeries so the MAX range extends the IBKR curve
// past 12 months. History is rebased multiplicatively to meet perfSeries[0]
// (v = 0 at the seam) continuously — the trailing window is left untouched. A
// length-matched placeholder nav rides along because NavChart reads navSeries
// only for its length when perfSeries is present (values come from perf).
// The dollar leg of the same curve, for the $ half of the units toggle.
//
// It has to be portfolio.json's pnlSeries — the true daily cumulative *dollar*
// P&L — and never perfSeries scaled by a notional. TWR is scale-free by
// construction, so one multiplier silently assumes the account was one size all
// year; it wasn't, and that misprices every intra-year segment. (Combined.jsx's
// cmbIbkrPoints carries the measured damage: q4 25 read $57.7k against a true
// $63.6k.)
//
// The endpoint is then anchored to pnl["1y"].abs, IBKR's deposit-adjusted
// ChangeInNAV, which is what the stat tiles headline. On pnlSeries that is a
// uniform 0.66% nudge (the flows ChangeInNAV counts differ from the
// CashTransaction sum by ~$2k) rather than a reshaping of the curve — and
// without it the chart's last point and the "1y" tile would print two different
// dollar figures for the same quantity, two panels apart.
function pfAnchorDollars(pnlSeries, perfSeries, oneYearAbs) {
  if (!pnlSeries || !perfSeries || pnlSeries.length !== perfSeries.length || !pnlSeries.length) return null;
  const last = pnlSeries[pnlSeries.length - 1].v;
  if (oneYearAbs == null || !last) return pnlSeries.map(p => ({ d: p.d, v: p.v }));
  const k = oneYearAbs / last;
  return pnlSeries.map(p => ({ d: p.d, v: +(p.v * k).toFixed(2) }));
}

function pfExtendHistory(navSeries, perfSeries, pnlSeries, hist, oneYearAbs) {
  const dollars = pfAnchorDollars(pnlSeries, perfSeries, oneYearAbs);
  const rows = hist && hist.rows;
  const plain = { nav: navSeries, perf: perfSeries, pnl: dollars };
  if (!rows || !rows.length || !perfSeries || !perfSeries.length) return plain;
  const seamD = perfSeries[0].d;
  let tSeam = null;                            // history TWR at the seam (exact, else nearest earlier)
  let vSeam = null;                            // and its cumulative-$ twin, same row
  for (const r of rows) {
    if (r.d > seamD) break;
    if (r.t != null) { tSeam = r.t; vSeam = r.v; }
  }
  if (tSeam == null) return plain;
  const f = 1 + tSeam;
  const preRows = rows.filter(r => r.d < seamD && r.t != null);
  const pre = preRows.map(r => ({ d: r.d, v: (1 + r.t) / f - 1 }));
  if (!pre.length) return plain;
  // History rows are cumulative-$ on their own baseline while the trailing curve
  // starts at 0 on perfSeries[0].d, so the block is offset by its value at the
  // seam and the two meet continuously — the anchored trailing year is untouched.
  // Built off the SAME filtered rows as `pre` so the two legs stay index-aligned;
  // if a row is missing its dollar figure the whole dollar extension is dropped
  // rather than shipped one point short of the percent one.
  const preD = (dollars && vSeam != null && preRows.every(r => r.v != null))
    ? preRows.map(r => ({ d: r.d, v: +(r.v - vSeam).toFixed(2) }))
    : null;
  // The pre-window nav block used to be a length-matched run of zeros, because
  // NavChart only ever read navSeries for its length once perfSeries was
  // present. The units toggle now reads nav[0] as the notional its dollar
  // benchmarks are valued on, and a zero there silently dropped $ mode on every
  // window opening inside the history — MAX included. nav-history carries the
  // real closing NAV per row (`n`), so use it and keep 0 only where it is
  // genuinely absent.
  return {
    nav: preRows.map(r => ({ d: r.d, v: r.n != null ? r.n : 0 })).concat(navSeries),
    perf: pre.concat(perfSeries),
    pnl: preD ? preD.concat(dollars) : null,
  };
}

// Slice navSeries + perfSeries to a trailing range and re-base the cumulative
// TWR to the window start, so a 3M view reads as the 3M return rather than 3M of
// the full 12mo curve. Both arrays share dates/length, so one index aligns them.
//
// The base index comes from szRangeBaseIndex rather than a bare findIndex,
// because a calendar range has to rebase on the close BEFORE the period opens —
// otherwise the first day's return falls out of the window and the chart
// disagrees with the tile that covers the same period. See that function for the
// full reasoning; the short version is that qtd was reading +8.095% against a
// tile of +7.925% purely because 2026-07-01 was being used as the base instead
// of 2026-06-30.
function pfWindow(navSeries, perfSeries, pnlSeries, range) {
  if (!perfSeries || perfSeries.length < 2) return { nav: navSeries, perf: perfSeries, pnl: pnlSeries };
  const dates = perfSeries.map(p => p.d);
  const cutoff = pfRangeCutoff(range, dates);
  let i = window.szRangeBaseIndex(dates, range, cutoff);
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
  // Cumulative dollars subtract cleanly where TWR has to be re-compounded, so
  // the dollar leg rebases with one subtraction. Dropped entirely if it isn't
  // index-aligned with perf — a half-aligned series would draw the right shape
  // against the wrong dates.
  const pnl = (pnlSeries && pnlSeries.length === perfSeries.length)
    ? pnlSeries.slice(i, j + 1).map(p => ({ d: p.d, v: +(p.v - pnlSeries[i].v).toFixed(2) }))
    : null;
  return { nav: navSeries.slice(i, j + 1), perf, pnl };
}

// Cumulative alpha: portfolio TWR minus the benchmark's rebased cumulative
// return, per date (both start at 0 at the window start).
function pfAlphaSeries(perf, benchSeries) {
  if (!perf || perf.length < 2 || !benchSeries) return null;
  const b = rebaseBenchmark(benchSeries, perf.map(p => p.d));
  if (!b) return null;
  return perf.map((p, i) => ({ d: p.d, v: p.v - b[i] }));
}

// Same idea in dollars: cumulative $ P&L minus what the window-start NAV would
// have made in the index. Approximate by construction — the real capital base
// moved during the window — which is exactly why the percent version stays the
// default here and the dollar figure prints its notional in the legend.
function pfAlphaDollars(pnl, nav, benchSeries) {
  if (!pnl || pnl.length < 2 || !nav || !nav.length || !benchSeries) return null;
  const notional = nav[0].v;
  if (!notional) return null;
  const b = rebaseBenchmark(benchSeries, pnl.map(p => p.d));
  if (!b) return null;
  return pnl.map((p, i) => ({ d: p.d, v: +(p.v - notional * b[i]).toFixed(2) }));
}

// Sharpe / Sortino / annualized vol / max drawdown over a (windowed) TWR
// series. Mirrors the Python build_risk: daily HPRs off the 1+v wealth curve,
// 252-day annualized, excess of the fed funds rate in force on each day (rfRows
// = data/riskfree.json's series; omit it and this is the old rf-0 figure).
// Returns null for windows with too few points.
//
// The window matters more here than in the Python: that one only ever computes
// the trailing year, while this recomputes on every range the picker offers —
// so a 3M window sitting inside a cutting cycle is charged that quarter's rate,
// not the year's average. `rf` comes back with the rest so the tile can print
// what it was charged.
function pfRiskWindow(perf, rfRows) {
  if (!perf || perf.length < 21) return null;
  const PER = 252;
  const wealth = perf.map(p => 1 + p.v);
  const steps = window.szRfSteps ? window.szRfSteps(perf.map(p => p.d), rfRows, PER) : null;
  const rets = [], rfs = [];
  for (let i = 1; i < wealth.length; i++) {
    if (wealth[i - 1] > 0) {
      rets.push(wealth[i] / wealth[i - 1] - 1);
      rfs.push(steps ? steps[i] : 0);
    }
  }
  const n = rets.length;
  if (n < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const meanRf = rfs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  // vol stays the book's own volatility, not the excess series': it is a
  // published number in its own right, and subtracting a near-constant moves a
  // daily series' mean without moving its spread. That also keeps the identity
  // the three tiles imply — sharpe = (ann return - rf) / ann vol — true as read.
  const vol = sd * Math.sqrt(PER);
  const sharpe = vol ? ((mean - meanRf) * PER) / vol : null;
  // Sortino's denominator: the same excess series, but only the days that fell
  // short of cash, and squared about a fixed 0 rather than about their own
  // mean. Divided by every session and not just the losing ones — trailing cash
  // rarely is the achievement, so the count belongs in the denominator — and by
  // n rather than n-1, because a fixed threshold costs no degree of freedom.
  // build_risk does this identically; the two have to agree on the convention
  // or the tile and portfolio.json print different Sortinos for the same year.
  let dvar = 0;
  for (let i = 0; i < n; i++) { const e = Math.min(rets[i] - rfs[i], 0); dvar += e * e; }
  const downside = Math.sqrt(dvar / n) * Math.sqrt(PER);
  const sortino = downside ? ((mean - meanRf) * PER) / downside : null;

  // How much of that Sharpe is sample rather than skill. The standard error of
  // a Sharpe estimate widens with negative skew and with fat tails, and the
  // fat-tail term scales with SR² — so a high Sharpe drawn from a lumpy
  // distribution is a weaker claim than the same number drawn from a smooth
  // one (Bailey & López de Prado 2012). The moments are of the excess series,
  // since that is the series whose Sharpe this is, and γ₄ is raw kurtosis: 3
  // is normal, not 0. ReturnDistribution's pfMoments reports excess kurtosis
  // off the raw returns for a different purpose — the two are not interchangeable.
  //
  // Centered on `sharpe` above rather than on a separately derived estimate, so
  // the printed interval always brackets the printed number. That costs a
  // de-annualization: the variance formula wants a per-period SR.
  let m2 = 0, m3 = 0, m4 = 0;
  const exMean = mean - meanRf;
  for (let i = 0; i < n; i++) {
    const z = rets[i] - rfs[i] - exMean;
    m2 += z * z; m3 += z * z * z; m4 += z * z * z * z;
  }
  const exSd = Math.sqrt(m2 / (n - 1));
  let sharpeSe = null, sharpeLo = null, sharpeHi = null;
  if (sharpe != null && exSd > 0) {
    const g3 = (m3 / n) / exSd ** 3;
    const g4 = (m4 / n) / exSd ** 4;
    const srP = sharpe / Math.sqrt(PER);
    const v = (1 - g3 * srP + ((g4 - 1) / 4) * srP ** 2) / (n - 1);
    // The bracket can only go negative on a degenerate sample; guard rather
    // than emit a NaN interval around a real Sharpe.
    if (v > 0) {
      sharpeSe = Math.sqrt(v) * Math.sqrt(PER);
      sharpeLo = sharpe - 1.96 * sharpeSe;
      sharpeHi = sharpe + 1.96 * sharpeSe;
    }
  }

  const dd = drawdownSeries(perf);
  const maxDrawdown = dd.length ? Math.min(0, ...dd.map(p => p.v)) : 0;
  return { sharpe, sortino, vol, downside, sharpeSe, sharpeLo, sharpeHi,
    maxDrawdown, rf: meanRf ? meanRf * PER : null };
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
// `bench: true` metrics name the benchmark they were measured against, which the
// reader now chooses — so the label is built at render time from whichever one
// the strip was handed, not baked in here.
const PF_ROLL_METRICS = {
  beta: { label: 'beta', zero: 1, fmt: (v) => fmtNum(v, 2), bench: true },
  vol:  { label: 'ann vol', zero: 0, fmt: (v) => fmtPctBare(v, 1), bench: false },
  corr: { label: 'corr', zero: 0, fmt: (v) => fmtNum(v, 2), bench: true },
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
  // it summarizes, and stretching those fewer points across the same pixel width
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

// Colors, labels and ordering all come from the shared registry (SZ_BENCHES in
// Chrome.jsx), so this chart, the overview's, and the picker's swatches cannot
// drift apart as tickers are added.
const benchColor = (key) => (window.szBenchColor ? window.szBenchColor(key) : '#5eead4');
const benchLabel = (key) => (window.szBenchLabel ? window.szBenchLabel(key) : key);
const benchOrder = (keys) => (window.szBenchSort ? window.szBenchSort(keys) : (keys || []));

// ---------- Performance chart (deposit-adjusted TWR %) ----------
// Taller than the strips below it and the only one here carrying x-axis labels,
// hence the 28px foot.
const PF_NAV_FRAME = szFrame(220, 16, 28);

function NavChart({ series, perfSeries, benchmarks, benchKeys, unit, dollars }) {
  const F = PF_NAV_FRAME;
  const hv = useChartHover(F);

  // Use deposit-adjusted TWR series when available, otherwise fall back to raw NAV %
  const base = series[0].v;
  const perf = perfSeries && perfSeries.length === series.length
    ? perfSeries
    : series.map(p => ({ d: p.d, v: (p.v - base) / base }));

  // $ mode needs a real dollar curve AND a notional to value the benchmarks on.
  // Missing either, the chart quietly stays in percent rather than inventing one.
  const notional = series[0] ? series[0].v : null;
  const usd = unit === 'usd' && dollars && dollars.length === perf.length && !!notional;
  const plot = usd ? dollars : perf;
  const fmtV = usd ? (v) => (v >= 0 ? '+' : '') + fmtUSD(v) : fmtPct;

  // Only what the picker has selected, in registry order — a key the feed
  // doesn't carry drops out silently rather than drawing an empty line.
  const overlays = usePortMemo(() => {
    if (!benchmarks) return [];
    const dates = perf.map(p => p.d);
    return benchOrder(benchKeys)
      .map(key => {
        const b = benchmarks[key];
        const vals = b && rebaseBenchmark(b.series, dates);
        return vals && { key, label: benchLabel(key), vals, color: benchColor(key) };
      })
      .filter(Boolean);
  }, [benchmarks, benchKeys, perfSeries, series]);

  // The overlays are rebased *returns*; in $ they become what the window-start
  // NAV would have made in the index, which is the same comparison the combined
  // view draws.
  const ovVals = (o) => usd ? o.vals.map(v => notional * v) : o.vals;

  const values = plot.map(p => p.v);
  for (const o of overlays) values.push(...ovVals(o));
  // Unanchored: this curve is already rebased to 0 at the window start, so zero
  // is inside the data by construction and does not need forcing into frame.
  const { y0, y1 } = szDomain(values, { pad: 0.08, floor: 0.005 });
  const { x, y } = szScales(F, perf.length, y0, y1);

  const linePath = smoothPath(plot.map((_, i) => x(i)), plot.map(p => y(p.v)));
  const areaPath = szAreaPath(linePath, x(0), x(plot.length - 1), y(0));

  const ticks = szTicks(perf, 5);
  const gridLines = [y1, (y0 + y1) / 2, y0];

  const hovered = hv.i != null ? plot[hv.i] : null;
  const zeroY = y(0);

  // The account level at the hovered column, latest when the cursor is off.
  // `series` is raw NAV — deposits and all — which is exactly why it isn't a
  // curve here: charting it would draw every funding step as if it were a
  // return. As a number under the cursor it's just the level behind the return,
  // and `plot` is index-aligned with it by construction above.
  // The `|| last` is not belt-and-braces: a hover index survives a range change,
  // so switching max → 1m can leave it past the end of the new series. The
  // crosshair and tooltip already blank themselves in that state; the reading
  // falls back to the latest point rather than taking the key down with it.
  const navHover = hv.i != null ? series[hv.i] : null;
  const navPt = navHover || series[series.length - 1];
  // Dollar readings live on the dollar side. In percent this curve is a return
  // series that never mentions a level, so a nav figure in its key is a unit the
  // chart isn't drawn in.
  const showNav = usd && !!navPt;

  return (
    <React.Fragment>
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={perf.length}>
        <SzChartDefs ramp="nav" id="pf-nav"/>
        {gridLines.map((v, i) => (
          <line key={i}
            x1={F.PAD_L} x2={F.W - F.PAD_R}
            y1={y(v)} y2={y(v)}
            stroke="rgba(167,139,250,0.05)"/>
        ))}
        <SzRule frame={F} y={zeroY}/>
        <path d={areaPath} fill="url(#pf-nav-fill)"/>
        {overlays.map(o => (
          <path key={o.key}
            d={smoothPath(ovVals(o).map((_, i) => x(i)), ovVals(o).map(v => y(v)))}
            fill="none" stroke={o.color} strokeOpacity="0.55" strokeWidth="1.25"/>
        ))}
        <path d={linePath} fill="none" stroke="url(#pf-nav-stroke)" strokeWidth="1.75"/>
        {/* Benchmarks get the same dot the portfolio line does, one weight down:
            they're overlays you read against, and the tooltip already quotes a
            value for each one at this column. */}
        {hovered && (
          <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)} fill="#a78bfa"
            dots={overlays.map(o => ({ key: o.key, cy: y(ovVals(o)[hv.i]), fill: o.color }))}/>
        )}
      </SzChartSvg>
      <div className="pf-axis-y">
        {[y1, y0].map((v, i) => (
          <span key={i} style={{ top: `${(y(v) / F.H) * 100}%` }}>{fmtV(v)}</span>
        ))}
      </div>
      <SzAxisX frame={F} ticks={ticks} x={x}/>
      {hovered && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)}>
          <div className="pm-tt-date">{hovered.d}</div>
          <div className={`pm-tt-val ${hovered.v >= 0 ? 'pos' : 'neg'}`}>{fmtV(hovered.v)}</div>
          {overlays.map(o => (
            <div key={o.key} className="pf-tt-bench" style={{ color: o.color }}>
              {o.label} {fmtV(ovVals(o)[hv.i])}
            </div>
          ))}
        </SzTooltip>
      )}
    </div>
    {/* The key carries the nav reading, so it stays even with every benchmark
        switched off. */}
    {(overlays.length > 0 || showNav) && (
      <div className="pf-bench-legend">
        {showNav && (
          <SzKeyReadout label="nav" value={fmtUSD(navPt.v)} live={!!navHover}/>
        )}
        {/* One statement of the stake the benchmark lines are drawn on, next to
            the nav reading it would otherwise be mistaken for. Per-row it was
            the same number printed once per benchmark. */}
        {usd && overlays.length > 0 && (
          <SzKeyReadout label="benchmarks on" value={fmtUSD(notional, true)} note="at open"/>
        )}
        {/* Swatches only earn their place once there is a second line to tell
            the first one from. */}
        {overlays.length > 0 && (
          <span><i className="pf-bench-swatch" style={{ background: 'linear-gradient(90deg,#a78bfa,#ff4fd8)' }}/>portfolio</span>
        )}
        {overlays.map(o => (
          <span key={o.key}><i className="pf-bench-swatch" style={{ background: o.color }}/>{o.label}</span>
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
          // than the circumference (that wraps and paints over its neighbors).
          const len = Math.max(0, Math.min(seg.pct || 0, 1)) * C;
          const offset = -acc;
          acc += len;
          const dash = { strokeDasharray: `${len} ${C - len}`, strokeDashoffset: offset };
          const spin = `rotate(-90 ${cx} ${cy})`;
          return (
            <React.Fragment key={i}>
              {/* Long slices are solid. Net-short slices read hollow — the band
                  drops to a ghost and a thin rail runs down its center — so
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
        <text x={cx} y={cy + 10} textAnchor="middle" fontFamily="JetBrains Mono, monospace"
          fontSize="17" fill="#f5f0ff">{data.length}</text>
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
// `change` always carries the sign — it drives the arrow and the color — while
// `changeText` optionally overrides what gets printed. That split is what lets
// the P&L tiles keep one shape under both units: the big number is whichever
// unit is selected, and the small colored line underneath is the other one.
function StatTile({ label, value, change, changeText, kicker }) {
  const pos = change != null && change >= 0;
  return (
    <div className="pf-stat">
      <div className="pf-stat-label">{label}</div>
      <div className="pf-stat-value">{value}</div>
      {change != null && (
        <div className={`pf-stat-chg ${pos ? 'pos' : 'neg'}`}>
          {pos ? '▲' : '▼'} {changeText != null ? changeText : fmtPct(change)}
        </div>
      )}
      {kicker && <div className="pf-stat-kicker">{kicker}</div>}
    </div>
  );
}

// ---------- Underwater (drawdown) strip ----------
// The underwater strip hangs off a hard ceiling at 0 rather than being centered,
// so it gets 2px less headroom than the strips that straddle their reference.
const PF_DD_FRAME = szFrame(60, 6, 12);
const PF_STRIP_FRAME = szFrame(60, 8, 12);

function DrawdownStrip({ perfSeries }) {
  const F = PF_DD_FRAME;
  const hv = useChartHover(F);
  if (!perfSeries || perfSeries.length < 2) return null;
  const dd = drawdownSeries(perfSeries);
  // Domain runs from the deepest drawdown up to a fixed 0 — this series is
  // non-positive by construction, so the top of the box is the running peak.
  const min = Math.min(0, ...dd.map(p => p.v));
  const { x, y } = szScales(F, dd.length, min, 0);
  const line = smoothPath(dd.map((_, i) => x(i)), dd.map(p => y(p.v)));
  const area = szAreaPath(line, x(0), x(dd.length - 1), y(0));
  const hovered = hv.i != null ? dd[hv.i] : null;

  return (
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={dd.length}>
        <SzChartDefs ramp="dd" id="pf-dd"/>
        <SzRule frame={F} y={y(0)}/>
        <path d={area} fill="url(#pf-dd-fill)"/>
        <path d={line} fill="none" stroke="url(#pf-dd-stroke)" strokeWidth="1.35"/>
        {hovered && <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)} fill="#ff6ec4"/>}
      </SzChartSvg>
      {hovered && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)}>
          <div className="pm-tt-date">{hovered.d}</div>
          <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{fmtPctBare(hovered.v)}</div>
        </SzTooltip>
      )}
    </div>
  );
}

// ---------- Rolling alpha strip (cumulative TWR minus SPX, zero-centered) ----------
function AlphaStrip({ alpha, unit }) {
  const F = PF_STRIP_FRAME;
  const hv = useChartHover(F);
  if (!alpha || alpha.length < 2) return null;
  const usd = unit === 'usd';
  // Anchored both ways so the zero line stays drawn even on a window that never
  // crossed it — "behind the whole way" is the reading, and it needs the rule.
  const { y0, y1 } = szDomain(alpha.map(p => p.v),
    { pad: 0.12, floor: usd ? 1 : 0.002, min: 0, max: 0 });
  const { x, y } = szScales(F, alpha.length, y0, y1);
  const line = smoothPath(alpha.map((_, i) => x(i)), alpha.map(p => y(p.v)));
  const zeroY = y(0);
  const area = szAreaPath(line, x(0), x(alpha.length - 1), zeroY);
  const hovered = hv.i != null ? alpha[hv.i] : null;

  return (
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={alpha.length}>
        <SzChartDefs ramp="alpha" id="pf-alpha"/>
        <SzRule frame={F} y={zeroY}/>
        <path d={area} fill="url(#pf-alpha-fill)"/>
        <path d={line} fill="none" stroke="url(#pf-alpha-stroke)" strokeWidth="1.35"/>
        {hovered && <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)} fill="#60a5fa"/>}
      </SzChartSvg>
      {hovered && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)}>
          <div className="pm-tt-date">{hovered.d}</div>
          <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>
            {hovered.v >= 0 ? '+' : ''}{usd ? fmtUSD(hovered.v) : fmtPctBare(hovered.v)}
          </div>
        </SzTooltip>
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

  const F = szFrame(180, 12, 24);
  const { W, H, PAD_L, PAD_R, PAD_T, PAD_B } = F;
  const { bins } = hist;
  const maxCount = Math.max(...bins.map(b => Math.max(b.count, b.expected)), 1);
  // x is bin-indexed, not point-indexed — bars occupy a slot, they don't sit on
  // a coordinate — so this is the one chart here that doesn't take szScales' x.
  const bw = (W - PAD_L - PAD_R) / bins.length;
  const x = (i) => PAD_L + i * bw;
  const { y } = szScales(F, bins.length, 0, maxCount);
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
          <line x1={PAD_L} x2={W - PAD_R} y1={base} y2={base} stroke="rgba(229,225,241,0.18)"/>
          {/* Hollow outlined bins: 1px stroke over a 0.13 wash, square corners —
              the same skin as the monthly-pnl columns and .pf-contrib-bar. The
              diverging pair is unchanged: pink is the positive/high side, violet
              the negative/low side, matching .pf-contrib-bar.pos/.neg. */}
          {bins.map((b, i) => {
            const h = base - y(b.count);
            const c = b.lo < 0 ? PF_MARK_NEG : PF_MARK_POS;
            const cw = Math.max(1, bw - 2);          // 2px surface gap between bins
            const bx = x(i) + (bw - cw) / 2;
            // An empty bin keeps a cap on the baseline instead of vanishing —
            // "no sessions landed here" is information, and the tails are where
            // the whole chart is interesting.
            if (h < 0.6) return (
              <line key={i} x1={bx} x2={bx + cw} y1={base} y2={base}
                stroke={c} strokeWidth="1" strokeOpacity="0.5"/>
            );
            return (
              <rect key={i}
                x={bx} width={cw} y={y(b.count)} height={h}
                fill={c} fillOpacity="0.13"
                stroke={c} strokeWidth="1" strokeOpacity="0.8"
                shapeRendering="crispEdges"
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
          {/* Normal reference, same mean and sd. Solid, not dashed: teal against
              the pink/violet bins and a curve against rectangles already say
              "this is the model, not the data", so the dashes were only adding
              texture. A 3/3 dash is a 50% duty cycle, so going solid doubles the
              ink — the weight comes back down via opacity instead. */}
          <path d={normPath} fill="none" stroke="rgba(94,234,212,0.55)"
            strokeWidth="1.25"/>
          {/* No rule at zero. The bins already change color there — violet to
              the left, pink to the right — so the split is drawn by the data
              itself, and the 0% tick sits under the axis. A dashed line on top
              of that was a third marker for the same fact, and it cut through
              the tallest bin. */}
        </svg>
        <div className="pf-axis-x">
          <span className="start" style={{ left: '0%' }}>{fmtPctBare(bins[0].lo, 1)}</span>
          <span style={{ left: `${(zeroX / W) * 100}%` }}>0%</span>
          <span className="end" style={{ left: '100%' }}>{fmtPctBare(bins[bins.length - 1].hi, 1)}</span>
        </div>
        {hb && (
          <SzTooltip frame={F} x={x(bins.indexOf(hb)) + bw / 2} y={y(hb.count)}>
            <div className="pm-tt-date">{fmtPctBare(hb.lo, 1)} … {fmtPctBare(hb.hi, 1)}</div>
            <div className={`pm-tt-val ${hb.lo < 0 ? 'neg' : 'pos'}`}>{hb.count} sessions</div>
            <div className="pf-tt-bench" style={{ color: '#5eead4' }}>
              normal {hb.expected.toFixed(1)}
            </div>
          </SzTooltip>
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
function RollingStrip({ fullSeries, perfSeries, benchSeries, benchName = 'spx', periods = 252 }) {
  const F = PF_STRIP_FRAME;
  const [metric, setMetric] = usePortState('beta');
  const hv = useChartHover(F);

  const available = Object.keys(PF_ROLL_METRICS)
    .filter(k => (benchSeries ? true : !PF_ROLL_METRICS[k].bench));
  const active = available.includes(metric) ? metric : available[0];
  const spec = PF_ROLL_METRICS[active];
  const roll = pfRollingWindowed(fullSeries || perfSeries, perfSeries, benchSeries, active, periods);
  if (!roll) return null;

  const { series, window: win, firstIdx } = roll;
  const vals = series.filter(p => p.v != null).map(p => p.v);
  // Anchored at the metric's reference (1 for beta, 0 for vol/corr) so "at the
  // benchmark" is always a visible line rather than an off-screen implication.
  const { y0, y1 } = szDomain(vals, { pad: 0.12, floor: 0.01, min: spec.zero, max: spec.zero });
  // x spans every perf date, including the blank warm-up, so this strip lines up
  // column-for-column with the chart and strips above it.
  const { x, y } = szScales(F, series.length, y0, y1);
  const drawn = series.map((p, i) => ({ p, i })).filter(o => o.p.v != null);
  const line = smoothPath(drawn.map(o => x(o.i)), drawn.map(o => y(o.p.v)));
  const refY = y(spec.zero);

  // Only the filled part of the axis carries a reading; hovering the warm-up
  // shows the crosshair (so it still tracks the charts above) but no value.
  const hovered = hv.i != null && series[hv.i] && series[hv.i].v != null
    ? series[hv.i] : null;
  const now = vals.length ? vals[vals.length - 1] : null;

  return (
    <React.Fragment>
      <SzStripHead label={`rolling ${spec.label}${spec.bench ? ` vs ${benchName}` : ''} · ${win}-session`}>
        <div className="pf-strip-toggle">
          <div className="pf-range">
            <SzToggle options={available} value={active} onChange={setMetric}/>
          </div>
          <span className="pf-strip-meta">now {spec.fmt(now)}</span>
        </div>
      </SzStripHead>
      <div className="pm-chart-wrap">
        <SzChartSvg frame={F} hover={hv} n={series.length}>
          {/* The 'roll' ramp runs horizontally — see SZ_GRADIENTS. Concretely:
              this axis is anchored at spec.zero, not at the data, so a metric
              sitting far from its anchor gets squeezed into a sliver of the
              height. Beta is the default and anchors at 1, so a book running
              beta near zero leaves the line ~8% of the plot tall, far too little
              vertical travel for a value-keyed ramp to register. It is also the
              violet family rather than the pink one: this strip sits directly
              under the P&L chart, and reusing that chart's gradient made the two
              read as the same series. */}
          <SzChartDefs ramp="roll" id="pf-roll"/>
          {/* Guarded: a lookback that has not filled yet leaves `drawn` empty,
              and closing an area path off a missing endpoint would throw. */}
          {drawn.length > 1 && (
            <path d={szAreaPath(line, x(drawn[0].i), x(drawn[drawn.length - 1].i), refY)}
              fill="url(#pf-roll-fill)"/>
          )}
          <SzRule frame={F} y={refY}/>
          {/* Where the lookback window finishes filling — left of it the metric
              simply does not exist yet, rather than being zero. */}
          {firstIdx > 0 && (
            <line x1={x(firstIdx)} x2={x(firstIdx)} y1={F.PAD_T} y2={F.H - F.PAD_B}
              stroke="rgba(167,139,250,0.10)"/>
          )}
          <path d={line} fill="none" stroke="url(#pf-roll-stroke)" strokeWidth="1.35"/>
          {/* cy null over the warm-up: hairline only, nothing to mark. */}
          {hv.i != null && (
            <SzCrosshair frame={F} x={x(hv.i)}
              cy={hovered ? y(hovered.v) : null} fill="#a78bfa"/>
          )}
        </SzChartSvg>
        {hovered && (
          <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)}>
            <div className="pm-tt-date">{hovered.d}</div>
            <div className="pm-tt-val">{spec.fmt(hovered.v)}</div>
          </SzTooltip>
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
  const [rf, setRf] = usePortState(null);
  const [range, setRange] = usePortState('1Y');
  // Percent by default: this page's headline metric is TWR (the "1y" tile says
  // so), and the benchmark overlays are exact in percent where the dollar
  // versions have to assume a notional. $ is one click away — and once clicked
  // it is remembered, here and on the overview tab, which share the key.
  const [unit, setUnit] = window.useKeptState(
    window.SZ_UNIT_PREF, 'pct', window.SZ_UNIT_VALUES);
  // What the book is drawn against. SPX alone by default — it's the comparison
  // the tiles and strips below are worded for, and a chart that opens with one
  // benchmark on it says which one matters rather than making you read a key.
  const [benchKeys, setBenchKeys] = usePortState(window.SZ_BENCH_DEFAULT || ['spx']);

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
    // Fed funds (best-effort). Without it the risk tiles fall back to rf 0 and
    // say so, rather than holding the whole panel hostage to one small file.
    fetch('data/riskfree.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j && j.series && j.series.length) setRf(j.series); })
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
  const oneY = d.pnl && d.pnl['1y'] ? d.pnl['1y'].abs : null;
  const ext = pfExtendHistory(d.navSeries, d.perfSeries, d.pnlSeries, hist, oneY);
  const win = pfWindow(ext.nav, ext.perf, ext.pnl, range);
  // Completed quarters the (history-extended) curve covers end to end.
  const quarters = (window.szQuarters && ext.perf && ext.perf.length)
    ? window.szQuarters(ext.perf[0].d, ext.perf[ext.perf.length - 1].d)
    : [];
  const PfHistoryPicker = window.HistoryPicker;
  // Plain computations (not hooks) — these run after the early returns above, so a
  // useMemo here would violate the rules of hooks. Both are cheap.
  const winRisk = pfRiskWindow(win.perf, rf) || risk;
  // Beta, alpha and capture all name a benchmark, so they follow the picker
  // rather than staying pinned to SPX while the chart above draws something
  // else. First selected wins; an empty selection falls back to spx so these
  // panels keep working when the reader just wants a bare chart.
  const primary = window.szBenchPrimary ? window.szBenchPrimary(benchKeys) : 'spx';
  const primaryName = benchLabel(primary);
  const primarySeries = bench && bench[primary] ? bench[primary].series : null;
  const betaObj = primarySeries ? computeBeta(win.perf, primarySeries) : null;
  const alpha = primarySeries ? pfAlphaSeries(win.perf, primarySeries) : null;
  const alphaD = primarySeries ? pfAlphaDollars(win.pnl, win.nav, primarySeries) : null;
  const winDd = win.perf && win.perf.length ? drawdownSeries(win.perf) : [];
  const winMaxDd = winDd.length ? Math.min(0, ...winDd.map(p => p.v)) : 0;
  const winCurDd = winDd.length ? winDd[winDd.length - 1].v : 0;
  const alphaNow = alpha && alpha.length ? alpha[alpha.length - 1].v : null;
  // $ mode only stands where the dollar leg survived (see pfExtendHistory);
  // otherwise every panel below silently keeps drawing percent.
  const usd = unit === 'usd' && !!win.pnl;
  const alphaShown = (usd && alphaD) ? alphaD : alpha;
  const alphaShownNow = alphaShown && alphaShown.length ? alphaShown[alphaShown.length - 1].v : null;
  const PfUnitBar = window.UnitBar;
  // Range-aware like the risk tiles: every panel below re-reads the same window.
  const capture = primarySeries ? pfCapture(win.perf, primarySeries) : null;
  const episodes = pfDrawdownEpisodes(win.perf);
  const PfBenchPicker = window.BenchPicker;

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
        <div className="pf-head-right">
          <div className="pf-updated">
            <span className="pf-dot"/>
            <span>auto-updated {updatedStr}</span>
          </div>
          {/* Renders nothing here: the switch itself is drawn in the nav, which
              stays put while the analytics stack below runs past the fold. No
              note — the notional the dollar benchmarks are valued on is already
              in the chart's own legend, beside the lines it applies to. */}
          {PfUnitBar && win.pnl && (
            <PfUnitBar value={unit} onChange={setUnit}/>
          )}
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

      {/* These four are fixed calendar periods, not the range picker's window,
          so the toggle only swaps which of the two figures each tile already
          carried is the big one — the other takes the small colored line
          underneath. Same shape under both units; only the pair swaps. */}
      <div className="pf-stats">
        {/* Every kicker carries `· twr` now. It used to sit on 1y alone, which
            read as a distinction — and was one: the other three divided dollar
            P&L by the NAV the period opened on. All four are the same chained
            return the chart draws, so the label says so on all four. */}
        {[['mtd', 'mtd', 'month to date · twr'],
          ['qtd', 'qtd', 'quarter to date · twr'],
          ['ytd', 'ytd', 'year to date · twr'],
          ['1y', '1y', 'trailing 12mo · twr']].map(([key, label, kicker]) => {
          const p = d.pnl[key];
          if (!p) return null;
          return usd
            ? <StatTile key={key} label={label} value={fmtUSD(p.abs)} change={p.pct} kicker={kicker}/>
            : <StatTile key={key} label={label} value={fmtPct(p.pct)} change={p.pct}
                changeText={fmtUSD(p.abs)} kicker={kicker}/>;
        })}
      </div>

      {risk && (
        <div className="pf-stats pf-stats-5 pf-stats-risk">
          <StatTile label="sharpe"  value={fmtNum(winRisk.sharpe)}          kicker={pfCiLabel(winRisk)}/>
          {/* Sortino charges the same rf as Sharpe and divides by the same
              excess returns — only the denominator changes, from every day's
              spread to the shortfall days alone. So the kicker prints that
              denominator rather than repeating the rf: the gap between it and
              the vol tile two along is the entire reason this tile is here. */}
          <StatTile label="sortino" value={fmtNum(winRisk.sortino)}         kicker={`downside dev ${fmtPctBare(winRisk.downside)}`}/>
          <StatTile label="ann vol" value={fmtPctBare(winRisk.vol)}         kicker="annualized · twr"/>
          <StatTile label="max dd"  value={fmtPctBare(winRisk.maxDrawdown)} kicker="peak-to-trough"/>
          <StatTile label="beta"    value={betaObj ? fmtNum(betaObj.beta) : '—'}
                    kicker={betaObj ? `vs ${primaryName} · r² ${fmtNum(betaObj.r2)}` : `vs ${primaryName}`}/>
        </div>
      )}

      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">performance · {pfRangeLabel(range)}</span>
          <div className="pf-range">
            <SzToggle options={PF_RANGES} value={range} onChange={setRange}/>
            {PfHistoryPicker && (
              <PfHistoryPicker quarters={quarters} value={range} onPick={setRange}/>
            )}
            {PfBenchPicker && bench && (
              <PfBenchPicker value={benchKeys} onChange={setBenchKeys}
                available={Object.keys(bench)}/>
            )}
          </div>
        </div>
        <NavChart series={win.nav} perfSeries={win.perf} benchmarks={bench}
          benchKeys={benchKeys} unit={unit} dollars={win.pnl}/>
        {/* Drawdown stays in percent under both units: a decline from peak is a
            portfolio-level ratio, and the combined view reads it the same way. */}
        <div className="pf-strip-head">
          <span className="pf-strip-label">underwater · drawdown from peak</span>
          <span className="pf-strip-meta">max {fmtPctBare(winMaxDd)} · now {fmtPctBare(winCurDd)}</span>
        </div>
        <DrawdownStrip perfSeries={win.perf}/>
        {alphaShown && (
          <>
            <div className="pf-strip-head">
              <span className="pf-strip-label">alpha vs {primaryName} · cumulative</span>
              <span className="pf-strip-meta">
                now {alphaShownNow >= 0 ? '+' : ''}
                {(usd && alphaD) ? fmtUSD(alphaShownNow) : fmtPctBare(alphaShownNow)}
              </span>
            </div>
            <AlphaStrip alpha={alphaShown} unit={(usd && alphaD) ? 'usd' : 'pct'}/>
          </>
        )}
        <RollingStrip fullSeries={ext.perf} perfSeries={win.perf} benchSeries={primarySeries}
          benchName={primaryName}/>
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
            <span className="pf-panel-title">capture vs {primaryName}</span>
            {/* A net-short book prints negative capture — it moves against the
                index rather than damping it — so say what the sign means. */}
            <span className="pf-panel-meta">
              {capture.upDays} up · {capture.downDays} down sessions · negative = moved opposite
            </span>
          </div>
          <div className="pf-stats pf-stats-capture">
            <StatTile label="up capture"
              value={capture.upCapture != null ? fmtPctBare(capture.upCapture, 0) : '—'}
              kicker={`of ${primaryName} gains on its up days`}/>
            <StatTile label="down capture"
              value={capture.downCapture != null ? fmtPctBare(capture.downCapture, 0) : '—'}
              kicker={`of ${primaryName} losses on its down days`}/>
            <StatTile label="bull beta" value={fmtNum(capture.bullBeta)}
              kicker={`slope · ${primaryName} up days`}/>
            <StatTile label="bear beta" value={fmtNum(capture.bearBeta)}
              kicker={`slope · ${primaryName} down days`}/>
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
