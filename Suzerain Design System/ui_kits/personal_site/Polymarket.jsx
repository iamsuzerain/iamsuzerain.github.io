// Polymarket.jsx — LIVE polymarket panel (fetches data-api directly from browser)
// Globals: React, Cursor
// NOTE: we namespace hook aliases to avoid collisions with Portfolio.jsx

const {
  useState: usePmState,
  useEffect: usePmEffect,
  useRef: usePmRef,
  useMemo: usePmMemo,
} = React;

// Chart machinery (Chart.jsx, loaded ahead of this file) — the same box,
// scales, hover math and gradient stops the ibkr and book charts use.
const {
  szSmoothPath: smoothPath, szFrame, szScales, szDomain, szAreaPath, szTicks,
  useChartHover, SzChartSvg, SzChartDefs, SzRule, SzCrosshair, SzCrosshairLine,
  SzTooltip, SzAxisX, SzAxisZero, SzToggle,
} = window;

const PM_WALLETS = (window.SZ_ID.wallets && window.SZ_ID.wallets.length)
  ? window.SZ_ID.wallets
  : [window.SZ_ID.wallet];
const PM_PRIMARY = PM_WALLETS[0];
const PM_HANDLE = 'Seutervoinen';
const PM_CACHE_KEY = 'pm-cache-v11'; // v11: caches the live halves, not the daily files
const PM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const PM_BM_URL = `https://www.betmoar.fun/profile/${PM_WALLETS[1] || PM_PRIMARY}`;

const pmPositionsUrl = (w) =>
  `https://data-api.polymarket.com/positions?user=${w}&limit=100&sortBy=CURRENT&sortDirection=DESC`;
const pmPnlUrl = (w) =>
  `https://user-pnl-api.polymarket.com/user-pnl?user_address=${w}&interval=all&fidelity=1d`;
const pmActivityUrl = (w) =>
  `https://data-api.polymarket.com/activity?user=${w}&limit=20`;

// ---------- formatting helpers ----------
function pmUSD(n, compact = false) {
  if (n == null || isNaN(n)) return '—';
  if (compact && Math.abs(n) >= 1000) {
    return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function pmPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}
function pmRel(iso) {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (ms <= 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const day = Math.floor(h / 24);
  return day + 'd ago';
}

// ---------- live fetch + shape ----------
// Shared with the book view, which anchors its rewards ramp on the same cut
// (szPnlLifeStartDay) without trimming the series it charts.
function pmTrimFlat(series) {
  if (!series.length) return series;
  return series.slice(window.szPnlFirstMoveIndex(series));
}
// Plot-point ceiling shared with the book view (CMB_CHART_MAX_POINTS). Sized so
// daily resolution survives ~11 years of history rather than reverting to
// every-other-day partway through 2027.
const PM_CHART_MAX_POINTS = 2000;

// Gap between the feed's curve and the book-value walk that is worth saying out
// loud. See the effect that reads it for why this number.
const PM_BOOK_GAP_WARN = 3000;

function pmDownsample(arr, target = PM_CHART_MAX_POINTS) {
  const step = Math.max(1, Math.floor(arr.length / target));
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

// ---------- earnings breakdown (betmoar → polymarket-rewards.json fallback) ----------
function pmParseBetmoar(html) {
  const extract = (label) => {
    const re = new RegExp(label + '[^<$]{0,60}\\$([\\d,]+)', 'i');
    const m = html.match(re);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  };
  const trading  = extract('Trading');
  const lp       = extract('\\bLP\\b');
  const yld      = extract('Yield');
  const maker    = extract('Maker');
  const taker    = extract('Taker');
  const sponsored = extract('Sponsored');
  const uma      = extract('\\bUMA\\b');
  if (trading == null && lp == null && maker == null) return null;
  return { trading, lp, yield: yld, maker, taker, sponsored, uma, source: 'betmoar' };
}

async function pmFetchBreakdown() {
  // Primary: polymarket-breakdown.json written by betmoar-refresh workflow
  try {
    const bd = await window.szJson('data/polymarket-breakdown.json');
    if (bd.totals) {
      return {
        trading:   bd.totals.trading,
        lp:        bd.totals.lp,
        yield:     bd.totals.yield,
        maker:     bd.totals.maker,
        taker:     bd.totals.taker,
        sponsored: bd.totals.sponsored,
        uma:       bd.totals.uma,
        fees:      bd.totals.fees,
        // Full Polymarket NAV (open positions + idle USDC) from the daily
        // snapshot; used as portfolio value so it matches the book view's
        // capital-deployment bar exactly.
        nav:       bd.balances ? bd.balances.nav : null,
        source:    'betmoar',
      };
    }
  } catch {}

  // Fallback: polymarket-rewards.json (maker + LP via CLOB script)
  try {
    const rw = await window.szJson('data/polymarket-rewards.json');
    if (rw.totals && (rw.totals.makerRebates || rw.totals.liquidityRewards)) {
      return {
        trading:   null,
        lp:        Math.round(rw.totals.liquidityRewards || 0),
        yield:     0,
        maker:     Math.round(rw.totals.makerRebates || 0),
        taker:     0,
        sponsored: 0,
        uma:       0,
        fees:      0,
        source:    'json',
      };
    }
  } catch {}

  return null;
}

// ---------- cumulative-pnl snapshot (polymarket-pnl daily cron) ----------
// Already summed across wallets by fetch-polymarket-pnl.py, same {t,p} shape as
// the live feed, and same origin — one round trip against a static file rather
// than a cold computation on user-pnl-api. The book view has read this for a
// while as a last-resort fallback; here it is the opening hand, so the three
// P&L figures and the chart have something true to draw on the first tick.
async function pmFetchPnlSnapshot() {
  try {
    const j = await window.szJson('data/polymarket-pnl.json');
    if (!j || !Array.isArray(j.rows) || !j.rows.length) return null;
    return { rows: j.rows, source: 'snapshot', generatedAt: j.generatedAt || null };
  } catch { return null; }
}

// What pmBuild reads for the series. `pending` is about the *live* call only —
// a snapshot can be on screen while the live series is still in flight.
const PM_PNL_PENDING = { rows: [], source: null, generatedAt: null, pending: true };
const PM_PNL_NONE = { rows: [], source: null, generatedAt: null, pending: false };
const pmPnlSettled = (p) => (p ? { ...p, pending: false } : PM_PNL_NONE);

// Merge same-market positions across wallets: sum shares/value/pnl, weight-avg
// the entry price. Key is slug+outcome since the same market+side at different
// wallets is economically one position.
function pmMergePositions(lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const p of (list || [])) {
      const key = (p.slug || p.title || '') + '|' + (p.outcome || '').toUpperCase();
      const size = p.size || 0;
      const ex = merged.get(key);
      if (!ex) {
        merged.set(key, {
          title: p.title,
          slug: p.slug,
          outcome: p.outcome,
          size,
          avgWeighted: (p.avgPrice || 0) * size,
          curPrice: p.curPrice || 0,
          currentValue: p.currentValue || 0,
          cashPnl: p.cashPnl || 0,
          realizedPnl: p.realizedPnl || 0,
        });
      } else {
        ex.size += size;
        ex.avgWeighted += (p.avgPrice || 0) * size;
        ex.currentValue += p.currentValue || 0;
        ex.cashPnl += p.cashPnl || 0;
        ex.realizedPnl += p.realizedPnl || 0;
        if (!ex.curPrice && p.curPrice) ex.curPrice = p.curPrice;
      }
    }
  }
  return [...merged.values()]
    .map(m => ({
      title: m.title,
      slug: m.slug,
      outcome: m.outcome,
      size: m.size,
      avgPrice: m.size ? m.avgWeighted / m.size : 0,
      curPrice: m.curPrice,
      currentValue: m.currentValue,
      cashPnl: m.cashPnl,
      realizedPnl: m.realizedPnl,
    }))
    .sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
}

// Cumulative-PnL series can start at different times per wallet. Union the
// timestamps, carry forward each wallet's last known value (0 before its first
// point), sum at each timestamp.
function pmSumPnlSeries(seriesList) {
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

function pmMergeActivity(lists) {
  const all = [];
  for (const l of lists) if (l && l.length) for (const a of l) if (a) all.push(a);
  return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// The wallet calls, all issued on one tick, split by what the view needs to
// draw. positions/activity answer in ~0.3s. The pnl series does not: it is a
// cold-cache computation on user-pnl-api, measured at 2-8s on the first call for
// a wallet and ~0.08s on every call after, so gating the whole view on it meant
// staring at a spinner while the positions sat fetched and idle.
//
// It also can't take the page down any more. pnl used to share the 10s abort
// and reject into the same Promise.all as everything else, so a cold call
// crossing that budget — 7.8s measured, uncomfortably close — put the view on
// "couldn't reach polymarket" with nothing wrong but one slow endpoint.
function pmFetchStreams() {
  const timeout = (ms) => AbortSignal.timeout(ms);
  // The breakdown snapshot is independent of the live wallet calls, so it goes
  // out on the same tick rather than queueing behind them — one round trip of
  // overlap instead of one appended to the end. Same for the pnl snapshot,
  // which is what the P&L figures draw until the live series lands.
  const breakdownP = pmFetchBreakdown();
  const snapshotP = pmFetchPnlSnapshot();

  const coreP = Promise.all(PM_WALLETS.map(async (w) => {
    const [posRes, actRes] = await Promise.all([
      fetch(pmPositionsUrl(w), { signal: timeout(10000) }),
      fetch(pmActivityUrl(w), { signal: timeout(10000) }),
    ]);
    if (!posRes.ok) throw new Error('positions ' + posRes.status + ' (' + w.slice(0, 6) + ')');
    const positions = await posRes.json();
    const activity = actRes.ok ? await actRes.json() : [];
    return { positions, activity };
  }));

  // Best-effort, and on a budget sized for the cold path rather than the warm
  // one — user-pnl-api answers in ~0.08s per wallet warm and ~3s cold.
  //
  // All-or-nothing across wallets. A wallet that failed used to resolve `[]`,
  // which pmSumPnlSeries then carried forward as a flat zero for the whole
  // series: the surviving wallet's book rendered as the lifetime figure, with
  // nothing on screen saying so. The two wallets currently sit at roughly
  // -$34k and +$34k, so losing either one moves every P&L figure and the whole
  // chart by tens of thousands of dollars in the confident direction. And the
  // failure correlates with the cold path, so the wrong number arrived exactly
  // when the wait had been longest. A partial answer is discarded instead, and
  // the snapshot — which is summed across both wallets or not written at all —
  // stands.
  //
  // `null` means the call failed; a 200 carrying `[]` is a real answer (a
  // wallet with no history) and sums as zero legitimately.
  const pnlP = Promise.all(PM_WALLETS.map(async (w) => {
    try {
      const r = await fetch(pmPnlUrl(w), { signal: timeout(25000) });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j) ? j : null;
    } catch { return null; }
  })).then(lists => lists.some(l => l == null)
    ? null
    : { rows: pmSumPnlSeries(lists), source: 'live', generatedAt: null });

  return { breakdownP, coreP, pnlP, snapshotP };
}

// `onPartial` gets the view as soon as positions and the snapshot land — which
// is one same-origin round trip, not the live series' cold path. The three P&L
// figures that need a series draw the snapshot's, labeled as such; only when
// there is no snapshot at all do they hold on `pnlPending`. What they must never
// do is print the open-position fallback (realized-on-open + unrealized, off by
// thousands) as though it were the lifetime figure.
// The cache holds the two slow live halves and nothing else: data-api's
// per-wallet positions, and user-pnl-api's series (~0.08s/wallet warm, ~3.1s
// cold — the reason any of this is cached). The daily same-origin files are
// refetched on every load instead of riding along inside the cached payload.
//
// Caching them together meant a freshly published breakdown stayed invisible
// for the whole TTL, and localStorage survives a hard refresh — so the one
// move anybody makes when a page looks stale could not shift it. The files
// cost one round trip each; there was never anything to win by pinning them.
function pmReadCache({ ignoreAge = false } = {}) {
  try {
    const entry = JSON.parse(localStorage.getItem(PM_CACHE_KEY));
    if (!entry || !entry.perWallet || !entry.pnl) return null;
    if (!ignoreAge && Date.now() - entry.t >= PM_CACHE_TTL_MS) return null;
    return entry;
  } catch { return null; }
}

// Cached live halves + a breakdown fetched now, never the cached one.
async function pmViewFromCache(entry) {
  return pmBuild(entry.perWallet, pmPnlSettled(entry.pnl), await pmFetchBreakdown());
}

async function pmFetchAll(onPartial) {
  const cached = pmReadCache();
  const { breakdownP, coreP, pnlP, snapshotP } = pmFetchStreams();

  // Stale-while-revalidate. A cache hit paints immediately but no longer *ends*
  // the load — the live calls go out on the same tick either way, so a reload
  // always converges on current figures. Returning the cached view and stopping
  // there replayed the same numbers for the rest of the TTL, which is what made
  // refreshing look broken to anyone watching an intraday move.
  if (cached && onPartial) {
    breakdownP
      .then(bd => onPartial(pmBuild(cached.perWallet, pmPnlSettled(cached.pnl), bd)))
      .catch(() => {});
  }

  // pmFetchBreakdown and pmFetchPnlSnapshot resolve to null on any failure, so
  // awaiting them alongside a fan-out that can throw never strands a rejection.
  const [perWallet, breakdown, snapshot] = await Promise.all([coreP, breakdownP, snapshotP]);
  if (onPartial) {
    // With a cached live series in hand, hold it through this paint rather than
    // downgrading to the snapshot and back again while the live call lands.
    const interim = cached
      ? pmPnlSettled(cached.pnl)
      : (snapshot ? { ...snapshot, pending: true } : PM_PNL_PENDING);
    onPartial(pmBuild(perWallet, interim, breakdown));
  }

  // Live wins when it is complete; otherwise the snapshot keeps standing rather
  // than being replaced by a half-summed live series or by nothing.
  const settled = pmPnlSettled((await pnlP) || snapshot);
  const data = pmBuild(perWallet, settled, breakdown);
  // Only cache a complete live series. A snapshot-backed one would pin
  // yesterday's close for the whole TTL on every reload, and a pnl-less one
  // would suppress the chart for the same window.
  if (data.pnlSource === 'live' && data.pnlSeries.length) {
    try {
      localStorage.setItem(PM_CACHE_KEY,
        JSON.stringify({ t: Date.now(), perWallet, pnl: settled }));
    } catch {}
  }
  return data;
}

// `pnl` is the shape above: rows already summed across wallets, plus where they
// came from and whether the live call is still out.
function pmBuild(perWallet, pnl, breakdown) {
  // Drop positions Polymarket has resolved — they still come back from the
  // positions endpoint with currentValue:0 but cashPnl carrying the loss, so
  // they'd otherwise appear as "open" with a $0 value.
  const openOnly = perWallet.map(x => (x.positions || []).filter(p => !p.redeemable));
  const mergedPositionsRaw = pmMergePositions(openOnly);
  const summedPnl = [...((pnl && pnl.rows) || [])].sort((a, b) => a.t - b.t);
  const mergedActivity = pmMergeActivity(perWallet.map(x => x.activity));

  const positions = mergedPositionsRaw.map(p => ({
    market: p.title,
    slug: p.slug,
    side: (p.outcome || '').toUpperCase(),
    shares: Math.round(p.size),
    avgPrice: +(p.avgPrice || 0).toFixed(4),
    curPrice: +(p.curPrice || 0).toFixed(4),
    value: +(p.currentValue || 0).toFixed(2),
    unrealized: +(p.cashPnl || 0).toFixed(2),
    realized: +(p.realizedPnl || 0).toFixed(2),
  }));

  // Portfolio value = full Polymarket NAV (positions + idle USDC) as the betmoar
  // scrape read it, and nothing else. Falls back to live open-position value when
  // the scrape is missing.
  //
  // This used to carry the scrape forward by (lifetime now - lifetime at the
  // scrape), so the panel moved intraday rather than sitting at the morning's
  // reading, and so it tracked the book view's capital-deployment bar, which
  // extends by the same quantity. Both halves of that argument assumed the live
  // user-pnl figure was true intraday, and it is not: a neg-risk conversion
  // corrupts it until the market closes (see szPmBookExtend). On 2026-08-27 that
  // carry put $20,046 of value on this tile that the book did not have, and the
  // same $20,046 on the book view's bar.
  //
  // A stale but measured NAV beats a live but wrong one, and the two views agree
  // trivially once both read the scrape instead of each rebuilding a carry. The
  // cost is a figure up to a day old, which the timestamp already says.
  const positionsValue = +positions.reduce((a, p) => a + p.value, 0).toFixed(2);
  const snapNav = (breakdown && breakdown.nav != null) ? breakdown.nav : null;
  const totalValue = snapNav == null ? positionsValue : snapNav;
  const unrealized = +positions.reduce((a, p) => a + p.unrealized, 0).toFixed(2);
  const realized = +positions.reduce((a, p) => a + p.realized, 0).toFixed(2);

  const trimmed = pmTrimFlat(summedPnl);
  // One point per day, matching the ibkr and book charts. At 150 the
  // ~425-point series took every 2nd day, putting this chart on a different
  // time base to the others. The cap is 2000 rather than something tighter
  // because floor(len/target) only steps to 2 at 2x the target: 400 would hold
  // 1d resolution just past 2027 and then silently coarsen again, whereas
  // smoothPath costs ~1.6ms at 2000 points — well inside a frame even though
  // it is recomputed on every hover move.
  const sampled = pmDownsample(trimmed, PM_CHART_MAX_POINTS);
  // szPmPointDay, not the raw stamp's own date: the feed's daily points sit on
  // 00:00 UTC boundaries, so stamp D is the close of D-1. Taking the stamp at face
  // value labeled every point a day late and, because the live intraday tail is
  // *not* a boundary, put the last two points on the same date.
  // Deduped last: polymarket skips hourly tail updates often enough that two
  // points can resolve to one day (see szDedupeByDate).
  const pnlSeries = window.szDedupeByDate(sampled.map(r => ({
    d: window.szFromEpochDay(window.szPmPointDay(r.t)),
    v: +r.p.toFixed(2),
  })));

  const activity = mergedActivity.slice(0, 15).map(a => ({
    t: new Date((a.timestamp || 0) * 1000).toISOString(),
    type: (a.type || 'TRADE').toUpperCase(),
    side: (a.side || '').toUpperCase(),
    size: Math.round(a.size || 0).toLocaleString(),
    price: a.price || 0,
    market: a.title || '',
  }));

  return {
    generatedAt: new Date().toISOString(),
    profile: { handle: PM_HANDLE, wallet: PM_PRIMARY, wallets: PM_WALLETS },
    summary: {
      totalValue,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      openPositions: positions.length,
      marketsTradedLifetime: null,
    },
    breakdown,
    positions,
    pnlSeries,
    // Two independent facts: where the series on screen came from, and whether
    // a better one is still coming. A snapshot renders while live is in flight,
    // so "pending" no longer implies "nothing to draw".
    pnlSource: (pnl && pnl.source) || null,
    pnlAsOf: (pnl && pnl.generatedAt) || null,
    pnlPending: !!(pnl && pnl.pending),
    activity,
  };
}

// ---------- PnL sparkline ----------
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  return `${mo} ${d}, ${y}`;
}
// Span-aware x-axis label, same three modes the book chart uses: 'day' ->
// "Jun 12" (short windows, where every tick would otherwise read the same
// month), 'month' -> "Jun" (within one year), 'monthyear' -> "Jun 26".
function pmAxisLabel(iso, mode) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  if (mode === 'day') return `${mo} ${d}`;
  if (mode === 'month') return mo;
  return `${mo} ${String(y).slice(2)}`;
}
function pmSpanDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function pmUSDCompact(n) {
  if (Math.abs(n) >= 1000) {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
  }
  return '$' + Math.round(n);
}

// ---------- rewards curve ----------
// Cumulative non-trading income ($ aligned to `dates`): real where the betmoar
// breakdown history reaches, linearly ramped before it.
//
// The trading curve is a lifetime daily series but the rewards history only
// starts once the betmoar cron did, so the two are joined at a seam the way
// pfExtendHistory joins NAV history in Portfolio.jsx: actual dated values from
// the seam forward, and the remainder — everything earned before the history
// began — ramped across the earlier stretch. The old whole-timeline ramp put a
// flat ~$5/day all the way back to the first trade, which understated a recent
// market-making ramp-up by an order of magnitude on the short ranges.
//
// `total` (the live breakdown snapshot) anchors the last point, so the curve
// still ends exactly on the lifetime-pnl headline even when breakdown.json is a
// cron cycle fresher than the history file.
// Both the sum and the curve live in Chrome.jsx now, shared with the book view.
// They were separate implementations that disagreed twice over: on whether `uma`
// counted as income, and on where the pre-history ramp starts — this copy
// measured it in *series points* from the trimmed first date, the book view in
// *days* from the raw feed's first row, so identical inputs produced two
// different 12mo figures.
const pmRewardsNet = (r) => window.szPmIncomeNet(r);

function pmRewardsCurve(dates, hist, total, lifeStartDay) {
  const n = dates.length;
  if (!n) return [];
  const endDay = window.szEpochDay(dates[n - 1]);
  const at = window.szPmIncomeCurve((hist && hist.rows) || [], lifeStartDay, total, endDay);
  return dates.map(d => +at(window.szEpochDay(d)).toFixed(2));
}

// ---------- range windowing ----------
// Same vocabulary (and the same completed-quarter picker) as the ibkr and
// book pages, so a range picked here spans what it spans there.
const PM_RANGES = ['1M', '3M', 'QTD', '6M', 'YTD', '1Y', 'MAX'];
const PM_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', 'QTD': 'qtd', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo', 'MAX': 'all-time' };

// Both live in Chrome.jsx, shared with the book view.
const pmRangeEnd = (range) => window.szRangeEnd(range);
const pmRangeCutoff = (range, last) => window.szRangeCutoff(range, last);

function pmRangeLabel(range) {
  return PM_RANGE_LABEL[range] || (window.szQuarterLabel && window.szQuarterLabel(range)) || range;
}

// Slice the cumulative-pnl curve to a range and rebase it to the window start,
// so "3mo" reads as the P&L earned in those three months rather than three
// months of the lifetime curve. Cumulative dollars subtract cleanly (unlike the
// ibkr page's TWR, which has to be re-compounded), so one subtraction per point
// is the whole job — and it keeps peak/trough and the $0 line window-relative.
// MAX is the exception: see `base` below.
function pmWindow(series, range) {
  if (!series || series.length < 2) return series;
  const last = series[series.length - 1].d;
  const cutoff = pmRangeCutoff(range, last);
  // Calendar ranges rebase on the close BEFORE the period opens; trailing ones
  // on the cutoff day itself. See szRangeBaseIndex. The D-1 restatement these
  // rows carry is applied once at fetch (szPmDateSnapshotRows), so `d` is already
  // the effective close date here and the two shifts do not compound.
  let i = window.szRangeBaseIndex(series.map(p => p.d), range, cutoff);
  if (i > series.length - 2) i = series.length - 2;   // keep >= 2 points to plot
  const endCut = pmRangeEnd(range);
  let j = series.length - 1;
  if (endCut) {
    const over = series.findIndex(p => p.d > endCut);
    if (over > 0) j = over - 1;
  }
  if (j < i + 1) j = Math.min(series.length - 1, i + 1);
  // MAX is not a window — it is the lifetime curve, so it must end on the
  // lifetime-pnl headline. Keyed on `cutoff` rather than i === 0: a 1Y or
  // quarter window whose start predates the series also lands on i === 0, but
  // there the opening value really was earned before the window and belongs
  // subtracted away.
  const base = cutoff ? series[i].v : 0;
  return series.slice(i, j + 1).map(p => ({ ...p, v: +(p.v - base).toFixed(2) }));
}

// ---------- percent mode: time-weighted return, from 2026-06-01 ----------
// A percentage here can only be a time-weighted return, and only over a window
// where the capital base is stable. Both halves of that were learned the hard
// way:
//
//   A fixed denominator cannot work. The book went ~$3k to ~$247k on transfers,
//   so dividing a window's P&L by any single NAV in it is wrong at one end or
//   the other — 6mo on its window-start NAV printed peak +270.8%.
//
//   TWR fixes the ramp (each day's P&L is measured against the NAV that earned
//   it, and a transfer moves NAV without moving P&L, so flows never register as
//   performance) but not the data. polymarket-nav-history.json is `derived`
//   before 2026-07-15 — anchored to the oldest recorded NAV and walked back
//   through transfer/pnl/rewards deltas — and its error is an ABSOLUTE dollar
//   amount, not a proportional one. The generator validates at 0.36% mean /
//   1.52% worst, but that was measured at ~$230k NAV. The same $838-$3,485
//   against the $3,032 NAV of 2026-01-09 is 28%-115%. Run over the full history
//   the answer is "+111%, give or take 40 points", which is not a number to put
//   on a page.
//
// 2026-06-01 is where the book crosses ~$200k and stays there (min NAV after it
// is $215,185, so the worst residual is 1.62% of the smallest denominator).
// From there the percent and the dollars finally tell the same story — 1mo
// reads +10.1% against +$22,895 — which is the test the longer windows failed.
//
// Hardcoded rather than rediscovered from a NAV threshold each load: it is one
// fact about when this account got funded, and a computed floor would move
// under the reader whenever a scrape landed near the boundary.
const PM_PCT_START = '2026-06-01';
// Carries the year everywhere it is shown. "jun 1" beside a chart whose axis
// runs into 2026 reads as this year's june by default, and the whole point of
// the label is to say which june the series actually begins.
const PM_PCT_START_SHORT = 'jun 1 26';     // range button — sized like "all-time"
const PM_PCT_START_LONG = 'jun 1, 2026';   // panel title, on that range only

// Which timeframes percent can honestly cover, given the last day of history.
// Module-level because two callers need them: the panel below, and the effect
// that reconciles a remembered percent against the range it opens on — which
// has to run before that panel's code exists.
//
// A range qualifies once its own start clears PM_PCT_START. MAX always does,
// because it gets trimmed to exactly that date. This list grows on its own as
// history accumulates — 3mo qualifies from 2026-09-01, 6mo from 2026-12-01.
function pmPctRangeOk(r, lastD) {
  if (r === 'MAX') return true;
  if (!lastD) return false;
  const c = pmRangeCutoff(r, lastD);
  return c != null && c >= PM_PCT_START;
}

// Landing spot when the selected range has no percent. Prefer the longest real
// timeframe that does — earliest cutoff wins — and fall back to the trimmed
// window only if nothing else qualifies. Dropping straight to "jun 1 26" would
// swap a named timeframe for a substitute one when a genuine shorter timeframe
// was available: today 12mo steps down to qtd, not to the start date.
function pmPctFallback(lastD) {
  const real = PM_RANGES.filter(r => r !== 'MAX' && pmPctRangeOk(r, lastD));
  if (!real.length) return 'MAX';
  return real.reduce((best, r) =>
    pmRangeCutoff(r, lastD) < pmRangeCutoff(best, lastD) ? r : best);
}

// Last recorded NAV on or before a date, forward-filled. Rows arrive already
// restated to close-of-day by szPmDateSnapshotRows at the fetch site.
function pmNavLookup(rows) {
  const sorted = (rows || [])
    .filter(r => r && r.d && r.nav != null)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!sorted.length) return null;
  return (iso) => {
    let lo = 0, hi = sorted.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].d <= iso) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best === -1 ? null : sorted[best].nav;
  };
}

// Chain daily returns into a cumulative TWR series starting at 0. Takes the
// dollar curve the chart already plots — trading plus the all-source income
// ramp — so the two units describe the same quantity. Deltas are unaffected by
// pmWindow's rebasing, so the slice can arrive already rebased.
function pmTwrSeries(series, navAt) {
  if (!series || series.length < 2 || !navAt) return null;
  const out = [{ d: series[0].d, v: 0 }];
  let cum = 1;
  for (let i = 1; i < series.length; i++) {
    const base = navAt(series[i - 1].d);
    if (!base || base <= 0) return null;
    cum *= 1 + (series[i].v - series[i - 1].v) / base;
    out.push({ d: series[i].d, v: +(cum - 1).toFixed(6) });
  }
  return out;
}

// Taller foot than the ibkr chart's 28: this one carries peak/trough callouts
// that can sit near the bottom of the plot.
const PM_SPARK_FRAME = szFrame(220, 20, 32);

function PmSpark({ series, unit }) {
  const F = PM_SPARK_FRAME;
  const pct = unit === 'pct';
  const fmt = (v) => pct ? pmPct(v) : (v >= 0 ? '+' : '') + pmUSD(v);
  const fmtCompact = (v) => pct ? pmPct(v) : pmUSDCompact(v);
  const hv = useChartHover(F);

  const values = series.map(p => p.v);
  // Floor anchored at 0 but not the ceiling: a book that has only ever made
  // money should still show the $0 line it started from, while a window that
  // ran negative throughout keeps its own top rather than reserving space for
  // a zero it never reached.
  const { y0, y1, lo: min, hi: max } = szDomain(values, { pad: 0.08, floor: 1, min: 0 });
  const { x, y } = szScales(F, series.length, y0, y1);

  // Splined, like the ibkr and book curves. This series is spikier than
  // theirs — resolutions land as single-day jumps, and 16 of the ~465 segments
  // move the curve more than 2px off the straight chord where none of ibkr's
  // do — so the rounding is actually visible here rather than decorative. It
  // reads better all the same, and the book view already drew this same feed
  // splined, so straight segments here were the odd page out rather than a
  // principle the site held.
  const line = smoothPath(series.map((_, i) => x(i)), series.map(p => y(p.v)));
  // Closed to the floor of the box, not to the zero line — the fill reads as
  // the area under the curve rather than as a signed deviation.
  const area = szAreaPath(line, x(0), x(series.length - 1), F.H - F.PAD_B);
  const zeroY = y(0);

  const ticks = szTicks(series, 6);
  const spanDays = pmSpanDays(series[0].d, series[series.length - 1].d);
  const axisMode = spanDays <= 95 ? 'day'
    : (series[0].d.slice(0, 4) === series[series.length - 1].d.slice(0, 4) ? 'month' : 'monthyear');

  const maxIdx = values.indexOf(max);
  const minIdx = values.indexOf(min);

  const hovered = hv.i != null ? series[hv.i] : null;

  return (
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={series.length} className="pf-navchart pm-chart-svg">
        <SzChartDefs ramp="nav" id="pm"/>

        <SzRule frame={F} y={zeroY} stroke="rgba(229,225,241,0.1)"/>
        <path d={area} fill="url(#pm-fill)"/>
        <path d={line} fill="none" stroke="url(#pm-stroke)" strokeWidth="1.75"/>

        <circle cx={x(maxIdx)} cy={y(max)} r="2.5" fill="#a78bfa" opacity="0.7"/>
        <circle cx={x(minIdx)} cy={y(min)} r="2.5" fill="#ff9ae8" opacity="0.7"/>

        {hovered && <SzCrosshair frame={F} x={x(hv.i)} cy={y(hovered.v)} fill="#ff4fd8"/>}
      </SzChartSvg>

      <div className="pm-peak" style={{ left: `${(x(maxIdx) / F.W) * 100}%`, top: `${(y(max) / F.H) * 100}%` }}>peak {fmtCompact(max)}</div>
      <div className="pm-trough" style={{ left: `${(x(minIdx) / F.W) * 100}%`, top: `${(y(min) / F.H) * 100}%` }}>trough {fmtCompact(min)}</div>
      <SzAxisZero frame={F} y={zeroY}>{pct ? '0%' : '$0'}</SzAxisZero>
      <SzAxisX frame={F} ticks={ticks} x={x} label={(t) => pmAxisLabel(t.d, axisMode)}/>

      {hovered && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(hovered.v)}>
          <div className="pm-tt-date">{fmtDate(hovered.d)}</div>
          <div className={`pm-tt-val ${hovered.v >= 0 ? 'pos' : 'neg'}`}>{fmt(hovered.v)}</div>
        </SzTooltip>
      )}
    </div>
  );
}

// ---------- UI primitives ----------
function SidePill({ side }) {
  return <span className={`pm-side pm-side-${side.toLowerCase()}`}>{side}</span>;
}

function PmPositions({ rows }) {
  return (
    <div className="pf-table-wrap">
      <table className="pf-table pm-pos-table">
        <thead>
          <tr>
            <th>market</th>
            <th>side</th>
            <th className="pf-num">shares</th>
            <th className="pf-num">avg</th>
            <th className="pf-num">now</th>
            <th className="pf-num">value</th>
            <th className="pf-num">unrealized</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const up = p.unrealized >= 0;
            return (
              <tr key={i}>
                <td className="pm-market" title={p.market}>{p.market}</td>
                <td><SidePill side={p.side}/></td>
                <td className="pf-num">{p.shares.toLocaleString()}</td>
                <td className="pf-num pm-price">{(p.avgPrice * 100).toFixed(0)}¢</td>
                <td className="pf-num pm-price">{(p.curPrice * 100).toFixed(0)}¢</td>
                <td className="pf-num">{pmUSD(p.value)}</td>
                <td className={`pf-num ${up ? 'pos' : 'neg'}`}>
                  {up ? '+' : ''}{pmUSD(p.unrealized)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PmActivity({ rows }) {
  return (
    <ul className="pm-feed">
      {rows.map((a, i) => (
        <li key={i} className="pm-feed-row">
          <span className="pm-feed-time">{pmRel(a.t)}</span>
          <span className={`pm-feed-type pm-feed-${a.type.toLowerCase()}`}>{a.type}</span>
          <SidePill side={a.side}/>
          <span className="pm-feed-size">{a.size}</span>
          <span className="pm-feed-at">@</span>
          <span className="pm-feed-price">{(a.price * 100).toFixed(0)}¢</span>
          <span className="pm-feed-market" title={a.market}>{a.market}</span>
        </li>
      ))}
    </ul>
  );
}

function PmStat({ label, value, change, kicker, tone }) {
  const cls = tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : '';
  return (
    <div className="pf-stat">
      <div className="pf-stat-label">{label}</div>
      <div className={`pf-stat-value ${cls}`}>{value}</div>
      {change != null && (
        <div className={`pf-stat-chg ${change >= 0 ? 'pos' : 'neg'}`}>
          {change >= 0 ? '▲' : '▼'} {pmPct(change)}
        </div>
      )}
      {kicker && <div className="pf-stat-kicker">{kicker}</div>}
    </div>
  );
}

// ---------- earnings breakdown row ----------
function PmBreakdown({ bd, tradingPnl }) {
  // maker + taker rebates share a cell rather than taking one each: the grid is
  // six columns wide (three on mobile), and taker is a two-figure stream next to
  // a four-figure one — not worth a seventh column and a reflowed layout.
  const rebates = bd?.maker != null || bd?.taker != null
    ? (bd.maker || 0) + (bd.taker || 0)
    : null;
  const rows = [
    { key: 'trading',   label: 'trading',   val: tradingPnl != null ? Math.round(tradingPnl) : null },
    { key: 'lp',        label: 'lp',        val: bd?.lp        != null ? bd.lp        : null },
    { key: 'rebates',   label: 'rebates',   val: rebates },
    { key: 'yield',     label: 'yield',     val: bd?.yield     != null ? bd.yield     : null },
    { key: 'sponsored', label: 'sponsored', val: bd?.sponsored != null ? bd.sponsored : null },
    { key: 'fees',      label: 'fees',      val: bd?.fees      != null ? -bd.fees     : null },
  ];
  const source = bd?.source || null;
  return (
    <div className="pf-panel pm-breakdown-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">profit by source</span>
        <span className="pf-panel-meta">
          {source === 'betmoar' ? 'via betmoar' : source === 'json' ? 'maker + lp via clob' : 'trading only'}
          {' · '}
          <a className="pm-breakdown-src" href={PM_BM_URL} target="_blank" rel="noreferrer">full dashboard ↗</a>
        </span>
      </div>
      <div className="pm-breakdown-grid">
        {rows.map(({ key, label, val }) => (
          <div key={key} className="pm-breakdown-cell">
            <div className="pm-breakdown-label">{label}</div>
            <div className={`pm-breakdown-val${val != null && val > 0 ? ' pos' : ''}${val != null && val < 0 ? ' neg' : ''}`}>
              {val != null ? pmUSD(val) : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- attribution by market type ----------
// The aggregate hides the book. Net P&L is a small negative number that is
// actually a large positive book (geopolitics, politics) netted against a large
// negative one (commodities), so the only honest read is per-category.
//
// The picking-vs-sizing story reads off two columns in the same units the
// calibration headline already uses:
//   edge/pos — won − priced on resolved bets (pp), one vote per bet. Directional
//              picking skill.
//   roi      — realized P&L per dollar staked. The dollar-weighted outcome.
// edge/pos ≈ 0 (fairly priced) beside a deeply negative roi = the picking was
// fine and the sizing wasn't. top-1 (share of gross p&l in the single biggest
// move) guards against reading one trade as a category.
// From the polymarket-calibration daily cron (`byCategory` and `lots`).
const PM_CAT_MIN_N = 25;    // below this the row is noise — dimmed, not dropped
// A category whose |P&L| is under this fraction of the largest bar renders as a
// 1px speck indistinguishable from the zero-line divider. Plot only material
// movers (like the contribution-to-return chart); the table keeps the full tail.
const PM_CAT_BAR_FLOOR = 0.01;

// A lifetime aggregate is the wrong instrument for a book whose shape changed,
// and at 2026-09-08 it was hiding the damage rather than exaggerating it.
// Commodities reads -$86.5k all-time over 126 lots; window it to 3mo and it
// reads -$98.1k over 62. The whole loss and more landed in one quarter, netted
// in the lifetime figure against an earlier commodities book that had been
// mildly positive. Net over the window is -$34.9k against -$13.0k all-time.
//
// It is also why this panel cannot be read off the headline. Cumulative trading
// P&L rose ~$36k over roughly the same three months while the closed lots inside
// them summed to -$34.9k — both true, because the open book's marks moved the
// other way (see the scope line's `openBook`, +$27.2k unrealized). Attribution
// scores decisions that finished; the headline also carries ones that haven't.
//
// The short end is deliberately absent. 1M leaves ~40 lots to divide among ten
// categories, i.e. every row under PM_CAT_MIN_N and an `edge` column (settled
// lots only) that is mostly em-dashes — a window that reports nothing but its
// own thinness. 3M is the shortest span this book fills.
const PM_CAT_RANGES = ['3M', '6M', 'YTD', '1Y', 'MAX'];

// Mirrors category_stats in fetch-polymarket-calibration.py: same fields, same
// order, same definitions. Deliberately literal rather than clever, because the
// two have to keep agreeing — all-time reads the server's figures and every
// other range reads these, one toggle apart. The generator checks the round
// trip on every run (check_lots) so drift is caught there, not by a reader.
function pmCatStats(rows) {
  const n = rows.length;
  if (!n) return null;
  const decided = rows.filter(r => !r.push);
  const wins = decided.filter(r => r.win).length;
  const vol = rows.reduce((a, r) => a + r.volume, 0);
  const pnl = rows.reduce((a, r) => a + r.realizedPnl, 0);
  const avgImplied = rows.reduce((a, r) => a + r.impliedEntry, 0) / n;
  const gross = rows.reduce((a, r) => a + Math.abs(r.realizedPnl), 0);
  const hit = decided.length ? wins / decided.length : null;
  return {
    n,
    volume: vol,
    realizedPnl: pnl,
    roi: vol ? pnl / vol : null,
    hitRate: hit,
    avgImplied,
    edge: hit == null ? null : hit - avgImplied,
    top1Share: gross ? Math.max(...rows.map(r => Math.abs(r.realizedPnl))) / gross : null,
  };
}

// `lots` rows are positional arrays — the column order is carried in the feed's
// own method.lotColumns, and named here once so nothing downstream indexes them.
// `win` is 1 / 0 / null, null meaning a push: in `n` and `volume`, out of the
// hit-rate denominator, exactly as the generator has it.
// `market` and `outcome` are absent on a payload older than the lot tape, which
// then falls back to naming the category.
function pmLotRow([category, closedOn, via, volume, realizedPnl, win, impliedEntry, market, outcome]) {
  return {
    category, closedOn, market, outcome,
    resolvedVia: via === 's' ? 'settlement' : 'exit',
    volume, realizedPnl,
    win: win === 1, push: win == null,
    impliedEntry,
  };
}

// Rebuilds the `byCategory` shape from whatever lots fall inside a window, so
// the render path below never learns which source it is reading.
function pmByCategory(rows) {
  const groups = {};
  for (const r of rows) (groups[r.category] || (groups[r.category] = [])).push(r);
  const out = {};
  for (const cat of Object.keys(groups)) {
    const entry = { combined: pmCatStats(groups[cat]) };
    for (const series of ['settlement', 'exit']) {
      const s = pmCatStats(groups[cat].filter(r => r.resolvedVia === series));
      if (s) entry[series] = s;
    }
    out[cat] = entry;
  }
  return out;
}

// A category can be entirely unresolved — every bet in it still riding — and it
// still belongs in the panel. Its closed side falls back to this rather than the
// row being dropped for having no history yet.
const PM_CAT_NO_CLOSED = {
  n: 0, volume: 0, realizedPnl: 0,
  roi: null, hitRate: null, avgImplied: null, edge: null, top1Share: null,
};
const PM_CAT_NO_OPEN = { n: 0, cost: 0, mark: 0, unrealized: 0 };

function PmCategoryPanel({ byCategory, lots, asOf, openBook, openByCategory }) {
  const [sort, setSort] = usePmState('pnl');
  const [range, setRange] = usePmState('MAX');
  const [hover, setHover] = usePmState(null);
  if (!byCategory) return null;

  // Both are required to window at all: an older cached feed carries neither,
  // and the panel then renders exactly as it did before, all-time and untoggled.
  const hasLots = Array.isArray(lots) && lots.length > 0 && /^\d{4}-\d\d-\d\d$/.test(asOf || '');
  // Cut from the feed's generation day, not from the newest close: "3mo" has to
  // mean the three months up to today, or a quiet fortnight silently slides the
  // window back and the panel stops being the current thing it claims to be.
  //
  // Membership is a plain `closedOn >= cutoff` for trailing AND calendar ranges
  // alike. The cumulative curve needs szRangeBaseIndex's calendar/trailing split
  // because it rebases against a prior close; these are discrete events with
  // nothing to rebase, so the first day inside the period is simply the first
  // day that counts.
  const cutoff = hasLots && range !== 'MAX' ? pmRangeCutoff(range, asOf) : null;
  const inWindow = cutoff
    ? lots.map(pmLotRow).filter(r => r.closedOn && r.closedOn >= cutoff)
    : null;
  const src = inWindow ? pmByCategory(inWindow) : byCategory;

  // The open book joins the bars ONLY at all-time, and the reason is that a mark
  // cannot be sliced by date. A closed lot has a day it landed on; a live
  // position has one number, today's, and no history of what it was marked at
  // three months ago. Adding today's mark to a three-month realized figure would
  // produce something that is neither a period P&L nor a book total — so a
  // window shows what closed inside it, full stop, and says so.
  //
  // The `open` and `unreal` COLUMNS stay visible in every range regardless,
  // because "what is still riding in this category" is a fact about now that a
  // reader wants whichever window they are looking through.
  const openSrc = openByCategory || null;
  const withOpen = !cutoff && !!openSrc;

  const rows = [...new Set([...Object.keys(src), ...Object.keys(openSrc || {})])]
    .map(cat => {
      const v = src[cat] || {};
      const c = v.combined || PM_CAT_NO_CLOSED;
      const o = (openSrc && openSrc[cat]) || PM_CAT_NO_OPEN;
      // `unreal` is what the bars are allowed to add; `o.unrealized` is what the
      // columns always report. They differ inside a window, deliberately.
      const unreal = withOpen ? o.unrealized : 0;
      return {
        cat, c, o, unreal,
        total: c.realizedPnl + unreal,
        stake: c.volume + (withOpen ? o.cost : 0),
        settle: v.settlement || null,
        exit: v.exit || null,
      };
    })
    .filter(r => r.c.n || r.o.n);

  const head = (
    <div className="pf-panel-head">
      <span className="pf-panel-title">attribution · by market type</span>
      <div className="pf-panel-head-right">
        {/* What the bars are, in the slot the pnl chart uses for the same job,
            and directly beside the control that changes it. The bars lose their
            faded segments the moment you leave all-time, and without this the
            only account of why is a scope note below a 300px table — read after
            the numbers, if at all. Scope belongs in front of them. */}
        <span className="pf-panel-meta">
          {withOpen ? 'closed + open mark' : 'closed lots only'}
        </span>
        <div className="pf-range">
          {hasLots && <SzToggle options={PM_CAT_RANGES} value={range}
            onChange={setRange} label={pmRangeLabel}/>}
          {/* the same hairline divider the pnl chart puts between its range and
              unit toggles, so two groups in one head read as two groups */}
          <span className={`pf-unit${hasLots ? ' pf-range-unit' : ''}`}>
            <SzToggle options={[['pnl', 'p&l'], ['volume', 'stake']]}
              value={sort} onChange={setSort}/>
          </span>
        </div>
      </div>
    </div>
  );

  // A window can be legitimately empty: nothing RESOLVED inside it. On a book
  // this long-dated that is a real state, not an error — and returning null
  // would take the range toggle down with the table, stranding the reader in a
  // window with no control left to leave it by.
  if (!rows.length) {
    return (
      <div className="pf-panel">
        {head}
        <div className="pf-contrib-foot pm-cat-scope">
          <span>no lots closed in {pmRangeLabel(range)}</span>
        </div>
      </div>
    );
  }

  rows.sort(sort === 'pnl'
    ? (a, b) => b.total - a.total
    : (a, b) => b.stake - a.stake);

  // Scale on whichever end is further out. A category whose mark has carried it
  // past its realized figure (or back across zero) must not overflow the track.
  const maxAbs = Math.max(
    ...rows.map(r => Math.max(Math.abs(r.c.realizedPnl), Math.abs(r.total))), 1);
  const net = rows.reduce((a, r) => a + r.total, 0);
  const barRows = rows.filter(r =>
    Math.max(Math.abs(r.c.realizedPnl), Math.abs(r.total)) >= maxAbs * PM_CAT_BAR_FLOOR);
  // Track coordinate for a dollar figure: 50% is the zero line, ±50% the edges.
  const at = (v) => 50 + (v / maxAbs) * 50;

  return (
    <div className="pf-panel">
      {head}

      <div className="pf-contrib pm-cat-bars" onMouseLeave={() => setHover(null)}>
        {barRows.map(r => {
          // Two segments on one track. The solid one runs zero -> realized; the
          // faded one carries on from there to the total, so its length IS the
          // mark and its direction says whether the open book is adding to the
          // booked figure or handing it back. When they disagree in sign the
          // faded segment retraces toward zero, which is the honest picture and
          // needs no extra encoding to read.
          const ends = (a, b) => ({ left: `${Math.min(a, b)}%`, width: `${Math.abs(b - a)}%` });
          const realized = ends(50, at(r.c.realizedPnl));
          const mark = ends(at(r.c.realizedPnl), at(r.total));
          const pos = r.total >= 0;
          // The box always hangs BELOW its row, which is the only placement the
          // geometry actually allows: it stands ~140px tall against a list of
          // 20px rows that is 160px from end to end, so there is no row with
          // enough clear space above it — a flip for the lower half would just
          // push the box up through the panel head instead of down. Below, it
          // overlays the table, which costs nothing: it is pointer-transparent
          // and gone the moment the cursor leaves.
          //
          // Anchored on the row's bottom edge rather than the pointer's y so it
          // sits against the bar it describes instead of wobbling. Horizontally
          // it does follow the pointer — that is what gives SzTooltip's clamp
          // something to keep inside the panel.
          const onRow = (e) => {
            const row = e.currentTarget, wrap = row.offsetParent;
            if (!wrap) return;
            setHover({
              cat: r.cat,
              x: e.clientX - wrap.getBoundingClientRect().left,
              y: row.offsetTop + row.offsetHeight,
              W: wrap.clientWidth, H: wrap.clientHeight,
            });
          };
          return (
            <div className="pf-contrib-row" key={r.cat}
              onMouseEnter={onRow} onMouseMove={onRow}>
              <span className={`pf-contrib-sym${r.c.n < PM_CAT_MIN_N ? ' pm-cat-thin' : ''}`}>
                {r.cat}
              </span>
              <div className="pf-contrib-track">
                <div className="pf-contrib-center"/>
                {r.c.realizedPnl !== 0 && (
                  <div className={`pf-contrib-bar ${r.c.realizedPnl >= 0 ? 'pos' : 'neg'}`}
                    style={realized}/>
                )}
                {r.unreal !== 0 && (
                  <div className={`pf-contrib-bar mark ${r.unreal >= 0 ? 'pos' : 'neg'}`}
                    style={mark}/>
                )}
              </div>
              <span className={`pf-contrib-val ${pos ? 'pos' : 'neg'}`}>
                {pos ? '+' : ''}{pmUSD(r.total)}
              </span>
            </div>
          );
        })}
        <div className="pf-contrib-foot">
          <span>
            {rows.length} market types · {rows.reduce((a, r) => a + r.c.n, 0)} lots
            {barRows.length < rows.length && ` · ${rows.length - barRows.length} near zero`}
          </span>
          <span>
            {withOpen ? 'book ' : 'net '}{net >= 0 ? '+' : ''}{pmUSD(net)}
          </span>
        </div>

        {/* The box carries what the bar can't: the dollar split behind its two
            segments, and the size of the position on either side of it. It
            deliberately doesn't repeat edge/pos or roi — those are a column
            scan away in the table below, and a hover that mirrors the table is
            just a second table you have to hold still to read.

            SzTooltip is the chart's own box; handing it a frame measured off
            this container rather than a chart's viewBox gets the same styling
            and, more usefully, the same edge clamping, so a hover on the
            left-hand category names doesn't push it out of the panel. */}
        {hover && (() => {
          const r = barRows.find(b => b.cat === hover.cat);
          if (!r) return null;
          const money = (v) => `${v >= 0 ? '+' : ''}${pmUSD(v)}`;
          const tone = (v) => (v >= 0 ? 'pos' : 'neg');
          return (
            <SzTooltip frame={{ W: hover.W, H: hover.H }} x={hover.x} y={hover.y}
              className="pm-cat-tt below">
              <div className="pm-tt-date">{r.cat}</div>
              <div className={`pm-tt-val ${tone(r.total)}`}>
                {money(r.total)}
                <span className="pm-cat-tt-scope">
                  {withOpen ? 'book' : pmRangeLabel(range)}
                </span>
              </div>
              {r.unreal !== 0 && (
                <div className="pm-cat-tt-split">
                  <div className="pm-cat-tt-row">
                    <span>realized</span>
                    <span className={tone(r.c.realizedPnl)}>{money(r.c.realizedPnl)}</span>
                  </div>
                  <div className="pm-cat-tt-row">
                    <span>marked</span>
                    <span className={tone(r.unreal)}>{money(r.unreal)}</span>
                  </div>
                </div>
              )}
              <div className="pm-cat-tt-split">
                <div className="pm-cat-tt-row">
                  <span>{r.c.n} closed {r.c.n === 1 ? 'lot' : 'lots'}</span>
                  <span>{pmUSD(r.c.volume, true)} staked</span>
                </div>
                <div className="pm-cat-tt-row">
                  <span>{r.o.n ? `${r.o.n} open` : 'nothing open'}</span>
                  <span>{r.o.n ? `${pmUSD(r.o.cost, true)} at risk` : '—'}</span>
                </div>
              </div>
            </SzTooltip>
          );
        })()}
      </div>

      <div className="pf-table-wrap pm-cat-table-wrap">
        <table className="pf-table">
          <thead>
            {/* Two scopes sit in this table and nothing in the column names said
                so: everything under `closed lots` is scored on finished bets,
                everything under `open now` is today's mark and ignores the range
                entirely. The groups are what make that legible — which also
                forced the column order, since a span can only cover columns that
                are already adjacent. The last column stands outside both because
                it is their sum, and it is the one figure here that always equals
                the bar on the same row. */}
            <tr className="pf-table-group">
              <th/>
              <th className="pf-num" colSpan={7}>
                closed lots{cutoff && ` · ${pmRangeLabel(range)}`}
              </th>
              <th className="pf-num" colSpan={3}>open now</th>
              <th/>
            </tr>
            <tr>
              <th>type</th>
              <th className="pf-num">n</th>
              <th className="pf-num">staked</th>
              <th className="pf-num">edge/pos</th>
              <th className="pf-num">roi</th>
              <th className="pf-num">resolved</th>
              <th className="pf-num">swing</th>
              <th className="pf-num">top-1</th>
              <th className="pf-num pm-cat-open">open</th>
              <th className="pf-num pm-cat-open">at risk</th>
              <th className="pf-num pm-cat-open">unreal</th>
              {/* Named for what it sums: the whole book at all-time, and just
                  the window's realized P&L once the mark drops out — the same
                  switch the bar foot makes. */}
              <th className="pf-num">{withOpen ? 'book' : 'p&l'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              // Picking edge is a resolved-market concept (won vs priced); swing
              // lots closed while the outcome was still live have no resolution
              // truth, so read it from the resolved slice only.
              const edge = r.settle ? r.settle.edge : null;
              return (
                <tr key={r.cat} className={r.c.n < PM_CAT_MIN_N ? 'pm-cat-thin-row' : ''}>
                  <td className="pf-sym">{r.cat}</td>
                  {/* A category can be all open book and no closed lots yet, in
                      which case the scored columns have nothing to say — an
                      em-dash, the same as the open columns use when the reverse
                      is true, rather than a 0 and a $0 that read as measured. */}
                  <td className="pf-num">{r.c.n || '—'}</td>
                  <td className="pf-num">{r.c.n ? pmUSD(r.c.volume, true) : '—'}</td>
                  <td className={`pf-num ${edge == null ? '' : (edge >= 0 ? 'pos' : 'neg')}`}
                    title={edge == null ? 'no resolved bets in this type' : undefined}>
                    {edge != null ? (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + 'pp' : '—'}
                  </td>
                  <td className={`pf-num ${r.c.roi == null ? '' : (r.c.roi >= 0 ? 'pos' : 'neg')}`}>
                    {pmPct1(r.c.roi)}
                  </td>
                  <td className={`pf-num ${r.settle ? (r.settle.roi >= 0 ? 'pos' : 'neg') : ''}`}>
                    {r.settle ? pmPct1(r.settle.roi) : '—'}
                  </td>
                  <td className={`pf-num ${r.exit ? (r.exit.roi >= 0 ? 'pos' : 'neg') : ''}`}>
                    {r.exit ? pmPct1(r.exit.roi) : '—'}
                  </td>
                  <td className="pf-num pm-cat-top1">{r.c.top1Share != null ? pmPct0(r.c.top1Share) : '—'}</td>
                  <td className="pf-num pm-cat-open">{r.o.n || '—'}</td>
                  <td className="pf-num pm-cat-open">
                    {r.o.n ? pmUSD(r.o.cost, true) : '—'}
                  </td>
                  <td className={`pf-num ${r.o.n ? (r.o.unrealized >= 0 ? 'pos' : 'neg') : 'pm-cat-open'}`}>
                    {r.o.n ? (r.o.unrealized >= 0 ? '+' : '') + pmUSD(r.o.unrealized, true) : '—'}
                  </td>
                  <td className={`pf-num pm-cat-book ${r.total >= 0 ? 'pos' : 'neg'}`}>
                    {r.total >= 0 ? '+' : ''}{pmUSD(r.total, true)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Scope. At all-time the bars carry the whole book — realized lots plus
          the mark on what is still open — which is what reconciles this panel
          with the headline trading P&L (closed + open ≈ headline, the remainder
          being fees). The two sitting adjacent and unequal read as a
          contradiction before the open half was in here.

          Inside a window they cannot both be shown: the realized side slices by
          close date and the mark has no date to slice by. So a window drops back
          to closed lots. The `open`/`at risk`/`unreal` columns keep reporting
          now either way — they answer "what is still riding", not "what happened
          in the window".

          Which of the two is on screen is the head meta's job, above the bars.
          This line carries what that caption can't fit: which KINDS of lot are
          in scope, and — in a window — why the open figure on its right is not
          in the bars on its left. */}
      {openBook && (
        <div className="pf-contrib-foot pm-cat-scope">
          <span>
            {withOpen
              ? 'resolved, swing or live'
              : `resolved or swing · ${pmRangeLabel(range)}, open book excluded`}
          </span>
          <span>
            {openBook.n} open{' '}
            <b className={openBook.unrealized >= 0 ? 'pos' : 'neg'}>
              {openBook.unrealized >= 0 ? '+' : ''}{pmUSD(openBook.unrealized)}
            </b>
          </span>
        </div>
      )}

    </div>
  );
}

// ---------- calibration / hit-rate reliability diagram ----------
// Win rate bucketed by implied entry odds. The 45° line is perfect calibration:
// a point on it means the price was fair; above = the side won more often than it
// was priced for (edge); below = overpaid. 'resolved' lots (outcome determined —
// held to resolution, or sold at >=99.8c/<=0.2c into a market that resolved) are
// the true calibration test. 'swing' lots (closed while the outcome was still
// live, "win" = closed in profit) are a hit-rate view whose wins sit above the
// diagonal by construction — so the two are a toggle, never a blend. From the
// polymarket-calibration daily cron.
const PM_CAL_TEAL = '#5eead4';   // the diagonal / reference
const PM_CAL_GOOD = '#ff6ec4';   // won more than priced
const PM_CAL_UNDER = '#a78bfa';  // won less than priced

function pmPct0(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
function pmPct1(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }

function PmCalScatter({ buckets }) {
  const svgRef = usePmRef(null);
  const [hover, setHover] = usePmState(null);
  const pts = (buckets || []).filter(b => b.n > 0 && b.winRate != null);
  if (pts.length < 2) return null;
  // Bubbles are sized by gross P&L — wins plus losses, unsigned — not by position
  // count: 8 lottery tickets at $2 and 8 five-figure bets are the same dot under
  // count-weighting, which reads the wrong way when the money is this lopsided.
  // Gross rather than $ staked or net: staked inflates buckets you only parked
  // money in, and net would shrink a busy bucket whose wins and losses happened
  // to cancel down to nothing. Area scales with the weight (radius ~ sqrt), so a
  // bucket's ink matches its share of the money that actually moved.
  // grossPnl postdates the panel, so fall back to cost basis if a stale
  // calibration payload is still in front of a fresh bundle.
  const wOf = (b) => (b.grossPnl != null ? b.grossPnl : b.volume) || 0;
  const maxW = Math.max(...pts.map(wOf)) || 1;
  // Wide plot. viewBox aspect must equal the container's, since preserveAspectRatio
  // is "none" — otherwise the non-uniform stretch would squash the bubbles into
  // ellipses. Radius stays in viewBox units and scales uniformly.
  const VW = 920, VH = 460, PAD = 44;
  const x = (p) => PAD + p * (VW - 2 * PAD);
  const y = (p) => (VH - PAD) - p * (VH - 2 * PAD);
  const rOf = (w) => 5 + 15 * Math.sqrt(w / maxW);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div style={{ width: '100%' }}>
      <div className="pm-chart-wrap" style={{ aspectRatio: `${VW} / ${VH}` }}>
        <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} className="pf-navchart"
          preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}>
          {/* grid + axes */}
          {ticks.map(t => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} stroke="rgba(229,225,241,0.07)"/>
              <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="rgba(229,225,241,0.07)"/>
            </g>
          ))}
          {/* perfect-calibration diagonal — solid, matching the normal reference
              on the return histogram. Same duty-cycle correction: a 4/4 dash was
              half ink, so opacity drops to keep the weight it had. */}
          <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)}
            stroke={PM_CAL_TEAL} strokeWidth="1" opacity="0.45"/>
          {/* wilson error bars */}
          {pts.map((b, k) => (
            <line key={'e' + k} x1={x(b.avgImplied)} x2={x(b.avgImplied)}
              y1={y(b.wilsonLo)} y2={y(b.wilsonHi)}
              stroke="rgba(229,225,241,0.28)" strokeWidth="1"/>
          ))}
          {/* bucket bubbles — sized by gross P&L, colored by edge sign. Painted
              biggest first so a dominant bucket can't bury a small one and take
              its hover target with it. */}
          {pts.map((b, k) => k)
            .sort((a, k) => wOf(pts[k]) - wOf(pts[a]))
            .map(k => {
              const b = pts[k];
              const edge = b.winRate - b.avgImplied;
              const c = edge >= 0 ? PM_CAL_GOOD : PM_CAL_UNDER;
              const active = hover === k;
              return (
                <g key={k} onMouseEnter={() => setHover(k)} style={{ cursor: 'pointer' }}>
                  <circle cx={x(b.avgImplied)} cy={y(b.winRate)} r={rOf(wOf(b))}
                    fill={c} fillOpacity={active ? 0.5 : 0.28}
                    stroke={c} strokeWidth={active ? 1.75 : 1}/>
                </g>
              );
            })}
        </svg>

        {/* axis labels — x = implied (priced) odds, y = actual win rate */}
        <div className="pf-axis-x">
          {ticks.map((t, i) => (
            <span key={i} className={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : ''}
              style={{ left: `${(x(t) / VW) * 100}%` }}>{Math.round(t * 100)}%</span>
          ))}
        </div>
        {ticks.filter(t => t > 0).map(t => (
          <span key={'y' + t} style={{
            position: 'absolute', left: 2, top: `${(y(t) / VH) * 100}%`,
            transform: 'translateY(-50%)', fontSize: '0.6rem',
            color: 'rgba(229,225,241,0.4)', pointerEvents: 'none',
          }}>{Math.round(t * 100)}%</span>
        ))}
        <span style={{
          position: 'absolute', left: 2, top: 6, fontSize: '0.6rem',
          letterSpacing: '0.05em', color: 'rgba(229,225,241,0.55)', pointerEvents: 'none',
        }}>won ↑</span>
        <span style={{
          position: 'absolute', right: 8, bottom: '11%', fontSize: '0.6rem',
          letterSpacing: '0.05em', color: 'rgba(229,225,241,0.55)', pointerEvents: 'none',
        }}>priced odds →</span>

        {hover != null && pts[hover] && (() => {
          const b = pts[hover];
          const edge = b.winRate - b.avgImplied;
          return (
            <SzTooltip frame={{ W: VW, H: VH }} x={x(b.avgImplied)} y={y(b.winRate)}
              className="cmb-tooltip">
              <div className="pm-tt-date">{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}¢ · {b.n} positions{b.pushes ? ` · ${b.pushes} push` : ''}</div>
              <div className="cmb-tt-row">staked<span className="cmb-tt-num">{pmUSD(b.volume, true)}</span></div>
              {b.grossPnl != null && (
                <div className="cmb-tt-row">gross P&L<span className="cmb-tt-num">{pmUSD(b.grossPnl, true)}</span></div>
              )}
              {b.realizedPnl != null && (
                <div className="cmb-tt-row">net P&L<span className={`cmb-tt-num ${b.realizedPnl >= 0 ? 'pos' : 'neg'}`}>{pmUSD(b.realizedPnl, true)}</span></div>
              )}
              <div className="cmb-tt-row">won<span className="cmb-tt-num">{pmPct1(b.winRate)}</span></div>
              <div className="cmb-tt-row">priced<span className="cmb-tt-num">{pmPct1(b.avgImplied)}</span></div>
              <div className="cmb-tt-row">edge<span className={`cmb-tt-num ${edge >= 0 ? 'pos' : 'neg'}`}>{(edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + 'pp'}</span></div>
            </SzTooltip>
          );
        })()}
      </div>
      <div className="pf-bench-legend" style={{ justifyContent: 'center' }}>
        <span><i className="pf-bench-swatch" style={{ background: PM_CAL_TEAL }}/>fair (45°)</span>
        <span><i className="pf-bench-swatch" style={{ background: PM_CAL_GOOD }}/>won &gt; priced</span>
        <span><i className="pf-bench-swatch" style={{ background: PM_CAL_UNDER }}/>won &lt; priced</span>
        <span className="sz-dim">bubble = gross P&L (win + loss) · bar = 95% ci</span>
      </div>
    </div>
  );
}

function PmCalibration({ cal }) {
  const [series, setSeries] = usePmState('settlement');
  if (!cal || !cal.buckets) return null;
  const h = (cal.headline && cal.headline[series]) || {};
  const buckets = cal.buckets[series] || [];
  const hasExit = cal.headline && cal.headline.exit && cal.headline.exit.n;
  if (!h.n) return null;

  return (
    <div className="pf-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">calibration · win rate vs implied odds</span>
        <div className="pf-range">
          <SzToggle
            options={[['settlement', 'resolved']].concat(hasExit ? [['exit', 'swing trades']] : [])}
            value={series} onChange={setSeries}/>
        </div>
      </div>

      <div className="pf-stats">
        <PmStat label="hit rate" value={pmPct0(h.hitRate)}
          tone={series === 'settlement' ? undefined : (h.hitRate >= 0.5 ? 'pos' : 'neg')}
          kicker={`${h.n} resolved positions${h.pushes ? ` · ${h.pushes} push` : ''}`}/>
        {series === 'settlement' && (
          <>
            <PmStat label="brier" value={h.brier != null ? h.brier.toFixed(3) : '—'} kicker="lower = sharper · 0 is perfect"/>
            <PmStat label="edge · per position"
              value={h.edge != null ? `${h.edge >= 0 ? '+' : ''}${(h.edge * 100).toFixed(1)}pp` : '—'}
              tone={h.edge != null ? (h.edge >= 0 ? 'pos' : 'neg') : undefined}
              kicker="won − priced · position-weighted"/>
          </>
        )}
        <PmStat label="edge · per $"
          value={h.roi != null ? `${h.roi >= 0 ? '+' : ''}${(h.roi * 100).toFixed(1)}%` : '—'}
          tone={h.roi != null ? (h.roi >= 0 ? 'pos' : 'neg') : undefined}
          kicker={`realized per $ staked · ${series === 'settlement' ? 'outcome determined' : 'closed while live'}`}/>
      </div>

      <PmCalScatter buckets={buckets}/>

      {series === 'settlement' && (
        <div className="pf-panel-head" style={{ marginTop: 4 }}>
          <span className="pf-panel-meta">
            positions whose outcome was determined — held to resolution, or sold at ≥99.8¢/≤0.2¢ into a market that resolved. the true calibration test
          </span>
        </div>
      )}
    </div>
  );
}

// ---------- lot tape: realized P&L one position at a time ----------
// The calibration panel scores the averages; this draws what the averages are
// made of. Every closed lot is one step of equal width, in the order the lots
// closed, so a buy-the-favorite book reads as what it is: a long staircase of
// small wins and a few cliffs. Width is per position, not per day, on purpose —
// on a date axis a quiet month and a busy one would draw the same, and the
// texture of the steps is the whole reading.
//
// Steps rather than a spline: a lot lands all at once, and a smoothed cliff
// would draw P&L that accrued across positions that never carried it.
//
// Lots only carry a date, so within a day the feed's own order stands (the sort
// is stable). That can reorder same-day steps but never moves where a day ends.
const PM_TAPE_FRAME = szFrame(220, 20, 32);

// Everything that depends only on the lots, not the pointer. The hover state
// lives in the same component, so without this every mousemove rebuilt a path
// of one segment per lot.
function pmTapeGeometry(F, lots) {
  const n = lots.length + 1;   // a leading $0 point, so the first lot is a step too
  const run = [0];
  for (const l of lots) run.push(run[run.length - 1] + l.realizedPnl);
  const { y0, y1, lo: min, hi: max } = szDomain(run, { pad: 0.08, floor: 1, min: 0 });
  const { x, y } = szScales(F, n, y0, y1);
  let line = `M${x(0).toFixed(2)},${y(0).toFixed(2)}`;
  for (let i = 1; i < n; i++) line += ` H${x(i).toFixed(2)} V${y(run[i]).toFixed(2)}`;
  const area = szAreaPath(line, x(0), x(n - 1), F.H - F.PAD_B);
  return { n, run, min, max, x, y, line, area };
}

function PmLotTape({ lots }) {
  const F = PM_TAPE_FRAME;
  const hv = useChartHover(F);
  const geo = usePmMemo(() => (lots.length < 2 ? null : pmTapeGeometry(F, lots)), [lots]);
  if (!geo) return null;
  const { n, run, min, max, x, y, line, area } = geo;

  // At ~1.4 viewBox units a step, the nearest index is almost never the cliff
  // the pointer is sitting on. So the hover reads the biggest move within a
  // hair of the pointer (~1% of the width either side) — the cliffs are what a
  // reader reaches for, and a small win beside one is still reachable by
  // moving off it.
  const reach = Math.max(1, Math.round(lots.length * 0.008));
  let hi = null;
  // `hv.i < n`: a hover index from a longer window can outlive the switch to a
  // shorter one for a render.
  if (hv.i != null && hv.i < n) {
    hi = Math.max(1, hv.i);
    for (let k = Math.max(1, hv.i - reach); k <= Math.min(n - 1, hv.i + reach); k++) {
      if (Math.abs(lots[k - 1].realizedPnl) > Math.abs(lots[hi - 1].realizedPnl)) hi = k;
    }
  }
  const lot = hi != null ? lots[hi - 1] : null;

  const maxIdx = run.indexOf(max);
  const minIdx = run.indexOf(min);
  const first = lots[0].closedOn, last = lots[lots.length - 1].closedOn;
  const axisMode = pmSpanDays(first, last) <= 95 ? 'day'
    : (first.slice(0, 4) === last.slice(0, 4) ? 'month' : 'monthyear');
  // The axis is positions, not time, so evenly spaced ticks land on whatever
  // dates the busy stretches happen to hold — two "Jun 26"s side by side. Tick
  // the first lot of each new label instead, dropping any that would crowd the
  // one before it: the gaps between them then say how busy each month was.
  // 16% is sized for a phone, where a "Mar 26" is ~13% of the plot.
  const ticks = [];
  lots.forEach((l, k) => {
    const label = pmAxisLabel(l.closedOn, axisMode);
    const prev = k ? pmAxisLabel(lots[k - 1].closedOn, axisMode) : null;
    if (label === prev) return;
    if (ticks.length && (k + 1 - ticks[ticks.length - 1].i) / n < 0.16) return;
    ticks.push({ i: k + 1, d: l.closedOn });
  });
  const signed = (v) => (v >= 0 ? '+' : '') + pmUSD(v);

  return (
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={n} className="pf-navchart pm-chart-svg">
        <SzChartDefs ramp="nav" id="pm-tape"/>
        <SzRule frame={F} y={y(0)} stroke="rgba(229,225,241,0.1)"/>
        <path d={area} fill="url(#pm-tape-fill)"/>
        <path d={line} fill="none" stroke="url(#pm-tape-stroke)" strokeWidth="1.25"
          strokeLinejoin="round"/>
        {max > 0 && <circle cx={x(maxIdx)} cy={y(max)} r="2.5" fill="#a78bfa" opacity="0.7"/>}
        {min < 0 && <circle cx={x(minIdx)} cy={y(min)} r="2.5" fill="#ff9ae8" opacity="0.7"/>}
        {lot && <SzCrosshair frame={F} x={x(hi)} cy={y(run[hi])}
          fill={lot.realizedPnl >= 0 ? '#ff4fd8' : '#a78bfa'}/>}
      </SzChartSvg>

      {max > 0 && <div className="pm-peak" style={{ left: `${(x(maxIdx) / F.W) * 100}%`, top: `${(y(max) / F.H) * 100}%` }}>peak {pmUSDCompact(max)}</div>}
      {min < 0 && <div className="pm-trough" style={{ left: `${(x(minIdx) / F.W) * 100}%`, top: `${(y(min) / F.H) * 100}%` }}>trough {pmUSDCompact(min)}</div>}
      <SzAxisZero frame={F} y={y(0)}>$0</SzAxisZero>
      {/* Not SzAxisX: that pins its last tick's label to end at the tick, which
          is right for a series' final day and wrong here, where the last month
          boundary can sit anywhere — "Sep 26" would read as the stretch before
          September. Only a tick actually near an edge is pulled inside. */}
      <div className="pf-axis-x">
        {ticks.map(t => (
          <span key={t.i}
            className={t.i <= 1 ? 'start' : t.i / n > 0.94 ? 'end' : ''}
            style={{ left: `${(x(t.i) / F.W) * 100}%` }}>{pmAxisLabel(t.d, axisMode)}</span>
        ))}
      </div>

      {lot && (
        <SzTooltip frame={F} x={x(hi)} y={y(run[hi])} className="cmb-tooltip">
          <div className="pm-tt-date">{fmtDate(lot.closedOn)} · {lot.category} · {lot.resolvedVia === 'settlement' ? 'resolved' : 'swing'}</div>
          <div className="pm-tt-market">
            {lot.market || lot.category}{lot.market && lot.outcome ? ` · ${lot.outcome}` : ''}
          </div>
          <div className="cmb-tt-row">entry<span className="cmb-tt-num">{(lot.impliedEntry * 100).toFixed(1)}¢</span></div>
          <div className="cmb-tt-row">staked<span className="cmb-tt-num">{pmUSD(lot.volume, true)}</span></div>
          {/* won/lost only where the market decided it; a swing trade was sold. */}
          <div className="cmb-tt-row">{lot.push ? 'push' : lot.resolvedVia === 'exit' ? 'sold' : lot.win ? 'won' : 'lost'}<span className={`cmb-tt-num ${lot.realizedPnl >= 0 ? 'pos' : 'neg'}`}>{signed(lot.realizedPnl)}</span></div>
          <div className="cmb-tt-row">running<span className={`cmb-tt-num ${run[hi] >= 0 ? 'pos' : 'neg'}`}>{signed(run[hi])}</span></div>
        </SzTooltip>
      )}
    </div>
  );
}

// One quarter per view by default. A whole book is ~700 steps into a plot a
// phone draws ~320px wide, so a step is under a pixel and no single small
// position can be read or hovered; a quarter keeps that to a few hundred.
// Each quarter restarts at $0, so its line ends on what that quarter booked.
//
// A quarter only gets a button once it holds PM_CAT_MIN_N lots — the same
// floor the attribution panel dims thin rows below. The 2025 quarters held
// under ten each; as buttons they would be the bulk of the strip and the least
// of the book. They are still in `all`.
const pmLotQuarter = (d) => `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;

// Resolved and swing lots on one line. The calibration panel keeps them apart
// because a swing "win" is a profitable sale, not a correct forecast, so the
// two can't share a hit rate. Dollars have no such problem: a swing trade's
// P&L is as realized as a settlement's, and a tape of only one kind would skip
// steps the book really took. The tooltip still says which kind each lot was.
function PmLotTapePanel({ cal }) {
  const [picked, setPicked] = usePmState(null);   // null = newest quarter
  const allLots = usePmMemo(() => ((cal && cal.lots) || [])
    .map(pmLotRow)
    .filter(l => l.closedOn)
    .map((l, k) => [l, k])
    .sort((a, b) => (a[0].closedOn < b[0].closedOn ? -1 : a[0].closedOn > b[0].closedOn ? 1 : a[1] - b[1]))
    .map(([l]) => l), [cal]);

  const counts = {};
  for (const l of allLots) { const q = pmLotQuarter(l.closedOn); counts[q] = (counts[q] || 0) + 1; }
  const quarters = Object.keys(counts).filter(q => counts[q] >= PM_CAT_MIN_N).sort();
  // A remembered pick that no longer has a button (the file changed under an
  // open page) falls back to the newest, rather than highlighting nothing.
  const q = picked === 'all' || quarters.includes(picked)
    ? picked : (quarters[quarters.length - 1] || 'all');
  const lots = usePmMemo(() => (q === 'all'
    ? allLots : allLots.filter(l => pmLotQuarter(l.closedOn) === q)), [allLots, q]);

  // The quarter still running reads "qtd", as it does on every range strip on
  // the site: "q3 26" on a half-finished quarter would read as its full result.
  const asOf = (cal && cal.generatedAt || '').slice(0, 10);
  const running = asOf ? pmLotQuarter(asOf) : null;
  const qLabel = (k) => k === running ? 'qtd' : window.szQuarterLabel(k);

  if (allLots.length < 2) return null;

  return (
    <div className="pf-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">realized pnl · position by position</span>
        <div className="pf-panel-head-right">
          <span className="pf-panel-meta">{lots.length} positions in closing order · one step each</span>
          <div className="pf-range">
            <SzToggle options={[...quarters.map(k => [k, qLabel(k)]), ['all', 'all-time']]}
              value={q} onChange={setPicked}/>
          </div>
        </div>
      </div>
      <PmLotTape lots={lots}/>
    </div>
  );
}

// ---------- Rewards accrual (market-making income over time) ----------
// Two lines, each grouping the betmoar breakdown's income fields by the activity
// that earned them, over the breakdown history. These are steady positive
// streams, distinct from swingy trading P&L. Each line is re-based to the first
// tracked day (see below), so every group starts at 0 and shows what it has
// earned since tracking began. Total carries the brand pink and the gradient
// stroke; lp takes the neutral near-white total used to hold. The headline line
// should be the one wearing the house color — the groups are components of it,
// not peers.
const PM_REWARD_PARTS = [
  // Sponsored rewards are liquidity rewards a market's sponsor funds rather than
  // Polymarket — same quoting that earns `lp`, so they ride the same line.
  { key: 'lp', label: 'lp', color: '#f5f0ff', fields: ['lp', 'sponsored'] },
  // Both sides of the fee rebate: maker rebates plus taker rebates (and the
  // backpay betmoar reports when a rebate period settles late). "maker" stopped
  // being the honest label once the taker side was in there.
  { key: 'rebates', label: 'rebates', color: '#a78bfa', fields: ['maker', 'taker'] },
];
const pmRewardPart = (r, fields) => fields.reduce((s, f) => s + (r[f] || 0), 0);
// Total still counts every income stream (incl. the tiny yield one we no longer
// chart on its own), so it sits just above lp + rebates.
function pmRewardsTotal(r) {
  return (r.lp || 0) + (r.maker || 0) + (r.taker || 0)
    + (r.yield || 0) + (r.sponsored || 0);
}
const PM_REWARDS_FRAME = szFrame(200, 16, 14);

function PmRewardsChart({ rows }) {
  const F = PM_REWARDS_FRAME;
  const hv = useChartHover(F);
  if (!rows || rows.length < 2) return null;
  // The betmoar figures are cumulative *lifetime* totals, and the snapshot cron
  // only started on rows[0].d — so lifetime rewards were already well above zero
  // on day one. Re-base each source to that first tracked day so its line reads
  // as earned-since-tracking-began, starting at 0.
  const first = rows[0];
  const lines = [
    ...PM_REWARD_PARTS.map(p => ({
      ...p,
      series: rows.map(r => ({
        d: r.d, v: pmRewardPart(r, p.fields) - pmRewardPart(first, p.fields),
      })),
    })),
    // `stroke` overrides `color` for the line only — dots, legend swatch and
    // tooltip text still need a flat color a gradient url cannot provide.
    { key: 'total', label: 'total', color: '#ff4fd8', stroke: 'url(#pm-rewards-stroke)',
      fill: 'url(#pm-rewards-fill)', width: 1.9,
      series: rows.map(r => ({ d: r.d, v: pmRewardsTotal(r) - pmRewardsTotal(first) })) },
  ];
  // The total is the headline three ways: drawn last so it sits on top of its
  // own components, read first in the tooltip, and the curve the tooltip box
  // rides. The parts follow it in the order the legend lists them.
  const totalLine = lines[lines.length - 1];
  const ttLines = [totalLine, ...lines.slice(0, -1)];
  const n = rows.length;
  const allV = lines.flatMap(l => l.series.map(p => p.v));
  // Asymmetric on purpose: these are cumulative income curves rebased to 0 on
  // the first tracked day, so they only go up. The floor is the zero line
  // itself — padding underneath it would float the whole band off its baseline
  // — while the ceiling gets headroom for the topmost label.
  const min = Math.min(...allV, 0), max = Math.max(...allV);
  const y0 = min, y1 = max + ((max - min) * 0.1 || 1);
  const { x, y } = szScales(F, n, y0, y1);
  const path = (s) => smoothPath(s.map((_, i) => x(i)), s.map(p => y(p.v)));

  return (
    <React.Fragment>
    <div className="pm-chart-wrap">
      <SzChartSvg frame={F} hover={hv} n={n}>
        <SzChartDefs ramp="rewards" id="pm-rewards"/>
        <SzRule frame={F} y={y(0)} stroke="rgba(229,225,241,0.08)"/>
        {/* Crosshair below the curves and its dots above them, so the hairline
            never cuts across a line it is meant to be reading. */}
        {hv.i != null && <SzCrosshairLine frame={F} x={x(hv.i)}/>}
        {/* Area under the total only — one filled band, so the component lines
            stay legible on top of it rather than three washes overlapping. */}
        {lines.filter(l => l.fill).map(l => (
          <path key={`${l.key}-fill`}
            d={szAreaPath(path(l.series), x(0), x(n - 1), y(0))}
            fill={l.fill}/>
        ))}
        {lines.map(l => (
          <path key={l.key} d={path(l.series)} fill="none"
            stroke={l.stroke || l.color} strokeWidth={l.width || 1.5}/>
        ))}
        {hv.i != null && lines.map(l => (
          <circle key={l.key} cx={x(hv.i)} cy={y(l.series[hv.i].v)} r="3.5"
            fill={l.color} stroke="#f5f0ff" strokeWidth="1"/>
        ))}
      </SzChartSvg>
      {/* Anchored to the total rather than pinned at a fixed height: the box
          climbs with the curve it leads with, so the figure and the point it
          reads off never drift apart. The total is the topmost curve, so it is
          also the anchor that keeps the box clear of the other two. */}
      {hv.i != null && (
        <SzTooltip frame={F} x={x(hv.i)} y={y(totalLine.series[hv.i].v)}>
          <div className="pm-tt-date">{rows[hv.i].d}</div>
          {ttLines.map(l => (
            <div key={l.key} className="pf-tt-bench" style={{ color: l.color }}>
              {l.label} +{pmUSD(l.series[hv.i].v)}
            </div>
          ))}
        </SzTooltip>
      )}
    </div>
    <div className="pf-bench-legend">
      {lines.map(l => (
        <span key={l.key}>
          <i className="pf-bench-swatch" style={{ background: l.color }}/>{l.label}
          {' '}<b style={{ color: 'var(--fg-2)', fontWeight: 500 }}>+{pmUSD(l.series[n - 1].v)}</b>
        </span>
      ))}
    </div>
    </React.Fragment>
  );
}

// Kicker for the two figures that read off the pnl series. The figure itself is
// only blanked when there is no series at all; a snapshot-backed one is real and
// says where it came from, so a later refinement by the live call doesn't read
// as the page having lied.
function pmPnlKicker(base, hasPnl, stale, pending) {
  if (!hasPnl) return pending ? 'loading pnl series' : 'pnl series unavailable';
  if (!stale) return base;
  return pending ? `${base} · daily snapshot, refreshing` : `${base} · daily snapshot`;
}

// ---------- main view ----------
function Polymarket() {
  const [data, setData] = usePmState(null);
  const [err, setErr] = usePmState(null);
  const [cal, setCal] = usePmState(null);
  const [hist, setHist] = usePmState(null);
  // Daily Polymarket NAV — read only as the denominator for percent mode.
  const [navRows, setNavRows] = usePmState(null);
  // The manual IBKR->Polymarket transfer ledger. Read only past the book-value
  // seam, where money moved in would otherwise walk into the curve as money
  // earned. Inert before it, and inert on any day with no transfer.
  const [pmTransfers, setPmTransfers] = usePmState(null);
  // Defaults to the trailing year like the ibkr and book charts — the
  // lifetime curve is still one click away under MAX.
  const [range, setRange] = usePmState('1Y');
  // Dollars by default, and unlike the other two views this governs the chart
  // panel alone — which is why the switch lives in that panel's head rather
  // than the page's. The tiles above are lifetime figures whose window reaches
  // back past PM_PCT_START by definition, so they have no honest percent and
  // stay in dollars under both settings.
  // Remembered under its own key rather than the page-wide one the other two
  // views share: a reader who set the book view to percent has said nothing
  // about this panel, whose percent covers a shorter history than its dollars.
  const [unit, setUnit] = window.useKeptState(
    'unit.pm', 'usd', window.SZ_UNIT_VALUES);
  // The timeframe percent stepped down from, so switching back restores it
  // rather than stranding the reader on the shorter window.
  const [usdRange, setUsdRange] = usePmState(null);

  usePmEffect(() => {
    let canceled = false;
    pmFetchAll(d => { if (!canceled) setData(d); })
      .then(d => { if (!canceled) setData(d); })
      .catch(e => {
        if (canceled) return;
        // Live fetch failed — fall back to expired cache rather than a blank
        // error. The breakdown is still refetched, so the daily figures are
        // current even when the live wallet calls are down.
        const stale = pmReadCache({ ignoreAge: true });
        if (stale) {
          pmViewFromCache(stale)
            .then(d => { if (!canceled) setData(d); })
            .catch(() => { if (!canceled) setErr(String(e.message || e)); });
          return;
        }
        setErr(String(e.message || e));
      });
    // Calibration dataset (polymarket-calibration daily cron). Best-effort and
    // independent of the live fetch — the panel renders only when present.
    window.szJson('data/polymarket-calibration.json')
      .then(j => { if (!canceled && j) setCal(j); })
      .catch(() => {});
    // Rewards-accrual history (betmoar breakdown daily cron). Best-effort; the
    // panel renders only when the history file is present. Row dates are restated
    // to close-of-day here so the income curve, the accrual chart and the "since"
    // captions all read the same convention as the P&L series.
    window.szJson('data/polymarket-breakdown-history.json')
      .then(j => {
        if (canceled || !j) return;
        setHist({ ...j, rows: window.szPmDateSnapshotRows(j.rows) });
      })
      .catch(() => {});
    // NAV history rides the same ~08:45 UTC betmoar scrape as the breakdown
    // history, so its rows get the same date restatement — a denominator read
    // off the wrong day would shift every return in percent mode.
    window.szJson('data/polymarket-nav-history.json')
      .then(j => {
        if (canceled || !j || !Array.isArray(j.rows)) return;
        setNavRows(window.szPmDateSnapshotRows(j.rows));
      })
      .catch(() => {});
    // Same ledger the book view reads for its benchmark notional; here it is the
    // flow term in the book-value walk.
    window.szJson('data/content.json')
      .then(j => {
        if (canceled || !j) return;
        setPmTransfers(j.pmTransfers || []);
      })
      .catch(() => {});
    return () => { canceled = true; };
  }, []);

  // A remembered percent arrives without passing through onUnit, so the
  // step-down that lives there runs here instead — once the feed that decides
  // which timeframes percent can cover has landed. Above the early returns
  // below because it is a hook; the panel that would be the natural home for it
  // is drawn only after those.
  usePmEffect(() => {
    const rows = data && data.pnlSeries;
    const lastD = (rows && rows.length) ? rows[rows.length - 1].d : null;
    if (unit !== 'pct' || !lastD || pmPctRangeOk(range, lastD)) return;
    setUsdRange(range);
    setRange(pmPctFallback(lastD));
  }, [data, unit, range]);

  // The feed stops being the source at the seam and becomes the check. Past it
  // the two are measuring the same book by different routes, so a large gap is
  // information: either polymarket is mis-marking a conversion again, or capital
  // moved into the account without reaching the transfer ledger. The second is
  // the standing cost of pricing P&L off book value — money that arrives reads as
  // money earned — and it is silent in every other reading on the page.
  //
  // Threshold is ~4x the day-to-day residual between the two routes ($757 sd over
  // the 41 days both were recorded), so ordinary mark disagreement stays quiet.
  usePmEffect(() => {
    if (!data || !hist) return;
    const d = window.szPmBookDivergence(data.pnlSeries, hist.rows, pmTransfers);
    if (d && Math.abs(d.gap) > PM_BOOK_GAP_WARN) {
      console.warn(
        `[polymarket] user-pnl and book value disagree by $${d.gap.toLocaleString()} ` +
        `at ${d.d} (feed ${d.feed}, book ${d.book}). Either a mis-marked ` +
        `conversion, or a transfer missing from content.json pmTransfers.`);
    }
  }, [data, hist, pmTransfers]);

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ polymarket</div>
      <h2 className="sz-h2">couldn't reach polymarket.</h2>
      <p><code>{err}</code></p>
      <p className="sz-dim">data-api.polymarket.com may be rate-limiting or down. refresh in a minute.</p>
    </section>
  );
  if (!data) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ polymarket · live</div>
      <h2 className="sz-h2">fetching positions<Cursor /></h2>
    </section>
  );

  const { profile, summary, positions, activity, breakdown } = data;
  // Past the seam the feed's own tail is unusable — a neg-risk conversion
  // corrupts it until the market closes — so the curve is walked off book value
  // from there (szPmBookExtend). Everything downstream reads this one series:
  // the three P&L figures, the income curve, the chart and its windows. Applying
  // it here rather than in each consumer is what stops one of them being left on
  // the raw feed and quietly disagreeing with the rest.
  const pnlSeries = window.szPmBookExtend(
    data.pnlSeries, hist && hist.rows, pmTransfers);
  // Whether there is a series to draw at all, and whether the one being drawn is
  // the daily snapshot with the live call still out. Only the first gates the
  // P&L figures — the second just labels them, since a snapshot is the same
  // quantity from the same feed, hours old rather than absent.
  const hasPnl = !!(pnlSeries && pnlSeries.length);
  const pnlStale = data.pnlSource === 'snapshot';
  const pnlPending = !!data.pnlPending;
  // Nothing to draw yet: the live series is still out and no snapshot answered.
  const pnlHolding = !hasPnl && pnlPending;
  // Show the second wallet in the header pill (matches the profile/betmoar links below).
  const displayWallet = (profile.wallets && profile.wallets[1]) || profile.wallet;
  const updated = new Date(data.generatedAt);
  const updatedStr = updated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  // Authoritative lifetime P&L = last point of user-pnl series (trading only).
  // Null, not a fallback, when there is no series: the only other figures to
  // hand are the open book's, and realized-on-open + unrealized is a different
  // quantity — it misses every closed market, which is most of the history. It
  // read as the lifetime number while being thousands out.
  const lifetimePnl = hasPnl ? pnlSeries[pnlSeries.length - 1].v : null;
  // True realized = lifetime − unrealized (settled P&L across all markets, open + closed).
  const realizedTotal = lifetimePnl == null ? null : lifetimePnl - summary.unrealizedPnl;
  // All-source total = trading + LP + rebates + yield + sponsored + uma − fees.
  // pnlSeries (used as lifetimePnl) is gross of trading fees, so net them here.
  const bdExtra = pmRewardsNet(breakdown);
  const totalPnl = lifetimePnl == null ? null : lifetimePnl + bdExtra;

  // Sparkline series: trading pnl plus the all-source income curve, so it ends
  // at totalPnl and matches the headline. Dated from the breakdown history where
  // that reaches; only the pre-history remainder is an even ramp.
  //
  // pnlSeries is already past pmTrimFlat, so its first date *is* the day the
  // book started being P&L history — the same anchor szPnlLifeStartDay hands the
  // book view off the raw feed.
  const rewardsSeam = (hist && hist.rows && hist.rows.length) ? hist.rows[0].d : null;
  const sparkSeries = (pnlSeries && pnlSeries.length > 1 && bdExtra)
    ? (() => {
        const rw = pmRewardsCurve(pnlSeries.map(p => p.d), hist, bdExtra,
          window.szEpochDay(pnlSeries[0].d));
        return pnlSeries.map((p, i) => ({ ...p, v: +(p.v + rw[i]).toFixed(2) }));
      })()
    : pnlSeries;

  // Chart window. Rewards are spread across the *lifetime* timeline before the
  // slice, so a window shows the share of them that accrued inside it.
  const winSeries = pmWindow(sparkSeries, range);

  // ---- percent mode ----
  // Every window is trimmed at PM_PCT_START, so MAX in percent means "since
  // jun 1" rather than a lifetime TWR whose early denominators are guesses.
  const navAt = pmNavLookup(navRows);
  const lastD = (pnlSeries && pnlSeries.length) ? pnlSeries[pnlSeries.length - 1].d : null;
  const pctRangeOk = (r) => pmPctRangeOk(r, lastD);
  const pctSlice = (winSeries || []).filter(p => p.d >= PM_PCT_START);
  const twrSeries = navAt ? pmTwrSeries(pctSlice, navAt) : null;
  // Percent is only offered when there is a denominator for every day of it.
  const pctReady = !!(twrSeries && twrSeries.length > 1);
  const pct = unit === 'pct' && pctReady;
  const chartSeries = pct ? twrSeries : winSeries;
  const shownRanges = pct ? PM_RANGES.filter(pctRangeOk) : PM_RANGES;
  // MAX stops meaning all-time once the window is trimmed, so it says so.
  const labelFor = (r) => (pct && r === 'MAX') ? PM_PCT_START_SHORT : pmRangeLabel(r);
  const pctFallback = () => pmPctFallback(lastD);
  const onUnit = (u) => {
    setUnit(u);
    // Leaving the reader on a range percent cannot express would silently show
    // them a different window than the highlighted button claims.
    if (u === 'pct' && !pctRangeOk(range)) { setUsdRange(range); setRange(pctFallback()); }
    // Coming back, restore whatever timeframe they were on before the step-down.
    if (u === 'usd' && usdRange) { setRange(usdRange); setUsdRange(null); }
  };

  // Completed quarters the curve covers end to end, for the history picker.
  const allQuarters = (window.szQuarters && pnlSeries && pnlSeries.length)
    ? window.szQuarters(pnlSeries[0].d, pnlSeries[pnlSeries.length - 1].d)
    : [];
  const quarters = pct ? allQuarters.filter(q => q.start >= PM_PCT_START) : allQuarters;
  const PmHistoryPicker = window.HistoryPicker;
  const PmUnitToggle = window.UnitToggle;

  return (
    <section className="pf-wrap pm-view">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ polymarket · live from data-api</div>
          <h2 className="sz-h2 pm-headline">
            {pmUSD(summary.totalValue)}<span className="pf-currency">portfolio value</span>
          </h2>
          <div className="pf-sub">
            <span>@{profile.handle}</span>
            <span className="sz-sep">·</span>
            <span className="pm-wallet">{displayWallet.slice(0, 6)}…{displayWallet.slice(-4)}</span>
          </div>
        </div>
        <div className="pf-updated">
          <span className="pf-dot"/>
          <span>fetched {updatedStr}</span>
        </div>
      </div>

      <div className="pf-stats">
        <PmStat label="lifetime pnl"
          value={pmUSD(totalPnl)}
          tone={totalPnl == null ? null : totalPnl >= 0 ? 'pos' : 'neg'}
          kicker={pmPnlKicker('all sources', hasPnl, pnlStale, pnlPending)}/>
        <PmStat label="unrealized pnl" value={pmUSD(summary.unrealizedPnl)} tone={summary.unrealizedPnl >= 0 ? 'pos' : 'neg'} kicker="open positions"/>
        <PmStat label="realized pnl"
          value={pmUSD(realizedTotal)}
          tone={realizedTotal == null ? null : realizedTotal >= 0 ? 'pos' : 'neg'}
          kicker={pmPnlKicker('settled · all markets', hasPnl, pnlStale, pnlPending)}/>
        <PmStat label="open positions" value={String(summary.openPositions)} kicker="markets currently held"/>
      </div>

      <PmBreakdown bd={breakdown} tradingPnl={lifetimePnl} />

      {/* Held open at the chart's own aspect ratio while the series is in
          flight, so the panels below don't shift down when it lands. Only
          reached when the snapshot is missing too — otherwise the chart is
          already drawn and the live series just refines it in place. */}
      {pnlHolding && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">cumulative pnl</span>
            <span className="pf-panel-meta">fetching series<Cursor /></span>
          </div>
          <div className="pm-chart-pending"/>
        </div>
      )}

      {pnlSeries && pnlSeries.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">
              cumulative pnl · {pct && range === 'MAX' ? `since ${PM_PCT_START_LONG}` : pmRangeLabel(range)}
            </span>
            <div className="pf-panel-head-right">
              <span className="pf-panel-meta">
                {/* No start date here. The title names the window on every
                    range and the range strip carries the start date on the one
                    button where it IS the window — repeating it in the meta put
                    a jun 1 next to timeframes that begin in july. This says
                    what the numbers are, matching the dollar line beside it. */}
                {pct
                  ? (bdExtra ? 'time-weighted · all sources' : 'time-weighted · trading only')
                  : !bdExtra ? 'trading only · USDC'
                  : rewardsSeam ? `all sources · rewards dated from ${pmAxisLabel(rewardsSeam, 'day').toLowerCase()}`
                  : 'all sources · rewards spread linearly'}
                {pnlStale && (pnlPending
                  ? <> · <span className="sz-dim">daily snapshot, refreshing<Cursor /></span></>
                  : <> · <span className="sz-dim">daily snapshot</span></>)}
              </span>
              <div className="pf-range">
                <SzToggle options={shownRanges} value={range} onChange={setRange}
                  label={(r) => labelFor(r).toLowerCase()}/>
                {PmHistoryPicker && (
                  <PmHistoryPicker quarters={quarters} value={range} onPick={setRange}/>
                )}
                {/* Sits with the range buttons, in this panel's head, because
                    it governs this panel and nothing else on the page. The ibkr
                    and book switches ride in the nav instead — they govern
                    a whole page, and a page-wide control in a panel head is the
                    thing worth hoisting. This one is not. */}
                {PmUnitToggle && pctReady && (
                  <span className="pf-range-unit">
                    <PmUnitToggle value={pct ? 'pct' : 'usd'} onChange={onUnit}/>
                  </span>
                )}
              </div>
            </div>
          </div>
          <PmSpark series={chartSeries} unit={pct ? 'pct' : 'usd'}/>
        </div>
      )}

      {cal && <PmCategoryPanel byCategory={cal.byCategory} lots={cal.lots}
        asOf={(cal.generatedAt || '').slice(0, 10)} openBook={cal.openBook}
        openByCategory={cal.openByCategory}/>}

      {cal && <PmCalibration cal={cal}/>}

      {cal && <PmLotTapePanel cal={cal}/>}

      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">open positions</span>
          <span className="pf-panel-meta">{positions.length} markets · sorted by value</span>
        </div>
        <PmPositions rows={positions}/>
      </div>

      {activity && activity.length > 0 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">activity</span>
            <span className="pf-panel-meta">last {activity.length} trades</span>
          </div>
          <PmActivity rows={activity}/>
        </div>
      )}

      {hist && hist.rows && hist.rows.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">rewards accrual · market-making income</span>
            <span className="pf-panel-meta">lp · rebates · total · since {hist.rows[0].d}</span>
          </div>
          <PmRewardsChart rows={hist.rows}/>
        </div>
      )}

      <div className="pf-footer pm-footer-deep">
        <span>live · data-api.polymarket.com</span>
        <span className="sz-sep">·</span>
        <a href={`https://polymarket.com/profile/${PM_WALLETS[1] || PM_PRIMARY}`} target="_blank" rel="noreferrer">
          wallet ↗ polymarket
        </a>
        <span className="sz-sep">·</span>
        <a href={`https://www.betmoar.fun/profile/${PM_WALLETS[1] || PM_PRIMARY}`} target="_blank" rel="noreferrer">
          analytics ↗ betmoar
        </a>
        <span className="sz-sep">·</span>
        <a href={`https://predictfolio.com/@${PM_HANDLE}`} target="_blank" rel="noreferrer">
          analytics ↗ predictfolio
        </a>
      </div>
    </section>
  );
}

window.Polymarket = Polymarket;
