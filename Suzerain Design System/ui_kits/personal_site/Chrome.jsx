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
