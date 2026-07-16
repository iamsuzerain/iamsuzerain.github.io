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
const PM_CACHE_KEY = 'pm-cache-v8';  // v8: portfolio value now = snapshot NAV (positions + cash)
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
function pmTrimFlat(series) {
  if (!series.length) return series;
  const base = series[0].p;
  for (let i = 0; i < series.length; i++) {
    if (Math.abs(series[i].p - base) > 0.001) {
      return series.slice(Math.max(0, i - 1));
    }
  }
  return series.slice(-1);
}
function pmDownsample(arr, target = 150) {
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
  const sampled = pmDownsample(trimmed, 150);
  const pnlSeries = sampled.map(r => ({
    d: new Date(r.t * 1000).toISOString().slice(0, 10),
    v: +r.p.toFixed(2),
  }));

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
function fmtDateShort(iso) {
  const [y, m] = iso.split('-').map(Number);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
  return `${mo} ${String(y).slice(2)}`;
}
function pmUSDCompact(n) {
  if (Math.abs(n) >= 1000) {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + (Math.abs(n) / 1000).toFixed(1) + 'k';
  }
  return '$' + Math.round(n);
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
            <stop offset="0%" stopColor="#ff4fd8" stopOpacity="0.28"/>
            <stop offset="100%" stopColor="#ff4fd8" stopOpacity="0"/>
          </linearGradient>
          <linearGradient id="pm-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a78bfa"/>
            <stop offset="100%" stopColor="#ff4fd8"/>
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
            style={{ left: `${(x(t.i) / W) * 100}%` }}>{fmtDateShort(t.d)}</span>
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

// ---------- main view ----------
function Polymarket() {
  const [data, setData] = usePmState(null);
  const [err, setErr] = usePmState(null);

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
  // All-source total = trading + LP + maker + yield + sponsored − fees.
  // pnlSeries (used as lifetimePnl) is gross of trading fees, so net them here.
  const bdExtra = breakdown
    ? (breakdown.lp || 0) + (breakdown.yield || 0) + (breakdown.maker || 0)
      + (breakdown.sponsored || 0) - (breakdown.fees || 0)
    : 0;
  const totalPnl = lifetimePnl + bdExtra;

  // Sparkline series: spread all-source income (bdExtra) linearly across the
  // trading-pnl timeline so the curve ends at totalPnl and matches the headline.
  // Linear = assumes rewards accrued evenly; intra-period points are estimates.
  const sparkSeries = (pnlSeries && pnlSeries.length > 1 && bdExtra)
    ? pnlSeries.map((p, i) => ({
        ...p,
        v: +(p.v + bdExtra * (i / (pnlSeries.length - 1))).toFixed(2),
      }))
    : pnlSeries;

  return (
    <section className="pf-wrap pm-view">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ polymarket · live from data-api</div>
          <h2 className="sz-h2 pm-headline">
            <span className={totalPnl >= 0 ? 'pos' : 'neg'}>
              {totalPnl >= 0 ? '+' : ''}{pmUSD(totalPnl)}
            </span>
            <span className="pf-currency">lifetime pnl · all sources</span>
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
        <PmStat label="portfolio value" value={pmUSD(summary.totalValue)}/>
        <PmStat label="unrealized pnl" value={pmUSD(summary.unrealizedPnl)} tone={summary.unrealizedPnl >= 0 ? 'pos' : 'neg'} kicker="open positions"/>
        <PmStat label="realized pnl"   value={pmUSD(realizedTotal)}   tone={realizedTotal >= 0 ? 'pos' : 'neg'} kicker="settled · all markets"/>
        <PmStat label="open positions" value={String(summary.openPositions)} kicker="markets currently held"/>
      </div>

      <PmBreakdown bd={breakdown} tradingPnl={lifetimePnl} />

      {pnlSeries && pnlSeries.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">cumulative pnl</span>
            <span className="pf-panel-meta">
              {bdExtra ? 'all sources · rewards spread linearly' : 'all-time · USDC'}
            </span>
          </div>
          <PmSpark series={sparkSeries}/>
        </div>
      )}

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
