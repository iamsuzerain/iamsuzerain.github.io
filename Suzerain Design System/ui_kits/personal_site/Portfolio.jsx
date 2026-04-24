// Portfolio.jsx — IBKR Flex Query dashboard (reads data/portfolio.json)
// Globals: React, useDecode

const { useEffect: usePortEffect, useState: usePortState, useMemo: usePortMemo } = React;

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

// ---------- NAV chart ----------
function NavChart({ series }) {
  const W = 920, H = 220, PAD_L = 8, PAD_R = 8, PAD_T = 16, PAD_B = 28;
  const values = series.map(p => p.v);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = (max - min) * 0.08 || 1;
  const y0 = min - pad, y1 = max + pad;
  const x = (i) => PAD_L + (i / (series.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);

  const linePath = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const areaPath = linePath + ` L${x(series.length - 1).toFixed(2)},${H - PAD_B} L${x(0).toFixed(2)},${H - PAD_B} Z`;

  // x-axis ticks (every ~3rd point)
  const tickEvery = Math.max(1, Math.floor(series.length / 5));
  const ticks = series.map((p, i) => ({ i, d: p.d })).filter((_, i) => i % tickEvery === 0);
  // y-axis labels (min, mid, max)
  const yLabels = [
    { v: y1, label: fmtUSD(y1, true) },
    { v: (y0 + y1) / 2, label: fmtUSD((y0 + y1) / 2, true) },
    { v: y0, label: fmtUSD(y0, true) },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pf-navchart" preserveAspectRatio="none">
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
      {/* grid */}
      {yLabels.map((yl, i) => (
        <line key={i}
          x1={PAD_L} x2={W - PAD_R}
          y1={y(yl.v)} y2={y(yl.v)}
          stroke="rgba(167,139,250,0.08)" strokeDasharray="2 4"/>
      ))}
      {/* area + line */}
      <path d={areaPath} fill="url(#pf-nav-fill)"/>
      <path d={linePath} fill="none" stroke="url(#pf-nav-stroke)" strokeWidth="1.75"/>
      {/* final dot */}
      <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].v)} r="3.5" fill="#ff4fd8"/>
      <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].v)} r="7" fill="#ff4fd8" opacity="0.25"/>
      {/* y labels */}
      {yLabels.map((yl, i) => (
        <text key={i} x={W - PAD_R - 2} y={y(yl.v) - 4} textAnchor="end"
          fontFamily="JetBrains Mono, monospace" fontSize="9" fill="rgba(229,225,241,0.4)" letterSpacing="0.08em">
          {yl.label}
        </text>
      ))}
      {/* x labels */}
      {ticks.map((t, i) => (
        <text key={i} x={x(t.i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
          fontFamily="JetBrains Mono, monospace" fontSize="9" fill="rgba(229,225,241,0.4)" letterSpacing="0.1em">
          {t.d}
        </text>
      ))}
    </svg>
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

// ---------- Positions table ----------
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
            <th className="pf-num">unrealized</th>
            <th className="pf-num">wt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const up = p.unrealized >= 0;
            return (
              <tr key={p.symbol}>
                <td className="pf-sym">{p.symbol}</td>
                <td className="pf-name">{p.name}</td>
                <td className="pf-num">{p.qty}</td>
                <td className="pf-num">{fmtUSD(p.mktValue)}</td>
                <td className={`pf-num ${up ? 'pos' : 'neg'}`}>
                  {up ? '+' : ''}{fmtUSD(p.unrealized)}
                </td>
                <td className="pf-num pf-wt">
                  <span className="pf-wt-bar">
                    <span className="pf-wt-fill" style={{ width: `${(p.weight * 100).toFixed(1)}%` }}/>
                  </span>
                  <span className="pf-wt-num">{(p.weight * 100).toFixed(1)}%</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- main view ----------
function Portfolio() {
  const [data, setData] = usePortState(null);
  const [err, setErr] = usePortState(null);

  usePortEffect(() => {
    fetch('data/portfolio.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(setData)
      .catch(e => setErr(String(e)));
  }, []);

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ portfolio</div>
      <h2 className="sz-h2">couldn't load portfolio feed.</h2>
      <p><code>{err}</code></p>
      <p className="sz-dim">the daily IBKR flex fetch may not have run yet. see <code>scripts/ibkr-flex/README.md</code>.</p>
    </section>
  );
  if (!data) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ portfolio</div>
      <h2 className="sz-h2">fetching latest positions<Cursor /></h2>
    </section>
  );

  const d = data;
  const updated = new Date(d.generatedAt);
  const updatedStr = updated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return (
    <section className="pf-wrap">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ portfolio · ibkr flex feed</div>
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
        <StatTile label="day"  value={fmtUSD(d.pnl.day.abs)}  change={d.pnl.day.pct}  kicker="since open"/>
        <StatTile label="mtd"  value={fmtUSD(d.pnl.mtd.abs)}  change={d.pnl.mtd.pct}  kicker="month to date"/>
        <StatTile label="ytd"  value={fmtUSD(d.pnl.ytd.abs)}  change={d.pnl.ytd.pct}  kicker="year to date"/>
        <StatTile label="itd"  value={fmtUSD(d.pnl.itd.abs)}  change={d.pnl.itd.pct}  kicker="inception"/>
      </div>

      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">NAV · 12mo</span>
          <span className="pf-panel-meta">daily · log y</span>
        </div>
        <NavChart series={d.navSeries}/>
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
            <span className="pf-panel-meta">{d.positions.length} shown · sorted by weight</span>
          </div>
          <PositionsTable rows={d.positions}/>
        </div>
      </div>

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
