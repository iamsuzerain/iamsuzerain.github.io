// Chrome.jsx — shared layout, cursor glow, decode-in hook
// Globals: React, ReactDOM

const { useEffect, useRef, useState, useMemo } = React;

// Track cursor position for the hero glow
function useCursor() {
  const [pos, setPos] = useState({ x: -500, y: -500 });
  useEffect(() => {
    const onMove = (e) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);
  return pos;
}

// Scramble text in, resolve over ~duration ms
const GLYPHS = '◆◇▸→∴§#*/\\|{}[]<>01'.split('');
function useDecode(target, duration = 400, startDelay = 0) {
  const initial = target.split('').map(c => c === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('');
  const [text, setText] = useState(initial);
  useEffect(() => {
    let raf;
    const t0 = performance.now() + startDelay;
    const tick = (now) => {
      const elapsed = Math.max(0, now - t0);
      const p = Math.min(1, elapsed / duration);
      const revealed = Math.floor(p * target.length);
      let out = '';
      for (let i = 0; i < target.length; i++) {
        if (i < revealed) out += target[i];
        else if (target[i] === ' ') out += ' ';
        else out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setText(out);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setText(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, startDelay]);
  return text;
}

// Blinking magenta cursor ▋
function Cursor({ className = '' }) {
  return <span className={`sz-cursor ${className}`}>▋</span>;
}

// ---------- rained-on-glass scene ----------
// Deterministic PRNG so droplet layout is stable between renders
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function Droplets() {
  const drops = useMemo(() => {
    const rand = mulberry32(1337);
    const out = [];
    for (let i = 0; i < 220; i++) {
      out.push({ cx: rand()*100, cy: rand()*100, r: 0.4 + rand()*0.9, op: 0.25 + rand()*0.35, micro: true });
    }
    for (let i = 0; i < 260; i++) {
      out.push({ cx: rand()*100, cy: rand()*100, r: 0.8 + rand()*1.8, op: 0.35 + rand()*0.4 });
    }
    for (let i = 0; i < 18; i++) {
      out.push({ cx: rand()*100, cy: rand()*100, r: 3.5 + rand()*6, op: 0.5 + rand()*0.35, bead: true, tint: rand() > 0.62 });
    }
    return out;
  }, []);

  return (
    <svg className="sz-droplets" viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs>
        <filter id="sz-drop-refract" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise"/>
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.15" result="blurred"/>
          <feDisplacementMap in="blurred" in2="noise" scale="2.5"/>
        </filter>
        <radialGradient id="sz-bead" cx="35%" cy="30%" r="70%">
          <stop offset="0%"  stopColor="rgba(255,255,255,0.95)"/>
          <stop offset="35%" stopColor="rgba(220,232,240,0.42)"/>
          <stop offset="75%" stopColor="rgba(150,185,210,0.20)"/>
          <stop offset="100%" stopColor="rgba(8,14,26,0.68)"/>
        </radialGradient>
        <radialGradient id="sz-bead-tint" cx="35%" cy="30%" r="70%">
          <stop offset="0%"  stopColor="rgba(255,255,255,0.90)"/>
          <stop offset="35%" stopColor="rgba(167,139,250,0.38)"/>
          <stop offset="75%" stopColor="rgba(100,160,220,0.20)"/>
          <stop offset="100%" stopColor="rgba(8,14,26,0.65)"/>
        </radialGradient>
        <radialGradient id="sz-sprinkle" cx="40%" cy="35%" r="60%">
          <stop offset="0%"  stopColor="rgba(255,255,255,0.88)"/>
          <stop offset="60%" stopColor="rgba(210,225,235,0.28)"/>
          <stop offset="100%" stopColor="rgba(150,185,210,0.0)"/>
        </radialGradient>
      </defs>
      <g filter="url(#sz-drop-refract)">
        {drops.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={d.r/10}
            fill={`url(#${d.bead ? (d.tint ? 'sz-bead-tint' : 'sz-bead') : 'sz-sprinkle'})`} opacity={d.op}/>
        ))}
      </g>
      {drops.filter(d => d.bead).map((d, i) => (
        <circle key={'h'+i} cx={d.cx - d.r/30} cy={d.cy - d.r/25} r={d.r/45}
          fill="rgba(255,255,255,0.9)" opacity="0.8"/>
      ))}
    </svg>
  );
}

function Trickles() {
  const streaks = useMemo(() => {
    const rand = mulberry32(42);
    return Array.from({ length: 42 }, () => ({
      left: 3 + rand() * 94,
      delay: rand() * 16,
      duration: 5 + rand() * 10,
      opacity: 0.18 + rand() * 0.38,
      height: 20 + rand() * 65,
      width: 1 + rand() * 2,
    }));
  }, []);

  return streaks.map((s, i) => {
    return (
      <div key={i} className="sz-trickle-wrap"
        style={{
          left: `${s.left}%`,
          opacity: s.opacity,
          animationDelay: `${s.delay}s`,
          animationDuration: `${s.duration}s`,
        }}>
        <div className="sz-trickle-streak"
          style={{ width: `${s.width}px`, height: `${s.height}px` }}/>
      </div>
    );
  });
}

// City photo behind the glass — subtle parallax driven by cursor.
function CityPhoto({ parallax }) {
  // Tiny offset, so it feels like real depth without revealing edges.
  const tx = parallax.x * 0.012;
  const ty = parallax.y * 0.008;
  return (
    <div className="sz-skyline-photo"
      style={{ transform: `translate(${tx}px, ${ty}px) scale(1.04)` }}/>
  );
}

// Chrome wraps everything — city photo + glass scene + stage
function Chrome({ children, cursorGlow = false, dim = false }) {
  const pos = useCursor();
  const parallax = useMemo(() => {
    const cx = (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2;
    const cy = (typeof window !== 'undefined' ? window.innerHeight : 800) / 2;
    return { x: pos.x - cx, y: pos.y - cy };
  }, [pos.x, pos.y]);

  return (
    <div className={`sz-chrome ${dim ? 'sz-dim' : ''}`}>
      {/* Layer -1 — the city out the window (photo) */}
      <div className="sz-skyline-wrap">
        <CityPhoto parallax={parallax} />
      </div>
      {/* Layer 0 — keep the original dot grid and corner bloom */}
      <div className="sz-grid" />
      <div className="sz-aurora" />
      {/* Layer 1 — frosted glass pane */}
      <div className="sz-glass" />
      {/* Layer 2 — droplets on the glass */}
      <Droplets />
      <Trickles />
      {cursorGlow && (
        <div className="sz-cursor-glow"
          style={{ transform: `translate(${pos.x - 250}px, ${pos.y - 250}px)` }}/>
      )}
      <div className="sz-stage">{children}</div>
    </div>
  );
}

// ---------- completed-quarter history (shared by the IBKR + overview charts) ----------
// Only whole quarters are offered. A quarter the data only partly covers would
// still print as "q2 25" and read as a full-quarter number, quietly understating
// it — so a quarter has to be covered end to end to appear.
const SZ_Q_RE = /^(\d{4})Q([1-4])$/;

function szIsQuarter(key) { return SZ_Q_RE.test(key || ''); }

function szQuarterLabel(key) {
  const m = SZ_Q_RE.exec(key || '');
  return m ? `q${m[2]} ${m[1].slice(2)}` : null;
}

function szQuarterBounds(key) {
  const m = SZ_Q_RE.exec(key || '');
  if (!m) return null;
  const y = +m[1], q = +m[2], endMonth = q * 3;
  const pad = (n) => String(n).padStart(2, '0');
  // Day 0 of the following month is the last day of this one — leap years and
  // 30/31-day months included, without a lookup table.
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return {
    key,
    label: szQuarterLabel(key),
    start: `${y}-${pad(endMonth - 2)}-01`,
    end: `${y}-${pad(endMonth)}-${pad(lastDay)}`,
  };
}

function szQuarters(firstDate, lastDate) {
  if (!firstDate || !lastDate) return [];
  const out = [];
  for (let y = +firstDate.slice(0, 4); y <= +lastDate.slice(0, 4); y++) {
    for (let q = 1; q <= 4; q++) {
      const b = szQuarterBounds(`${y}Q${q}`);
      if (b.start >= firstDate && b.end <= lastDate) out.push(b);
    }
  }
  return out.reverse();   // newest first — the one you most likely want
}

// ---------- shared series helpers (ibkr · polymarket · overview) ----------
// The overview and the polymarket view chart the same Polymarket feed, so
// anything deciding *which days a range covers* or *how undated rewards get
// spread* has to live in one place. It didn't, and the two copies drifted: the
// overview ramped pre-history rewards from the raw feed's first row while the
// polymarket view ramped from the first row that actually moved (182 days
// later), and the overview cut its trailing window from Date.now() while the
// polymarket view cut from the last real data point. The two errors partly
// cancelled, which is why the same 12mo P&L read as two numbers ~$57 apart
// instead of something obviously broken.
const SZ_DAY_MS = 86400000;
const SZ_DAY_S = 86400;

function szEpochDay(iso) {
  return Math.floor(new Date(iso + 'T00:00:00Z').getTime() / SZ_DAY_MS);
}

function szFromEpochDay(day) {
  return new Date(day * SZ_DAY_MS).toISOString().slice(0, 10);
}

// ---------- what a data point's date means ----------
// Three feeds, three conventions, and the overview sums them on one day axis —
// so they have to be reconciled to a single meaning of "dated D".
//
// The reference is IBKR: build_nav_series reads EquitySummaryByReportDateInBase
// keyed by reportDate, whose `total` is that day's end-of-day NAV. Dated D =
// close of D. Everything else is normalised to match.

// A polymarket user-pnl row's trading day. The feed's daily points are stamped at
// exactly 00:00:00 UTC, so a point stamped D holds cumulative P&L through the
// *close of D-1* — one day later than IBKR's row for the same number. Untranslated
// that put every interior point of the combined chart on a mismatched pair, and
// cost a window its last day (polymarket's Q4 25 measured Oct 1 -> Dec 30).
//
// The final point is not a day boundary: it is a live reading stamped at the
// current hour, so it belongs to the day it is stamped with, as a partial reading
// of that day. Keeping it there is also what stops the last two points colliding
// on one label.
function szPmPointDay(t) {
  const day = Math.floor(t / SZ_DAY_S);
  return (t % SZ_DAY_S === 0) ? day - 1 : day;
}

// A cron-scraped snapshot row's effective day (betmoar breakdown history, and the
// polymarket NAV history recorded off it). These rows carry the date the scrape
// ran, and betmoar reports live lifetime totals — so the row dated D was taken
// partway into D, not at a day boundary. It still means the close of D-1, because
// polymarket pays rewards in one daily batch rather than accruing them
// continuously:
//
//   - lp / maker / yield / sponsored land in a single batch at ~00:00 UTC covering
//     the previous day. Five days where the cron double-ran hold these fields
//     IDENTICAL across scrapes up to 7h apart (07-15 08:18/15:09, 07-18
//     06:59/07:56, 07-25 07:33/08:10, 07-26 01:26/08:30, 07-27 03:18/09:56) while
//     `trading` moved thousands in the same windows — a live scrape of a batched
//     quantity. The 07-26 01:26 UTC scrape already carries that day's step, which
//     brackets the batch to before 01:26.
//   - So any scrape on day D sees rewards earned through the close of D-1, exactly,
//     whatever hour it ran at. This is not an approximation and needs no
//     interpolation.
//
// The one field that does drift is `fees`, charged per trade: it moved +3 and +1
// inside those same windows. So the *net* figure folds in whatever fees accrued
// between 00:00 and the scrape — a median ~$1/day against a ~$35/day net accrual.
// Not worth carrying a timestamp for.
function szPmSnapshotDay(iso) {
  return szEpochDay(iso) - 1;
}

// Collapse points that resolve to the same day, keeping the last — the more
// complete reading of that day. Polymarket's user-pnl tail is nominally hourly but
// is not always updated, which gives two ways to land two points on one day:
//
//   - a stale tail still sitting on the day whose 00:00 boundary has since
//     arrived (the boundary is the exact close, so the later point is the one to
//     keep), and
//   - the likelier case: two wallets whose tails stopped at different hours, which
//     szPm/pmSumPnlSeries unions into two intraday points on the same day.
//
// The overview already gets this for free — cmbSampleDaily walks a day axis and
// keeps the last value at or before each day. This puts the polymarket chart on the
// same footing rather than drawing both points on one date. Safe as an
// adjacent-only pass because szPmPointDay is monotonic non-decreasing in t.
function szDedupeByDate(series) {
  const out = [];
  for (const p of (series || [])) {
    if (out.length && out[out.length - 1].d === p.d) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// Restate a scraped history's row dates onto the convention above, once, at the
// point the file is fetched. Every consumer downstream — the income curve, the
// capital base, the accrual chart, the "since" captions — then just reads `.d` and
// agrees. Applying the shift inside each consumer instead would leave whichever
// one got missed silently a day out.
function szPmDateSnapshotRows(rows) {
  return (rows || []).map(r => (r && r.d)
    ? { ...r, d: szFromEpochDay(szPmSnapshotDay(r.d)) }
    : r);
}

// End date of a closed window (a completed quarter). Trailing ranges run to the
// last point and return null here.
function szRangeEnd(range) {
  const b = szQuarterBounds(range);
  return b ? b.end : null;
}

// Start date of a range, measured back from `last` — which must be the last day
// the series actually has data for, never "today". Padding a series forward to
// the wall clock and then subtracting 12 months shifts the window start by a
// day, and one day of Polymarket P&L is routinely four figures.
function szRangeCutoff(range, last) {
  const qb = szQuarterBounds(range);
  if (qb) return qb.start;
  if (range === 'YTD') return last.slice(0, 4) + '-01-01';
  const m = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range];
  if (!m) return null;                     // MAX — no cutoff, start at the first point
  const c = new Date(last + 'T00:00:00Z');
  c.setUTCMonth(c.getUTCMonth() - m);
  return c.toISOString().slice(0, 10);
}

// Polymarket income beyond trading, net of fees. `uma` belongs in the sum — it
// is dispute-resolution income like any other — and having it in one copy of
// this total but not the other was a divergence waiting on the first payout.
function szPmIncomeNet(r) {
  if (!r) return 0;
  return (r.lp || 0) + (r.yield || 0) + (r.maker || 0)
    + (r.sponsored || 0) + (r.uma || 0) - (r.fees || 0);
}

// Index of the first point in a cumulative-pnl series that moves off the opening
// value, backed up one point so the flat run's last day survives as the origin.
// The Polymarket feed returns every day since the wallet existed, including a
// long dead stretch before the first trade; that stretch is not P&L history and
// nothing should be ramped across it.
function szPnlFirstMoveIndex(rows) {
  if (!rows || !rows.length) return 0;
  const base = rows[0].p;
  for (let i = 0; i < rows.length; i++) {
    if (Math.abs(rows[i].p - base) > 0.001) return Math.max(0, i - 1);
  }
  return rows.length - 1;
}

// The day a cumulative-pnl series starts being P&L history, as an epoch-day.
// Shared so the rewards ramp below is anchored identically wherever it is built.
function szPnlLifeStartDay(rows) {
  if (!rows || !rows.length) return null;
  return szPmPointDay(rows[szPnlFirstMoveIndex(rows)].t);
}

// Cumulative all-source Polymarket income at an epoch-day.
//
// Actual dated values wherever the betmoar breakdown history reaches. Before its
// first row the remainder — everything earned before that cron started — ramps
// evenly from `lifeStartDay` to the seam; after its last row it ramps to
// `total`, the live breakdown snapshot, so the curve still ends exactly on the
// all-sources headline when breakdown.json is a cron cycle fresher than the
// history file. Ramping across the lifetime rather than the selected window
// matters: a window ramp dumps every pre-history dollar into the window no
// matter how old it was.
function szPmIncomeCurve(rows, lifeStartDay, total, endDay) {
  // `rows` arrive already restated by szPmDateSnapshotRows at their fetch site.
  const pts = (rows || [])
    .filter(r => r && r.d)
    .map(r => ({ day: szEpochDay(r.d), v: szPmIncomeNet(r) }))
    .filter(p => p.day <= endDay)
    .sort((a, b) => a.day - b.day);
  const anchor = total != null ? total : (pts.length ? pts[pts.length - 1].v : 0);
  const lifeSpan = Math.max(1, endDay - lifeStartDay);
  // No dated history at all — one even ramp across the lifetime, as before.
  if (!pts.length) {
    return (day) => anchor *
      ((Math.min(Math.max(day, lifeStartDay), endDay) - lifeStartDay) / lifeSpan);
  }
  const seam = pts[0], tail = pts[pts.length - 1];
  const preSpan = Math.max(1, seam.day - lifeStartDay);
  const tailSpan = Math.max(1, endDay - tail.day);
  return (day) => {
    if (day <= lifeStartDay) return 0;
    if (day >= endDay) return anchor;
    if (day < seam.day) return seam.v * ((day - lifeStartDay) / preSpan);
    if (day > tail.day) return tail.v + (anchor - tail.v) * ((day - tail.day) / tailSpan);
    let v = seam.v;
    for (const p of pts) { if (p.day <= day) v = p.v; else break; }
    return v;
  };
}

// The "history" control that sits after MAX on a range selector.
function HistoryPicker({ quarters, value, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!quarters || !quarters.length) return null;
  const picked = szIsQuarter(value);
  return (
    <div className="pf-range-history" ref={ref}>
      <button type="button" className={`pf-range-btn${picked ? ' active' : ''}`}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(o => !o)}>
        {picked ? szQuarterLabel(value) : 'history'} <span className="pf-range-caret">▾</span>
      </button>
      {open && (
        <div className="pf-range-menu" role="listbox">
          <div className="pf-range-menu-head">completed quarters</div>
          {quarters.map(q => (
            <button key={q.key} type="button" role="option" aria-selected={value === q.key}
              className={`pf-range-menu-item${value === q.key ? ' active' : ''}`}
              onClick={() => { onPick(q.key); setOpen(false); }}>
              <span>{q.label}</span>
              <span className="pf-range-menu-span">{q.start.slice(5)} → {q.end.slice(5)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

window.Chrome = Chrome;
window.Cursor = Cursor;
window.useDecode = useDecode;
window.useCursor = useCursor;
window.HistoryPicker = HistoryPicker;
window.szQuarters = szQuarters;
window.szIsQuarter = szIsQuarter;
window.szQuarterLabel = szQuarterLabel;
window.szQuarterBounds = szQuarterBounds;
window.szEpochDay = szEpochDay;
window.szFromEpochDay = szFromEpochDay;
window.szPmPointDay = szPmPointDay;
window.szPmSnapshotDay = szPmSnapshotDay;
window.szPmDateSnapshotRows = szPmDateSnapshotRows;
window.szDedupeByDate = szDedupeByDate;
window.szRangeEnd = szRangeEnd;
window.szRangeCutoff = szRangeCutoff;
window.szPmIncomeNet = szPmIncomeNet;
window.szPnlFirstMoveIndex = szPnlFirstMoveIndex;
window.szPnlLifeStartDay = szPnlLifeStartDay;
window.szPmIncomeCurve = szPmIncomeCurve;
