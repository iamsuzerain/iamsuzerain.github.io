// Records.jsx — the whole book's all-time records, over a calendar of every day.
// Globals: React, Cursor, SzToggle (Chart.jsx), window.szBook (Combined.jsx)
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
// `rs` is the S&P 500's own step off the same build (its column is the index
// return rebased to the series start, forward-filled over weekends, so a closed
// market steps 0). `ib` and `pmc` are each book's share of `r`, its dollars on
// the same prior-day base, so the two always sum to the day's return.
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
    const ibkr = (s[i].ibkr || 0) - (s[i - 1].ibkr || 0);
    const pm = (s[i].pm || 0) - (s[i - 1].pm || 0);
    const base = s[i - 1].base > 0 ? s[i - 1].base : book.benchNotional;
    const hasSpx = pct[i].spx != null && pct[i - 1].spx != null;
    out.push({
      d: s[i].d, day,
      r: idx / (1 + pct[i - 1].v) - 1,
      usd: s[i].v - s[i - 1].v,
      ibkr, pm,
      ib: base > 0 ? ibkr / base : 0,
      pmc: base > 0 ? pm / base : 0,
      rs: hasSpx ? (1 + pct[i].spx) / (1 + pct[i - 1].spx) - 1 : null,
      pnl: s[i].v,          // cumulative since the series opens
      twr: pct[i].v,
      nav: s[i].base,       // ibkr nav + polymarket nav that day
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
    if (!map.has(k)) map.set(k, { key: k, days: [], g: 1, gs: 1, spx: true, usd: 0 });
    const p = map.get(k);
    p.days.push(x);
    p.g *= 1 + x.r;
    if (x.rs == null) p.spx = false; else p.gs *= 1 + x.rs;
    p.usd += x.usd;
  }
  return [...map.values()]
    .map(p => ({ ...p, r: p.g - 1, rs: p.spx ? p.gs - 1 : null,
      from: p.days[0].d, to: p.days[p.days.length - 1].d }))
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

  // Runs of consecutive complete weeks that pass a test. Ties go to the later
  // run — the recent one is the one a reader can still place.
  const run = (pass) => {
    let best = null, cur = null;
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      const adjacent = cur && w.key - cur.weeks[cur.weeks.length - 1].key === 7;
      if (pass(w)) {
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
      rs: ws.reduce((g, w) => g * (1 + (w.rs || 0)), 1) - 1,
      usd: ws.reduce((a, w) => a + w.usd, 0),
      from: ws[0].from, to: ws[ws.length - 1].to,
      // Still running if it ends on the last complete week and the current,
      // partial week hasn't broken it yet.
      open: ws[ws.length - 1] === weeks[weeks.length - 1],
      days: ws.flatMap(w => w.days),
    };
  };
  const upRun = run(w => w.r > 0), downRun = run(w => w.r < 0);

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
    spx: recVsSpx(days, months, run),
    books: recBooks(days),
    milestones: recMilestones(days),
    odds: recOdds(days),
    bestDay, worstDay, bestWeek, worstWeek, bestMonth, worstMonth,
    upRun, downRun, highs, wait };
}

// ---------- against the S&P 500 ----------
// Relative figures are simple differences of the two returns over the same
// span, in percentage points: a day the book made 1% while the index made 0.4%
// is +0.6 points. Weekends count, with the index at 0 — the market was shut and
// the book wasn't, which is the honest reading of those days.
function recVsSpx(days, months, run) {
  const dd = days.filter(x => x.rs != null);
  if (dd.length < 14) return null;
  const rel = (list) => list.filter(p => p.rs != null).map(p => ({ ...p, rel: p.r - p.rs }));
  const pick = (list, key, better) => list.reduce((a, b) => (a == null || better(b[key], a[key]) ? b : a), null);
  const rd = rel(dd), rm = rel(months);
  return {
    bestDay: pick(rd, 'rel', (a, b) => a > b), worstDay: pick(rd, 'rel', (a, b) => a < b),
    bestMonth: pick(rm, 'rel', (a, b) => a > b), worstMonth: pick(rm, 'rel', (a, b) => a < b),
    beatRun: run(w => w.rs != null && w.r > w.rs),
    trailRun: run(w => w.rs != null && w.r < w.rs),
    // Only sessions the index actually moved, so a flat weekend can't be the
    // best day on a red tape.
    redTape: pick(dd.filter(x => x.rs < 0), 'r', (a, b) => a > b),
    greenTape: pick(dd.filter(x => x.rs > 0), 'r', (a, b) => a < b),
  };
}

// ---------- the two books ----------
// Offsetting days need both books to have moved enough to matter, by the same
// 0.05% line that keeps a calendar cell neutral: polymarket moves by cents on a
// quiet weekend, and a +$4 day against ibkr's −$9k is not a hedge.
function recBooks(days) {
  const byLeg = (key, better) => days.reduce((a, b) => (a == null || better(b[key], a[key]) ? b : a), null);
  const both = days.filter(x => Math.abs(x.ib) >= REC_FLAT && Math.abs(x.pmc) >= REC_FLAT);
  const offset = both.filter(x => Math.sign(x.ib) !== Math.sign(x.pmc));
  // The day one book absorbed the most of the other's move: the smaller of the
  // two opposite legs is what actually got canceled.
  const cushion = offset.reduce((a, b) => {
    const cb = Math.min(Math.abs(b.ibkr), Math.abs(b.pm));
    return (a == null || cb > a.absorbed) ? { ...b, absorbed: cb } : a;
  }, null);
  return {
    ibBest: byLeg('ib', (a, b) => a > b), ibWorst: byLeg('ib', (a, b) => a < b),
    pmBest: byLeg('pmc', (a, b) => a > b), pmWorst: byLeg('pmc', (a, b) => a < b),
    both, offset, cushion,
  };
}

// ---------- milestones ----------
// The first close at or past each rung. Three ladders because they answer
// different questions: P&L is what the book earned since the history opens,
// the TWR is that as a return, and net liquidity is how big the book is —
// which deposits and transfers moved as much as performance did, so it is
// labeled as a size, not an achievement. Each ladder shows only the rungs
// reached.
function recShortUSD(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
  if (a >= 1e3) return '$' + Math.round(a / 1e3) + 'k';
  return '$' + Math.round(a);
}

const REC_LADDERS = [
  { key: 'pnl', label: 'pnl', rungs: [50e3, 100e3, 250e3, 500e3, 1e6, 2.5e6, 5e6],
    fmt: (v) => '+' + recShortUSD(v) },
  { key: 'twr', label: 'return', rungs: [0.25, 0.5, 1, 2, 3, 5],
    fmt: (v) => '+' + Math.round(v * 100) + '%' },
  { key: 'nav', label: 'net liquidity', rungs: [750e3, 1e6, 1.5e6, 2e6, 3e6, 5e6],
    fmt: (v) => recShortUSD(v) },
];

function recMilestones(days) {
  return REC_LADDERS.map(l => {
    const start = days[0][l.key];
    const hit = [];
    for (const t of l.rungs) {
      if (start != null && t <= start) continue;   // already there when the history opens
      const x = days.find(d => d[l.key] != null && d[l.key] >= t);
      if (!x) break;
      hit.push({ t, x, n: x.day - days[0].day + 1 });
    }
    return { ...l, hit };
  });
}

// ---------- odds and ends ----------
function recOdds(days) {
  const highsByMonth = new Map();
  for (const x of days) {
    if (!x.high) continue;
    const ym = x.d.slice(0, 7);
    if (!highsByMonth.has(ym)) highsByMonth.set(ym, []);
    highsByMonth.get(ym).push(x);
  }
  let mostHighs = null;
  for (const [ym, xs] of highsByMonth) if (!mostHighs || xs.length >= mostHighs.xs.length) mostHighs = { ym, xs };
  // Mean return by weekday, monday to friday. Weekends are left out: they carry
  // polymarket alone and would be ranked on a different book.
  const wd = [1, 2, 3, 4, 5].map(k => {
    const xs = days.filter(x => recDow(x.day) === k);
    return { k, xs, mean: xs.reduce((a, x) => a + x.r, 0) / (xs.length || 1),
      up: xs.filter(x => x.r > 0).length };
  });
  const best = wd.reduce((a, b) => (b.mean > a.mean ? b : a));
  const worst = wd.reduce((a, b) => (b.mean < a.mean ? b : a));
  return { mostHighs, best, worst };
}

// ---------- polymarket bets ----------
// From the calibration feed's closed lots. A position can close as two lots (a
// swing exit and a held-to-resolution remainder), so lots are summed per
// market and outcome first: the reader's unit is the bet, not the accounting
// split. Dated on the last lot's close; priced at its entry averaged over the
// lots by stake.
//
// Best and worst then rank whole events. Polymarket lists every strike of
// "what will WTI hit in June" as its own market, and one oil view bet across
// several of them showed up as both the worst bet (the $75 leg) and the
// biggest favorite loss (the $70 leg) — two rows for one trade. The feed's
// `event` column names the event where it differs from the market's title;
// where it is null the market is its own event.
//
// The underdog and favorite rows stay per market, because a price belongs to a
// market and not to an event, and they skip any market inside the events
// already shown as best or worst. They rank by money, not by price: ranking by
// the longest odds let a $700 punt at 7¢ outrank Ohtani-not-MVP bought at 23¢
// for +$7,296, and restricting to bets held to resolution dropped that one
// entirely — it was sold at a profit before the award was decided. Sold bets
// count: the question is what paid, and a sale is when it paid.
const REC_UNDERDOG = 0.5;

function recBets(cal) {
  if (!cal || !Array.isArray(cal.lots) || !cal.lots.length) return null;
  const cols = (cal.method && cal.method.lotColumns) ||
    ['category', 'closedOn', 'via', 'volume', 'realizedPnl', 'win', 'impliedEntry', 'market', 'outcome'];
  const at = Object.fromEntries(cols.map((c, i) => [c, i]));
  const bets = new Map();
  for (const l of cal.lots) {
    const lot = {
      d: l[at.closedOn], pnl: l[at.realizedPnl], entry: l[at.impliedEntry],
      market: l[at.market], outcome: l[at.outcome],
      event: (at.event != null && l[at.event]) || l[at.market],
    };
    if (!lot.d || lot.pnl == null) continue;
    const k = JSON.stringify([lot.market, lot.outcome]);
    const b = bets.get(k) || { market: lot.market, outcome: lot.outcome, event: lot.event,
      pnl: 0, d: lot.d, stake: 0, priced: 0 };
    b.pnl += lot.pnl;
    if (lot.d > b.d) b.d = lot.d;
    const vol = l[at.volume];
    if (lot.entry != null && vol > 0) { b.stake += vol; b.priced += lot.entry * vol; }
    bets.set(k, b);
  }
  const all = [...bets.values()].map(b => ({ ...b, entry: b.stake > 0 ? b.priced / b.stake : null }));
  if (!all.length) return null;

  const events = new Map();
  for (const b of all) {
    const e = events.get(b.event) || { event: b.event, pnl: 0, d: b.d, bets: [] };
    e.pnl += b.pnl;
    if (b.d > e.d) e.d = b.d;
    e.bets.push(b);
    events.set(b.event, e);
  }
  const evs = [...events.values()];
  const best = evs.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const worst = evs.reduce((a, b) => (b.pnl < a.pnl ? b : a));

  const shown = new Set([best.event, worst.event]);
  const rest = all.filter(b => !shown.has(b.event) && b.entry != null);
  const pickBy = (list, better) => list.length ? list.reduce((a, b) => (better(b.pnl, a.pnl) ? b : a)) : null;
  const underdog = pickBy(rest.filter(b => b.entry < REC_UNDERDOG && b.pnl > 0), (a, b) => a > b);
  const favorite = pickBy(rest.filter(b => b.entry > REC_UNDERDOG && b.pnl < 0), (a, b) => a < b);
  return { n: all.length, best, worst, underdog, favorite };
}

// ---------- the calendar ----------
// One block per calendar year, newest on top, Monday-first weeks as columns.
// A single continuous strip was the first cut, and it had nowhere to go: at 73
// weeks it already filled the panel, so every new week shrank every cell until
// the strip had to scroll and hide its own start. A year is a fixed 54 columns
// (a partial first week, 52 whole ones, a partial last), so the width never
// changes and history grows downward, one block a year.
//
// Stacking every year stopped scaling too, so one block draws at a time: the
// past 365 days by default, each calendar year behind a switch in the panel
// head. A span of 365 days is at most 53 week columns, so it fits the same 54.
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
const REC_BAND_GAP = 6, REC_BAND = 5;   // the new-highs band under the cells
const REC_BLOCK = REC_HEAD + 7 * REC_PITCH + REC_BAND_GAP + REC_BAND;

function RecCalendar({ rec, span, active, hover, onHover }) {
  const scrollRef = React.useRef(null);
  const svgRef = React.useRef(null);
  const byDay = React.useMemo(() => new Map(rec.days.map(x => [x.day, x])), [rec]);
  const lit = active ? active.set : null;
  const { from, to } = span;
  const inSpan = (day) => day >= from && day <= to;
  const days = React.useMemo(() => rec.days.filter(x => inSpan(x.day)), [rec, from, to]);
  const W = REC_LEFT + REC_COLS * REC_PITCH, H = REC_BLOCK;

  const col0 = recWeekStart(from);
  const colOf = (day) => (recWeekStart(day) - col0) / 7;
  const rowOf = (day) => (recDow(day) + 6) % 7;   // monday on top
  const cellX = (day) => REC_LEFT + colOf(day) * REC_PITCH;
  const cellY = (day) => REC_HEAD + rowOf(day) * REC_PITCH;

  // When it has to scroll, bring the span's latest day into view: in the
  // current year that is usually well short of december.
  React.useEffect(() => {
    const el = scrollRef.current, svg = svgRef.current;
    if (!el || !svg || !days.length || el.scrollWidth <= el.clientWidth) return;
    const scale = svg.getBoundingClientRect().width / W;
    el.scrollLeft = Math.max(0, (cellX(days[days.length - 1].day) + REC_PITCH * 3) * scale - el.clientWidth);
  }, [from, to]);

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const t = e.touches && e.touches.length ? e.touches[0] : e;
    const px = ((t.clientX - rect.left) / rect.width) * W;
    const py = ((t.clientY - rect.top) / rect.height) * H;
    const col = Math.floor((px - REC_LEFT) / REC_PITCH);
    const row = Math.floor((py - REC_HEAD) / REC_PITCH);
    if (col < 0 || col >= REC_COLS || row < 0 || row > 6) { onHover(null); return; }
    const day = col0 + col * 7 + row;
    const x = inSpan(day) ? byDay.get(day) : null;
    onHover(x ? x.day : null);
  }

  const out = [];
  // Every month labeled over the column holding its 1st, whether or not the
  // history reaches it: an empty january is still january. A span that starts
  // mid-month labels that month at its first column too, when the next label
  // leaves it room. In a year the corner names the year; across two, the year
  // takes january's place, where it turns.
  const fromIso = recIso(from);
  const isYear = fromIso.slice(5) === '01-01';
  if (isYear) out.push(<text key="y" className="rec-cal-year" x="0" y={REC_HEAD - 5}>{fromIso.slice(0, 4)}</text>);
  const firsts = [from];   // the span's own first month, 1st or not
  for (let y = +fromIso.slice(0, 4), m = +fromIso.slice(5, 7); ; m++) {
    const day = Math.floor(Date.UTC(y, m, 1) / REC_DAY_MS);   // Date.UTC rolls m = 12 over
    if (day > to) break;
    firsts.push(day);
  }
  firsts.forEach((day, i) => {
    const c = colOf(day), next = firsts[i + 1];
    if (i === 0 && fromIso.slice(8) !== '01' && next != null && colOf(next) - c < 3) return;
    const [y, m] = recIso(day).split('-').map(Number);
    const yearMark = !isYear && m === 1;
    out.push(<text key={`m${day}`} className={yearMark ? 'rec-cal-year' : 'rec-cal-label'}
      x={REC_LEFT + c * REC_PITCH} y={REC_HEAD - 5}>{yearMark ? y : REC_MONTHS[m - 1]}</text>);
  });
  for (const row of [0, 2, 4]) {
    out.push(<text key={`d${row}`} className="rec-cal-label" x="0"
      y={REC_HEAD + row * REC_PITCH + REC_CELL - 3}>{REC_DOW[(row + 1) % 7]}</text>);
  }
  out.push(<text key="h" className="rec-cal-label" x="0" y={REC_BLOCK}>high</text>);

  // Sign rides on the ramp alone (see REC_NEG); the readout under the calendar
  // and every record row also spell it out in text.
  for (const x of days) {
    out.push(<rect key={x.day} x={cellX(x.day)} y={cellY(x.day)} width={REC_CELL} height={REC_CELL} rx="1"
      fill={recFill(x.r)} opacity={lit && !lit.has(x.day) ? 0.16 : 1}/>);
  }

  // New highs per week, as one continuous band under the span: a column's
  // shade is how many of its days closed at a high. Adjacent weeks share an
  // edge, so a run of highs reads as a bar rather than a row of separate marks.
  const highsByCol = new Map();
  for (const h of rec.highs) {
    if (!inSpan(h.day)) continue;
    const c = colOf(h.day);
    if (!highsByCol.has(c)) highsByCol.set(c, []);
    highsByCol.get(c).push(h.day);
  }
  for (const [c, ds] of highsByCol) {
    const on = !lit || ds.some(d => lit.has(d));
    out.push(<rect key={`b${c}`} x={REC_LEFT + c * REC_PITCH}
      y={REC_HEAD + 7 * REC_PITCH + REC_BAND_GAP}
      width={REC_PITCH} height={REC_BAND}
      fill="#f5f0ff" fillOpacity={0.18 + 0.1 * ds.length} opacity={on ? 1 : 0.16}/>);
  }

  const hx = hover != null && inSpan(hover) ? byDay.get(hover) : null;

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

const recTone = (v) => (v == null ? undefined : v >= 0 ? 'pos' : 'neg');
const recPts = (v) => (v == null || !isFinite(v)) ? '—'
  : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(2) + ' pts';
const recDayWhen = (x) => `${REC_DOW[recDow(x.day)]} ${recDate(x.d)}`;
const recWeeks = (n) => `${n} week${n === 1 ? '' : 's'}`;
const recDaySet = (list) => new Set(list.map(x => x.day));
const recEmpty = (id, label, when = 'none yet') => ({ id, label, value: '—', when, set: new Set() });

function recRecordRows(rec) {
  const rows = [];
  const period = (id, label, p, kind) => p && rows.push({
    id, label, value: recPct(p.r), tone: recTone(p.r),
    when: kind === 'day' ? recDayWhen(p) : kind === 'month' ? recMonthName(p.key) : recSpan(p.from, p.to),
    note: recUSD(p.usd),
    set: kind === 'day' ? new Set([p.day]) : recDaySet(p.days),
  });
  period('best-day', 'best day', rec.bestDay, 'day');
  period('worst-day', 'worst day', rec.worstDay, 'day');
  period('best-week', 'best week', rec.bestWeek, 'week');
  period('worst-week', 'worst week', rec.worstWeek, 'week');
  period('best-month', 'best month', rec.bestMonth, 'month');
  period('worst-month', 'worst month', rec.worstMonth, 'month');
  const runRow = (id, label, x) => rows.push(x ? {
    id, label, value: recWeeks(x.n),
    when: `${recSpan(x.from, x.to)}${x.open ? ' · running' : ''}`,
    note: `${recPct(x.r)} · ${recUSD(x.usd)}`, set: recDaySet(x.days),
  } : recEmpty(id, label));
  runRow('up-run', 'longest run of up weeks', rec.upRun);
  runRow('down-run', 'longest run of down weeks', rec.downRun);
  const last = rec.highs[rec.highs.length - 1];
  rows.push({
    id: 'highs', label: 'new highs', value: `${rec.highs.length} days`,
    when: last ? `latest ${recDate(last.d)}` : 'none yet',
    note: `of ${rec.days.length} on record`, set: recDaySet(rec.highs),
  });
  const w = rec.wait;
  const waitDays = new Set();
  if (w) for (let d = recEpoch(w.from) + 1; d <= recEpoch(w.to); d++) waitDays.add(d);
  rows.push(w ? {
    id: 'wait', label: 'longest wait for a new high', value: `${w.n} days`,
    when: `${recSpan(w.from, w.to)}${w.open ? ' · still waiting' : ''}`,
    note: w.open ? 'measured to the latest close' : 'high to next high', set: waitDays,
  } : recEmpty('wait', 'longest wait for a new high', 'never below a high'));
  return rows;
}

function recSpxRows(x) {
  if (!x) return null;
  const rows = [];
  const dayRel = (id, label, d) => rows.push(d ? {
    id, label, value: recPts(d.rel), tone: recTone(d.rel), when: recDayWhen(d),
    note: `book ${recPct(d.r)} · s&p ${recPct(d.rs)}`, set: new Set([d.day]),
  } : recEmpty(id, label));
  const monthRel = (id, label, m) => rows.push(m ? {
    id, label, value: recPts(m.rel), tone: recTone(m.rel), when: recMonthName(m.key),
    note: `book ${recPct(m.r)} · s&p ${recPct(m.rs)}`, set: recDaySet(m.days),
  } : recEmpty(id, label));
  const runRow = (id, label, r) => rows.push(r ? {
    id, label, value: recWeeks(r.n),
    when: `${recSpan(r.from, r.to)}${r.open ? ' · running' : ''}`,
    note: `book ${recPct(r.r)} · s&p ${recPct(r.rs)}`, set: recDaySet(r.days),
  } : recEmpty(id, label));
  const tape = (id, label, d) => rows.push(d ? {
    id, label, value: recPct(d.r), tone: recTone(d.r), when: recDayWhen(d),
    note: `s&p ${recPct(d.rs)}`, set: new Set([d.day]),
  } : recEmpty(id, label));
  dayRel('spx-best-day', 'best day vs the s&p', x.bestDay);
  dayRel('spx-worst-day', 'worst day vs the s&p', x.worstDay);
  monthRel('spx-best-month', 'best month vs the s&p', x.bestMonth);
  monthRel('spx-worst-month', 'worst month vs the s&p', x.worstMonth);
  runRow('spx-beat', 'longest run of weeks ahead', x.beatRun);
  runRow('spx-trail', 'longest run of weeks behind', x.trailRun);
  tape('spx-red', 'best day while the s&p fell', x.redTape);
  tape('spx-green', 'worst day while the s&p rose', x.greenTape);
  return rows;
}

function recBookRows(b) {
  const rows = [];
  const leg = (id, label, d, key, usdKey) => rows.push(d ? {
    id, label, value: recPct(d[key]), tone: recTone(d[key]), when: recDayWhen(d),
    note: recUSD(d[usdKey]), set: new Set([d.day]),
  } : recEmpty(id, label));
  leg('ib-best', 'ibkr · best day', b.ibBest, 'ib', 'ibkr');
  leg('ib-worst', 'ibkr · worst day', b.ibWorst, 'ib', 'ibkr');
  leg('pm-best', 'polymarket · best day', b.pmBest, 'pmc', 'pm');
  leg('pm-worst', 'polymarket · worst day', b.pmWorst, 'pmc', 'pm');
  const share = b.both.length ? Math.round((100 * b.offset.length) / b.both.length) : null;
  rows.push({
    id: 'offset', label: 'days the books offset', value: `${b.offset.length} days`,
    when: `of ${b.both.length} days both moved 0.05%+`,
    note: share != null ? `${share}%` : null, set: recDaySet(b.offset),
  });
  const c = b.cushion;
  rows.push(c ? {
    id: 'cushion', label: 'biggest cushion', value: `$${Math.round(c.absorbed).toLocaleString('en-US')}`,
    when: recDayWhen(c), note: `ibkr ${recUSD(c.ibkr)} · poly ${recUSD(c.pm)}`, set: new Set([c.day]),
  } : recEmpty('cushion', 'biggest cushion'));
  return rows;
}

function recBetRows(bets, rec) {
  if (!bets) return null;
  // A bet that closed before the calendar opens has no cell to light.
  const daySet = (iso) => {
    const d = recEpoch(iso);
    return d >= rec.firstDay && d <= rec.lastDay ? new Set([d]) : new Set();
  };
  // A decimal near either end, where rounding would print a 99.77¢ entry as a
  // 100¢ one — a price no bet can have lost at.
  const cents = (p) => `${(p >= 0.99 || p <= 0.01) ? (p * 100).toFixed(1) : Math.round(p * 100)}¢`;
  const rows = [];
  // An event row names its one bet when it holds one, and counts its markets
  // when it holds several — a side ("bet No") means nothing across ten strikes.
  const bet = (id, label, e) => rows.push(e ? {
    id, label, value: recUSD(e.pnl), tone: recTone(e.pnl),
    when: `${e.event} · ${recDate(e.d)}`,
    note: e.bets.length === 1 ? `bet ${e.bets[0].outcome}` : `${e.bets.length} markets`,
    set: daySet(e.d),
  } : recEmpty(id, label));
  const odds = (id, label, x) => rows.push(x ? {
    id, label, value: recUSD(x.pnl), tone: recTone(x.pnl),
    when: `${x.market} · ${recDate(x.d)}`, note: `bet ${x.outcome} at ${cents(x.entry)}`, set: daySet(x.d),
  } : recEmpty(id, label));
  bet('bet-best', 'best bet', bets.best);
  bet('bet-worst', 'worst bet', bets.worst);
  odds('bet-underdog', 'biggest underdog win', bets.underdog);
  odds('bet-favorite', 'biggest favorite loss', bets.favorite);
  return rows;
}

// One column per ladder, one row per rung reached.
function recMilestoneColumns(ladders) {
  return ladders.map(l => ({
    key: l.key, label: l.label,
    rows: l.hit.map(h => ({
      id: `ms-${l.key}-${h.t}`, label: l.label, value: l.fmt(h.t),
      when: recDate(h.x.d), note: `day ${h.n}`, set: new Set([h.x.day]),
    })),
  }));
}

function recOddsRows(o, rec) {
  const rows = [];
  const m = o.mostHighs;
  rows.push(m ? {
    id: 'odds-highs', label: 'most new highs in a month', value: `${m.xs.length} days`,
    when: recMonthName(m.ym), note: `of ${rec.days.filter(x => x.d.slice(0, 7) === m.ym).length}`,
    set: recDaySet(m.xs),
  } : recEmpty('odds-highs', 'most new highs in a month'));
  const dry = rec.months.filter(mo => !mo.days.some(x => x.high));
  rows.push({
    id: 'odds-dry', label: 'months without a new high', value: `${dry.length}`,
    when: dry.length ? `latest ${recMonthName(dry[dry.length - 1].key)}` : 'every month set one',
    note: `of ${rec.months.length} complete`, set: recDaySet(dry.flatMap(mo => mo.days)),
  });
  const wd = (id, label, x) => rows.push({
    id, label, value: recPct(x.mean), tone: recTone(x.mean),
    when: `${REC_DOW_FULL[x.k]}days · ${x.xs.length} sessions`,
    note: `${x.up} up`, set: recDaySet(x.xs),
  });
  wd('odds-wd-best', 'best weekday, on average', o.best);
  wd('odds-wd-worst', 'worst weekday, on average', o.worst);
  return rows;
}

const REC_DOW_FULL = ['sun', 'mon', 'tues', 'wednes', 'thurs', 'fri', 'satur'];

function RecPanel({ title, meta, children }) {
  return (
    <div className="pf-panel">
      <div className="pf-panel-head">
        <span className="pf-panel-title">{title}</span>
        {meta && <span className="pf-panel-meta">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function Records() {
  const [book, setBook] = React.useState(null);
  const [cal, setCal] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [hoverRec, setHoverRec] = React.useState(null);
  const [pinned, setPinned] = React.useState(null);
  const [hoverDay, setHoverDay] = React.useState(null);
  const [span, setSpan] = React.useState('recent');   // 'recent' or a year
  const calRef = React.useRef(null);

  React.useEffect(() => {
    let canceled = false;
    window.szBook.load()
      .then(d => { if (!canceled) setBook(d); })
      .catch(e => { if (!canceled) setErr(String(e.message || e)); });
    // Best-effort: without it the bets panel just doesn't draw.
    window.szJson('data/polymarket-calibration.json')
      .then(d => { if (!canceled) setCal(d); })
      .catch(() => {});
    return () => { canceled = true; };
  }, []);

  const rec = React.useMemo(() => (book ? recBuild(book) : null), [book]);
  const groups = React.useMemo(() => {
    if (!rec) return null;
    const bets = recBets(cal);
    return {
      records: recRecordRows(rec),
      spx: recSpxRows(rec.spx),
      books: recBookRows(rec.books),
      bets: recBetRows(bets, rec),
      betCount: bets ? bets.n : 0,
      milestones: recMilestoneColumns(rec.milestones),
      odds: recOddsRows(rec.odds, rec),
    };
  }, [rec, cal]);

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

  const allRows = [
    ...groups.records, ...(groups.spx || []), ...groups.books, ...(groups.bets || []),
    ...groups.milestones.flatMap(c => c.rows), ...groups.odds,
  ];
  const activeId = hoverRec || pinned;
  const active = activeId ? allRows.find(x => x.id === activeId) : null;
  const recYear = (day) => +recIso(day).slice(0, 4);
  const years = [];
  for (let y = recYear(rec.lastDay); y >= recYear(rec.firstDay); y--) years.push(y);
  // The past 365 days by default, so the calendar is never a near-empty
  // january; each year's own block is a click away.
  const spanOf = (k) => k === 'recent'
    ? { from: rec.lastDay - 364, to: rec.lastDay }
    : { from: recEpoch(`${k}-01-01`), to: recEpoch(`${k}-12-31`) };
  const shown = spanOf(span);
  const spanDays = rec.days.filter(x => x.day >= shown.from && x.day <= shown.to);
  const shownDay = hoverDay != null
    ? rec.days.find(x => x.day === hoverDay)
    : spanDays[spanDays.length - 1];
  const first = rec.days[0].d, last = rec.days[rec.days.length - 1].d;
  // Most of the rows sit well below the calendar, where a hover lights cells
  // nobody can see. A tap pins the record and brings the calendar back into
  // view if it has scrolled away.
  const togglePin = (id) => {
    const pinning = pinned !== id;
    setPinned(pinning ? id : null);
    // A record wholly outside the span on screen turns the calendar to the
    // latest year it touches.
    const hit = pinning ? allRows.find(x => x.id === id) : null;
    if (hit && hit.set.size && ![...hit.set].some(d => d >= shown.from && d <= shown.to)) {
      setSpan(Math.max(...[...hit.set].map(recYear)));
    }
    const el = calRef.current;
    if (pinning && el) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 80 || r.top > window.innerHeight - 80) {
        const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      }
    }
  };
  const rowProps = (x) => ({
    ...x, active: activeId === x.id, pinned: pinned === x.id,
    onActive: setHoverRec, onPin: togglePin,
  });
  const grid = (rows) => (
    <div className="rec-grid">
      {rows.map(x => <RecRow key={x.id} {...rowProps(x)}/>)}
    </div>
  );

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
            the whole book, {recSpan(first, last)} · daily twr
          </div>
        </div>
      </div>

      <div className="pf-panel" ref={calRef}>
        <div className="pf-panel-head">
          <span className="pf-panel-title">every day</span>
          <div className="pf-panel-head-right">
            <span className="pf-panel-meta">weeks run monday to sunday · weekends are polymarket alone</span>
            {years.length > 1 && (
              <div className="pf-range" role="group" aria-label="calendar span">
                <SzToggle options={[['recent', 'past 365 days'], ...years.map(y => [y, String(y)])]}
                  value={span} onChange={(k) => { setSpan(k); setHoverDay(null); }}/>
              </div>
            )}
          </div>
        </div>
        <RecCalendar rec={rec} span={shown} active={active} hover={hoverDay} onHover={setHoverDay}/>
        <RecReadout x={shownDay}/>
        <RecLegend/>
      </div>

      <RecPanel title="records" meta="complete weeks and months only">
        {grid(groups.records)}
      </RecPanel>

      {groups.spx && (
        <RecPanel title="against the s&p 500" meta="differences in percentage points · the index counts 0 on days it was shut">
          {grid(groups.spx)}
        </RecPanel>
      )}

      <RecPanel title="the two books" meta="each book's share of the day's return, on the whole book's capital">
        {grid(groups.books)}
      </RecPanel>

      {groups.bets && (
        <RecPanel title="polymarket bets" meta={`${groups.betCount} closed bets · realized, sold or settled · underdog means entered under 50¢`}>
          {grid(groups.bets)}
        </RecPanel>
      )}

      <RecPanel title="milestones" meta="first close past each mark · net liquidity includes deposits">
        <div className="rec-ladders">
          {groups.milestones.map(c => (
            <div key={c.key} className="rec-ladder">
              {c.rows.map(x => <RecRow key={x.id} {...rowProps(x)}/>)}
            </div>
          ))}
        </div>
      </RecPanel>

      <RecPanel title="odds and ends" meta="weekday averages are a small sample, mostly noise">
        {grid(groups.odds)}
      </RecPanel>
    </section>
  );
}

window.Records = Records;
