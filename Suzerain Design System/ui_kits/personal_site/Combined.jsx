// Combined.jsx — IBKR + Polymarket cumulative P&L, merged on a trailing-1y axis.
// Globals: React, Cursor

const {
  useState: useCmbState,
  useEffect: useCmbEffect,
  useRef: useCmbRef,
} = React;

// Chart machinery (Chart.jsx, loaded ahead of this file) — the same box,
// scales, hover math and gradient stops the ibkr and polymarket charts use.
// The spline in particular is shared rather than re-derived, so both books'
// curves round the same way.
const {
  szSmoothPath: smoothPath, szFrame, szScales, szDomain, szAreaPath, szTicks,
  useChartHover, SzChartSvg, SzChartDefs, SzRule, SzCrosshair,
  SzTooltip, SzAxisX, SzAxisZero, SzKeyReadout, SzStripHead, SzToggle,
} = window;

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
// Benchmark colors/labels/order come from the shared registry (SZ_BENCHES in
// Chrome.jsx), the same one the ibkr tab and the picker read.
const cmbBenchColor = (key) => (window.szBenchColor ? window.szBenchColor(key) : '#5eead4');
const cmbBenchLabel = (key) => (window.szBenchLabel ? window.szBenchLabel(key) : key);

function cmbUSD(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function cmbSigned(n) {
  return (n >= 0 ? '+' : '') + cmbUSD(n);
}
// Percent values arrive as ratios (see cmbPctSeries), so the formatter only has
// to pick a unit — it never divides. Dividing here is what made this view's
// third construction: a single window-start base for a book whose capital moved
// all year.
// Two decimals, matching the ibkr view's fmtPct. One decimal made the legs look
// like they missed the headline they sum to: 50.94 + 0.45 rounds to 50.9 + 0.5
// = 51.4 against a total of 51.3. The values are exactly additive (see
// cmbPctSeries); only the display was losing the carry.
const cmbPctFmt = (v) => (v == null || !isFinite(v)) ? '—'
  : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
function cmbFmt(v, unit) {
  return unit === 'pct' ? cmbPctFmt(v) : cmbSigned(v);
}

// ---------- percent mode: chained daily TWR, same construction as ibkr + polymarket ----------
// Each day's P&L is measured against the capital that actually earned it —
// p.base, carried per point from real NAV — and the daily returns are chained.
// Deposits and IBKR→Polymarket transfers move the base without registering as
// return, which is the property a fixed denominator cannot have.
//
// The legs are decomposed additively rather than chained on their own: a leg
// accumulates (Δleg / base) scaled by the compounding factor to date. That sums
// EXACTLY to the total, because the day's return is the sum of the legs' and
// TWR = Σ_d r_d · Π_{k<d}(1 + r_k). Chaining each leg separately would leave
// ibkr + polymarket a few basis points off the headline they sit under.
//
// Benchmarks stay their own index returns. Their dollar column is
// winNotional × (index return), so dividing by that notional recovers the index
// exactly — and they are not components of this book, so chaining them against
// its capital base would be meaningless.
function cmbPctSeries(series, notional, benchKeys) {
  if (!series || series.length < 2) return null;
  const keys = benchKeys && benchKeys.length ? benchKeys : ['spx'];
  const bench = (src, dst) => {
    for (const k of keys) {
      if (src[k] != null && notional) dst[k] = src[k] / notional;
    }
  };
  const first = { d: series[0].d, v: 0, ibkr: 0, pm: 0 };
  bench(series[0], first);
  const out = [first];
  let cum = 1, cIbkr = 0, cPm = 0;
  for (let i = 1; i < series.length; i++) {
    const p = series[i], q = series[i - 1];
    const base = (q.base != null && q.base > 0) ? q.base : notional;
    if (!base || base <= 0) return null;
    const dIbkr = (p.ibkr || 0) - (q.ibkr || 0);
    const dPm = (p.pm || 0) - (q.pm || 0);
    cIbkr += (dIbkr / base) * cum;         // cum is Π_{k<d}(1+r_k) — before this step
    cPm += (dPm / base) * cum;
    cum *= 1 + (dIbkr + dPm) / base;
    const row = { d: p.d, v: cum - 1, ibkr: cIbkr, pm: cPm };
    bench(p, row);
    out.push(row);
  }
  return out;
}
// Correlations always carry a sign — an unsigned "0.03" reads as a magnitude and
// loses the one bit that matters. U+2212 minus to match the display font's digits.
function cmbCorrFmt(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
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

// Plot-point ceiling shared with the polymarket view (PM_CHART_MAX_POINTS).
// Sized so daily resolution survives ~11 years of history: floor(len/target)
// only steps to 2 at 2x the target, so a tighter cap would hold 1d for a while
// and then silently coarsen. smoothPath costs ~1.6ms at 2000 points, well
// inside a frame even though it is recomputed on every hover move.
const CMB_CHART_MAX_POINTS = 2000;

function cmbDownsample(arr, target = CMB_CHART_MAX_POINTS) {
  if (arr.length <= target) return arr;
  const step = Math.floor(arr.length / target);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

// The visible point nearest a date, or null when the date falls outside the
// window. Shared by the log markers and the transfer ticks below: both pin a
// dated event onto an axis of point indices, and both DROP what the window does
// not cover rather than clamping it to an edge — a mark pinned to the first
// column is a claim that something happened there.
function cmbPinIndex(days, iso) {
  if (!days.length || !iso) return null;
  const d = cmbEpochDay(iso);
  if (d < days[0] || d > days[days.length - 1]) return null;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < days.length; i++) {
    const diff = Math.abs(days[i] - d);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

// Map each dated log entry onto the nearest chart point so it can be pinned to
// the total line. Entries outside the visible window are dropped.
function cmbMarkers(series, log) {
  if (!series.length || !log || !log.length) return [];
  const days = series.map(p => cmbEpochDay(p.d));
  return (log || []).map(entry => {
    const i = entry ? cmbPinIndex(days, entry.date) : null;
    if (i == null) return null;
    return { i, date: entry.date, body: entry.body, link: entry.link, slug: entry.slug, v: series[i].v };
  }).filter(Boolean);
}

// The same, for the IBKR->Polymarket ledger in content.json. These are the only
// events on the capital chart that are decisions rather than marks: every other
// step in those two bands is the market moving.
function cmbTransferMarks(series, transfers) {
  if (!series || !series.length || !transfers || !transfers.length) return [];
  const days = series.map(p => cmbEpochDay(p.d));
  return transfers.map(t => {
    const i = t ? cmbPinIndex(days, t.date) : null;
    return i == null ? null : { i, date: t.date, amount: t.amount || 0 };
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

// A note that carries a slug is the blurb of a post, not a standalone note —
// see buildStream in Hero.jsx, where the row itself becomes the link. The
// caption can't do that: its head already holds three buttons, so wrapping the
// block would put anchors inside anchors. The link rides at the end of the body
// instead, titled from the manifest once it lands and labeled generically until
// then (App.jsx re-renders the tree when POSTS arrives).
function cmbPostLink(entry) {
  if (!entry || !entry.slug) return null;
  const post = (window.POSTS || []).find(p => p.slug === entry.slug);
  // The leading space is a text node, not margin: it is the only break
  // opportunity between the body's last word and the title, and without one the
  // pair is a single unbreakable run that overhangs the card on a phone. The
  // arrow is glued on with a non-breaking space so it can't wrap alone.
  return (
    <React.Fragment>
      {' '}
      <a className="cmb-annot-cap-more" href={`#/thoughts/${entry.slug}`}>
        {post ? post.title : 'read the post'} →
      </a>
    </React.Fragment>
  );
}

// IBKR cumulative $ P&L, anchored so the endpoint equals pnl["1y"].abs — IBKR's
// authoritative deposit-adjusted dollar figure (ChangeInNAV), which the Portfolio
// tab headlines.
//
// Source order matters. pnlSeries is the true daily cumulative *dollar* P&L and
// is what we want; perfSeries (TWR) is only a fallback for snapshots that
// predate it. TWR is scale-free by construction, so turning it into dollars with
// a single multiplier silently assumes the account was one size all year. It
// wasn't — 642k to 727k with 242k moved out to Polymarket — and that misprices
// every intra-year segment: q4 25 read $57.7k against a true $63.6k, because a
// constant factor values 1% of TWR at ~$5.8k when the account was really ~$680k
// through that quarter.
//
// Both sources still get scaled to the pnl["1y"].abs endpoint, but on pnlSeries
// that is a uniform ~0.6% nudge (the flows IBKR's ChangeInNAV counts differ from
// the CashTransaction sum by $2k) rather than a reshaping of the curve.
function cmbIbkrPoints(portfolio, pnlHistory) {
  const nav = portfolio.navSeries || [];
  const perf = portfolio.perfSeries || [];
  const pnlS = portfolio.pnlSeries || [];
  if (!nav.length) return [];
  const startNAV = nav[0].v;
  const oneY = portfolio.pnl && portfolio.pnl['1y'] ? portfolio.pnl['1y'].abs : null;

  const inDollars = pnlS.length === nav.length && pnlS.length > 0;
  const shape = inDollars
    ? pnlS.map(p => ({ d: p.d, v: p.v }))
    : (perf.length === nav.length && perf.length)
      ? perf.map(p => ({ d: p.d, v: p.v }))
      : nav.map(p => ({ d: p.d, v: startNAV ? (p.v - startNAV) / startNAV : 0 }));

  const last = shape[shape.length - 1].v;
  const toDollars = (oneY != null && last)
    ? (v) => oneY * (v / last)
    : inDollars ? (v) => v : (v) => startNAV * v;

  const trailing = shape.map(p => ({ day: cmbEpochDay(p.d), v: toDollars(p.v) }));

  // Prepend accumulated pre-window history (nav-history.json) so the MAX range
  // can span multiple years. History rows are cumulative-$ P&L on their own
  // baseline; the trailing curve starts at 0 on nav[0].d. Offset the history
  // block by its value at the seam so the two meet continuously — the trailing
  // year (endpoint anchored to pnl["1y"].abs) is left untouched.
  const hist = (pnlHistory && pnlHistory.rows) || [];
  if (hist.length && trailing.length) {
    const seamDay = trailing[0].day;
    let seamV = null;
    for (const r of hist) {
      const rd = cmbEpochDay(r.d);
      if (rd <= seamDay) seamV = r.v; else break;
    }
    if (seamV != null) {
      const pre = hist
        .filter(r => cmbEpochDay(r.d) < seamDay)
        .map(r => ({ day: cmbEpochDay(r.d), v: r.v - seamV }));
      if (pre.length) return pre.concat(trailing);
    }
  }
  return trailing;
}

// Polymarket raw user-pnl rows: [{ t: unixSeconds, p: dollars }] → daily $ points,
// on IBKR's "dated D = close of D" convention (szPmPointDay). The raw stamps are
// day *boundaries*, so taking them at face value put the polymarket leg a day
// ahead of the IBKR leg it gets summed with below.
function cmbPmPoints(rows, bdRows, transfers) {
  const dated = window.szDedupeByDate((rows || []).map(r => ({
    d: window.szFromEpochDay(window.szPmPointDay(r.t)), v: r.p,
  })));
  // Past the seam the feed's own figure is unusable — a neg-risk conversion
  // corrupts it until the market closes — so the curve is walked off book value
  // from there (szPmBookExtend, same call the polymarket view makes). Doing it
  // here, on the shared rows, is what keeps the chart and the capital base on
  // one reading: a level built off this feed's raw delta past the last scrape
  // carried $20,046 of phantom polymarket capital on 2026-08-27, while the
  // panel it linked to said the same.
  return window.szPmBookExtend(dated, bdRows, transfers)
    .map(x => ({ day: window.szEpochDay(x.d), v: x.v }));
}

// Best-effort JSON GET: resolves to null on any failure so a missing optional
// feed never rejects the Promise.all that the loader fans out with. The fetch
// underneath is szJson, so a feed the ibkr or polymarket view already pulled is
// not pulled again on the way here.
function cmbGetJson(url) {
  return window.szJson(url).catch(() => null);
}

// All-source polymarket income beyond trading (lp + maker/taker rebates + yield
// + sponsored + uma), windowed to ~12mo. betmoar's totals are lifetime, so we diff against the
// oldest history snapshot that's <= 365d ago. Without a baseline that old, we
// use lifetime totals (correct as long as no rewards/fees pre-date the window).
// betmoar breakdown is primary; CLOB rewards json is the fallback.
//
// Takes the already-fetched breakdown + history payloads rather than fetching
// its own: the loader has both in its parallel fan-out by the time this runs.
async function cmbBdExtra(bd, hist) {
  const current = (bd && bd.totals) ? bd.totals : null;
  if (!current) {
    // Fallback only — left lazy so the common path never pays for it.
    const rw = await cmbGetJson('data/polymarket-rewards.json');
    if (rw && rw.totals) {
      return { total: Math.round(rw.totals.makerRebates || 0) + Math.round(rw.totals.liquidityRewards || 0), rows: [] };
    }
    return { total: 0, rows: [] };
  }

  // Restate the scrape dates onto the close-of-day convention here, once, so
  // everything downstream can read `.d` at face value.
  const rows = hist
    ? window.szPmDateSnapshotRows((hist.rows || []).filter(x => x && x.d))
    : [];

  // Lifetime total; szPmIncomeCurve does the windowing off the dated history.
  // This used to subtract a 365d-old baseline row, but the history rarely
  // reaches back that far, so the baseline was almost always null and the whole
  // lifetime landed in the window regardless of when it was earned.
  return { total: cmbBdNet(current), rows };
}

// Polymarket's user-pnl-api series (used as the `pm` line) excludes trading
// fees, so betmoar's implied `fees` come off here. Shared with the polymarket
// view (Chrome.jsx) — the two used to keep separate sums that disagreed on
// whether `uma` counted.
const cmbBdNet = (r) => window.szPmIncomeNet(r);

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

function cmbBuild(portfolio, pmRows, bd, benchmarks, pmTransfers, pnlHistory, pmNavHistory) {
  const nowDay = Math.floor(Date.now() / CMB_DAY_MS);

  const ibkrPts = cmbIbkrPoints(portfolio, pnlHistory);
  const pmPts = cmbPmPoints(pmRows, (bd && bd.rows) || [], pmTransfers);

  // End the series on the last day either feed actually reports, not the wall
  // clock. Padding forward to `now` used to push the trailing-range cutoff a day
  // past the polymarket view's — same range name, window-start a day apart, and
  // one day of polymarket P&L is four figures. Polymarket's tail is walked off
  // the morning's betmoar scrape (szPmBookExtend), so it is the fresher of the
  // two; `max` therefore lands on the same last day the
  // polymarket view sees, and clamping to `nowDay` keeps a future-dated file
  // from projecting the axis forward.
  const lastFeedDay = Math.max(
    ibkrPts.length ? ibkrPts[ibkrPts.length - 1].day : -Infinity,
    pmPts.length ? pmPts[pmPts.length - 1].day : -Infinity
  );
  const today = Number.isFinite(lastFeedDay) ? Math.min(lastFeedDay, nowDay) : nowDay;

  // Window = IBKR's actual trailing-year series start, so the IBKR endpoint isn't
  // clipped by rebasing and stays equal to pnl["1y"].abs.
  const start = ibkrPts.length ? ibkrPts[0].day : today - 365;

  const ibkr = cmbSampleDaily(ibkrPts, start, today);
  const pm = cmbSampleDaily(pmPts, start, today);

  // Rebase each to its value at the window start so the chart shows P&L over the year.
  const ibkrBase = ibkr[0], pmBase = pm[0];

  // All-source polymarket income (maker/lp/yield/…) as a dated curve rather than
  // a flat ramp, then rebased to the window start so the chart still reads as
  // P&L earned over the window. Only applied when polymarket has data; points
  // before the breakdown history begins are still estimates.
  //
  // The anchor is szPnlLifeStartDay, not pmPts[0].day: the raw feed opens with a
  // long flat stretch before the first trade (182 days as of writing), and using
  // the raw first row stretched the pre-history ramp across it. That put a
  // different slope on the ramp than the polymarket view's — which trims the
  // flat run before charting — so the same pre-seam rewards split differently
  // across the same 12mo boundary on the two pages.
  //
  // Built here rather than after the capital base below because the base now
  // reads it: income lands in the account, so it moves the level exactly as
  // trading P&L does.
  const hasPm = pmPts.length > 0;
  const rewardsAt = window.szPmIncomeCurve(
    (bd && bd.rows) || [],
    hasPm ? window.szPnlLifeStartDay(pmRows) : start,
    (bd && bd.total) || 0, today);
  const rewardsBase = hasPm ? rewardsAt(start) : 0;
  const extra = hasPm ? +(rewardsAt(today) - rewardsBase).toFixed(2) : 0;

  // Capital base on any given day = that day's real IBKR NAV + every
  // IBKR→Polymarket transfer made on or before it (content.json pmTransfers).
  // Money moved to Polymarket has left the IBKR NAV but is still capital you
  // committed, so the ledger adds it back.
  //
  // It has to be the *actual* NAV, looked up per day, and never base + P&L:
  // deposits and transfers move NAV without being P&L (pnl.abs is
  // deposit-adjusted ChangeInNAV, by design), so back-deriving a level from a
  // return series drifts by every cash flow in between. That bug had the 1y
  // window claiming a $733k base against a real $642k.
  const navByDay = new Map();
  for (const r of ((pnlHistory && pnlHistory.rows) || [])) {
    if (r && r.d && r.n != null) navByDay.set(cmbEpochDay(r.d), r.n);
  }
  for (const p of (portfolio.navSeries || [])) {   // recent Flex window wins
    if (p && p.d) navByDay.set(cmbEpochDay(p.d), p.v);
  }
  const navDays = [...navByDay.keys()].sort((a, b) => a - b);
  const navAt = (day) => {
    if (!navDays.length) return 0;
    let lo = 0, hi = navDays.length - 1, best = -1;
    while (lo <= hi) {                              // last recorded day <= day
      const mid = (lo + hi) >> 1;
      if (navDays[mid] <= day) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return navByDay.get(navDays[best === -1 ? 0 : best]);
  };
  const transfersThrough = (day) => (pmTransfers || [])
    .filter(t => t && t.date && cmbEpochDay(t.date) <= day)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  const transfersOn = (day) => (pmTransfers || [])
    .filter(t => t && t.date && cmbEpochDay(t.date) === day)
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  // The Polymarket half of the base, preferring its real NAV.
  //
  // The transfers ledger values money sent to Polymarket at what was sent,
  // forever, so base(D) = true capital(D) − PM cumulative P&L(D). At today's
  // −12.5k on a 969k base that is 1.3% and invisible, but a +100k swing would
  // put the base ~10% under true capital: the SPX line understated by 10% of
  // its move, vol and drawdown inflated ~1.1x, and the gap between adjacent
  // quarter bases blown out to 100k.
  //
  // polymarket-nav-history.json carries it back to the first transfer
  // (2026-01-09): recorded NAV from 2026-07-15, and before that a value
  // reconstructed by walking the oldest recorded day backwards through
  // transfer / user-pnl / rewards deltas. Checked against the 12 days where
  // both exist, that reconstruction is off by 838 on average (0.36%) versus
  // 18,368 (8.2%) for the ledger it replaces. Earlier than the first transfer
  // there is no honest figure — Polymarket was funded from outside the ledger —
  // so those windows fall back to it and PM contributes nothing, as before.
  // Row dates arrive already restated to the snapshot convention (see the fetch
  // site): the recorded rows are betmoar's `nav` off the same ~08:45 UTC scrape as
  // the breakdown history, and the derived rows are walked back from them, so both
  // carried the scrape's day rather than a closed one. Worth ~$2k/day against a
  // ~$965k base — a 0.2% correction that matters for staying on one convention
  // with the P&L legs, not for the base itself.
  const pmNavByDay = new Map();
  for (const r of ((pmNavHistory && pmNavHistory.rows) || [])) {
    if (r && r.d && r.nav != null) pmNavByDay.set(cmbEpochDay(r.d), r.nav);
  }
  // The breakdown history carries the same `nav`, and it is where nav-history's
  // `recorded` rows come from: build-pm-nav-history.py copies balances.nav
  // straight across and only *derives* the days before the scrape started
  // carrying balances. So this overlay is the same number from the nearer of two
  // copies — identical on every day both hold — except at the tail, where it is
  // the only one that exists.
  //
  // The two files are written by different workflows: betmoar-refresh appends
  // the scrape to the breakdown history, and polymarket-pnl-refresh rebuilds
  // nav-history off it ten minutes later. On the cron path they stay in step. A
  // manual betmoar-refresh dispatch does not: it moves the breakdown that the
  // polymarket view reads its headline off, and leaves nav-history — and so this
  // page's polymarket level — on the previous day's scrape until the next 06:10
  // UTC run. That is a full scrape of drift between two numbers naming one
  // quantity, +$1,386 (0.55%) at the dispatch that turned it up. Reading the
  // scrape directly puts the level on the same footing the polymarket view has,
  // and takes the rebuild off this page's critical path.
  //
  // `nav` and `trading` are both read live off the profile, so the row also
  // pins the P&L the book had *at the moment its nav was measured* — kept here
  // for the carry-forward below, where the labeled day is the wrong baseline.
  const pmScrapeEarned = new Map();
  for (const r of ((bd && bd.rows) || [])) {
    if (!r || !r.d || r.nav == null) continue;
    const day = cmbEpochDay(r.d);
    pmNavByDay.set(day, r.nav);
    // Before the book-value seam only. Past it the series is already walked off
    // these same scrape rows (cmbPmPoints -> szPmBookExtend), so pmEarnedAt is
    // scrape-consistent by construction and this override has nothing left to
    // correct — while `trading` is itself the corrupted field the seam exists to
    // stop reading. Left in place it would net a book-derived level against a
    // feed-derived anchor, which is the glitch back again with its sign flipped.
    if (r.trading != null && r.d <= window.SZ_PM_BOOK_SEAM) {
      pmScrapeEarned.set(day, r.trading + cmbBdNet(r));
    }
  }
  const pmNavDays = [...pmNavByDay.keys()].sort((a, b) => a - b);
  const pmFloor = pmNavDays.length ? pmNavDays[0] : null;
  // The ledger opens mid-life, so its first entry is an opening balance wearing
  // a date rather than a wire that moved that day: every earlier move to
  // polymarket is condensed onto it. The arithmetic says so outright — the
  // derived rows satisfy nav = transfersThrough + cumPnl + 1044.56 exactly, so
  // the day before that entry implies a NAV of -$3,468, which no book held.
  //
  // Drawn, that condensation is a $6,500 step onto a $3,031 level on a day when
  // nothing of the sort happened. So the split is only charted from the first
  // ledger entry onward, where an entry means what it says. Earlier days keep
  // their level in `base` (where a four-figure polymarket book against a $640k
  // base is a rounding error) and simply aren't split.
  const firstXferDay = (pmTransfers || []).reduce((min, t) => {
    if (!t || !t.date) return min;
    const d = cmbEpochDay(t.date);
    return min == null || d < min ? d : min;
  }, null);
  const splitFloor = (pmFloor != null && firstXferDay != null)
    ? Math.max(pmFloor, firstXferDay)
    : pmFloor;
  //
  // One correction on the way out. Every scraped polymarket row is restated back
  // a day (szPmSnapshotDay) on the premise that a morning scrape reports through
  // the previous close. That premise is about what the book EARNED, and for
  // rewards it is exact. It is wrong about money that was MOVED: a wire that
  // landed on T is in the scrape taken on T, so restating files it under T-1 —
  // while the IBKR close that gave those dollars up does not report until T. For
  // that one day the same money is counted on both sides of the base. On the
  // 2026-06-02 transfer that is +$97k on a $909k base, a 10% step up and
  // straight back down; it has been in `base` since `base` was written and only
  // became visible when the capital chart drew the level instead of a return.
  //
  // The ledger dates the move and the ledger wins, so the transfer comes back
  // out of the polymarket level on the day before it. Only off a row dated that
  // day: that row is the restated scrape which actually contains the money, and
  // a stale row carried forward from before the wire never did — subtracting
  // there would open a hole the size of the transfer instead of closing one.
  const pmCapitalAt = (day) => {
    if (pmFloor == null || day < pmFloor) return transfersThrough(day);
    let lo = 0, hi = pmNavDays.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pmNavDays[mid] <= day) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const at = pmNavDays[best];
    const level = pmNavByDay.get(at);
    if (at !== day) return level;
    const t = transfersOn(day + 1);
    if (!t) return level;
    // Structurally, a restated row for day D IS the raw row for D+1, and the raw
    // rows are aligned with the ledger — so a row dated D always contains a
    // transfer dated D+1, whatever that day's P&L did to the level. Testing for
    // a visible step instead was wrong: on 2026-05-07 the book fell $1,039 while
    // an $1,850 wire landed, the step came out negative, and the correction was
    // skipped on a day that needed it.
    //
    // Two structural guards, no thresholds. `best > 0` skips the first row of
    // the series, which is the anchor of a walk-back reconstruction and where
    // the ledger's condensed opening entry lands — subtracting there returns
    // -$3,468 of capital. The floor check refuses any result no book could hold,
    // which is the same failure caught a second way.
    const corrected = level - t;
    return (best > 0 && corrected >= 0) ? corrected : level;
  };
  // Both level feeds stop before the P&L does. IBKR posts at the close, so a
  // weekend has no rows at all; a polymarket scrape on day D reports through the
  // close of D-1 (szPmSnapshotDay). The P&L legs meanwhile run to today off the
  // live user-pnl API. Carried forward flat, that left the nav reading pinned to
  // Friday while the number beside it moved every day.
  //
  // So past its last measured day each half is carried by its own P&L move
  // instead: level(D) = last measured level + (P&L(D) − P&L(that day)). Absent a
  // cash flow that is not an approximation — a book's level moves by its P&L,
  // definitionally — and it is a different thing from the reconstruction the
  // note above warns off. That one derived the *whole* base curve from returns
  // and so accumulated every deposit and transfer of the year; this spans the
  // day or three between the last scrape and now, and every measured level still
  // wins wherever one exists. A flow inside that gap is still missed, and
  // corrects itself the moment the next scrape lands.
  //
  // The IBKR half is symmetric but usually inert: its P&L and its NAV come off
  // the same file, so when the level stops the P&L has stopped too and the delta
  // is zero. It is written this way for the case where they don't.
  const atDay = (arr, day) => arr[Math.max(0, Math.min(arr.length - 1, day - start))];
  const lastNavDay = navDays.length ? navDays[navDays.length - 1] : null;
  const lastPmNavDay = pmNavDays.length ? pmNavDays[pmNavDays.length - 1] : null;
  const pmEarnedAt = (day) => atDay(pm, day) + (hasPm ? rewardsAt(day) : 0);
  const extendable = (lastDay) => lastDay != null && lastDay >= start && lastDay <= today;
  const ibkrLevelAt = (day) => {
    const level = navAt(day);
    if (!extendable(lastNavDay) || day <= lastNavDay) return level;
    return level + (atDay(ibkr, day) - atDay(ibkr, lastNavDay));
  };
  const pmLevelAt = (day) => {
    const level = pmCapitalAt(day);
    if (!extendable(lastPmNavDay) || day <= lastPmNavDay) return level;
    // Baseline is the P&L the scrape itself saw, not the close of the day it is
    // filed under. Those are different readings: the row dated D-1 was taken
    // partway into D, so `nav` already contains everything the book earned
    // between D-1's close and the scrape. Measuring the carry-forward from
    // D-1's close therefore counts that stretch twice — +$380 on a 5h-old
    // scrape, and a four-figure overstatement on a day the book actually moved.
    // The dating is right for the rewards the row also carries (they batch at
    // 00:00 for the previous day, which is what szPmSnapshotDay is about); it is
    // the live-marked fields that need reading at their own timestamp, and the
    // row carries those too.
    const anchor = pmScrapeEarned.has(lastPmNavDay)
      ? pmScrapeEarned.get(lastPmNavDay)
      : pmEarnedAt(lastPmNavDay);
    return level + (pmEarnedAt(day) - anchor);
  };
  const baseAt = (day) => ibkrLevelAt(day) + pmLevelAt(day);
  const notional = baseAt(start);

  // Whether the two level feeds reach far enough to split the base at all. The
  // capital chart draws ibkrLevel and pmLevel per point; before the first
  // polymarket nav row there is no honest polymarket figure (see pmCapitalAt),
  // and half a stack would read as the whole book.
  const hasLevels = navDays.length > 0 && pmFloor != null && today >= pmFloor;
  const bench = [];
  if (benchmarks && notional) {
    for (const [key, b] of Object.entries(benchmarks)) {
      const vals = cmbBenchDollars(b.series, notional, start, today);
      if (vals) bench.push({ key, label: b.label, vals });
    }
  }
  const series = [];
  for (let k = 0; k < ibkr.length; k++) {
    const day = start + k;
    const ramp = hasPm ? rewardsAt(day) - rewardsBase : 0;
    // The two halves of the capital base, kept apart. `base` was their sum from
    // the day it was written and stays exactly that — hasLevels' two calls — but
    // only the sum was carried, so the split existed for the latest day alone
    // and nowhere else. Carrying both is what lets the split be drawn as a
    // curve instead of asserted as a ratio.
    const ibkrL = ibkrLevelAt(day);
    const pmL = pmLevelAt(day);
    const pt = {
      d: cmbFromEpochDay(day),
      v: +((ibkr[k] - ibkrBase) + (pm[k] - pmBase) + ramp).toFixed(2),
      ibkr: +(ibkr[k] - ibkrBase).toFixed(2),
      pm: +((pm[k] - pmBase) + ramp).toFixed(2),
      // Real capital base that day, so a sub-window can read its own base off
      // its first point instead of reconstructing one from returns. Measured
      // wherever the level feeds reach, which is every day but the last few
      // (see baseAt). Rounded from the unrounded sum, not from the two rounded
      // halves, so it stays the figure every window's notional has always been.
      base: +(ibkrL + pmL).toFixed(2),
      ibkrLevel: +ibkrL.toFixed(2),
      // null, not zero, before polymarket's nav history begins. pmCapitalAt
      // falls back to the transfer ledger there, and the ledger opens on
      // 2026-01-09 — so every earlier day reads $0 while the user-pnl feed,
      // which goes back to 2024-11-28, has the book already ±$4.5k. A zero band
      // under a P&L line that moves is a claim that the book traded on no
      // capital, and it is not one the data supports: polymarket was funded
      // from outside the ledger and the true level for those days is unknown,
      // not nothing. The chart drops what it cannot split (cmbCapitalPoints).
      //
      // `base` above is deliberately untouched and stays ibkrLevel + 0. It is
      // the denominator of every percent return on this page and the notional
      // of every window, both since long before the split was carried; the true
      // pre-2026 polymarket level is low four figures against a ~$640k base, so
      // the fallback is a rounding error there and a false statement only when
      // drawn as a band of its own.
      pmLevel: (splitFloor != null && day >= splitFloor) ? +pmL.toFixed(2) : null,
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
    series: cmbDownsample(series, CMB_CHART_MAX_POINTS),
    total: last.v,
    ibkr: last.ibkr,
    pm: last.pm,
    bdExtra: extra,
    pmAvailable: pmPts.length > 0,
    bench: bench.map(b => ({ key: b.key, label: b.label })),
    benchNotional: notional,
    vsSpx,
    hasLevels,
    // The ledger itself, so the capital chart can tick the days money moved.
    // Lifetime, not windowed — the panel drops what its own range doesn't cover
    // (cmbTransferMarks) and prints the lifetime sum beside the split.
    transfers: pmTransfers || [],
    // Deliberately not range-windowed: the overlap is only ~144 sessions to
    // begin with (Polymarket NAV history is the binding constraint), and slicing
    // that to 1M would leave a correlation estimate that is pure noise.
    corr: cmbCorrelation(pnlHistory, pmPts, pmNavHistory),
  };
}

// ---------- total pnl sparkline (violet→magenta) with pinned log markers ----------
// The tallest chart on the site — it carries two component lines, n benchmark
// lines and the aggregate, so it gets 20px more than the ibkr curve.
const CMB_CHART_FRAME = szFrame(240, 20, 32);
const CMB_DD_FRAME = szFrame(60, 6, 12);
const CMB_CORR_FRAME = szFrame(76, 8, 14);
const CMB_STRIP_FRAME = szFrame(60, 8, 12);
const CMB_BARS_FRAME = szFrame(200, 14, 22);

function CmbChart({ series, pctSeries, log, bench, benchNotional, ddNotional, unit, primary }) {
  const F = CMB_CHART_FRAME;
  const benches = bench || [];
  const base = ddNotional != null ? ddNotional : benchNotional;
  const pct = unit === 'pct' && !!pctSeries;
  // Percent redraws the curve rather than relabeling it: chaining against a
  // moving capital base is a different shape, not a rescale. `series` stays the
  // dollar copy because the drawdown strip rebuilds an equity curve from it.
  const plot = pct ? pctSeries : series;
  const fmt = (v) => cmbFmt(v, pct ? 'pct' : 'usd');
  const hv = useChartHover(F);
  const [annot, setAnnot] = useCmbState(null);
  // The caption defaults to the newest entry rather than to nothing, so it is
  // always sitting above the chart whether or not you asked for it. Collapsing
  // leaves the date bar behind instead of removing the block: gone entirely, the
  // chart would jump up the page and there would be no way back to a note you
  // hadn't already pinned.
  const [capHidden, setCapHidden] = useCmbState(false);
  const markers = cmbMarkers(plot, log).sort((a, b) => a.i - b.i);
  const cur = annot || (markers.length ? markers[markers.length - 1] : null);
  const curIdx = cur ? markers.findIndex(m => m.i === cur.i) : -1;
  // Picking a marker is a request to read it, so it reopens a collapsed caption.
  const pickAnnot = (m) => { setAnnot(m); setCapHidden(false); };

  const all = [];
  for (const p of plot) {
    all.push(p.v, p.ibkr, p.pm);
    for (const b of benches) if (p[b.key] != null) all.push(p[b.key]);
  }
  // Floor anchored at 0 so the zero line is always drawn; the ratio floor is a
  // hundredth rather than the dollar `1`, which is a hundred percentage points
  // and would flatten a whole window onto that line.
  const { y0, y1 } = szDomain(all, { pad: 0.08, floor: pct ? 0.01 : 1, min: 0 });
  const { x, y } = szScales(F, plot.length, y0, y1);

  const linePath = (key) =>
    smoothPath(plot.map((_, i) => x(i)), plot.map(p => y(p[key])));
  const totalPath = linePath('v');
  const areaPath = szAreaPath(totalPath, x(0), x(plot.length - 1), y(0));
  const zeroY = y(0);

  const ticks = szTicks(plot, 6);
  const spanDays = plot.length > 1 ? cmbEpochDay(plot[plot.length - 1].d) - cmbEpochDay(plot[0].d) : 0;
  const axisMode = spanDays <= 95 ? 'day'
    : (plot[0].d.slice(0, 4) === plot[plot.length - 1].d.slice(0, 4) ? 'month' : 'monthyear');

  const hp = hv.i != null ? plot[hv.i] : null;

  // Book NAV at the hovered column — ibkr's real NAV plus polymarket's, carried
  // per point as `base` (see baseAt). It reads off `series` rather than `plot`
  // because the percent copy is a return series with no level in it; the two are
  // index-aligned by construction (cmbPctSeries maps one row to one row). No
  // fallback to notional + p.v: that adds every deposit and transfer back in as
  // if it were profit, which is the whole reason `base` is carried.
  // A hover index outlives a range change, so it can point past the end of a
  // shorter window: fall back to the latest point there, the same way the
  // crosshair blanks rather than reading a row that isn't in frame.
  const navHover = hv.i != null ? series[hv.i] : null;
  const navPt = navHover || series[series.length - 1];
  const navNow = navPt && navPt.base != null ? navPt.base : null;
  // Dollars belong to the dollar reading. In percent the chart makes no claim
  // about the level — it is a chained return series, where the level is only the
  // denominator of each day's move — so a dollar figure in that key is a second
  // unit the reader has to reconcile against a curve that never mentions it.
  const showNav = !pct && navNow != null;

  return (
    <>
    {/* Event-log caption sits above the chart, not under the strips. Below, it
        landed between the alpha and rolling-beta strips and broke the stack of
        strips that are meant to read as one column against the chart — and it
        appears and disappears on click, shifting everything under it. */}
    {cur && (
      <div className={`cmb-annot-cap cmb-annot-cap-top${capHidden ? ' collapsed' : ''}`}>
        {/* Date leads, controls group at the right — the arrangement SzStripHead
            uses, and the one the log rows and post kickers already read in. The
            date's flex:1 does the pushing. Prev and next had been split by the
            full width of that field, which is a long trip between two buttons
            that are one control. */}
        <div className="cmb-annot-cap-head">
          {/* Collapsed the bar names the control rather than the entry behind
              it: with the arrows gone the date labels nothing you can read or
              step through, and the pinned entry is already the one marker
              wearing the active stroke on the chart. */}
          <div className="cmb-annot-cap-date">{capHidden ? 'log' : cmbFullDate(cur.date)}</div>
          {/* Stepping through entries you cannot read is a control without a
              purpose, so collapsed leaves the date and the toggle alone. */}
          {!capHidden && (
            <button className="cmb-annot-nav" disabled={curIdx <= 0}
              onClick={() => setAnnot(markers[curIdx - 1])} aria-label="previous entry">←</button>
          )}
          {!capHidden && (
            <button className="cmb-annot-nav" disabled={curIdx >= markers.length - 1}
              onClick={() => setAnnot(markers[curIdx + 1])} aria-label="next entry">→</button>
          )}
          <button className="cmb-annot-nav" onClick={() => setCapHidden(!capHidden)}
            aria-expanded={!capHidden}
            aria-label={capHidden ? 'show note' : 'hide note'}>{capHidden ? '+' : '−'}</button>
        </div>
        {!capHidden && (
          <p className="cmb-annot-cap-body">{cmbCaptionBody(cur)}{cmbPostLink(cur)}</p>
        )}
      </div>
    )}
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={plot.length} className="pf-navchart pm-chart-svg">
        <SzChartDefs ramp="nav" id="cmb-nav"/>

        <SzRule frame={F} y={zeroY} stroke="rgba(229,225,241,0.1)"/>

        {/* component lines — faint, recessed beneath the aggregate */}
        <path d={linePath('ibkr')} fill="none" stroke={CMB_C_IBKR} strokeWidth="1" opacity="0.3"/>
        <path d={linePath('pm')} fill="none" stroke={CMB_C_PM} strokeWidth="1" opacity="0.3"/>
        {benches.map(b => (
          <path key={b.key} d={linePath(b.key)} fill="none"
            stroke={cmbBenchColor(b.key)} strokeWidth="1" opacity="0.45"/>
        ))}

        <path d={areaPath} fill="url(#cmb-nav-fill)"/>
        <path d={totalPath} fill="none" stroke="url(#cmb-nav-stroke)" strokeWidth="1.75"/>

        {/* Hairline under every dot, then the components and benchmarks, then
            the aggregate on top. Every line this chart draws is dotted — the
            benchmarks are read off the crosshair exactly like the component
            curves are, and marking only some of them made them look like
            backdrop rather than series. */}
        {hp && (
          <SzCrosshair frame={F} x={x(hv.i)} cy={y(hp.v)} fill="#a78bfa" ring="#f5f0ff"
            dots={[
              { key: 'ibkr', cy: y(hp.ibkr), fill: CMB_C_IBKR },
              { key: 'pm', cy: y(hp.pm), fill: CMB_C_PM },
              ...benches.map(b => ({
                key: b.key,
                cy: hp[b.key] != null ? y(hp[b.key]) : null,
                fill: cmbBenchColor(b.key),
              })),
            ]}/>
        )}

        {/* log event markers — click to pin to the caption below */}
        {markers.map((m, k) => (
          <CmbAnnotDot key={k} cx={x(m.i)} cy={y(m.v)}
            active={cur && cur.i === m.i} onClick={() => pickAnnot(m)}/>
        ))}
      </SzChartSvg>

      <SzAxisZero frame={F} y={zeroY}>{pct ? '0%' : '$0'}</SzAxisZero>
      <SzAxisX frame={F} ticks={ticks} x={x} label={(t) => cmbAxisLabel(t.d, axisMode)}/>

      {hp && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(hp.v)} className="cmb-tooltip">
          <div className="pm-tt-date">{cmbFullDate(hp.d)}</div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_TOTAL }}/>total<span className={`cmb-tt-num ${hp.v >= 0 ? 'pos' : 'neg'}`}>{fmt(hp.v)}</span></div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_IBKR }}/>ibkr<span className={`cmb-tt-num ${hp.ibkr >= 0 ? 'pos' : 'neg'}`}>{fmt(hp.ibkr)}</span></div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_PM }}/>polymarket<span className={`cmb-tt-num ${hp.pm >= 0 ? 'pos' : 'neg'}`}>{fmt(hp.pm)}</span></div>
          {benches.map(b => hp[b.key] != null && (
            <div key={b.key} className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: cmbBenchColor(b.key) }}/>{cmbBenchLabel(b.key)}<span className={`cmb-tt-num ${hp[b.key] >= 0 ? 'pos' : 'neg'}`}>{fmt(hp[b.key])}</span></div>
          ))}
        </SzTooltip>
      )}

    </div>
    {(benches.length > 0 || showNav) && (
      <div className="pf-bench-legend">
        {showNav && (
          <SzKeyReadout label="nav" value={cmbUSD(navNow)} live={!!navHover}/>
        )}
        {/* The notional only explains anything in dollars — in percent the
            benchmark line IS the index's own return, on no notional at all.
            Said once, next to the nav reading it invites comparison with: every
            benchmark is staked on the same capital, so repeating it per row
            printed one number n times and left it looking like a stale nav. */}
        {!pct && base && benches.length > 0 && (
          <SzKeyReadout label="benchmarks on" value={cmbUSDk(base)} note="at open"/>
        )}
        {benches.length > 0 && (
          <span><i className="pf-bench-swatch" style={{ background: 'linear-gradient(90deg,#a78bfa,#ff4fd8)' }}/>total</span>
        )}
        {benches.map(b => (
          <span key={b.key}><i className="pf-bench-swatch" style={{ background: cmbBenchColor(b.key) }}/>{cmbBenchLabel(b.key)}</span>
        ))}
      </div>
    )}
    {/* Always the dollar series: this rebuilds an equity curve from notional +
        cumulative P&L, and reads as a percentage under both settings anyway. */}
    <CmbDrawdownStrip series={series} notional={base}
      markers={markers} cur={cur} onPick={pickAnnot}/>
    <CmbAlphaStrip series={plot} markers={markers} cur={cur} onPick={pickAnnot}
      unit={pct ? 'pct' : 'usd'} benchKey={primary}/>
    </>
  );
}

// Risk/return analytics for the combined book, off the reconstructed equity
// curve (window-start capital base + cumulative combined P&L). data.series is
// calendar-daily (cmbSampleDaily fills every day), so we annualize by 365 — not
// the 252 the IBKR tab uses on its trading-day perfSeries.
//
// Sharpe is excess of the fed funds rate in force on each of those days
// (rfRows = data/riskfree.json's series; without it this is the old rf-0
// figure). 365 goes to szRfSteps too, so a calendar day here is charged a
// calendar day of interest and the printed rf is the same average rate the
// IBKR tab prints for the same span, despite the two annualizing differently.
function cmbRisk(series, notional, benchKey = 'spx', rfRows = null) {
  if (!series || series.length < 21 || !notional || notional <= 0) return null;
  const PER = 365;
  const eq = series.map(p => notional + p.v);
  const steps = window.szRfSteps ? window.szRfSteps(series.map(p => p.d), rfRows, PER) : null;
  const rp = [], rf = [];
  for (let i = 1; i < eq.length; i++) {
    if (eq[i - 1] > 0) {
      rp.push(eq[i] / eq[i - 1] - 1);
      rf.push(steps ? steps[i] : 0);
    }
  }
  const n = rp.length;
  if (n < 20) return null;
  const mean = rp.reduce((a, b) => a + b, 0) / n;
  const meanRf = rf.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rp.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  // Raw vol, not the excess series' — see pfRiskWindow in Portfolio.jsx for why
  // the published volatility stays the book's own.
  const vol = sd * Math.sqrt(PER);
  const sharpe = vol ? ((mean - meanRf) * PER) / vol : null;
  // Downside deviation about the same per-day rf, divided by every session and
  // about a fixed 0 — see pfRiskWindow in Portfolio.jsx for the convention and
  // why it is the one build_risk uses. Only PER differs here, and it differs
  // for both halves of the ratio at once.
  let dvar = 0;
  for (let i = 0; i < n; i++) { const e = Math.min(rp[i] - rf[i], 0); dvar += e * e; }
  const downside = Math.sqrt(dvar / n) * Math.sqrt(PER);
  const sortino = downside ? ((mean - meanRf) * PER) / downside : null;

  // Standard error of the Sharpe, widened for skew and fat tails — see
  // pfRiskWindow in Portfolio.jsx for the formula and why the interval is
  // centered on the printed Sharpe rather than on its own estimate.
  let m2 = 0, m3 = 0, m4 = 0;
  const exMean = mean - meanRf;
  for (let i = 0; i < n; i++) {
    const z = rp[i] - rf[i] - exMean;
    m2 += z * z; m3 += z * z * z; m4 += z * z * z * z;
  }
  const exSd = Math.sqrt(m2 / (n - 1));
  let sharpeSe = null, sharpeLo = null, sharpeHi = null;
  if (sharpe != null && exSd > 0) {
    const g3 = (m3 / n) / exSd ** 3;
    const g4 = (m4 / n) / exSd ** 4;
    const srP = sharpe / Math.sqrt(PER);
    const v = (1 - g3 * srP + ((g4 - 1) / 4) * srP ** 2) / (n - 1);
    if (v > 0) {
      sharpeSe = Math.sqrt(v) * Math.sqrt(PER);
      sharpeLo = sharpe - 1.96 * sharpeSe;
      sharpeHi = sharpe + 1.96 * sharpeSe;
    }
  }
  const rfAnn = meanRf ? meanRf * PER : null;

  let peak = eq[0], maxDD = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? e / peak - 1 : 0;
    if (dd < maxDD) maxDD = dd;
  }

  // Beta vs the chosen benchmark, if its column is present (benchmark equity =
  // notional + that column's dollars).
  //
  // Paired session to session, not calendar day to calendar day, for the reason
  // spelled out over pfPairedReturns in Portfolio.jsx: `series` is calendar-daily
  // and the benchmark column is forward-filled raw closes, so a weekend or
  // holiday enters as a day the benchmark returned exactly 0 while the book —
  // polymarket trades every day — did not. Those days add variance to the book's
  // leg without adding covariance, so they drag beta and deflate r2. The pull is
  // mild on a book this uncorrelated (QTD beta 0.13 -> 0.15, r2 unmoved at 0.03)
  // and would grow with the correlation.
  //
  // A day the column did not move is a day the benchmark did not trade; genuinely
  // flat closes do not occur at four decimals. The first confirmed session only
  // seeds `prev` — its own left endpoint is unverifiable — so this gives up one
  // pair to keep every pair it does emit spanning the same days on both legs.
  let beta = null, r2 = null;
  if (series[0][benchKey] != null) {
    const beq = series.map(p => notional + (p[benchKey] || 0));
    const a = [], b = [];
    let prev = -1;
    for (let i = 1; i < eq.length; i++) {
      if (beq[i] === beq[i - 1]) continue;             // benchmark did not trade
      if (prev >= 0 && eq[prev] > 0 && beq[prev] > 0) {
        a.push(eq[i] / eq[prev] - 1);
        b.push(beq[i] / beq[prev] - 1);
      }
      prev = i;
    }
    const m = a.length;
    if (m >= 20) {
      const ma = a.reduce((x, y) => x + y, 0) / m, mb = b.reduce((x, y) => x + y, 0) / m;
      let cov = 0, vb = 0, va = 0;
      for (let i = 0; i < m; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; vb += db * db; va += da * da; }
      if (vb > 0 && va > 0) { beta = cov / vb; r2 = (cov * cov) / (vb * va); }
    }
  }
  return { sharpe, sortino, vol, downside, sharpeSe, sharpeLo, sharpeHi,
    maxDD, beta, r2, rf: rfAnn };
}

// ---------- cross-book correlation: does polymarket diversify ibkr? ----------
// Deliberately NOT computed off data.series. That series is calendar-daily
// (cmbSampleDaily forward-fills), so weekends enter as a flat IBKR day against a
// live Polymarket one — a run of (0, x) pairs that drags any correlation toward
// zero and understates IBKR vol. This walks IBKR's real sessions instead and
// compounds Polymarket's P&L across each non-trading gap into the next session,
// so both legs always describe the same calendar span.
//
// Both legs are flow-adjusted, which is the whole game here: IBKR comes off
// cumulative TWR (`t`), so deposits and IBKR→Polymarket transfers are not
// performance, and Polymarket is d(user-pnl)/NAV rather than d(NAV) — its NAV
// went $3k → $241k over this window almost entirely on transfers.
//
// Scope is deliberately narrow: the correlation and its rolling track, nothing
// else. This briefly also carried combined vol/Sharpe and a diversification
// decomposition; both restated what the risk panel above already owns, and
// having a second Sharpe on the page — on a different grid, window and
// annualization — cost more in confusion than it paid in insight. The value
// here is drift detection, not a competing performance number.
const CMB_CORR_ROLL = 60;

function cmbCorrPearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return (va > 0 && vb > 0) ? cov / Math.sqrt(va * vb) : null;
}

function cmbCorrelation(pnlHistory, pmPts, pmNavHistory) {
  const hist = ((pnlHistory && pnlHistory.rows) || []).filter(r => r && r.d && r.t != null);
  const navRows = ((pmNavHistory && pmNavHistory.rows) || []).filter(r => r && r.d && r.nav != null);
  if (hist.length < 30 || navRows.length < 30) return null;

  // IBKR sessions → daily TWR return.
  const ibDays = [], ibRet = new Map();
  for (let i = 1; i < hist.length; i++) {
    const prev = 1 + hist[i - 1].t, cur = 1 + hist[i].t;
    if (prev <= 0) continue;
    ibRet.set(hist[i].d, cur / prev - 1);
    ibDays.push(hist[i].d);
  }
  ibDays.sort();

  // Polymarket's cumulative curve exactly as the rest of the view has it: already
  // on the close-of-day convention, and already walked off book value past the
  // seam (cmbPmPoints). This used to take the raw feed rows and redo the date
  // shift itself, which left the risk block on the one series the seam exists to
  // stop trusting — a mis-marked conversion enters here as a single +8% session
  // and then sits in the 60-day window for two months.
  const pmCum = new Map();
  for (const r of (pmPts || [])) {
    if (!r || r.day == null || r.v == null) continue;
    pmCum.set(cmbFromEpochDay(r.day), r.v);   // last wins within a day
  }
  const pmDays = [...pmCum.keys()].sort();
  if (pmDays.length < 30) return null;
  const pmDelta = [];
  for (let i = 1; i < pmDays.length; i++) {
    pmDelta.push({ d: pmDays[i], v: pmCum.get(pmDays[i]) - pmCum.get(pmDays[i - 1]) });
  }

  // pmNavHistory rows are already restated by the loader, so read `d` at face value.
  const pmNav = new Map();
  for (const r of navRows) pmNav.set(r.d, r.nav);

  // Pair up: for each IBKR session, Polymarket's P&L since the previous one.
  const rows = [];
  let ptr = 0, prev = null;
  for (const d of ibDays) {
    if (prev === null) { prev = d; continue; }
    while (ptr < pmDelta.length && pmDelta[ptr].d <= prev) ptr++;
    let dollars = 0, seen = 0, scan = ptr;
    while (scan < pmDelta.length && pmDelta[scan].d <= d) { dollars += pmDelta[scan].v; seen++; scan++; }
    const base = pmNav.get(prev);
    if (seen && base > 0) rows.push({ d, ib: ibRet.get(d), pm: dollars / base });
    prev = d;
  }
  if (rows.length < 40) return null;

  const ib = rows.map(r => r.ib), pm = rows.map(r => r.pm);
  const n = rows.length;
  const r = cmbCorrPearson(ib, pm);
  if (r == null) return null;

  const roll = [];
  for (let i = CMB_CORR_ROLL; i <= n; i++) {
    const v = cmbCorrPearson(ib.slice(i - CMB_CORR_ROLL, i), pm.slice(i - CMB_CORR_ROLL, i));
    if (v != null) roll.push({ d: rows[i - 1].d, v });
  }

  return { r, roll };
}

// ---------- adapters onto the shared risk panels (window.SZ_RISK) ----------
// Portfolio.jsx owns the distribution / rolling / capture / drawdown-episode
// panels and expects a perfSeries: { d, v } with v a cumulative return *ratio*.
// The book view carries cumulative *dollars* against a notional instead, so
// convert rather than reimplement — equity is notional + v, and rebasing the
// equity curve leaves daily returns unchanged.
function cmbPerfSeries(series, notional) {
  if (!series || series.length < 2 || !notional || notional <= 0) return null;
  return series.map(p => ({ d: p.d, v: (notional + (p.v || 0)) / notional - 1 }));
}

// The benchmark goes in as raw closes (data.benchmarks[primary].series) rather
// than its windowed dollar column. rebaseBenchmark() rebases whatever it is
// given to the first date it is asked about, and the dollar column is only
// defined across the current window — feeding that to a full-series rolling
// lookback makes every pre-window day back-fill to a constant, i.e. a flat
// benchmark, and the regression at the window's left edge silently reads against
// a straight line. Raw closes span the whole history, so every lookback sees
// real returns. (The two are equivalent inside a window: notional + bench$ =
// notional*close/base, so consecutive ratios are identical.)

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
// measure the % decline from its running peak. Splined to match CmbChart.
function CmbDrawdownStrip({ series, notional, markers, cur, onPick }) {
  const F = CMB_DD_FRAME;
  const hv = useChartHover(F);
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

  // Deepest drawdown up to a fixed 0 — non-positive by construction, so the top
  // of the box is the running peak.
  const { x, y } = szScales(F, dd.length, min, 0);
  const line = smoothPath(dd.map((_, i) => x(i)), dd.map(p => y(p.v)));
  const area = szAreaPath(line, x(0), x(dd.length - 1), y(0));
  const hovered = hv.i != null ? dd[hv.i] : null;

  return (
    <>
      <SzStripHead label="underwater · drawdown from peak"
        meta={`max ${pct(maxDD)} · now ${pct(curDD)}`}/>
      <div className="pm-chart-wrap">
        <SzChartSvg frame={F} hover={hv} n={dd.length}>
          <SzChartDefs ramp="dd" id="cmb-dd"/>
          <SzRule frame={F} y={y(0)}/>
          <path d={area} fill="url(#cmb-dd-fill)"/>
          <path d={line} fill="none" stroke="url(#cmb-dd-stroke)" strokeWidth="1.35"/>
          {(markers || []).map((m, k) => m.i < dd.length && (
            <CmbAnnotDot key={k} cx={x(m.i)} cy={y(dd[m.i].v)}
              active={cur && cur.i === m.i} onClick={onPick ? () => onPick(m) : undefined}/>
          ))}
          {hovered && (
            <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)}
              fill="#ff6ec4" ring="#f5f0ff"/>
          )}
        </SzChartSvg>
        {hovered && (
          <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)} className="cmb-tooltip">
            <div className="pm-tt-date">{cmbFullDate(hovered.d)}</div>
            <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{pct(hovered.v)}</div>
          </SzTooltip>
        )}
      </div>
    </>
  );
}

// ---------- rolling cross-book correlation strip ----------
// Fixed ±0.5 floor on the domain. Auto-scaling to the data would zoom a series
// that lives inside ±0.2 into a mountain range and make noise read as regime
// change — the honest picture here is a line sitting on zero, so the axis has to
// stay wide enough to show that. Domain only grows if the data leaves the floor.
// Single neutral line, no pos/neg tinting: low correlation is the *good* outcome
// here, and the site's green/pink polarity would say the opposite.
function CmbCorrStrip({ roll }) {
  const F = CMB_CORR_FRAME;
  const hv = useChartHover(F);
  if (!roll || roll.length < 2) return null;

  const peak = Math.max(0.5, ...roll.map(p => Math.abs(p.v)));
  const dom = Math.min(1, Math.ceil(peak * 4) / 4);
  // Fixed symmetric band rather than szDomain's data-fitted one — see the note
  // above: the honest picture is a line sitting on zero, and an auto-scaled axis
  // would zoom that into a mountain range.
  const { x, y } = szScales(F, roll.length, -dom, dom);
  const line = smoothPath(roll.map((_, i) => x(i)), roll.map(p => y(p.v)));
  // Filled to the zero line rather than the floor: this series crosses zero, so
  // an area anchored at the bottom would read as a level when it is a deviation.
  const area = szAreaPath(line, x(0), x(roll.length - 1), y(0));
  const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  const hovered = hv.i != null ? roll[hv.i] : null;

  return (
    <>
      <SzStripHead
        label={`ibkr ↔ polymarket · rolling ${CMB_CORR_ROLL}-session correlation`}
        meta={`band ±${dom.toFixed(2)} · now ${fmt(roll[roll.length - 1].v)}`}/>
      <div className="pm-chart-wrap">
        <SzChartSvg frame={F} hover={hv} n={roll.length}>
          {/* The 'corr' ramp runs left→right — see SZ_GRADIENTS. This series
              lives inside ±0.2 of a ±0.5 band, so a value-keyed vertical ramp
              compressed the whole pink→violet range into ~13px and read as one
              flat tone; worse, it painted *higher* correlation pink, the worse
              outcome here and the inverse of what pink means on the P&L charts.
              Keyed to time instead, it makes no claim at all. */}
          <SzChartDefs ramp="corr" id="cmb-corr"/>
          {/* ±0.25 guides, so the eye can judge how flat "flat" is */}
          {[dom / 2, -dom / 2].map((g, k) => (
            <SzRule key={k} frame={F} y={y(g)} stroke="rgba(229,225,241,0.07)"/>
          ))}
          <path d={area} fill="url(#cmb-corr-fill)"/>
          <SzRule frame={F} y={y(0)} stroke="rgba(229,225,241,0.12)"/>
          <path d={line} fill="none" stroke="url(#cmb-corr-stroke)" strokeWidth="1.4"
            strokeLinejoin="round" strokeLinecap="round"/>
          {hovered && (
            <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)}
              fill={CMB_C_TOTAL} ring="#f5f0ff"/>
          )}
        </SzChartSvg>
        {hovered && (
          <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)} className="cmb-tooltip">
            <div className="pm-tt-date">{cmbFullDate(hovered.d)}</div>
            <div className="pm-tt-val">{fmt(hovered.v)}</div>
          </SzTooltip>
        )}
      </div>
    </>
  );
}

// ---------- range windowing ----------
const CMB_RANGES = ['1M', '3M', 'QTD', '6M', 'YTD', '1Y', 'MAX'];
const CMB_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', 'QTD': 'qtd', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo', 'MAX': 'max' };

// Windowing is shared with the polymarket view (Chrome.jsx) so a range picked
// here spans exactly the days it spans there.
const cmbRangeEnd = (range) => window.szRangeEnd(range);
const cmbRangeCutoff = (range, last) => window.szRangeCutoff(range, last);

function cmbRangeLabel(range) {
  return CMB_RANGE_LABEL[range] || (window.szQuarterLabel && window.szQuarterLabel(range)) || range;
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
// (v/ibkr/pm) to the window start. Benchmark lines are *rebuilt* from raw closes
// on the window-start equity, so they track the selected timeframe rather than
// the 1y-ago capital/base. Returns the window-start equity as `notional`, which
// also keeps the drawdown strip's % correct for the sub-window.
//
// `benchKeys` is what the picker has selected, plus the primary if the reader
// cleared the selection — the alpha strip, beta and monthly bars read a column
// off this series, so the primary's column has to exist even when no benchmark
// line is drawn.
function cmbWindow(series, notional, range, benchmarks, benchKeys) {
  if (!series || series.length < 2) return { series, notional };
  const last = series[series.length - 1].d;
  const cutoff = cmbRangeCutoff(range, last);
  // Calendar ranges rebase on the close BEFORE the period opens; trailing ones on
  // the cutoff day itself. See szRangeBaseIndex. Note this also moves `s0` and so
  // winNotional below: the window's capital base becomes the capital the period
  // actually opened with, rather than the capital after its first day. That is
  // the correct denominator — a deposit landing on day one of a quarter should
  // not be in the base the quarter's return is measured against — and it is the
  // same rule start_nav() applies in fetch-ibkr.py. On the current data it moves
  // qtd by 0.079% and ytd by -0.012%.
  let i = window.szRangeBaseIndex(series.map(p => p.d), range, cutoff);
  if (i > series.length - 2) i = series.length - 2;
  // Closed windows (a completed quarter) also stop early; trailing ranges run
  // to the last point. Keep at least two points so every downstream chart and
  // stat still has a series to work with.
  const endCut = cmbRangeEnd(range);
  let j = series.length - 1;
  if (endCut) {
    const over = series.findIndex(p => p.d > endCut);
    if (over > 0) j = over - 1;
  }
  if (j < i + 1) j = Math.min(series.length - 1, i + 1);
  const s0 = series[i];
  // The window's own capital base, carried per-point from real NAV. The old
  // `notional + s0.v` reconstructed it from cumulative P&L, which silently
  // added back every deposit and transfer since the series began.
  const winNotional = s0.base != null ? s0.base : (notional || 0) + (s0.v || 0);
  const out = series.slice(i, j + 1).map(p => {
    const q = { d: p.d };
    for (const k of ['v', 'ibkr', 'pm']) if (p[k] != null) q[k] = +(p[k] - s0[k]).toFixed(2);
    // Levels ride through unrebased, like `base` and for the same reason: these
    // are quantities of capital, not P&L streams, and a capital base rebased to
    // zero at the window start would say the account was empty that morning.
    for (const k of ['base', 'ibkrLevel', 'pmLevel']) if (p[k] != null) q[k] = p[k];
    return q;
  });
  const dates = out.map(p => p.d);
  for (const key of (benchKeys && benchKeys.length ? benchKeys : ['spx'])) {
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

// ---------- combined rolling alpha strip (total $ minus the benchmark's $, zero-centered) ----------
function CmbAlphaStrip({ series, markers, cur, onPick, unit, benchKey = 'spx' }) {
  const F = CMB_STRIP_FRAME;
  const hv = useChartHover(F);
  const pct = unit === 'pct';
  const fmt = (v) => cmbFmt(v, unit);
  if (!series || series.length < 2 || series[0][benchKey] == null) return null;
  // In percent both terms are already returns, so the subtraction is in
  // percentage points and needs no rounding to cents.
  const alpha = series.map(p => ({
    d: p.d,
    v: pct ? p.v - (p[benchKey] || 0) : +(p.v - (p[benchKey] || 0)).toFixed(2),
  }));
  const last = alpha[alpha.length - 1].v;
  // Anchored both ways so the zero line stays drawn even on a window spent
  // entirely behind the benchmark.
  const { y0, y1 } = szDomain(alpha.map(p => p.v),
    { pad: 0.12, floor: pct ? 0.01 : 1, min: 0, max: 0 });
  const { x, y } = szScales(F, alpha.length, y0, y1);
  const line = smoothPath(alpha.map((_, i) => x(i)), alpha.map(p => y(p.v)));
  const zeroY = y(0);
  const area = szAreaPath(line, x(0), x(alpha.length - 1), zeroY);
  const hovered = hv.i != null ? alpha[hv.i] : null;

  return (
    <>
      <SzStripHead label={`alpha vs ${cmbBenchLabel(benchKey)} · cumulative`}
        meta={`now ${fmt(last)}`}/>
      <div className="pm-chart-wrap">
        <SzChartSvg frame={F} hover={hv} n={alpha.length}>
          <SzChartDefs ramp="alpha" id="cmb-alpha"/>
          <SzRule frame={F} y={zeroY}/>
          <path d={area} fill="url(#cmb-alpha-fill)"/>
          <path d={line} fill="none" stroke="url(#cmb-alpha-stroke)" strokeWidth="1.35"/>
          {(markers || []).map((m, k) => m.i < alpha.length && (
            <CmbAnnotDot key={k} cx={x(m.i)} cy={y(alpha[m.i].v)}
              active={cur && cur.i === m.i} onClick={onPick ? () => onPick(m) : undefined}/>
          ))}
          {hovered && (
            <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)}
              fill="#60a5fa" ring="#f5f0ff"/>
          )}
        </SzChartSvg>
        {hovered && (
          <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)} className="cmb-tooltip">
            <div className="pm-tt-date">{cmbFullDate(hovered.d)}</div>
            <div className={`pm-tt-val ${hovered.v < 0 ? 'neg' : 'pos'}`}>{fmt(hovered.v)}</div>
          </SzTooltip>
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

// The days both halves of the base are measured, which is where the capital
// chart can honestly draw a split. Always a suffix of the window — pmLevel is
// null strictly before polymarket's nav history begins — so filtering leaves a
// contiguous series rather than a gapped one.
function cmbCapitalPoints(series) {
  return (series || []).filter(p => p.ibkrLevel != null && p.pmLevel != null);
}

// ---------- capital deployed over time ----------
// Where the money is, and when it moved. This replaced a tug-of-war bar that
// showed the same split as a single ratio for one day only: two ends, a flag,
// and a percentage that could not say whether the book had just moved $100k or
// had sat where it was all year. The curve answers both, and the last column
// answers what the bar did.
//
// Stacked, not two lines: the reading is a split of one pot, and stacking makes
// the total the top edge so the same picture carries the split and the size of
// the book without a second chart. IBKR on the bottom because it is the account
// the money starts in and returns to.
//
// Levels, not P&L. Every other chart on this page rebases to zero at the window
// start; this one must not, because a capital base is a quantity whose zero is
// real — so the domain runs from a hard 0 rather than from the data's own floor,
// and a window where the book merely doubled does not read as a book that grew
// from nothing.
const CMB_CAP_FRAME = szFrame(160, 16, 28);

function CmbCapitalChart({ series, transfers }) {
  const F = CMB_CAP_FRAME;
  const hv = useChartHover(F);
  const pts = cmbCapitalPoints(series);
  if (pts.length < 2) return null;

  const ibkrVals = pts.map(p => p.ibkrLevel);
  const totals = pts.map(p => p.ibkrLevel + p.pmLevel);
  const hi = Math.max(...totals);
  const { x, y } = szScales(F, pts.length, 0, (hi * 1.08) || 1);

  // Straight segments, not the site's monotone spline. A transfer is a step —
  // $100k left one account and arrived in the other on one day — and a spline
  // rounds that corner into a slope the money never travelled down. The two
  // bands also share a boundary, so both edges are generated by one function:
  // a fill and a line drawn by different code eventually part company by a
  // subpixel and show a hairline of background between the bands.
  const lineOf = (vals) => vals
    .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const backOf = (vals) => {
    let out = '';
    for (let i = vals.length - 1; i >= 0; i--) out += ` L${x(i).toFixed(2)},${y(vals[i]).toFixed(2)}`;
    return out;
  };
  const ibkrLine = lineOf(ibkrVals);
  const totalLine = lineOf(totals);
  const last = pts.length - 1;
  const ibkrArea = `${ibkrLine} L${x(last).toFixed(2)},${y(0).toFixed(2)} L${x(0).toFixed(2)},${y(0).toFixed(2)} Z`;
  const pmArea = `${totalLine}${backOf(ibkrVals)} Z`;

  // A mark on the first plotted column has no before-state to point at: whatever
  // step it caused is off the left edge, so it reads as an event that did
  // nothing. Dropped rather than drawn — which is also what takes the ledger's
  // condensed opening entry off the chart, since the split is floored on its
  // date (see splitFloor).
  const marks = cmbTransferMarks(pts, transfers).filter(m => m.i > 0);
  const ticks = szTicks(pts, 6);
  const spanDays = cmbEpochDay(pts[last].d) - cmbEpochDay(pts[0].d);
  const axisMode = spanDays <= 95 ? 'day'
    : (pts[0].d.slice(0, 4) === pts[last].d.slice(0, 4) ? 'month' : 'monthyear');

  const hp = hv.i != null && hv.i < pts.length ? pts[hv.i] : null;
  const hpTotal = hp ? hp.ibkrLevel + hp.pmLevel : null;
  // A transfer is only called out when the cursor is on its own column. The tick
  // is already drawn; repeating the nearest one at every column would attach a
  // decision to days it wasn't made on.
  const hpXfer = hp ? marks.find(m => m.i === hv.i) : null;

  return (
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={pts.length} className="pf-navchart pm-chart-svg">
        {/* Venue colors, matching the bar below — violet is IBKR and pink is
            Polymarket here, not gain and loss. Flat fills for the same reason
            the bar drops its wash: this is a composition, so the reading comes
            from area, and a vertical ramp would make the taller band look like
            it was also worth more per pixel at the top. */}
        <path d={ibkrArea} fill={CMB_C_IBKR} opacity="0.26"/>
        <path d={pmArea} fill={CMB_C_PM} opacity="0.26"/>

        <path d={ibkrLine} fill="none" stroke={CMB_C_IBKR} strokeWidth="1.25"/>
        <path d={totalLine} fill="none" stroke={CMB_C_PM} strokeWidth="1.35"/>

        {/* Transfers, as the same diamond the log markers wear on the total
            chart — one event-marker shape on this page rather than two.
            Ridden on the top line, which is also where that chart puts them.
            The boundary underneath is arguably the truer spot — it is the line a
            transfer actually moves, and the total is unchanged by definition —
            but a mark there sits inside a filled band and has to fight the fill
            for contrast, while the same mark on the outer contour reads against
            the page. The step is legible either way; the marker only has to say
            which column to look at, and the tooltip carries the amount.
            Drawn over the lines rather than under them. Full-height rules came
            first and read as chart furniture — nine of them striped the plot and
            competed with the bands they were there to annotate. */}
        {marks.map((m, k) => {
          const my = y(totals[m.i]);
          return (
            <rect key={k} className="cmb-annot-sq" x={x(m.i) - 2.5} y={my - 2.5}
              width="5" height="5" transform={`rotate(45 ${x(m.i)} ${my})`}/>
          );
        })}

        {hp && (
          <SzCrosshair frame={F} x={x(hv.i)} cy={y(hpTotal)} fill={CMB_C_PM} ring="#0a0612"
            dots={[{ key: 'ibkr', cy: y(hp.ibkrLevel), fill: CMB_C_IBKR }]}/>
        )}
      </SzChartSvg>

      {/* The floor is a real zero, so it gets the marker every other baseline on
          the site gets rather than being left to look like a cropped axis. */}
      <SzAxisZero frame={F} y={y(0)}>$0</SzAxisZero>
      <SzAxisX frame={F} ticks={ticks} x={x} label={(t) => cmbAxisLabel(t.d, axisMode)}/>

      {hp && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(hpTotal)} className="cmb-tooltip">
          <div className="pm-tt-date">{cmbFullDate(hp.d)}</div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_IBKR }}/>ibkr<span className="cmb-tt-num">{cmbUSD(hp.ibkrLevel)}</span></div>
          <div className="cmb-tt-row"><span className="cmb-tt-dot" style={{ background: CMB_C_PM }}/>polymarket<span className="cmb-tt-num">{cmbUSD(hp.pmLevel)}</span></div>
          <div className="cmb-tt-row cmb-tt-sum">total<span className="cmb-tt-num">{cmbUSD(hpTotal)}</span></div>
          {hpXfer && (
            <div className="cmb-tt-xfer">moved {cmbUSDk(hpXfer.amount)} → polymarket</div>
          )}
        </SzTooltip>
      )}
    </div>
  );
}

// ---------- Monthly P&L, split by book ----------
// Each month's contribution per series = the change in that series' cumulative
// (deposit-adjusted) P&L between the month's last observation and the prior
// month's. `total` is the net of both books; `bench` is the chosen benchmark's
// dollar return on the same notional, present only when its overlay loaded.
// Grouped bars around a shared zero line so signs read directly.
function cmbMonthly(series, benchKey = 'spx') {
  if (!series || series.length < 2) return [];
  const end = new Map();                    // 'YYYY-MM' -> {ibkr, pm, bench}
  for (const p of series) end.set(p.d.slice(0, 7), { ibkr: p.ibkr || 0, pm: p.pm || 0, bench: p[benchKey] });
  const keys = [...end.keys()].sort();
  // The window's first point is its *base* — the day every stream is rebased
  // against — so its own bucket is zero by construction. When the next point is
  // already in a new month, that bucket holds nothing but the base and drew a
  // full-width empty column. Calendar windows always land here: they rebase on
  // the close BEFORE the period opens (see szRangeBaseIndex), so ytd led with an
  // empty "dec" and a picked quarter with the month before it. Drop it — `prev`
  // below still starts from that base, so the first real month is unchanged.
  const baseYm = series[0].d.slice(0, 7);
  if (keys[0] === baseYm && series[1].d.slice(0, 7) !== baseYm) keys.shift();
  const out = [];
  let prev = { ibkr: series[0].ibkr || 0, pm: series[0].pm || 0, bench: series[0][benchKey] };
  for (const k of keys) {
    const e = end.get(k);
    const row = { ym: k, ibkr: e.ibkr - prev.ibkr, pm: e.pm - prev.pm };
    row.total = row.ibkr + row.pm;
    if (e.bench != null && prev.bench != null) row.bench = e.bench - prev.bench;
    out.push(row);
    prev = e;
  }
  return out;
}

// Outlined columns: 1px stroke over a 0.13 fill, square corners. Everything
// else on the page draws data as a hairline (1px @ 0.3 on the nav chart) or a
// translucent gradient, so an opaque saturated rect with rx="1" — a radius a
// quarter of the bar's width — read as extruded gel next to it. The fill is
// what carries visual weight; keeping it at 0.13 is what lets three columns
// per month stay lighter than the two solid ones this replaced.
//
// The benchmark sits BETWEEN the books, not after them: each book is then
// adjacent to the thing it's judged against. `total` isn't drawn at all — it's
// the sum of the two books, so as a third bar it was the answer printed beside
// its own working, and it set the vertical scale while adding nothing. It lives
// in the hover tooltip instead.
const cmbBarMeta = (benchKey) => [
  { key: 'ibkr',  label: 'ibkr',                    color: CMB_C_IBKR },
  { key: 'bench', label: cmbBenchLabel(benchKey),   color: cmbBenchColor(benchKey) },
  { key: 'pm',    label: 'polymarket',              color: CMB_C_PM },
];

function CmbMonthlyBars({ series, unit, benchKey = 'spx' }) {
  const svgRef = useCmbRef(null);
  const [hover, setHover] = useCmbState(null);
  // In percent the series carries additive contributions, so differencing month
  // ends still gives columns that sum to the window's total return — the same
  // arithmetic that works on cumulative dollars.
  const fmt = (v) => cmbFmt(v, unit);
  const months = cmbMonthly(series, benchKey);
  if (months.length < 2) return null;
  const hasBench = months.some(m => m.bench != null);
  const bars = cmbBarMeta(benchKey).filter(b => b.key !== 'bench' || hasBench);
  const nb = bars.length;
  const F = CMB_BARS_FRAME;
  const { W, H, PAD_L, PAD_R, PAD_T, PAD_B } = F;

  // Fit the range to what's actually drawn rather than pinning zero to the
  // vertical center with a symmetric ±maxAbs. The books are lopsided (a
  // trailing year runs roughly -43k..+79k), so forced symmetry left a third of
  // the plot permanently empty and shortened every column to pay for it.
  const vals = months.flatMap(m => bars.map(b => m[b.key]).filter(v => v != null));
  const { y0, y1 } = szDomain(vals, { pad: 0.08, floor: 1, min: 0, max: 0 });
  // Columns sit in slots rather than on coordinates, so only the y scale comes
  // from the shared pair — x is built from `slot` below.
  const { y } = szScales(F, months.length, y0, y1);
  const zeroY = y(0);

  const slot = (W - PAD_L - PAD_R) / months.length;
  const step = Math.max(6, Math.min(11, (slot * 0.62) / nb));
  const bw = Math.max(3, Math.min(9, step * 0.8));
  const cx = (i) => PAD_L + slot * (i + 0.5);
  const barX = (i, j) => cx(i) + (j - (nb - 1) / 2) * step;

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
        <SzRule frame={F} y={zeroY}/>

        {/* Faint rule at each year boundary — a bare run of month abbreviations
            with two januaries in view can't say which year it's in. */}
        {months.map((m, i) => (i > 0 && m.ym.slice(5, 7) === '01') && (
          <line key={`yr-${m.ym}`} x1={(cx(i) + cx(i - 1)) / 2} x2={(cx(i) + cx(i - 1)) / 2}
            y1={PAD_T - 6} y2={H - PAD_B + 2} stroke="rgba(229,225,241,0.10)"/>
        ))}

        {hover != null && (
          <rect x={cx(hover) - slot / 2} y={PAD_T - 8} width={slot} height={H - PAD_T - PAD_B + 12}
            fill={CMB_C_IBKR} opacity="0.07"/>
        )}

        {months.map((m, i) => (
          <g key={m.ym} opacity={hover == null || hover === i ? 1 : 0.35}>
            {bars.map((b, j) => {
              const v = m[b.key];
              if (v == null || v === 0) return null;
              const x = barX(i, j), yv = y(v);
              const h = Math.abs(yv - zeroY);
              // Sub-pixel months keep their cap on the zero line instead of
              // vanishing or being floored to a fake minimum height — an
              // outline can lose its body and still read as itself. (The old
              // Math.max(0.5, …) drew these as a half-pixel fuzz along the
              // axis that looked like rendering dirt.)
              if (h < 0.6) return (
                <line key={b.key} x1={x - bw / 2} x2={x + bw / 2} y1={zeroY} y2={zeroY}
                  stroke={b.color} strokeWidth="1" strokeOpacity="0.5"/>
              );
              return (
                <rect key={b.key}
                  x={x - bw / 2} y={Math.min(zeroY, yv)} width={bw} height={h}
                  fill={b.color} fillOpacity="0.13"
                  stroke={b.color} strokeWidth="1" strokeOpacity="0.8"
                  shapeRendering="crispEdges"/>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="pf-axis-x">
        {months.map((m, i) => (
          <span key={m.ym} style={{ left: `${(cx(i) / W) * 100}%` }}>
            {m.ym.slice(5, 7) === '01' ? `${mLabel(m.ym)} ${m.ym.slice(2, 4)}` : mLabel(m.ym)}
          </span>
        ))}
      </div>
      {hovered && (
        <SzTooltip frame={F} x={cx(hover)} top="6%">
          <div className="pm-tt-date">{hovered.ym}</div>
          {/* Rows follow the on-chart column order so the tooltip reads left
              to right the same way the marks do. */}
          <div className="pf-tt-bench" style={{ color: CMB_C_IBKR }}>ibkr {fmt(hovered.ibkr)}</div>
          {hovered.bench != null && (
            <div className="pf-tt-bench" style={{ color: cmbBenchColor(benchKey) }}>
              {cmbBenchLabel(benchKey)} {fmt(hovered.bench)}
            </div>
          )}
          <div className="pf-tt-bench" style={{ color: CMB_C_PM }}>poly {fmt(hovered.pm)}</div>
          <div className={`pm-tt-val ${hovered.total >= 0 ? 'pos' : 'neg'}`}>total {fmt(hovered.total)}</div>
        </SzTooltip>
      )}
    </div>
    <div className="pf-bench-legend">
      {bars.map(b => (
        <span key={b.key}>
          <i className="pf-bench-swatch" style={{ background: b.color }}/>{b.label}
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
  // '$' or '%' for every P&L figure on the page. Percent by default, matching
  // the ibkr view: a return on a stated capital base is the comparable figure,
  // and it is the one that reads against the benchmark lines drawn beside it.
  // Dollars are one click away, and stay chosen — the same stored preference
  // the ibkr tab reads, since it is the same switch in the same nav.
  const [unit, setUnit] = window.useKeptState(
    window.SZ_UNIT_PREF, 'pct', window.SZ_UNIT_VALUES);
  // What the book is drawn against — same control and same default as the ibkr
  // tab, kept per-view rather than shared so the two pages can be read side by
  // side against different benchmarks.
  const [benchKeys, setBenchKeys] = useCmbState(window.SZ_BENCH_DEFAULT || ['spx']);

  useCmbEffect(() => {
    let canceled = false;
    async function load() {
      // Every feed below is independent, so they all go out on the same tick.
      // This used to be a sequential await-chain: ten round trips end to end,
      // which on a slow link is most of the time spent on "merging feeds".
      // Only the two genuine fallbacks (live pnl, clob rewards) stay lazy —
      // they fire only when their primary comes back empty.
      const pPromise    = window.szJson('data/portfolio.json');
      const pnlSnapP    = cmbGetJson('data/polymarket-pnl.json');
      const contentP    = cmbGetJson('data/content.json');
      const benchP      = cmbGetJson('data/benchmarks.json');
      const rfP         = cmbGetJson('data/riskfree.json');
      const pmNavP      = cmbGetJson('data/polymarket-nav-history.json');
      const navHistP    = cmbGetJson('data/nav-history.json');
      const breakdownP  = cmbGetJson('data/polymarket-breakdown.json');
      const bdHistP     = cmbGetJson('data/polymarket-breakdown-history.json');

      const portfolio = await pPromise;

      // Polymarket: the daily snapshot, and the live API per wallet (summed) only
      // when that is missing. It used to be the other way round, and the live
      // call was nearly all of the wait on "merging feeds": user-pnl-api computes
      // the series cold, 2-8s a wallet on a first call, while every file above
      // lands in one same-origin round trip. None of what it added over the
      // snapshot survived the build, either — cmbPmPoints hands the rows to
      // szPmBookExtend, which drops every point past SZ_PM_BOOK_SEAM and walks
      // the tail off the breakdown history, so the only rows this page reads
      // are settled ones the snapshot already holds. Checked 2026-09-11: the
      // same series from either source, `corr` equal to 15 places (the snapshot
      // rounds to 3dp, the live sum carries float noise).
      let pmRows = [];
      const snap = await pnlSnapP;
      if (snap) pmRows = snap.rows || [];
      if (!pmRows.length) {
        // All-or-nothing: `null` for a wallet whose call failed, and one null
        // discards the lot. Summing a failed wallet as zero silently drops its
        // entire book out of the polymarket curve — the two wallets currently
        // sit at roughly -$34k and +$34k, so either one going missing moves the
        // combined line by tens of thousands of dollars and nothing on the page
        // says the feed was short. The budget is sized for the cold path, as on
        // the polymarket view: a cold call has been measured at 7.8s.
        const pmLists = await Promise.all(
          CMB_WALLETS.map(w =>
            fetch(cmbPnlUrl(w), { signal: AbortSignal.timeout(25000) })
              .then(r => r.ok ? r.json() : null)
              .then(j => Array.isArray(j) ? j : null)
              .catch(() => null)
          )
        );
        if (!pmLists.some(l => l == null)) pmRows = cmbSumPnlSeries(pmLists);
      }

      // Dated log entries → chart annotations; pmTransfers is the manually
      // maintained ledger of IBKR→Polymarket moves (used for the benchmark notional).
      const content = await contentP;
      const log = (content && content.home && content.home.log) || [];
      const pmTransfers = (content && content.pmTransfers) || [];

      // Fed funds, for the Sharpe on the risk panel. Best-effort like the rest:
      // missing, the tile falls back to rf 0 and its note says so. Awaited ahead
      // of the benchmarks now because it is also one of them — both requests
      // went out on the same tick above, so the order costs nothing.
      const rfj = await rfP;
      const rfRows = (rfj && rfj.series && rfj.series.length) ? rfj.series : null;

      // Benchmark overlay is best-effort; the chart renders fine without it.
      // szWithCash folds the rate series in as a drawable line, so this page's
      // picker and the ibkr page's offer the same list.
      const bj = await benchP;
      const benchmarks = window.szWithCash((bj && bj.benchmarks) || null, rfRows);

      // Accumulated multi-year P&L history (best-effort). Extends the IBKR curve
      // before the Flex window so the MAX range keeps charting aged-out markers.
      // Daily Polymarket NAV back to the first transfer — recorded where it
      // exists, reconstructed before that. Lets the capital base value the
      // Polymarket side at what it is worth rather than what was sent to it
      // (see pmCapitalAt).
      // Its rows ride the same ~08:45 UTC betmoar scrape, so they get the same
      // date restatement as the breakdown history. nav-history.json below is IBKR
      // and already on close-of-day — it is left alone.
      const navJson = await pmNavP;
      const pmNavHistory = navJson
        ? { ...navJson, rows: window.szPmDateSnapshotRows(navJson.rows) }
        : null;

      const pnlHistory = await navHistP;

      const breakdown = await breakdownP;
      const bd = await cmbBdExtra(breakdown, await bdHistP);  // { total, rows } — lifetime net + dated history

      const built = cmbBuild(portfolio, pmRows, bd, benchmarks, pmTransfers, pnlHistory, pmNavHistory);
      built.log = log;
      built.benchmarks = benchmarks;  // raw closes, for rebuilding benchmark $ per range
      built.rf = rfRows;              // EFFR rows, for the windowed Sharpe
      return built;
    }
    load()
      .then(d => { if (!canceled) setData(d); })
      .catch(e => { if (!canceled) setErr(String(e.message || e)); });
    return () => { canceled = true; };
  }, []);

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ book</div>
      <h2 className="sz-h2">couldn't build book feed.</h2>
      <p><code>{err}</code></p>
      <p className="sz-dim">needs <code>data/portfolio.json</code> (daily IBKR cron). polymarket reads <code>data/polymarket-pnl.json</code>, live if that is missing.</p>
    </section>
  );
  if (!data) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ book · live</div>
      <h2 className="sz-h2">merging feeds<Cursor /></h2>
    </section>
  );

  const go = (v) => setView ? () => setView(v) : undefined;
  const pct1 = (v) => (v * 100).toFixed(1) + '%';
  // The benchmark every "vs" figure on this page is measured against: first
  // selected, spx when the selection is empty. Its dollar column has to exist on
  // the windowed series even if no line is drawn for it, hence benchCols.
  const primary = window.szBenchPrimary ? window.szBenchPrimary(benchKeys) : 'spx';
  const primaryName = cmbBenchLabel(primary);
  const benchCols = benchKeys.length ? benchKeys : [primary];
  // Range selector windows the chart, its strips, AND the risk panel.
  const win = cmbWindow(data.series, data.benchNotional, range, data.benchmarks, benchCols);
  // Completed quarters the combined series actually covers end to end.
  const quarters = (window.szQuarters && data.series.length)
    ? window.szQuarters(data.series[0].d, data.series[data.series.length - 1].d)
    : [];
  const HistoryPicker = window.HistoryPicker;
  const BenchPicker = window.BenchPicker;
  const risk = cmbRisk(win.series, win.notional, primary, data.rf);
  // Shared risk panels, on the combined equity curve. The book view samples every
  // calendar day (prediction markets trade weekends), so vol annualizes on 365.
  const SZ = window.SZ_RISK || {};
  const cPerf = cmbPerfSeries(win.series, win.notional);
  const cFullPerf = cmbPerfSeries(data.series, data.benchNotional);
  const cBench = (data.benchmarks && data.benchmarks[primary] && data.benchmarks[primary].series) || null;
  const cCapture = (cPerf && cBench && SZ.pfCapture) ? SZ.pfCapture(cPerf, cBench) : null;
  const cEpisodes = (cPerf && SZ.pfDrawdownEpisodes) ? SZ.pfDrawdownEpisodes(cPerf) : [];
  // The same table the ibkr tab draws, on the combined equity curve. cPerf is
  // already in that file's perfSeries shape, which is why the panel is shared
  // rather than rebuilt: two implementations of "the book against ten indices"
  // would eventually disagree about one of them.
  const cBenchRows = (cPerf && data.benchmarks && SZ.pfBenchTable)
    ? SZ.pfBenchTable(cPerf, data.benchmarks) : [];
  // Normalized through szBenchSort exactly as BenchPicker does, so a row click
  // here and a tick in the menu produce one selection and `primary` cannot read
  // two different first-entries off the same set.
  const toggleBench = (key) => setBenchKeys(prev => {
    const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
    return window.szBenchSort ? window.szBenchSort(next) : next;
  });
  // Endpoint of the rebased window = each stream's P&L over the selected range,
  // so the headline + summary tiles track the timeframe on the chart.
  const wLast = (win.series && win.series.length) ? win.series[win.series.length - 1] : { v: 0, ibkr: 0, pm: 0 };
  const wTotal = wLast.v || 0, wIbkr = wLast.ibkr || 0, wPm = wLast.pm || 0;
  const wBenchD = wLast[primary] != null ? +(wLast.v - wLast[primary]).toFixed(2) : null;
  const wBenchPts = (wBenchD != null && win.notional) ? (wBenchD / win.notional) * 100 : null;
  // Only selections that actually produced a column get a line: a key the feed
  // is missing would otherwise plot as a path of NaNs.
  const drawnBench = (win.series && win.series.length)
    ? benchKeys.filter(k => win.series[0][k] != null).map(k => ({ key: k }))
    : [];
  const pos = wTotal >= 0;
  const rangeSub = range === '1Y' ? 'trailing 12mo' : cmbRangeLabel(range);
  const rangeNote = data.bdExtra ? `${cmbRangeLabel(range)} · trading + rewards` : `${cmbRangeLabel(range)} trading`;
  // Percent is a chained TWR on the real per-day capital base — the same
  // construction the ibkr and polymarket views use, so a return means one thing
  // across all three pages.
  const pctSeries = cmbPctSeries(win.series, win.notional, benchCols);
  const pct = unit === 'pct' && !!pctSeries;
  const shown = pct ? pctSeries : win.series;
  const sLast = (shown && shown.length) ? shown[shown.length - 1] : { v: 0, ibkr: 0, pm: 0 };
  const fmt = (v) => cmbFmt(v, pct ? 'pct' : 'usd');
  // Tone follows the figure actually printed. In percent a book carries its
  // compounding-weighted contribution, which can end the window on the far side
  // of zero from its dollars — a leg down early on a large base and up later on
  // a small one nets negative in cash while contributing a positive return.
  // Coloring off the dollars there painted a +0.05% tile red.
  const tone = (v) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');
  const vIbkr = pct ? sLast.ibkr : wIbkr;
  const vPm = pct ? sLast.pm : wPm;
  const vBench = pct ? (wBenchD == null ? null : sLast.v - (sLast[primary] || 0)) : wBenchD;
  const UnitBar = window.UnitBar;
  // Lifetime, not windowed: it labels the ledger the ticks come from, and a sum
  // that shrank when the reader picked 1M would look like money coming back.
  const xferTotal = (data.transfers || []).reduce((sum, t) => sum + ((t && t.amount) || 0), 0);
  // The capital chart spans only the days the split is measured, which on any
  // window reaching back past 2026-01-09 is a suffix of the range every other
  // panel draws. Said in the meta rather than left for the reader to notice
  // that one x-axis on the page starts somewhere else.
  const capPts = cmbCapitalPoints(win.series);
  const capFrom = (capPts.length > 1 && win.series.length && capPts[0].d !== win.series[0].d)
    ? capPts[0].d : null;

  return (
    <section className="pf-wrap cmb-view">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ book · ibkr + polymarket</div>
          <h2 className="sz-h2 pm-headline">
            <span>{pct ? cmbPctFmt(sLast.v) : `${pos ? '+' : ''}${cmbUSD(wTotal)}`}</span>
            <span className="pf-currency">{range === '1Y' ? 'trailing 12mo pnl' : `${cmbRangeLabel(range)} pnl`}</span>
          </h2>
          <div className="pf-sub">
            deposit-adjusted brokerage + prediction-market trading{data.bdExtra ? ' + rewards' : ''}, {rangeSub}
            {!data.pmAvailable && <span> <span className="sz-sep">·</span> polymarket unavailable, showing ibkr only</span>}
          </div>
        </div>
        {/* Draws in the nav, not here — the risk grid and monthly bars this
            governs sit well below the fold. There is no single denominator to
            name (each day divides by its own capital), so the note names the
            method, and in the nav it names it the way the ibkr page's 1y tile
            already does. */}
        {UnitBar && (
          <UnitBar value={unit} onChange={setUnit} note={pct ? 'twr' : null}/>
        )}
      </div>

      <div className="pf-stats">
        {/* In % each book reads as its contribution to the combined return, so
            the two still add to the headline exactly (see cmbPctSeries). A
            return on the book's own capital would be a different question, and
            one the polymarket page already answers. */}
        <CmbStat label="ibkr" value={fmt(vIbkr)} tone={tone(vIbkr)} onClick={go('ibkr')}
          note={pct ? 'deposit-adjusted · contribution' : 'deposit-adjusted'}/>
        <CmbStat label="polymarket" value={fmt(vPm)} tone={tone(vPm)} onClick={go('polymarket')}
          note={pct ? `${rangeNote} · contribution` : rangeNote}/>
        {/* In % the tile's own value IS the points figure it used to carry as a
            kicker, so the kicker takes the dollars instead of restating it. */}
        {wBenchD != null && (
          <CmbStat label={`vs ${primaryName}`}
            value={pct ? cmbPctFmt(vBench) : cmbSigned(wBenchD)}
            tone={tone(vBench)}
            note={pct ? `${cmbSigned(wBenchD)} in dollars` : `${wBenchPts >= 0 ? '+' : ''}${wBenchPts.toFixed(1)}% on notional`}/>
        )}
      </div>

      {data.series.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">total pnl · {cmbRangeLabel(range)}</span>
            <div className="pf-range">
              <SzToggle options={CMB_RANGES} value={range} onChange={setRange}/>
              {HistoryPicker && (
                <HistoryPicker quarters={quarters} value={range} onPick={setRange}/>
              )}
              {BenchPicker && data.bench && data.bench.length > 0 && (
                <BenchPicker value={benchKeys} onChange={setBenchKeys}
                  available={data.bench.map(b => b.key)}/>
              )}
            </div>
          </div>
          {/* `bench` is the drawn set — the selection only, so clearing it leaves
              a clean chart even though the primary's column is still carried on
              the series for the strips and tiles below. */}
          <CmbChart series={win.series} pctSeries={pctSeries} log={data.log}
            bench={drawnBench} primary={primary}
            benchNotional={data.benchNotional} ddNotional={win.notional} unit={pct ? 'pct' : 'usd'}/>
          {SZ.RollingStrip && cPerf && (
            <SZ.RollingStrip fullSeries={cFullPerf || cPerf} perfSeries={cPerf}
              benchSeries={cBench} benchName={primaryName} periods={365}/>
          )}
        </div>
      )}

      {/* The two panels the benchmarks button governs, directly under the panel
          that carries it. Same reasoning as the ibkr tab: a control whose effect
          only shows up several screens further down is a control acting at a
          distance, and both of these restate themselves entirely when the
          selection changes. */}
      {cCapture && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">capture vs {primaryName}</span>
            <span className="pf-panel-meta">
              {cCapture.upDays} up · {cCapture.downDays} down sessions · negative = moved opposite
            </span>
          </div>
          <div className="cmb-risk-grid">
            <CmbStat label="up capture"
              value={cCapture.upCapture != null ? pct1(cCapture.upCapture) : '—'}
              note={`of ${primaryName} gains on its up days`}/>
            <CmbStat label="down capture"
              value={cCapture.downCapture != null ? pct1(cCapture.downCapture) : '—'}
              note={`of ${primaryName} losses on its down days`}/>
            <CmbStat label="bull beta"
              value={cCapture.bullBeta != null ? cCapture.bullBeta.toFixed(2) : '—'}
              note={`slope · ${primaryName} up days`}/>
            <CmbStat label="bear beta"
              value={cCapture.bearBeta != null ? cCapture.bearBeta.toFixed(2) : '—'}
              note={`slope · ${primaryName} down days`}/>
          </div>
        </div>
      )}

      {cBenchRows.length > 0 && SZ.BenchTable && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">benchmark comparison · {cmbRangeLabel(range)}</span>
            <span className="pf-panel-meta">click a row to draw it · → is the one the tiles above name</span>
          </div>
          <SZ.BenchTable rows={cBenchRows} selected={benchKeys} primary={primary}
            onToggle={toggleBench}/>
        </div>
      )}

      {risk && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">risk · {range === '1Y' ? 'trailing 12mo' : cmbRangeLabel(range)}</span>
            <span className="pf-panel-meta">combined equity · 365d annualized</span>
          </div>
          <div className={`cmb-risk-grid ${data.corr ? 'cmb-risk-grid-6' : 'cmb-risk-grid-5'}`}>
            {/* The interval, not the rf — same call as the ibkr tab's sharpe
                tile, and for the same reason: the band is what a lone Sharpe
                hides. Falls back to naming the benchmark when the sample is
                too short to bracket. */}
            <CmbStat label="sharpe"  value={risk.sharpe != null ? risk.sharpe.toFixed(2) : '—'}
              note={risk.sharpeLo != null
                ? `95% ci ${risk.sharpeLo.toFixed(2)} – ${risk.sharpeHi.toFixed(2)}`
                : 'excess of cash'}/>
            {/* Same rf and same excess returns as the tile to its left; only
                the denominator narrows to the shortfall days. The note prints
                that denominator, so its distance from the vol tile is legible
                without arithmetic. */}
            <CmbStat label="sortino" value={risk.sortino != null ? risk.sortino.toFixed(2) : '—'}
              note={`downside dev ${risk.downside != null ? pct1(risk.downside) : '—'}`}/>
            <CmbStat label="ann vol" value={risk.vol != null ? pct1(risk.vol) : '—'} note="annualized · 365d"/>
            <CmbStat label="max dd"  value={pct1(risk.maxDD)} tone={risk.maxDD < 0 ? 'neg' : undefined} note="peak-to-trough"/>
            <CmbStat label="beta"    value={risk.beta != null ? risk.beta.toFixed(2) : '—'}
              note={risk.beta != null && risk.r2 != null ? `vs ${primaryName} · r² ${risk.r2.toFixed(2)}` : `vs ${primaryName}`}/>
            {/* Full overlap, not the selected range — at 1M this would be ~21
                sessions and the estimate would be noise. Its own note carries the
                window so the tile stays honest next to four range-scoped ones. */}
            {data.corr && (
              <CmbStat label="ibkr ↔ pm" value={cmbCorrFmt(data.corr.r)} note="book corr · daily"/>
            )}
          </div>
          {data.corr && data.corr.roll.length > 1 && <CmbCorrStrip roll={data.corr.roll}/>}
        </div>
      )}

      {data.hasLevels && capPts.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">capital deployed · {cmbRangeLabel(range)}</span>
            <span className="pf-panel-meta">
              ibkr nav + polymarket nav{capFrom ? ` from ${cmbFullDate(capFrom)}` : ''} · diamonds are transfers
              {xferTotal > 0 ? `, ${cmbUSDk(xferTotal)} to date` : ''}
            </span>
          </div>
          <CmbCapitalChart series={win.series} transfers={data.transfers}/>
        </div>
      )}

      {cmbMonthly(win.series, primary).length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">monthly pnl · {cmbRangeLabel(range)}</span>
            <span className="pf-panel-meta">
              ibkr · {primaryName} · polymarket{pct ? ' · contribution to return' : ''}
            </span>
          </div>
          <CmbMonthlyBars series={shown} unit={pct ? 'pct' : 'usd'} benchKey={primary}/>
        </div>
      )}

      {/* Shared with the ibkr view — same panels, combined equity curve. */}
      {cPerf && SZ.ReturnDistribution && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">return distribution · daily</span>
            <span className="pf-panel-meta">vs normal, same mean and sd</span>
          </div>
          <SZ.ReturnDistribution perfSeries={cPerf}/>
        </div>
      )}

      {cEpisodes.length > 0 && SZ.DrawdownTable && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">drawdown episodes · {cmbRangeLabel(range)}</span>
            <span className="pf-panel-meta">deepest {cEpisodes.length}, peak to recovery</span>
          </div>
          <SZ.DrawdownTable episodes={cEpisodes}/>
        </div>
      )}
    </section>
  );
}

window.Combined = Combined;
