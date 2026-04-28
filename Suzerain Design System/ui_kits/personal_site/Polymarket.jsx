// Polymarket.jsx — LIVE polymarket panel (fetches data-api directly from browser)
// Globals: React, Cursor
// NOTE: we namespace hook aliases to avoid collisions with Portfolio.jsx

const {
  useState: usePmState,
  useEffect: usePmEffect,
  useRef: usePmRef,
} = React;

const PM_WALLET = '0xcbab47f889ffffbb603f600a5feeb0eca0cc9a8a';
const PM_HANDLE = 'ameameameameame';
const PM_CACHE_KEY = 'pm-cache-v3';
const PM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const PM_PF_URL_BASE = 'https://predictfolio.com/@';

const PM_POSITIONS_URL =
  `https://data-api.polymarket.com/positions?user=${PM_WALLET}&limit=100&sortBy=CURRENT&sortDirection=DESC`;
const PM_PNL_URL =
  `https://user-pnl-api.polymarket.com/user-pnl?user_address=${PM_WALLET}&interval=all&fidelity=1d`;
const PM_ACTIVITY_URL =
  `https://data-api.polymarket.com/activity?user=${PM_WALLET}&limit=20`;

// CLOB rewards API — update if Polymarket restructures the endpoint
const PM_REWARDS_URL =
  `https://clob.polymarket.com/rewards/user?user_address=${PM_WALLET}`;
const PM_REWARDS_HIST_URL =
  `https://clob.polymarket.com/rewards/user-daily?user_address=${PM_WALLET}&limit=90`;

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

  const [posRes, pnlRes, actRes] = await Promise.all([
    fetch(PM_POSITIONS_URL),
    fetch(PM_PNL_URL),
    fetch(PM_ACTIVITY_URL),
  ]);
  if (!posRes.ok) throw new Error('positions ' + posRes.status);
  if (!pnlRes.ok) throw new Error('pnl ' + pnlRes.status);
  const positionsRaw = await posRes.json();
  const pnlRaw = await pnlRes.json();
  const activityRaw = actRes.ok ? await actRes.json() : [];

  // Rewards fetched separately — failure never blocks the main dashboard
  const rewards = await pmFetchRewards();

  const positions = positionsRaw.map(p => ({
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

  const totalValue = +positions.reduce((a, p) => a + p.value, 0).toFixed(2);
  const unrealized = +positions.reduce((a, p) => a + p.unrealized, 0).toFixed(2);
  const realized = +positions.reduce((a, p) => a + p.realized, 0).toFixed(2);

  const trimmed = pmTrimFlat(pnlRaw);
  const sampled = pmDownsample(trimmed, 150);
  const pnlSeries = sampled.map(r => ({
    d: new Date(r.t * 1000).toISOString().slice(0, 10),
    v: +r.p.toFixed(2),
  }));

  const activity = (activityRaw || []).slice(0, 15).map(a => ({
    t: new Date((a.timestamp || 0) * 1000).toISOString(),
    type: (a.type || 'TRADE').toUpperCase(),
    side: (a.side || '').toUpperCase(),
    size: Math.round(a.size || 0).toLocaleString(),
    price: a.price || 0,
    market: a.title || '',
  }));

  const data = {
    generatedAt: new Date().toISOString(),
    profile: { handle: PM_HANDLE, wallet: PM_WALLET },
    summary: {
      totalValue,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      openPositions: positions.length,
      marketsTradedLifetime: null,
    },
    positions,
    pnlSeries,
    activity,
    rewards,
  };

  try {
    localStorage.setItem(PM_CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {}
  return data;
}

// ---------- rewards fetch ----------
async function pmFetchRewards() {
  try {
    const [sumRes, histRes] = await Promise.all([
      fetch(PM_REWARDS_URL),
      fetch(PM_REWARDS_HIST_URL),
    ]);

    // Parse summary — shape may vary; extract totals defensively
    let total = 0, currentEpoch = null, markets = [];
    if (sumRes.ok) {
      const raw = await sumRes.json();
      // Shape A: { total_earnings, current_epoch: {amount}, markets: [...] }
      // Shape B: flat array of epoch objects
      // Shape C: { earnings, data: [...] }
      const obj = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      total = +(
        obj?.total_earnings ??
        obj?.totalEarnings ??
        obj?.total ??
        obj?.earnings ??
        0
      );
      const ep = obj?.current_epoch ?? obj?.currentEpoch ?? obj?.epoch ?? null;
      if (ep) {
        currentEpoch = {
          amount: +(ep.amount ?? ep.earnings ?? ep.total ?? 0),
          label: ep.epoch ?? ep.id ?? ep.label ?? null,
        };
      }
      const mktArr = obj?.markets ?? obj?.market_breakdown ?? obj?.byMarket ?? [];
      markets = (Array.isArray(mktArr) ? mktArr : []).map(m => ({
        title: m.title ?? m.market ?? m.name ?? m.condition_id ?? '—',
        earned: +(m.amount ?? m.earnings ?? m.total ?? 0),
        eligible: m.eligible ?? m.is_eligible ?? true,
      })).filter(m => m.earned > 0).sort((a, b) => b.earned - a.earned).slice(0, 10);
    }

    // Parse daily history — shape: array of { date/timestamp, amount/earnings }
    let dailySeries = [];
    if (histRes.ok) {
      const histRaw = await histRes.json();
      const rows = Array.isArray(histRaw) ? histRaw : (histRaw?.data ?? histRaw?.rows ?? []);
      let cumulative = 0;
      dailySeries = rows.map(r => {
        const rawDate = r.date ?? r.reportDate ?? r.timestamp ?? r.t;
        let d;
        if (typeof rawDate === 'number') {
          d = new Date(rawDate * (rawDate > 1e10 ? 1 : 1000)).toISOString().slice(0, 10);
        } else {
          d = String(rawDate).slice(0, 10);
        }
        const amt = +(r.amount ?? r.earnings ?? r.rewards ?? r.total ?? 0);
        cumulative += amt;
        return { d, daily: amt, v: +cumulative.toFixed(4) };
      }).filter(r => r.d && r.d.length === 10).sort((a, b) => a.d.localeCompare(b.d));

      // If API gives pre-aggregated totals use them; else derive from history
      if (!total && dailySeries.length) total = dailySeries[dailySeries.length - 1].v;
    }

    return { total, currentEpoch, markets, dailySeries, available: true };
  } catch {
    return { available: false };
  }
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
    const px = ((e.clientX - rect.left) / rect.width) * W;
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
        <text x={x(maxIdx)} y={y(max) - 8} textAnchor="middle"
          fontFamily="JetBrains Mono, monospace" fontSize="9" fill="#a78bfa" opacity="0.85">
          peak {pmUSDCompact(max)}
        </text>
        <circle cx={x(minIdx)} cy={y(min)} r="2.5" fill="#ff9ae8" opacity="0.7"/>
        <text x={x(minIdx)} y={y(min) + 14} textAnchor="middle"
          fontFamily="JetBrains Mono, monospace" fontSize="9" fill="#ff9ae8" opacity="0.85">
          trough {pmUSDCompact(min)}
        </text>

        {ticks.map((t, i) => (
          <text key={i} x={x(t.i)} y={H - 10}
            textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
            fontFamily="JetBrains Mono, monospace" fontSize="9"
            fill="rgba(229,225,241,0.4)" letterSpacing="0.08em">{fmtDateShort(t.d)}</text>
        ))}

        <text x={PAD_L + 2} y={zeroY - 4}
          fontFamily="JetBrains Mono, monospace" fontSize="9"
          fill="rgba(229,225,241,0.35)" letterSpacing="0.08em">$0</text>

        {hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#ff4fd8" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}
      </svg>

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

// ---------- rewards components ----------
function PmRewardsSpark({ series }) {
  const W = 920, H = 140, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 24;
  const svgRef = usePmRef(null);
  const [hover, setHover] = usePmState(null);

  const values = series.map(p => p.v);
  const min = 0, max = Math.max(...values, 0.001);
  const x = i => PAD_L + (i / (series.length - 1)) * (W - PAD_L - PAD_R);
  const y = v => PAD_T + (1 - (v - min) / (max - min)) * (H - PAD_T - PAD_B);

  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const area = line + ` L${x(series.length - 1).toFixed(2)},${H - PAD_B} L${x(0).toFixed(2)},${H - PAD_B} Z`;

  const tickEvery = Math.max(1, Math.floor(series.length / 5));
  const ticks = series.map((p, i) => ({ i, d: p.d })).filter((_, i) => i % tickEvery === 0);

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = (px - PAD_L) / (W - PAD_L - PAD_R);
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(t * (series.length - 1)))));
  }

  const hovered = hover != null ? series[hover] : null;

  return (
    <div className="pm-chart-wrap">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        className="pf-navchart pm-chart-svg" preserveAspectRatio="none"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="pm-rew-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c5cf5" stopOpacity="0.3"/>
            <stop offset="100%" stopColor="#7c5cf5" stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path d={area} fill="url(#pm-rew-fill)"/>
        <path d={line} fill="none" stroke="#7c5cf5" strokeWidth="1.75"/>
        <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].v)} r="3.5" fill="#a78bfa"/>
        <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].v)} r="7" fill="#a78bfa" opacity="0.2"/>
        {ticks.map((t, i) => (
          <text key={i} x={x(t.i)} y={H - 6}
            textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
            fontFamily="JetBrains Mono, monospace" fontSize="9"
            fill="rgba(229,225,241,0.4)" letterSpacing="0.08em">{fmtDateShort(t.d)}</text>
        ))}
        {hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B}
              stroke="rgba(229,225,241,0.2)" strokeDasharray="2 3"/>
            <circle cx={x(hover)} cy={y(hovered.v)} r="4" fill="#a78bfa" stroke="#0a0612" strokeWidth="1.5"/>
          </g>
        )}
      </svg>
      {hovered && (
        <div className="pm-tooltip" style={{
          left: `${(x(hover) / W) * 100}%`,
          top: `${(y(hovered.v) / H) * 100}%`,
        }}>
          <div className="pm-tt-date">{fmtDate(hovered.d)}</div>
          <div className="pm-tt-val pos">+{hovered.daily.toFixed(4)} MATIC</div>
          <div className="pm-tt-kicker">cumul. {hovered.v.toFixed(4)}</div>
        </div>
      )}
    </div>
  );
}

function PmRewards({ rewards }) {
  if (!rewards?.available) return (
    <div className="pf-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">rewards</span>
        <span className="pf-panel-meta">LP / market-maker program</span>
      </div>
      <p className="sz-dim" style={{padding:'12px 0', fontSize:'0.82rem'}}>
        Rewards endpoint unavailable — the CLOB API may have restructured.
        Check <code>clob.polymarket.com/rewards</code> or the #market-makers Discord.
      </p>
    </div>
  );

  const { total, currentEpoch, markets, dailySeries } = rewards;

  return (
    <div className="pf-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">rewards</span>
        <span className="pf-panel-meta">LP / market-maker program · MATIC</span>
      </div>

      <div className="pf-stats" style={{marginBottom: '12px'}}>
        <PmStat label="lifetime earned" value={total ? total.toFixed(4) + ' MATIC' : '—'} tone="pos"/>
        {currentEpoch && (
          <PmStat
            label={currentEpoch.label ? `epoch ${currentEpoch.label}` : 'current epoch'}
            value={currentEpoch.amount ? currentEpoch.amount.toFixed(4) + ' MATIC' : '—'}
            tone="pos"
          />
        )}
      </div>

      {dailySeries && dailySeries.length > 1 && (
        <PmRewardsSpark series={dailySeries}/>
      )}

      {markets && markets.length > 0 && (
        <div className="pf-table-wrap" style={{marginTop:'12px'}}>
          <table className="pf-table pm-pos-table">
            <thead>
              <tr>
                <th>market</th>
                <th className="pf-num">earned (MATIC)</th>
                <th className="pf-num">eligible</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m, i) => (
                <tr key={i}>
                  <td className="pm-market" title={m.title}>{m.title}</td>
                  <td className="pf-num pos">{m.earned.toFixed(4)}</td>
                  <td className="pf-num">{m.eligible ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      .catch(e => { if (!cancelled) setErr(String(e.message || e)); });
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

  const { profile, summary, pnlSeries, positions, activity, rewards } = data;
  const updated = new Date(data.generatedAt);
  const updatedStr = updated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  // Authoritative lifetime P&L = last point of user-pnl series.
  const lifetimePnl = (pnlSeries && pnlSeries.length)
    ? pnlSeries[pnlSeries.length - 1].v
    : summary.realizedPnl + summary.unrealizedPnl;
  // True realized = lifetime − unrealized (settled P&L across all markets, open + closed).
  const realizedTotal = lifetimePnl - summary.unrealizedPnl;

  return (
    <section className="pf-wrap pm-view">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ polymarket · live from data-api</div>
          <h2 className="sz-h2 pm-headline">
            <span className={lifetimePnl >= 0 ? 'pos' : 'neg'}>
              {lifetimePnl >= 0 ? '+' : ''}{pmUSD(lifetimePnl)}
            </span>
            <span className="pf-currency">lifetime pnl</span>
          </h2>
          <div className="pf-sub">
            <span>@{profile.handle}</span>
            <span className="sz-sep">·</span>
            <span className="pm-wallet">{profile.wallet.slice(0, 6)}…{profile.wallet.slice(-4)}</span>
          </div>
        </div>
        <div className="pf-updated">
          <span className="pf-dot"/>
          <span>fetched {updatedStr}</span>
        </div>
      </div>

      <div className="pf-stats">
        <PmStat label="portfolio value" value={pmUSD(summary.totalValue)} kicker="open USDC at risk"/>
        <PmStat label="unrealized pnl" value={pmUSD(summary.unrealizedPnl)} tone={summary.unrealizedPnl >= 0 ? 'pos' : 'neg'} kicker="open positions"/>
        <PmStat label="realized pnl"   value={pmUSD(realizedTotal)}   tone={realizedTotal >= 0 ? 'pos' : 'neg'} kicker="settled · all markets"/>
        <PmStat label="open positions" value={String(summary.openPositions)} kicker="markets currently held"/>
      </div>

      <a className="pm-deeplink" href={`${PM_PF_URL_BASE}${profile.handle}`} target="_blank" rel="noreferrer">
        <span className="pm-deeplink-cta">full dashboard on predictfolio <span className="pm-deeplink-arrow">↗</span></span>
      </a>

      {pnlSeries && pnlSeries.length > 1 && (
        <div className="pf-panel">
          <div className="pf-panel-head">
            <span className="pf-panel-title">cumulative pnl</span>
            <span className="pf-panel-meta">all-time · USDC</span>
          </div>
          <PmSpark series={pnlSeries}/>
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

      <PmRewards rewards={rewards}/>

      <div className="pf-footer pm-footer-deep">
        <span>live · data-api.polymarket.com</span>
        <span className="sz-sep">·</span>
        <a href={`https://polymarket.com/profile/${profile.wallet}`} target="_blank" rel="noreferrer">
          wallet ↗ polymarket
        </a>
        <span className="sz-sep">·</span>
        <a href={`${PM_PF_URL_BASE}${profile.handle}`} target="_blank" rel="noreferrer">
          analytics ↗ predictfolio
        </a>
      </div>
    </section>
  );
}

window.Polymarket = Polymarket;
