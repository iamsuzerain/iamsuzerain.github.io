// Records.jsx — the whole book's all-time records, over a calendar of every day.
// Globals: React, Cursor, window.szBook (Combined.jsx)
//
// Everything here reads the build the book view draws (window.szBook.load) and
// its chained TWR (window.szBook.pctSeries), never a loader of its own: a day's
// return on this page is the same number the book's percent curve steps by on
// that day. The book view owns the windowed analytics — risk, drawdown episodes,
// the return distribution, monthly bars. This page is lifetime-only and answers
// a different question: when were the extremes, and how long did the runs last.

const REC_DAY_MS = 86400000;
// A diverging ramp: magenta gains, deep violet losses, both running down to
// the panel at zero. Deep violet rather than the site's --mark-neg: the lighter
// violet sat too close to pink to read the sign (and under the colorblind
// separation floor, deutan ΔE 7.5); the lightness gap to this one clears it
// (ΔE 13.9). Every step is mixed OPAQUE toward --ink-2 instead of drawn
// translucent, so the glass pane's backdrop — the skyline, brighter in some
// places than others — can't show through and shift a cell's shade.
const REC_POS = '#ff4fd8';   // --mark-pos: gains are magenta
const REC_NEG = '#6d28d9';   // violet-700: losses are deep violet
const REC_BASE = '#120c1f';  // --ink-2, what the ramp fades into
const REC_FLAT_FILL = '#e5e1f1';
const REC_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const REC_DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Cell intensity by |daily return|. Fixed, round breakpoints rather than
// quantiles, so the legend can name them and a day's shade doesn't change as
// history accumulates. Roughly the 45th/70th/90th/98th percentiles of |r| on
// the history as of 2026-09-14.
//
// The first bucket is a real bucket, not noise suppression: weekend days carry
// only polymarket, and their median move is under a basis point. Tinting those
// pink or violet would paint two of every seven cells with a sign nobody could
// act on, so under 0.05% the cell stays neutral.
const REC_FLAT = 0.0005;
const REC_STEPS = [0.0025, 0.005, 0.01, 0.02];
const REC_ALPHA = [0.2, 0.38, 0.58, 0.8, 1];

function recMix(hex, t) {
  const a = [1, 3, 5].map(i => parseInt(REC_BASE.slice(i, i + 2), 16));
  const b = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}
// Index 0-4 by recLevel; flat days take a faint neutral step of their own.
const REC_RAMP_POS = REC_ALPHA.map(t => recMix(REC_POS, t));
const REC_RAMP_NEG = REC_ALPHA.map(t => recMix(REC_NEG, t));
const REC_RAMP_FLAT = recMix(REC_FLAT_FILL, 0.06);
const recFill = (r) => {
  const lv = recLevel(r);
  return lv < 0 ? REC_RAMP_FLAT : (r > 0 ? REC_RAMP_POS : REC_RAMP_NEG)[lv];
};

function recLevel(r) {
  const a = Math.abs(r);
  if (a < REC_FLAT) return -1;
  let k = 0;
  while (k < REC_STEPS.length && a >= REC_STEPS[k]) k++;
  return k;
}

const recEpoch = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / REC_DAY_MS);
const recIso = (day) => new Date(day * REC_DAY_MS).toISOString().slice(0, 10);
// Monday-start weeks: 1970-01-01 was a Thursday, so day+3 puts Monday at 0.
const recWeekStart = (day) => day - ((day + 3) % 7);
const recDow = (day) => (day + 4) % 7;   // 0 = sunday, as Date.getUTCDay

function recDate(iso, withYear = true) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${REC_MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}
function recSpan(a, b) {
  if (a === b) return recDate(a);
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return `${recDate(a, !sameYear)} – ${recDate(b)}`;
}
function recMonthName(ym) {
  return `${REC_MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
}
const recPct = (v) => (v == null || !isFinite(v)) ? '—'
  : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(2) + '%';
function recUSD(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '−') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
}

// One row per day off the book build. `r` is the chained TWR's own step,
// (1+v_i)/(1+v_{i-1}) − 1, which is exactly Δ(P&L)/base_{i-1} — the day's P&L on
// the capital that earned it. `usd` and the legs are that day's dollars.
//
// The series is calendar-daily until it outgrows the plot-point ceiling
// (cmbDownsample, ~5 years out); past that a step would span several days, so
// any gap is refused rather than silently read as one day.
function recDays(book) {
  const s = book && book.series;
  if (!s || s.length < 2) return null;
  const pct = window.szBook.pctSeries(s, book.benchNotional, ['spx']);
  if (!pct) return null;
  const out = [];
  let peak = 1;
  for (let i = 1; i < s.length; i++) {
    const day = recEpoch(s[i].d);
    if (day - recEpoch(s[i - 1].d) !== 1) return null;
    const idx = 1 + pct[i].v;
    const high = idx > peak;
    if (high) peak = idx;
    out.push({
      d: s[i].d, day,
      r: idx / (1 + pct[i - 1].v) - 1,
      usd: s[i].v - s[i - 1].v,
      ibkr: (s[i].ibkr || 0) - (s[i - 1].ibkr || 0),
      pm: (s[i].pm || 0) - (s[i - 1].pm || 0),
      high,
    });
  }
  return out;
}

// Calendar periods, chained from the days inside them. Only complete periods
// are eligible for a record: the first month opens on Apr 24 and the current
// week is still running, and a three-day "worst week" is a different claim from
// a seven-day one.
function recPeriods(days, keyOf, isComplete) {
  const map = new Map();
  for (const x of days) {
    const k = keyOf(x);
    if (!map.has(k)) map.set(k, { key: k, days: [], g: 1, usd: 0 });
    const p = map.get(k);
    p.days.push(x);
    p.g *= 1 + x.r;
    p.usd += x.usd;
  }
  return [...map.values()]
    .map(p => ({ ...p, r: p.g - 1, from: p.days[0].d, to: p.days[p.days.length - 1].d }))
    .filter(isComplete);
}

function recBuild(book) {
  const days = recDays(book);
  if (!days || days.length < 14) return null;
  const firstDay = days[0].day, lastDay = days[days.length - 1].day;

  const weeks = recPeriods(days, x => recWeekStart(x.day), p => p.days.length === 7);
  const daysInMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  const months = recPeriods(days, x => x.d.slice(0, 7), p => p.days.length === daysInMonth(p.key));

  const extreme = (list, better) => list.reduce((a, b) => (a == null || better(b.r, a.r) ? b : a), null);
  const bestDay = extreme(days, (a, b) => a > b), worstDay = extreme(days, (a, b) => a < b);
  const bestWeek = extreme(weeks, (a, b) => a > b), worstWeek = extreme(weeks, (a, b) => a < b);
  const bestMonth = extreme(months, (a, b) => a > b), worstMonth = extreme(months, (a, b) => a < b);

  // Runs of consecutive complete weeks on one side of zero. Ties go to the
  // later run — the recent one is the one a reader can still place.
  const run = (sign) => {
    let best = null, cur = null;
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      const adjacent = cur && w.key - cur.weeks[cur.weeks.length - 1].key === 7;
      if (Math.sign(w.r) === sign) {
        if (!adjacent) cur = { weeks: [] };
        cur.weeks.push(w);
        if (!best || cur.weeks.length >= best.weeks.length) best = { weeks: cur.weeks.slice() };
      } else {
        cur = null;
      }
    }
    if (!best) return null;
    const ws = best.weeks;
    return {
      n: ws.length,
      r: ws.reduce((g, w) => g * (1 + w.r), 1) - 1,
      usd: ws.reduce((a, w) => a + w.usd, 0),
      from: ws[0].from, to: ws[ws.length - 1].to,
      // Still running if it ends on the last complete week and the current,
      // partial week hasn't broken it yet.
      open: ws[ws.length - 1] === weeks[weeks.length - 1],
      days: ws.flatMap(w => w.days),
    };
  };
  const upRun = run(1), downRun = run(-1);

  // Closes at a new high of the TWR index (not NAV, which deposits would move).
  const highs = days.filter(x => x.high);
  // Longest stretch between one high and the next. The series opens at its own
  // high (the base), and a stretch still open today counts at its length so far.
  let wait = null;
  let prevDay = firstDay - 1, prevIso = recIso(firstDay - 1);
  const consider = (endDay, endIso, open) => {
    const n = endDay - prevDay;
    if (n > 1 && (!wait || n >= wait.n)) wait = { n, from: prevIso, to: endIso, open };
  };
  for (const h of highs) { consider(h.day, h.d, false); prevDay = h.day; prevIso = h.d; }
  if (lastDay > prevDay) consider(lastDay, days[days.length - 1].d, true);

  return { days, weeks, months, firstDay, lastDay,
    bestDay, worstDay, bestWeek, worstWeek, bestMonth, worstMonth,
    upRun, downRun, highs, wait };
}

// ---------- the calendar ----------
// One block per calendar year, newest on top, Monday-first weeks as columns.
// A single continuous strip was the first cut, and it had nowhere to go: at 73
// weeks it already filled the panel, so every new week shrank every cell until
// the strip had to scroll and hide its own start. A year is a fixed 54 columns
// (a partial first week, 52 whole ones, a partial last), so the width never
// changes and history grows downward, one block a year.
//
// Drawn at a fixed pitch and scaled as a whole (aspect kept), so the labels can
// live in the SVG without being stretched; below a readable cell size it
// scrolls sideways instead of shrinking further, which only happens on a phone.
//
// Solid cells on a 1px seam, and nothing drawn inside a cell. An earlier pass
// outlined the loss days and dotted the new highs; hundreds of small rings and
// dots in a grid read as a cluster of holes, which is a trypophobia trigger, and
// the wider gap made every cell its own pit. Tight seams let a year read as one
// surface, and the highs moved to a band of their own under it.
const REC_CELL = 13, REC_GAP = 1, REC_PITCH = REC_CELL + REC_GAP;
const REC_LEFT = 30, REC_HEAD = 16, REC_COLS = 54;
const REC_BAND_GAP = 6, REC_BAND = 5;   // the new-highs band under each year
const REC_BLOCK_GAP = 18;
const REC_BLOCK = REC_HEAD + 7 * REC_PITCH + REC_BAND_GAP + REC_BAND;

function RecCalendar({ rec, active, hover, onHover }) {
  const scrollRef = React.useRef(null);
  const svgRef = React.useRef(null);
  const byDay = React.useMemo(() => new Map(rec.days.map(x => [x.day, x])), [rec]);
  const lit = active ? active.set : null;

  const y0 = +recIso(rec.firstDay).slice(0, 4), y1 = +recIso(rec.lastDay).slice(0, 4);
  const years = [];
  for (let y = y1; y >= y0; y--) years.push(y);
  const W = REC_LEFT + REC_COLS * REC_PITCH;
  const H = years.length * REC_BLOCK + (years.length - 1) * REC_BLOCK_GAP;

  const yearOf = (day) => +recIso(day).slice(0, 4);
  const jan1 = (y) => Math.floor(Date.UTC(y, 0, 1) / REC_DAY_MS);
  const colOf = (day) => (recWeekStart(day) - recWeekStart(jan1(yearOf(day)))) / 7;
  const rowOf = (day) => (recDow(day) + 6) % 7;   // monday on top
  const topOf = (y) => (y1 - y) * (REC_BLOCK + REC_BLOCK_GAP);
  const cellX = (day) => REC_LEFT + colOf(day) * REC_PITCH;
  const cellY = (day) => topOf(yearOf(day)) + REC_HEAD + rowOf(day) * REC_PITCH;

  // When it has to scroll, bring the latest day into view: it sits in the top
  // block, usually well short of december.
  React.useEffect(() => {
    const el = scrollRef.current, svg = svgRef.current;
    if (!el || !svg || el.scrollWidth <= el.clientWidth) return;
    const scale = svg.getBoundingClientRect().width / W;
    el.scrollLeft = Math.max(0, (cellX(rec.lastDay) + REC_PITCH * 3) * scale - el.clientWidth);
  }, []);

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const t = e.touches && e.touches.length ? e.touches[0] : e;
    const px = ((t.clientX - rect.left) / rect.width) * W;
    const py = ((t.clientY - rect.top) / rect.height) * H;
    const b = Math.floor(py / (REC_BLOCK + REC_BLOCK_GAP));
    const y = y1 - b;
    const col = Math.floor((px - REC_LEFT) / REC_PITCH);
    const row = Math.floor((py - topOf(y) - REC_HEAD) / REC_PITCH);
    if (y < y0 || col < 0 || col >= REC_COLS || row < 0 || row > 6) { onHover(null); return; }
    const day = recWeekStart(jan1(y)) + col * 7 + row;
    const x = yearOf(day) === y ? byDay.get(day) : null;
    onHover(x ? x.day : null);
  }

  const out = [];
  for (const y of years) {
    const top = topOf(y);
    out.push(<text key={`y${y}`} className="rec-cal-year" x="0" y={top + REC_HEAD - 5}>{y}</text>);
    // Every month labeled over the column holding its 1st, whether or not the
    // history reaches it: an empty january is still january.
    for (let m = 0; m < 12; m++) {
      const c = colOf(Math.floor(Date.UTC(y, m, 1) / REC_DAY_MS));
      out.push(<text key={`m${y}-${m}`} className="rec-cal-label"
        x={REC_LEFT + c * REC_PITCH} y={top + REC_HEAD - 5}>{REC_MONTHS[m]}</text>);
    }
    for (const row of [0, 2, 4]) {
      out.push(<text key={`d${y}-${row}`} className="rec-cal-label" x="0"
        y={top + REC_HEAD + row * REC_PITCH + REC_CELL - 3}>{REC_DOW[(row + 1) % 7]}</text>);
    }
    out.push(<text key={`h${y}`} className="rec-cal-label" x="0"
      y={top + REC_BLOCK}>high</text>);
  }

  // Sign rides on the ramp alone (see REC_NEG); the readout under the calendar
  // and every record row also spell it out in text.
  for (const x of rec.days) {
    out.push(<rect key={x.day} x={cellX(x.day)} y={cellY(x.day)} width={REC_CELL} height={REC_CELL} rx="1"
      fill={recFill(x.r)} opacity={lit && !lit.has(x.day) ? 0.16 : 1}/>);
  }

  // New highs per week, as one continuous band under each year: a column's
  // shade is how many of its days closed at a high. Adjacent weeks share an
  // edge, so a run of highs reads as a bar rather than a row of separate marks.
  const highsByCol = new Map();
  for (const h of rec.highs) {
    const k = `${yearOf(h.day)}:${colOf(h.day)}`;
    if (!highsByCol.has(k)) highsByCol.set(k, []);
    highsByCol.get(k).push(h.day);
  }
  for (const [k, ds] of highsByCol) {
    const [y, c] = k.split(':').map(Number);
    const on = !lit || ds.some(d => lit.has(d));
    out.push(<rect key={`b${k}`} x={REC_LEFT + c * REC_PITCH}
      y={topOf(y) + REC_HEAD + 7 * REC_PITCH + REC_BAND_GAP}
      width={REC_PITCH} height={REC_BAND}
      fill="#f5f0ff" fillOpacity={0.18 + 0.1 * ds.length} opacity={on ? 1 : 0.16}/>);
  }

  const hx = hover != null ? byDay.get(hover) : null;

  return (
    <div className="rec-cal-scroll" ref={scrollRef}>
      <svg ref={svgRef} className="rec-cal" viewBox={`0 0 ${W} ${H}`}
        style={{ minWidth: `${Math.round(W * 0.8)}px` }}
        onMouseMove={onMove} onMouseLeave={() => onHover(null)}
        onTouchStart={onMove} onTouchMove={onMove}>
        {out}
        {hx && (
          <rect x={cellX(hx.day) - 1} y={cellY(hx.day) - 1}
            width={REC_CELL + 2} height={REC_CELL + 2} rx="2"
            fill="none" stroke="#f5f0ff" strokeWidth="1.2" pointerEvents="none"/>
        )}
      </svg>
    </div>
  );
}

// The hovered day, or the latest one at rest. A fixed line under the calendar
// rather than a floating tooltip: the calendar scrolls sideways on a phone, and
// a box hung off a 13px cell would be clipped by that same scroll container.
function RecReadout({ x }) {
  if (!x) return <div className="rec-readout"/>;
  const dow = REC_DOW[recDow(x.day)];
  return (
    <div className="rec-readout">
      <span className="rec-readout-date">{dow} {recDate(x.d)}</span>
      <span className={x.r >= 0 ? 'pos' : 'neg'}>{recPct(x.r)}</span>
      <span>{recUSD(x.usd)}</span>
      <span className="rec-readout-legs">ibkr {recUSD(x.ibkr)} · poly {recUSD(x.pm)}</span>
      {x.high && <span className="rec-readout-high">new high</span>}
    </div>
  );
}

function RecLegend() {
  const sw = (fill, i) => (
    <svg key={i} width="12" height="12" viewBox="0 0 12 12" aria-hidden>{fill}</svg>
  );
  return (
    <div className="rec-legend">
      <span>loss</span>
      {[...REC_RAMP_NEG].reverse().map((c, i) => sw(<rect width="12" height="12" rx="1" fill={c}/>, `n${i}`))}
      {sw(<rect width="12" height="12" rx="1" fill={REC_RAMP_FLAT}/>, 'z')}
      {REC_RAMP_POS.map((c, i) => sw(<rect width="12" height="12" rx="1" fill={c}/>, `p${i}`))}
      <span>gain</span>
      <span className="rec-legend-scale">steps at 0.05 · 0.25 · 0.5 · 1 · 2%</span>
      <span className="rec-legend-high">
        <svg width="18" height="5" viewBox="0 0 18 5" aria-hidden>
          <rect width="18" height="5" fill="#f5f0ff" fillOpacity="0.5"/>
        </svg>
        weeks with new highs
      </span>
    </div>
  );
}

// ---------- the records ----------
// Paired best | worst, so each row of the grid is one question with both of
// its answers side by side.
function RecRow({ id, label, value, tone, when, note, active, onActive, onPin, pinned }) {
  const cls = tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : '';
  return (
    <button type="button"
      className={`rec-row${active ? ' is-active' : ''}${pinned ? ' is-pinned' : ''}`}
      onMouseEnter={() => onActive(id)} onMouseLeave={() => onActive(null)}
      onFocus={() => onActive(id)} onBlur={() => onActive(null)}
      onClick={() => onPin(id)} aria-pressed={pinned}>
      <span className="rec-row-label">{label}</span>
      <span className={`rec-row-value ${cls}`}>{value}</span>
      <span className="rec-row-when">{when}</span>
      {note && <span className="rec-row-note">{note}</span>}
    </button>
  );
}

function recDefs(rec) {
  const daySet = (list) => new Set(list.map(x => x.day));
  const defs = [];
  const period = (id, label, p, kind) => p && defs.push({
    id, label, value: recPct(p.r), tone: p.r >= 0 ? 'pos' : 'neg',
    when: kind === 'day' ? `${REC_DOW[recDow(p.day)]} ${recDate(p.d)}`
      : kind === 'month' ? recMonthName(p.key) : recSpan(p.from, p.to),
    note: recUSD(p.usd),
    set: kind === 'day' ? new Set([p.day]) : daySet(p.days),
  });
  period('best-day', 'best day', rec.bestDay, 'day');
  period('worst-day', 'worst day', rec.worstDay, 'day');
  period('best-week', 'best week', rec.bestWeek, 'week');
  period('worst-week', 'worst week', rec.worstWeek, 'week');
  period('best-month', 'best month', rec.bestMonth, 'month');
  period('worst-month', 'worst month', rec.worstMonth, 'month');
  const runDef = (id, label, x) => defs.push(x ? {
    id, label, value: `${x.n} week${x.n === 1 ? '' : 's'}`,
    when: `${recSpan(x.from, x.to)}${x.open ? ' · running' : ''}`,
    note: `${recPct(x.r)} · ${recUSD(x.usd)}`, set: daySet(x.days),
  } : { id, label, value: '—', when: 'none yet', set: new Set() });
  runDef('up-run', 'longest run of up weeks', rec.upRun);
  runDef('down-run', 'longest run of down weeks', rec.downRun);
  const last = rec.highs[rec.highs.length - 1];
  defs.push({
    id: 'highs', label: 'new highs', value: `${rec.highs.length} days`,
    when: last ? `latest ${recDate(last.d)}` : 'none yet',
    note: `of ${rec.days.length} on record`, set: daySet(rec.highs),
  });
  const w = rec.wait;
  const waitDays = new Set();
  if (w) for (let d = recEpoch(w.from) + 1; d <= recEpoch(w.to); d++) waitDays.add(d);
  defs.push(w ? {
    id: 'wait', label: 'longest wait for a new high', value: `${w.n} days`,
    when: `${recSpan(w.from, w.to)}${w.open ? ' · still waiting' : ''}`,
    note: w.open ? 'measured to the latest close' : 'high to next high', set: waitDays,
  } : { id: 'wait', label: 'longest wait for a new high', value: '—', when: 'never below a high', set: new Set() });
  return defs;
}

function Records() {
  const [book, setBook] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [hoverRec, setHoverRec] = React.useState(null);
  const [pinned, setPinned] = React.useState(null);
  const [hoverDay, setHoverDay] = React.useState(null);

  React.useEffect(() => {
    let canceled = false;
    window.szBook.load()
      .then(d => { if (!canceled) setBook(d); })
      .catch(e => { if (!canceled) setErr(String(e.message || e)); });
    return () => { canceled = true; };
  }, []);

  const rec = React.useMemo(() => (book ? recBuild(book) : null), [book]);
  const defs = React.useMemo(() => (rec ? recDefs(rec) : []), [rec]);

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ records</div>
      <h2 className="sz-h2">couldn't build book feed.</h2>
      <p><code>{err}</code></p>
      <p className="sz-dim">records read the same build as the book view, which needs <code>data/portfolio.json</code>.</p>
    </section>
  );
  if (!book) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ records</div>
      <h2 className="sz-h2">merging feeds<Cursor /></h2>
    </section>
  );
  if (!rec) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ records</div>
      <h2 className="sz-h2">not enough daily history yet.</h2>
    </section>
  );

  const activeId = hoverRec || pinned;
  const active = activeId ? defs.find(x => x.id === activeId) : null;
  const shownDay = hoverDay != null
    ? rec.days.find(x => x.day === hoverDay)
    : rec.days[rec.days.length - 1];
  const first = rec.days[0].d, last = rec.days[rec.days.length - 1].d;
  const togglePin = (id) => setPinned(p => (p === id ? null : id));

  return (
    <section className="pf-wrap rec-view">
      <div className="pf-head">
        <div>
          <div className="sz-kicker">◆ records · ibkr + polymarket</div>
          <h2 className="sz-h2 pm-headline">
            <span>{rec.days.length}</span>
            <span className="pf-currency">days on record</span>
          </h2>
          <div className="pf-sub">
            the whole book, {recSpan(first, last)} · daily twr on the capital that earned it
          </div>
        </div>
      </div>

      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">every day</span>
          <span className="pf-panel-meta">weeks run monday to sunday · weekends are polymarket alone</span>
        </div>
        <RecCalendar rec={rec} active={active} hover={hoverDay} onHover={setHoverDay}/>
        <RecReadout x={shownDay}/>
        <RecLegend/>
      </div>

      <div className="pf-panel">
        <div className="pf-panel-head">
          <span className="pf-panel-title">records</span>
          <span className="pf-panel-meta">complete weeks and months only · hover or tap to find them above</span>
        </div>
        <div className="rec-grid">
          {defs.map(x => (
            <RecRow key={x.id} {...x} active={activeId === x.id} pinned={pinned === x.id}
              onActive={setHoverRec} onPin={togglePin}/>
          ))}
        </div>
      </div>
    </section>
  );
}

window.Records = Records;
