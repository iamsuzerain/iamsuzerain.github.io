// Chart.jsx — shared chart primitives (geometry, hover, crosshair, gradients).
// Globals: React
//
// Every time-series panel on this site is the same machine underneath: a
// 920-wide viewBox with 8px side gutters, an index→x and value→y pair built off
// that box, a pointer handler that turns a clientX into a series index, a
// vertical crosshair, and a tooltip positioned as a percentage of the box.
// Those parts had been written out once per chart — eleven copies across three
// ~1700-line files — so a fix to the hover maths, the axis padding or the
// gradient stops was a three-file change, and in practice usually a two-file
// change that quietly left the third behind. The drift was the real cost: the
// baseline rule already reads at three different alphas depending on which file
// drew it, for no reason anyone chose.
//
// What lives here is only the machinery. Each chart keeps its own body — the
// benchmark overlays, the annotation diamonds, the peak/trough callouts, the
// warm-up rule — because those are what the charts are *for*, and folding three
// distinct panels into one component behind a dozen booleans would trade drift
// for a worse mess.
//
// Loaded after Chrome.jsx and before the view files.

// ---------- Monotone cubic spline (Fritsch-Carlson) ----------
// Monotone matters: the fitted curve never overshoots a turning point, so an
// area fill can't bulge past a peak the data never reached.
function smoothPath(xs, ys) {
  const n = xs.length;
  if (n < 2) return `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  if (n === 2) return `M${xs[0].toFixed(2)},${ys[0].toFixed(2)} L${xs[1].toFixed(2)},${ys[1].toFixed(2)}`;
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) delta[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = delta[0];
  for (let i = 1; i < n - 1; i++) m[i] = (delta[i - 1] + delta[i]) / 2;
  m[n - 1] = delta[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(delta[i]) < 1e-10) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i], b = m[i + 1] / delta[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] *= t; m[i + 1] *= t; }
  }
  let path = `M${xs[0].toFixed(2)},${ys[0].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    path += ` C${(xs[i] + dx).toFixed(2)},${(ys[i] + m[i] * dx).toFixed(2)} ${(xs[i + 1] - dx).toFixed(2)},${(ys[i + 1] - m[i + 1] * dx).toFixed(2)} ${xs[i + 1].toFixed(2)},${ys[i + 1].toFixed(2)}`;
  }
  return path;
}

// Straight-segment path, for the series that are deliberately unsplined
// (polymarket's cumulative pnl and its rewards lines, which are step-like).
function szLinePath(pts, x, y) {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
}

// ---------- geometry ----------
// One box shape for the whole site. W and the side gutters have never differed
// between charts; height and the top/bottom padding do, because a 60px strip
// carries no x-axis labels and a 240px chart does.
function szFrame(H, PAD_T, PAD_B, W = 920, PAD_L = 8, PAD_R = 8) {
  return { W, H, PAD_L, PAD_R, PAD_T, PAD_B };
}

// index → x, value → y, both clamped to the frame's inner box.
//
// Two guards the copies didn't carry uniformly: a one-point series divides by
// zero on the x scale, and a flat domain (y0 === y1) divides by zero on the y
// scale. Every caller happens to guard length >= 2 today, and every domain
// carries a floor — but that is a property of eleven call sites rather than of
// the scale, which is exactly the sort of thing that stops being true.
function szScales(f, n, y0, y1) {
  const span = (y1 - y0) || 1;
  return {
    x: (i) => f.PAD_L + (n > 1 ? i / (n - 1) : 0) * (f.W - f.PAD_L - f.PAD_R),
    y: (v) => f.PAD_T + (1 - (v - y0) / span) * (f.H - f.PAD_T - f.PAD_B),
  };
}

// Symmetric padded domain, optionally anchored so a chosen reference stays in
// frame: 0 for a P&L curve (so the zero line is always drawn), 1 for a rolling
// beta. `floor` is the span used when the data is flat, and it has to be in the
// units of the series — which is why every caller passes one. 0.002 is a fifth
// of a percentage point in ratio terms and two-tenths of a cent in dollars, so
// the wrong choice collapses a whole window onto the zero line.
function szDomain(values, { pad: padFrac = 0.08, floor = 1, min: aMin, max: aMax } = {}) {
  const lo = aMin == null ? Math.min(...values) : Math.min(aMin, ...values);
  const hi = aMax == null ? Math.max(...values) : Math.max(aMax, ...values);
  const pad = (hi - lo) * padFrac || floor;
  return { y0: lo - pad, y1: hi + pad, lo, hi };
}

// Close a line path into a filled area by running it back along a baseline.
// Takes x coordinates rather than indices because the rolling strip fills only
// the stretch where its lookback has actually filled, not the whole axis.
function szAreaPath(line, xStart, xEnd, yBase) {
  return `${line} L${xEnd.toFixed(2)},${yBase.toFixed(2)} L${xStart.toFixed(2)},${yBase.toFixed(2)} Z`;
}

// Evenly spaced date ticks, `count` of them give or take one.
function szTicks(series, count) {
  const every = Math.max(1, Math.floor(series.length / count));
  return series.map((p, i) => ({ i, d: p.d })).filter((_, i) => i % every === 0);
}

// ---------- hover ----------
// Turns a pointer position into a series index. `bind(n)` is called at render
// rather than the length being passed to the hook, because several charts only
// know their point count after an early return that has to sit *below* the
// hooks — so the hook cannot depend on it.
function useChartHover(f) {
  const ref = React.useRef(null);
  const [hover, setHover] = React.useState(null);
  const clear = () => setHover(null);
  const move = (n) => (e) => {
    const svg = ref.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
    const px = ((clientX - rect.left) / rect.width) * f.W;
    const t = (px - f.PAD_L) / (f.W - f.PAD_L - f.PAD_R);
    setHover(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
  };
  return {
    i: hover,
    set: setHover,
    clear,
    bind: (n) => {
      const onMove = move(n);
      return {
        ref,
        onMouseMove: onMove, onMouseLeave: clear,
        onTouchStart: onMove, onTouchMove: onMove, onTouchEnd: clear,
      };
    },
  };
}

// ---------- svg frame ----------
// preserveAspectRatio="none" is load-bearing: the viewBox is a fixed 920 wide
// and the element is fluid, so the chart stretches to its column rather than
// letterboxing. Every x/y coordinate below is in viewBox units as a result, and
// every HTML overlay converts back with (coord / W) * 100%.
function SzChartSvg({ frame, hover, n, className = 'pf-navchart', children }) {
  return (
    <svg
      {...hover.bind(n)}
      viewBox={`0 0 ${frame.W} ${frame.H}`}
      className={className}
      preserveAspectRatio="none"
    >
      {children}
    </svg>
  );
}

// ---------- gradients ----------
// The five ramps the site draws with, in one place because four of them existed
// as byte-identical pairs in two files apiece.
//
// Vertical ramps are value-keyed — pink where the line runs high, violet where
// it runs low — and are robust to a choppy or declining line in a way a
// left→right ramp is not. Horizontal ramps are used where that argument breaks
// down: a series pinned near its reference (rolling beta anchored at 1, cross-
// book correlation inside a ±0.5 band) gets so little vertical travel that a
// value-keyed ramp compresses to one flat tone. Keying those to time instead
// makes no claim about the values at all, which is the honest option — a
// vertical ramp on the correlation strip painted *higher* correlation pink, the
// worse outcome, inverting what pink means everywhere else on the site.
const SZ_GRADIENTS = {
  nav:     { dir: 'v', stroke: ['#ff4fd8', '#a78bfa'], fill: [['#a78bfa', 0.32], ['#a78bfa', 0]] },
  dd:      { dir: 'v', stroke: ['#ff8ad4', '#ff4fd8'], fill: [['#ff4fd8', 0.02], ['#ff4fd8', 0.22]] },
  alpha:   { dir: 'v', stroke: ['#93c5fd', '#3b82f6'], fill: [['#60a5fa', 0.22], ['#60a5fa', 0.02]] },
  rewards: { dir: 'v', stroke: ['#ff4fd8', '#a78bfa'], fill: [['#ff4fd8', 0.22], ['#a78bfa', 0]] },
  roll:    { dir: 'h', stroke: ['#c4b5fd', '#8b5cf6'], fill: [['#c4b5fd', 0.16], ['#8b5cf6', 0.16]] },
  corr:    { dir: 'h', stroke: ['#a78bfa', '#ff4fd8'], fill: [['#a78bfa', 0.18], ['#ff4fd8', 0.18]] },
};

// Emits `${id}-stroke` and `${id}-fill`. The id stays a prop rather than being
// derived from the ramp name: ids are document-global, and while only one view
// mounts at a time today, a shared id would make that routing detail load-
// bearing for the rendering.
function SzChartDefs({ ramp, id }) {
  const g = SZ_GRADIENTS[ramp];
  if (!g) return null;
  const axis = g.dir === 'h'
    ? { x1: '0', y1: '0', x2: '1', y2: '0' }
    : { x1: '0', y1: '0', x2: '0', y2: '1' };
  return (
    <defs>
      <linearGradient id={`${id}-stroke`} {...axis}>
        <stop offset="0%" stopColor={g.stroke[0]}/>
        <stop offset="100%" stopColor={g.stroke[1]}/>
      </linearGradient>
      <linearGradient id={`${id}-fill`} {...axis}>
        <stop offset="0%" stopColor={g.fill[0][0]} stopOpacity={g.fill[0][1]}/>
        <stop offset="100%" stopColor={g.fill[1][0]} stopOpacity={g.fill[1][1]}/>
      </linearGradient>
    </defs>
  );
}

// ---------- marks ----------
// The reference rule a series is read against: zero on a P&L curve, the running
// peak on an underwater strip, 1 on a rolling beta. Pass dash={null} for a solid
// rule — the default only fills in for `undefined`, so null draws unbroken.
function SzRule({ frame, y, stroke = 'rgba(229,225,241,0.18)', dash = '3 5' }) {
  return (
    <line x1={frame.PAD_L} x2={frame.W - frame.PAD_R} y1={y} y2={y}
      stroke={stroke} strokeDasharray={dash}/>
  );
}

// Vertical hairline at the hovered column, alone. Separate from SzCrosshair
// because the rewards chart draws it *under* its curves and its dots over them.
function SzCrosshairLine({ frame, x }) {
  return (
    <line x1={x} x2={x} y1={frame.PAD_T} y2={frame.H - frame.PAD_B}
      stroke="rgba(229,225,241,0.25)" strokeDasharray="2 3"/>
  );
}

// Hairline plus the dot on the series. `cy == null` draws the line only, which
// is what the rolling strip wants over its warm-up stretch: the crosshair still
// tracks the charts above it, but there is no value there to mark.
//
// `dots` are the companion series read at the same column — the component curves
// on the combined chart, the benchmark overlays wherever they appear. Every line
// a chart draws gets marked, because a crosshair that dots some lines and not
// others reads as if the undotted ones aren't part of the reading. They sit
// under the primary dot at the recessed weight their lines carry, so the series
// the chart is *about* is still the one the eye lands on. Each entry is
// { key, cy, fill } with optional r/opacity; a null cy skips that dot the same
// way a null primary does.
function SzCrosshair({ frame, x, cy, fill, ring = '#0a0612', r = 4, dots }) {
  return (
    <g>
      <SzCrosshairLine frame={frame} x={x}/>
      {(dots || []).map(d => d.cy != null && (
        <circle key={d.key} cx={x} cy={d.cy} r={d.r || 2.5} fill={d.fill}
          opacity={d.opacity == null ? 0.6 : d.opacity}/>
      ))}
      {cy != null && (
        <circle cx={x} cy={cy} r={r} fill={fill} stroke={ring} strokeWidth="1.5"/>
      )}
    </g>
  );
}

// ---------- html overlays ----------
// These sit in .pm-chart-wrap alongside the svg rather than inside it, so they
// get real text rendering and don't inherit preserveAspectRatio="none"'s
// horizontal stretch. Positions convert from viewBox units to percentages.
function SzTooltip({ frame, x, y, className = '', children }) {
  return (
    <div className={`pm-tooltip${className ? ' ' + className : ''}`}
      style={{ left: `${(x / frame.W) * 100}%`, top: `${(y / frame.H) * 100}%` }}>
      {children}
    </div>
  );
}

// First and last ticks carry .start/.end so the css can pull them inside the
// box instead of letting them hang off either edge.
function SzAxisX({ frame, ticks, x, label = (t) => t.d }) {
  return (
    <div className="pf-axis-x">
      {ticks.map((t, i) => (
        <span key={i}
          className={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : ''}
          style={{ left: `${(x(t.i) / frame.W) * 100}%` }}>{label(t, i)}</span>
      ))}
    </div>
  );
}

// The "$0" / "0%" marker pinned to the baseline at the left gutter.
function SzAxisZero({ frame, y, children }) {
  return (
    <div className="pf-axis-zero"
      style={{ left: `${(frame.PAD_L / frame.W) * 100}%`, top: `${(y / frame.H) * 100}%` }}>
      {children}
    </div>
  );
}

// A reading that tracks the crosshair, pinned to the left of a chart's key.
//
// This exists so a level that would otherwise want its own panel — the NAV
// behind a P&L curve — can be read off the chart that is already drawn. A
// second chart of the account level would be a redundant restatement of the
// curve above it, deposits and all; one number at the hovered column is the
// part of it you actually can't already see.
//
// Idle it shows the latest point, so the key still reads as the book's current
// level when the cursor is elsewhere. `live` (the cursor is on the chart) only
// lifts the colour: the crosshair and tooltip already say which day it is, so
// the readout doesn't repeat the date and doesn't change width as you move.
// `note` is a qualifier the value can't carry on its own — "at open" on a
// benchmark's notional, which is a level from one particular column rather than
// the one under the cursor. It stays outside the <b> so it reads at the key's
// own dim weight, and it is the difference between two dollar figures sitting
// side by side making sense and looking like a contradiction.
function SzKeyReadout({ label, value, note, live }) {
  return (
    <span className={`pf-key-readout${live ? ' live' : ''}`}>
      {label}<b className="pf-key-val">{value}</b>{note}
    </span>
  );
}

// Label on the left, current reading on the right — the header every strip
// under a main chart carries.
function SzStripHead({ label, meta, children }) {
  return (
    <div className="pf-strip-head">
      <span className="pf-strip-label">{label}</span>
      {children != null ? children : <span className="pf-strip-meta">{meta}</span>}
    </div>
  );
}

// ---------- toggles ----------
// Every segmented control on the site — timeframe, $/%, rolling metric, sort
// key — is this button with this active class. Options are either bare keys
// (labelled by `label`, lowercased by default) or [key, text] pairs.
//
// type="button" is not decoration: a bare <button> inside a form defaults to
// submit, and one of the six hand-written copies had dropped it.
function SzToggle({ options, value, onChange, label = (o) => String(o).toLowerCase() }) {
  return (
    <React.Fragment>
      {options.map(o => {
        const key = Array.isArray(o) ? o[0] : o;
        const text = Array.isArray(o) ? o[1] : label(o);
        return (
          <button key={key} type="button"
            className={`pf-range-btn${value === key ? ' active' : ''}`}
            onClick={() => onChange(key)}>{text}</button>
        );
      })}
    </React.Fragment>
  );
}

window.szSmoothPath = smoothPath;
window.szLinePath = szLinePath;
window.szFrame = szFrame;
window.szScales = szScales;
window.szDomain = szDomain;
window.szAreaPath = szAreaPath;
window.szTicks = szTicks;
window.useChartHover = useChartHover;
window.SzChartSvg = SzChartSvg;
window.SzChartDefs = SzChartDefs;
window.SZ_GRADIENTS = SZ_GRADIENTS;
window.SzRule = SzRule;
window.SzCrosshair = SzCrosshair;
window.SzCrosshairLine = SzCrosshairLine;
window.SzTooltip = SzTooltip;
window.SzAxisX = SzAxisX;
window.SzAxisZero = SzAxisZero;
window.SzKeyReadout = SzKeyReadout;
window.SzStripHead = SzStripHead;
window.SzToggle = SzToggle;
