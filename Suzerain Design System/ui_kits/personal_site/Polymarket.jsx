// Polymarket.jsx — LIVE polymarket panel (fetches data-api directly from browser)
// Globals: React, Cursor
// NOTE: we namespace hook aliases to avoid collisions with Portfolio.jsx

const {
  useState: usePmState,
  useEffect: usePmEffect,
  useRef: usePmRef,
} = React;

const PM_WALLETS = (window.SZ_ID.wallets && window.SZ_ID.wallets.length)
  ? window.SZ_ID.wallets
  : [window.SZ_ID.wallet];
const PM_PRIMARY = PM_WALLETS[0];
const PM_HANDLE = 'Seutervoinen';
const PM_CACHE_KEY = 'pm-cache-v9';  // v9: breakdown carries uma; shared income sum
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
// Shared with the overview, which anchors its rewards ramp on the same cut
// (szPnlLifeStartDay) without trimming the series it charts.
function pmTrimFlat(series) {
  if (!series.length) return series;
  return series.slice(window.szPnlFirstMoveIndex(series));
}
// Plot-point ceiling shared with the overview (CMB_CHART_MAX_POINTS). Sized so
// daily resolution survives ~11 years of history rather than reverting to
// every-other-day partway through 2027.
const PM_CHART_MAX_POINTS = 2000;

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
  const sponsored = extract('Sponsored');
  const uma      = extract('\\bUMA\\b');
  if (trading == null && lp == null && maker == null) return null;
  return { trading, lp, yield: yld, maker, sponsored, uma, source: 'betmoar' };
}

async function pmFetchBreakdown() {
  // Primary: polymarket-breakdown.json written by betmoar-refresh workflow
  try {
    const r = await fetch('data/polymarket-breakdown.json', { cache: 'no-store' });
    if (r.ok) {
      const bd = await r.json();
      if (bd.totals) {
        return {
          trading:   bd.totals.trading,
          lp:        bd.totals.lp,
          yield:     bd.totals.yield,
          maker:     bd.totals.maker,
          sponsored: bd.totals.sponsored,
          uma:       bd.totals.uma,
          fees:      bd.totals.fees,
          // Full Polymarket NAV (open positions + idle USDC) from the daily
          // snapshot; used as portfolio value so it matches the overview's
          // capital-deployment bar exactly.
          nav:       bd.balances ? bd.balances.nav : null,
          source:    'betmoar',
        };
      }
    }
  } catch {}

  // Fallback: polymarket-rewards.json (maker + LP via CLOB script)
  try {
    const r = await fetch('data/polymarket-rewards.json', { cache: 'no-store' });
    if (r.ok) {
      const rw = await r.json();
      if (rw.totals && (rw.totals.makerRebates || rw.totals.liquidityRewards)) {
        return {
          trading:   null,
          lp:        Math.round(rw.totals.liquidityRewards || 0),
          yield:     0,
          maker:     Math.round(rw.totals.makerRebates || 0),
          sponsored: 0,
          uma:       0,
          fees:      0,
          source:    'json',
        };
      }
    }
  } catch {}

  return null;
}

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

async function pmFetchAll() {
  // Try cache first
  try {
    const raw = localStorage.getItem(PM_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.t < PM_CACHE_TTL_MS) {
        return cached.data;
      }
    }
  } catch {}

  const timeout = () => AbortSignal.timeout(10000);

  // Fan out positions/pnl/activity per wallet, then merge.
  const perWallet = await Promise.all(PM_WALLETS.map(async (w) => {
    const [posRes, pnlRes, actRes] = await Promise.all([
      fetch(pmPositionsUrl(w), { signal: timeout() }),
      fetch(pmPnlUrl(w), { signal: timeout() }),
      fetch(pmActivityUrl(w), { signal: timeout() }),
    ]);
    if (!posRes.ok) throw new Error('positions ' + posRes.status + ' (' + w.slice(0, 6) + ')');
    if (!pnlRes.ok) throw new Error('pnl ' + pnlRes.status + ' (' + w.slice(0, 6) + ')');
    const positions = await posRes.json();
    const pnl = await pnlRes.json();
    const activity = actRes.ok ? await actRes.json() : [];
    return { positions, pnl, activity };
  }));
  const breakdown = await pmFetchBreakdown();

  // Drop positions Polymarket has resolved — they still come back from the
  // positions endpoint with currentValue:0 but cashPnl carrying the loss, so
  // they'd otherwise appear as "open" with a $0 value.
  const openOnly = perWallet.map(x => (x.positions || []).filter(p => !p.redeemable));
  const mergedPositionsRaw = pmMergePositions(openOnly);
  const summedPnl = pmSumPnlSeries(perWallet.map(x => x.pnl));
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

  // Portfolio value = full Polymarket NAV (positions + idle USDC) from the
  // betmoar daily snapshot, so it matches the overview's capital-deployment
  // bar exactly. Falls back to live open-position value if the snapshot NAV
  // is unavailable.
  const positionsValue = +positions.reduce((a, p) => a + p.value, 0).toFixed(2);
  const totalValue = (breakdown && breakdown.nav != null) ? breakdown.nav : positionsValue;
  const unrealized = +positions.reduce((a, p) => a + p.unrealized, 0).toFixed(2);
  const realized = +positions.reduce((a, p) => a + p.realized, 0).toFixed(2);

  const trimmed = pmTrimFlat(summedPnl);
  // One point per day, matching the ibkr and overview charts. At 150 the
  // ~425-point series took every 2nd day, putting this chart on a different
  // time base to the others. The cap is 2000 rather than something tighter
  // because floor(len/target) only steps to 2 at 2x the target: 400 would hold
  // 1d resolution just past 2027 and then silently coarsen again, whereas
  // smoothPath costs ~1.6ms at 2000 points — well inside a frame even though
  // it is recomputed on every hover move.
  const sampled = pmDownsample(trimmed, PM_CHART_MAX_POINTS);
  // szPmPointDay, not the raw stamp's own date: the feed's daily points sit on
  // 00:00 UTC boundaries, so stamp D is the close of D-1. Taking the stamp at face
  // value labelled every point a day late and, because the live intraday tail is
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

  const data = {
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
    activity,
  };

  try {
    localStorage.setItem(PM_CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {}
  return data;
}

// ---------- PnL sparkline ----------
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  return `${mo} ${d}, ${y}`;
}
// Span-aware x-axis label, same three modes the overview chart uses: 'day' ->
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
// Both the sum and the curve live in Chrome.jsx now, shared with the overview.
// They were separate implementations that disagreed twice over: on whether `uma`
// counted as income, and on where the pre-history ramp starts — this copy
// measured it in *series points* from the trimmed first date, the overview in
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
// overview pages, so a range picked here spans what it spans there.
const PM_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'MAX'];
const PM_RANGE_LABEL = { '1M': '1mo', '3M': '3mo', '6M': '6mo', 'YTD': 'ytd', '1Y': '12mo', 'MAX': 'all-time' };

// Both live in Chrome.jsx, shared with the overview.
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
function pmWindow(series, range) {
  if (!series || series.length < 2) return series;
  const last = series[series.length - 1].d;
  const cutoff = pmRangeCutoff(range, last);
  let i = cutoff ? series.findIndex(p => p.d >= cutoff) : 0;
  if (i < 0) i = 0;
  if (i > series.length - 2) i = series.length - 2;   // keep >= 2 points to plot
  const endCut = pmRangeEnd(range);
  let j = series.length - 1;
  if (endCut) {
    const over = series.findIndex(p => p.d > endCut);
    if (over > 0) j = over - 1;
  }
  if (j < i + 1) j = Math.min(series.length - 1, i + 1);
  const base = series[i].v;
  return series.slice(i, j + 1).map(p => ({ ...p, v: +(p.v - base).toFixed(2) }));
}

function PmSpark({ series }) {
  const W = 920, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 20, PAD_B = 32;
  const svgRef = usePmRef(null);
  const [hover, setHover] = usePmState(null);

  const values = series.map(p => p.v);
  const min = Math.min(...values, 0), max = Math.max(...values);
  const pad = (max - min) * 0.08 || 1;
  const y0 = min - pad, y1 = max + pad;
  const x = (i) => PAD_L + (i / (series.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);

  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const area = line + ` L${x(series.length - 1).toFixed(2)},${H - PAD_B} L${x(0).toFixed(2)},${H - PAD_B} Z`;
  const zeroY = y(0);

  const tickEvery = Math.max(1, Math.floor(series.length / 6));
  const ticks = series.map((p, i) => ({ i, d: p.d })).filter((_, i) => i % tickEvery === 0);
  const spanDays = pmSpanDays(series[0].d, series[series.length - 1].d);
  const axisMode = spanDays <= 95 ? 'day'
    : (series[0].d.slice(0, 4) === series[series.length - 1].d.slice(0, 4) ? 'month' : 'monthyear');

  const maxIdx = values.indexOf(max);
  const minIdx = values.indexOf(min);

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

  const hovered = hover != null ? series[hover] : null;

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
          <linearGradient id="pm-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.32"/>
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0"/>
          </linearGradient>
          {/* Vertical, value-keyed: bright pink where the line runs high, violet
              where it runs low — the "violet bottom → pink top" look, robust to a
              choppy/declining line (unlike a left→right horizontal gradient). */}
          <linearGradient id="pm-stroke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff4fd8"/>
            <stop offset="100%" stopColor="#a78bfa"/>
          </linearGradient>
        </defs>

        <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY}
          stroke="rgba(229,225,241,0.2)" strokeDasharray="2 4"/>
        <path d={area} fill="url(#pm-fill)"/>
        <path d={line} fill="none" stroke="url(#pm-stroke)" strokeWidth="1.75"/>

        <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].v)} r="3.5" fill="#ff4fd8"/>
        <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].v)} r="7" fill="#ff4fd8" opacity="0.25"/>

        <circle cx={x(maxIdx)} cy={y(max)} r="2.5" fill="#a78bfa" opacity="0.7"/>
        <circle cx={x(minIdx)} cy={y(min)} r="2.5" fill="#ff9ae8" opacity="0.7"/>

        {hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#ff4fd8" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}
      </svg>

      <div className="pm-peak" style={{ left: `${(x(maxIdx) / W) * 100}%`, top: `${(y(max) / H) * 100}%` }}>peak {pmUSDCompact(max)}</div>
      <div className="pm-trough" style={{ left: `${(x(minIdx) / W) * 100}%`, top: `${(y(min) / H) * 100}%` }}>trough {pmUSDCompact(min)}</div>
      <div className="pf-axis-zero" style={{ left: `${(PAD_L / W) * 100}%`, top: `${(zeroY / H) * 100}%` }}>$0</div>
      <div className="pf-axis-x">
        {ticks.map((t, i) => (
          <span key={i}
            className={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : ''}
            style={{ left: `${(x(t.i) / W) * 100}%` }}>{pmAxisLabel(t.d, axisMode)}</span>
        ))}
      </div>

      {hovered && (
        <div className="pm-tooltip" style={{
          left: `${(x(hover) / W) * 100}%`,
          top: `${(y(hovered.v) / H) * 100}%`,
        }}>
          <div className="pm-tt-date">{fmtDate(hovered.d)}</div>
          <div className={`pm-tt-val ${hovered.v >= 0 ? 'pos' : 'neg'}`}>
            {hovered.v >= 0 ? '+' : ''}{pmUSD(hovered.v)}
          </div>
        </div>
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
  const rows = [
    { key: 'trading',   label: 'trading',   val: Math.round(tradingPnl) },
    { key: 'lp',        label: 'lp',        val: bd?.lp        != null ? bd.lp        : null },
    { key: 'maker',     label: 'maker',     val: bd?.maker     != null ? bd.maker     : null },
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
// From the polymarket-calibration daily cron (`byCategory`).
const PM_CAT_MIN_N = 25;    // below this the row is noise — dimmed, not dropped
// A category whose |P&L| is under this fraction of the largest bar renders as a
// 1px speck indistinguishable from the zero-line divider. Plot only material
// movers (like the contribution-to-return chart); the table keeps the full tail.
const PM_CAT_BAR_FLOOR = 0.01;

function PmCategoryPanel({ byCategory, openBook }) {
  const [sort, setSort] = usePmState('pnl');
  if (!byCategory) return null;

  const rows = Object.entries(byCategory)
    .map(([cat, v]) => ({
      cat,
      c: v.combined,
      settle: v.settlement || null,
      exit: v.exit || null,
    }))
    .filter(r => r.c && r.c.n);
  if (!rows.length) return null;

  rows.sort(sort === 'pnl'
    ? (a, b) => b.c.realizedPnl - a.c.realizedPnl
    : (a, b) => b.c.volume - a.c.volume);

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.c.realizedPnl)), 1);
  const net = rows.reduce((a, r) => a + r.c.realizedPnl, 0);
  const barRows = rows.filter(r => Math.abs(r.c.realizedPnl) >= maxAbs * PM_CAT_BAR_FLOOR);

  return (
    <div className="pf-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">attribution · by market type</span>
        <div className="pf-range">
          {[['pnl', 'p&l'], ['volume', 'stake']].map(([k, lbl]) => (
            <button key={k} className={`pf-range-btn${sort === k ? ' active' : ''}`}
              onClick={() => setSort(k)}>{lbl}</button>
          ))}
        </div>
      </div>

      <div className="pf-contrib pm-cat-bars">
        {barRows.map(r => {
          const w = (Math.abs(r.c.realizedPnl) / maxAbs) * 50;
          const pos = r.c.realizedPnl >= 0;
          return (
            <div className="pf-contrib-row" key={r.cat}
              title={`${r.c.n} positions · ${pmUSD(r.c.volume)} staked`}>
              <span className={`pf-contrib-sym${r.c.n < PM_CAT_MIN_N ? ' pm-cat-thin' : ''}`}>
                {r.cat}
              </span>
              <div className="pf-contrib-track">
                <div className="pf-contrib-center"/>
                <div className={`pf-contrib-bar ${pos ? 'pos' : 'neg'}`}
                  style={pos ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}/>
              </div>
              <span className={`pf-contrib-val ${pos ? 'pos' : 'neg'}`}>
                {pos ? '+' : ''}{pmUSD(r.c.realizedPnl)}
              </span>
            </div>
          );
        })}
        <div className="pf-contrib-foot">
          <span>
            {rows.length} market types
            {barRows.length < rows.length && ` · ${rows.length - barRows.length} near zero`}
          </span>
          <span>net {net >= 0 ? '+' : ''}{pmUSD(net)}</span>
        </div>
      </div>

      <div className="pf-table-wrap pm-cat-table-wrap">
        <table className="pf-table">
          <thead>
            <tr>
              <th>type</th>
              <th className="pf-num">n</th>
              <th className="pf-num">staked</th>
              <th className="pf-num">edge/pos</th>
              <th className="pf-num">roi</th>
              <th className="pf-num">resolved</th>
              <th className="pf-num">swing</th>
              <th className="pf-num">top-1</th>
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
                  <td className="pf-num">{r.c.n}</td>
                  <td className="pf-num">{pmUSD(r.c.volume, true)}</td>
                  <td className={`pf-num ${edge == null ? '' : (edge >= 0 ? 'pos' : 'neg')}`}
                    title={edge == null ? 'no resolved bets in this type' : undefined}>
                    {edge != null ? (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + 'pp' : '—'}
                  </td>
                  <td className={`pf-num ${r.c.roi >= 0 ? 'pos' : 'neg'}`}>{pmPct1(r.c.roi)}</td>
                  <td className={`pf-num ${r.settle ? (r.settle.roi >= 0 ? 'pos' : 'neg') : ''}`}>
                    {r.settle ? pmPct1(r.settle.roi) : '—'}
                  </td>
                  <td className={`pf-num ${r.exit ? (r.exit.roi >= 0 ? 'pos' : 'neg') : ''}`}>
                    {r.exit ? pmPct1(r.exit.roi) : '—'}
                  </td>
                  <td className="pf-num pm-cat-top1">{r.c.top1Share != null ? pmPct0(r.c.top1Share) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Scope. Every number above is a CLOSED lot — resolved or swing — because
          you can't score a forecast that hasn't resolved. The net therefore sits
          below the headline trading P&L, which marks the open book too, and the
          two being adjacent and unequal reads as a contradiction without this.
          They reconcile: closed + open ≈ headline, the remainder being fees. */}
      {openBook && (
        <div className="pf-contrib-foot pm-cat-scope">
          <span>closed lots only · resolved or swing</span>
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
          {/* perfect-calibration diagonal */}
          <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)}
            stroke={PM_CAL_TEAL} strokeWidth="1" strokeDasharray="4 4" opacity="0.6"/>
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
            <div className="pm-tooltip cmb-tooltip" style={{
              left: `${(x(b.avgImplied) / VW) * 100}%`,
              top: `${(y(b.winRate) / VH) * 100}%`,
            }}>
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
            </div>
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
          <button type="button" className={`pf-range-btn${series === 'settlement' ? ' active' : ''}`}
            onClick={() => setSeries('settlement')}>resolved</button>
          {hasExit && (
            <button type="button" className={`pf-range-btn${series === 'exit' ? ' active' : ''}`}
              onClick={() => setSeries('exit')}>swing trades</button>
          )}
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

      <div className="pf-panel-head" style={{ marginTop: 4 }}>
        <span className="pf-panel-meta">
          {series === 'settlement'
            ? 'positions whose outcome was determined — held to resolution, or sold at ≥99.8¢/≤0.2¢ into a market that resolved. the true calibration test'
            : 'swing trades — closed while the outcome was still live, so there is no resolution truth. win = closed in profit (a hit-rate view, not calibration)'}
        </span>
      </div>
    </div>
  );
}

// ---------- Rewards accrual (market-making income over time) ----------
// One line per income source (lp / maker / yield / sponsored) from the betmoar
// breakdown history. These are steady positive streams, distinct from swingy
// trading P&L. Each line is re-based to the first tracked day (see below), so
// every source starts at 0 and shows what it has earned since tracking began.
const PM_REWARD_PARTS = [
  { key: 'lp', label: 'lp', color: '#ff4fd8' },
  { key: 'maker', label: 'maker', color: '#a78bfa' },
];
// Total still counts every income stream (incl. the tiny yield/sponsored ones we
// no longer chart on their own), so it sits just above lp + maker.
function pmRewardsTotal(r) {
  return (r.lp || 0) + (r.maker || 0) + (r.yield || 0) + (r.sponsored || 0);
}
function PmRewardsChart({ rows }) {
  const svgRef = usePmRef(null);
  const [hover, setHover] = usePmState(null);
  if (!rows || rows.length < 2) return null;
  // The betmoar figures are cumulative *lifetime* totals, and the snapshot cron
  // only started on rows[0].d — so lifetime rewards were already well above zero
  // on day one. Re-base each source to that first tracked day so its line reads
  // as earned-since-tracking-began, starting at 0.
  const first = rows[0];
  const lines = [
    ...PM_REWARD_PARTS.map(p => ({
      ...p,
      series: rows.map(r => ({ d: r.d, v: (r[p.key] || 0) - (first[p.key] || 0) })),
    })),
    { key: 'total', label: 'total', color: '#f5f0ff',
      series: rows.map(r => ({ d: r.d, v: pmRewardsTotal(r) - pmRewardsTotal(first) })) },
  ];
  const n = rows.length;
  const W = 920, H = 200, PAD_L = 8, PAD_R = 8, PAD_T = 16, PAD_B = 14;
  const allV = lines.flatMap(l => l.series.map(p => p.v));
  const min = Math.min(...allV, 0), max = Math.max(...allV);
  const pad = (max - min) * 0.1 || 1;
  const y0 = min, y1 = max + pad;
  const x = (i) => PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);
  const path = (s) => s.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    const idx = Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    setHover(idx);
  }

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
        <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)}
          stroke="rgba(229,225,241,0.14)" strokeDasharray="3 5"/>
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
            stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
        )}
        {lines.map(l => (
          <path key={l.key} d={path(l.series)} fill="none" stroke={l.color} strokeWidth="1.5"/>
        ))}
        {lines.map(l => (
          <circle key={l.key} cx={x(n - 1)} cy={y(l.series[n - 1].v)} r="3" fill={l.color}/>
        ))}
        {hover != null && lines.map(l => (
          <circle key={l.key} cx={x(hover)} cy={y(l.series[hover].v)} r="3.5"
            fill={l.color} stroke="#f5f0ff" strokeWidth="1"/>
        ))}
      </svg>
      {hover != null && (
        <div className="pm-tooltip" style={{ left: `${(x(hover) / W) * 100}%`, top: '4%' }}>
          <div className="pm-tt-date">{rows[hover].d}</div>
          {lines.map(l => (
            <div key={l.key} className="pf-tt-bench" style={{ color: l.color }}>
              {l.label} +{pmUSD(l.series[hover].v)}
            </div>
          ))}
        </div>
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

// ---------- main view ----------
function Polymarket() {
  const [data, setData] = usePmState(null);
  const [err, setErr] = usePmState(null);
  const [cal, setCal] = usePmState(null);
  const [hist, setHist] = usePmState(null);
  // Defaults to the trailing year like the ibkr and overview charts — the
  // lifetime curve is still one click away under MAX.
  const [range, setRange] = usePmState('1Y');

  usePmEffect(() => {
    let cancelled = false;
    pmFetchAll()
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => {
        if (cancelled) return;
        // Live fetch failed — fall back to expired cache rather than a blank error.
        try {
          const raw = localStorage.getItem(PM_CACHE_KEY);
          if (raw) { setData(JSON.parse(raw).data); return; }
        } catch {}
        setErr(String(e.message || e));
      });
    // Calibration dataset (polymarket-calibration daily cron). Best-effort and
    // independent of the live fetch — the panel renders only when present.
    fetch('data/polymarket-calibration.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled && j) setCal(j); })
      .catch(() => {});
    // Rewards-accrual history (betmoar breakdown daily cron). Best-effort; the
    // panel renders only when the history file is present. Row dates are restated
    // to close-of-day here so the income curve, the accrual chart and the "since"
    // captions all read the same convention as the P&L series.
    fetch('data/polymarket-breakdown-history.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled || !j) return;
        setHist({ ...j, rows: window.szPmDateSnapshotRows(j.rows) });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

  const { profile, summary, pnlSeries, positions, activity, breakdown } = data;
  // Show the second wallet in the header pill (matches the profile/betmoar links below).
  const displayWallet = (profile.wallets && profile.wallets[1]) || profile.wallet;
  const updated = new Date(data.generatedAt);
  const updatedStr = updated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  // Authoritative lifetime P&L = last point of user-pnl series (trading only).
  const lifetimePnl = (pnlSeries && pnlSeries.length)
    ? pnlSeries[pnlSeries.length - 1].v
    : summary.realizedPnl + summary.unrealizedPnl;
  // True realized = lifetime − unrealized (settled P&L across all markets, open + closed).
  const realizedTotal = lifetimePnl - summary.unrealizedPnl;
  // All-source total = trading + LP + maker + yield + sponsored + uma − fees.
  // pnlSeries (used as lifetimePnl) is gross of trading fees, so net them here.
  const bdExtra = pmRewardsNet(breakdown);
  const totalPnl = lifetimePnl + bdExtra;

  // Sparkline series: trading pnl plus the all-source income curve, so it ends
  // at totalPnl and matches the headline. Dated from the breakdown history where
  // that reaches; only the pre-history remainder is an even ramp.
  //
  // pnlSeries is already past pmTrimFlat, so its first date *is* the day the
  // book started being P&L history — the same anchor szPnlLifeStartDay hands the
  // overview off the raw feed.
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
  // Completed quarters the curve covers end to end, for the history picker.
  const quarters = (window.szQuarters && pnlSeries && pnlSeries.length)
    ? window.szQuarters(pnlSeries[0].d, pnlSeries[pnlSeries.length - 1].d)
    : [];
  const PmHistoryPicker = window.HistoryPicker;

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
        <PmStat label="lifetime pnl" value={pmUSD(totalPnl)} tone={totalPnl >= 0 ? 'pos' : 'neg'} kicker="all sources"/>
        <PmStat label="unrealized pnl" value={pmUSD(summary.unrealizedPnl)} tone={summary.unrealizedPnl >= 0 ? 'pos' : 'neg'} kicker="open positions"/>
        <PmStat label="realized pnl"   value={pmUSD(realizedTotal)}   tone={realizedTotal >= 0 ? 'pos' : 'neg'} kicker="settled · all markets"/>
        <PmStat label="open positions" value={String(summary.openPositions)} kicker="markets currently held"/>
      </div>

      <PmBreakdown bd={breakdown} tradingPnl={lifetimePnl} />

      {pnlSeries && pnlSeries.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">cumulative pnl · {pmRangeLabel(range)}</span>
            <div className="pf-panel-head-right">
              <span className="pf-panel-meta">
                {!bdExtra ? 'trading only · USDC'
                  : rewardsSeam ? `all sources · rewards dated from ${pmAxisLabel(rewardsSeam, 'day').toLowerCase()}`
                  : 'all sources · rewards spread linearly'}
              </span>
              <div className="pf-range">
                {PM_RANGES.map(r => (
                  <button key={r} type="button"
                    className={`pf-range-btn${range === r ? ' active' : ''}`}
                    onClick={() => setRange(r)}>{r.toLowerCase()}</button>
                ))}
                {PmHistoryPicker && (
                  <PmHistoryPicker quarters={quarters} value={range} onPick={setRange}/>
                )}
              </div>
            </div>
          </div>
          <PmSpark series={winSeries}/>
        </div>
      )}

      {cal && <PmCategoryPanel byCategory={cal.byCategory} openBook={cal.openBook}/>}

      {cal && <PmCalibration cal={cal}/>}

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
            <span className="pf-panel-meta">lp · maker · total · since {hist.rows[0].d}</span>
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
