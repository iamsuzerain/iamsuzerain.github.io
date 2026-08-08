// Politics.jsx — world + US maps of who i'd back, as a sentiment log
// Globals: React, Cursor
//
// Geometry is pre-projected into flat SVG paths by scripts/geo/build-geo.py, so
// there's no map library at runtime and hover/click are ordinary SVG events.
// World is Robinson; US is an Albers composite with AK/HI as insets.
//
// Logged places carry one ordered reading — how warm the endorsement is,
// enthusiastic through tactical. It's an ordinal ramp, so the steps run
// light→dark as well as magenta→violet; lightness is what keeps them apart for
// a colourblind reader, and the label is always printed beside the colour.

const { useState: usePolState, useEffect: usePolEffect, useMemo: usePolMemo } = React;

const POL_SCOPES = [
  { id: 'world', label: 'world', file: 'data/geo-world.json' },
  { id: 'us',    label: 'united states', file: 'data/geo-us.json' },
];

// How warm the endorsement is — an ordered ramp, warmest first. The colours
// live in index.html; the order here is what the legend and the map read from.
// Every place that paints a step also prints its label: the two cool steps sit
// ~13 ΔE apart under protanopia, which is fine as a secondary cue and useless
// as the only one.
const POL_LEVELS = [
  { id: 'enthusiastic', label: 'enthusiastic' },
  { id: 'qualified',    label: 'qualified' },
  { id: 'tactical',     label: 'tactical' },
];
const POL_LEVEL_IDS = POL_LEVELS.map(l => l.id);

// Unknown or missing values land mid-ramp rather than vanishing off the scale.
function polLevel(entry) {
  const v = entry && entry.enthusiasm;
  return POL_LEVEL_IDS.indexOf(v) >= 0 ? v : 'qualified';
}

// Rank only settles ties. What is coming *sooner* leads — a house race this
// year speaks for a place more than a presidential race two years out.
// Within a date: head of government, then legislature, then governors of
// non-sovereign polities. Matched on the office text so the data stays
// readable; `tier` overrides it for anything the keywords don't catch.
const POL_TIERS = [
  { id: 'executive',   label: 'executive',   test: /president|prime minister|\bpm\b|chancellor|taoiseach|head of government/i },
  { id: 'legislature', label: 'legislature', test: /senate|house|commons|bundestag|sejm|lok sabha|rajya|parliament|congress|assembly|diet|knesset|chamber|duma|cortes/i },
  { id: 'governor',    label: 'governor',    test: /governor|mayor|premier/i },
];
const POL_TIER_IDS = POL_TIERS.map(t => t.id);
const POL_UPPER = /senate|rajya|lords/i;
const POL_LOWER = /house|commons|bundestag|sejm|lok sabha|assembly|chamber|diet|congress/i;

function polTier(race) {
  if (!race) return POL_TIERS.length;
  const declared = POL_TIER_IDS.indexOf(race.tier);
  if (declared >= 0) return declared;
  const office = String(race.office || '');
  for (let i = 0; i < POL_TIERS.length; i++) {
    if (POL_TIERS[i].test.test(office)) return i;
  }
  // Unrecognised offices sort after everything known rather than jumping the
  // queue — better to be listed last than to mis-rank a presidential race.
  return POL_TIERS.length;
}

// Which chamber leads is a property of the polity, not of the map you happen
// to be looking at — the US ranks its senate above its house whether it shows
// up as a country on the world map or as fifty states. In a parliamentary
// system the reverse holds: the lower house forms the government, so
// commons/bundestag/lok sabha outrank an upper chamber.
const POL_UPPER_FIRST = /united states|u\.?s\.?a\.?/i;

function polChamber(race, scope, place) {
  const office = String(race.office || '');
  const upper = POL_UPPER.test(office);
  const lower = POL_LOWER.test(office);
  if (!upper && !lower) return 5;
  const upperFirst = scope === 'us' || POL_UPPER_FIRST.test(String(place || ''));
  if (upperFirst) return upper ? 0 : 1;
  return lower ? 0 : 1;
}

// Single sortable rank: tier first, chamber within it. An explicit numeric
// `rank` on a race wins outright — the escape hatch for anything the office
// keywords rank wrongly.
function polRank(race, scope, place) {
  if (typeof race.rank === 'number') return race.rank;
  const tier = polTier(race);
  return tier * 10 + (tier === 1 ? polChamber(race, scope, place) : 5);
}

// Places may still be written with a single race inline; normalise either way.
function polRaces(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.races)) return entry.races;
  return entry.office || entry.next || entry.pick ? [entry] : [];
}

// An election whose day has been and gone. It stops being something upcoming
// the moment the date passes, with no edit to the data.
function polPassed(race) {
  const d = polDaysOut(race && race.next);
  return d !== null && d < 0;
}

// Three buckets, in reading order: still to come, undated, already held. Then
// date within the bucket — ascending for what is coming, most-recent-first for
// what is done — and rank last, to settle a shared ballot.
function polBucket(race) {
  if (polPassed(race)) return 2;
  return race && race.next ? 0 : 1;
}

function polCmp(scope, place) {
  return (a, b) => {
    const ba = polBucket(a), bb = polBucket(b);
    if (ba !== bb) return ba - bb;
    const da = a.next, db = b.next;
    if (da && db && da !== db) {
      return ba === 2 ? db.localeCompare(da) : da.localeCompare(db);
    }
    const r = polRank(a, scope, place) - polRank(b, scope, place);
    return r || String(a.office || '').localeCompare(String(b.office || ''));
  };
}

// History for a place: what was written by hand, plus any race whose date has
// passed. The derived rows are what makes the log self-maintaining — a held
// election lands here without anyone moving it.
//
// A hand-written entry wins a collision on the same office and date: it is the
// considered version, and may say something the standing entry did not.
function polPastRows(name, entry) {
  const rows = [];
  const seen = new Set();
  const key = (office, date) => `${String(office || '').toLowerCase()}|${date || ''}`;

  (entry.past || []).forEach(p => {
    seen.add(key(p.office, p.date));
    rows.push({ name, ...p });
  });
  polRaces(entry).forEach(race => {
    if (!polPassed(race) || seen.has(key(race.office, race.next))) return;
    rows.push({
      name,
      date: race.next,
      office: race.office,
      pick: race.pick,
      enthusiasm: race.enthusiasm,
      note: race.note,
      logged: race.logged,
    });
  });
  return rows;
}

// The race that speaks for a place: soonest, and the ranking contest among
// those sharing that date. It is what the map paints and what the overlay
// leads with.
function polPrimary(entry, scope, place) {
  const races = polRaces(entry).slice().sort(polCmp(scope, place));
  return races[0] || null;
}

// Module scope, not component state: switching scope changes the hash, and
// App keys the view on the route param, so the component remounts. A cache
// inside it would be thrown away and every toggle would refetch the geometry.
const POL_CACHE = {};

function polFmtDate(iso) {
  if (!iso) return 'unscheduled';
  const [y, m, d] = iso.split('-').map(Number);
  const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][m - 1];
  return `${mo} ${d}, ${y}`;
}

// Whole days out, floored — the log is coarse and a shifting "in N days" that
// depends on the clock time would be noise.
function polDaysOut(iso) {
  if (!iso) return null;
  const then = Date.parse(iso + 'T00:00:00Z');
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((then - today) / 86400000);
}

function polCountdown(iso) {
  const d = polDaysOut(iso);
  if (d === null) return null;
  if (d < 0) return 'passed';
  if (d === 0) return 'today';
  if (d < 90) return `${d}d out`;
  return `${Math.round(d / 30.44)}mo out`;
}

// How long a position has been standing. The age is the useful part — a read
// taken two years ago deserves more suspicion than one from last month.
function polAgo(iso) {
  const d = polDaysOut(iso);
  if (d === null) return null;
  const past = -d;
  if (past < 0) return null;
  if (past === 0) return 'today';
  if (past === 1) return 'yesterday';
  if (past < 45) return `${past}d ago`;
  if (past < 365) return `${Math.round(past / 30.44)}mo ago`;
  const years = past / 365.25;
  return years < 1.75 ? '1y ago' : `${Math.round(years)}y ago`;
}

function polLookup(idx, feature) {
  return idx.get(feature.name.toLowerCase()) || idx.get(String(feature.id).toLowerCase()) || null;
}

function PolOverlay({ name, entry, scope, onClose }) {
  // Escape closes it — the box covers a corner of the map, so there has to be
  // a way out that isn't hunting for the ×.
  usePolEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Every contest for this place, soonest first, rank settling a shared date.
  // The map can only paint one colour, so the overlay is where a full ballot
  // becomes legible.
  const races = polRaces(entry).slice().sort(polCmp(scope, name));
  // Counts the derived rows too, so the hint matches what the panel below
  // actually shows once an election has been held.
  const pastCount = entry ? polPastRows(name, entry).length : 0;
  return (
    <div className="pol-overlay" role="dialog" aria-label={name}>
      <button className="pol-overlay-close" onClick={onClose} aria-label="close">×</button>
      <div className="pol-overlay-name">{name}</div>
      {!races.length ? (
        <div className="pol-dim">not logged.</div>
      ) : (
        <React.Fragment>
          {races.map((r, i) => {
            const countdown = polCountdown(r.next);
            return (
              <div className={`pol-race ${i === 0 ? 'is-primary' : ''}`} key={`${r.office}-${r.next}-${i}`}>
                <div className="pol-race-head">
                  <span className={`pol-swatch pol-sw-${polLevel(r)}`} aria-hidden />
                  <span className="pol-race-office">{r.office || '—'}</span>
                  <span className="pol-race-level">{polLevel(r)}</span>
                </div>
                <div className="pol-race-when">
                  {polFmtDate(r.next)}
                  {countdown && <span className="pol-dim"> · {countdown}</span>}
                </div>
                <div className="pol-race-pick">{r.pick || 'tbd'}</div>
                {r.note && <p className="pol-race-note">{r.note}</p>}
                {r.logged && (
                  <div className="pol-race-logged">
                    endorsed {polFmtDate(r.logged)}
                    {polAgo(r.logged) && <span className="pol-dim"> · {polAgo(r.logged)}</span>}
                  </div>
                )}
              </div>
            );
          })}
          {pastCount > 0 && (
            <div className="pol-overlay-past">
              {pastCount} earlier read{pastCount === 1 ? '' : 's'} below
            </div>
          )}
        </React.Fragment>
      )}
    </div>
  );
}

function PolMap({ geo, index, scope, selected, hovered, onSelect, onHover }) {
  // Logged places paint last. SVG has no z-index — a 4.5px border is drawn
  // centred on the path, so half of it sits outside the shape and any
  // neighbour drawn afterwards would paint over that half. Alphabetical order
  // would clip Canada's border wherever Greenland happens to follow it.
  const ordered = usePolMemo(() => {
    const unlogged = [], logged = [];
    geo.features.forEach(f => (polLookup(index, f) ? logged : unlogged).push(f));
    return unlogged.concat(logged);
  }, [geo, index]);

  const marked = usePolMemo(() => ordered.filter(f => polLookup(index, f)), [ordered, index]);

  return (
    <div className="pol-map-shell" onMouseLeave={() => onHover(null)}>
      <svg
        className="pol-map"
        viewBox={geo.viewBox}
        role="img"
        aria-label="map — click a place to read its entry"
      >
        {/* A stroke is centred on its path, so half of every border is drawn
            outside its own country. Where two marked countries touch — the US
            and Canada — those outer halves land on top of each other and the
            one painted second wins, so the shared edge shows a single colour
            and the seam reads as lost. Clipping each shape to itself keeps the
            inner half only, so both sides of the border survive. Widths are
            doubled because half of each is now thrown away. */}
        <defs>
          {marked.map(f => (
            <clipPath key={f.id + f.name} id={`pol-clip-${f.id}`}>
              <path d={f.d} />
            </clipPath>
          ))}
        </defs>
        {ordered.map((f) => {
          const entry = polLookup(index, f);
          const isSel = selected === f.name;
          return (
            <path
              key={f.id + f.name}
              d={f.d}
              className={`pol-shape ${entry ? 'pol-lv-' + polLevel(polPrimary(entry, scope, f.name)) : 'pol-none'} ${isSel ? 'is-selected' : ''}`}
              // Per-feature weight from build-geo.py: a border heavy enough for
              // Texas turns Japan into a blob. Unlogged shapes keep the CSS
              // hairline — only the marked ones carry a sized outline, clipped
              // to themselves and doubled so the visible band still reads at
              // the intended weight.
              clipPath={entry ? `url(#pol-clip-${f.id})` : undefined}
              style={entry ? { strokeWidth: f.w * 2 } : undefined}
              // Only logged places are tab stops — 177 countries of tabbing to
              // reach the ten that say anything isn't navigation.
              tabIndex={entry ? 0 : undefined}
              role={entry ? 'button' : undefined}
              aria-label={entry ? `${f.name} — ${polLevel(polPrimary(entry, scope, f.name))}` : undefined}
              onMouseEnter={() => onHover(f.name)}
              onFocus={() => onHover(f.name)}
              onClick={() => onSelect(isSel ? null : f.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(f.name); }
              }}
            />
          );
        })}
      </svg>
      <div className="pol-caption">{hovered || ''}</div>
    </div>
  );
}

function Politics({ scope: routeScope }) {
  // A bare #/politics lands on the US map. It carries the whole 2026 senate
  // slate, so there is far more painted there than on the world map — which is
  // two countries. Revisit when the world side fills out.
  const scope = POL_SCOPES.some(s => s.id === routeScope) ? routeScope : 'us';
  const [log, setLog] = usePolState(POL_CACHE.log || null);
  const [geo, setGeo] = usePolState(POL_CACHE[scope] || null);
  const [selected, setSelected] = usePolState(null);
  const [hovered, setHovered] = usePolState(null);
  const [err, setErr] = usePolState(null);

  // The bare URL is whichever scope is the default above, so the two must move
  // together — otherwise the non-default button writes a hash that resolves
  // straight back to the default and the toggle looks broken.
  const setScope = (id) => { window.location.hash = id === 'us' ? '/politics' : `/politics/${id}`; };

  // Both fetches go out on the same tick — the log and this scope's geometry
  // are independent, and chaining them would stall the map behind the JSON.
  // Only the active scope's geometry is pulled; the other file is ~80KB that
  // most visits never open.
  usePolEffect(() => {
    const src = POL_SCOPES.find(s => s.id === scope);
    let cancelled = false;
    Promise.all([
      POL_CACHE.log
        ? Promise.resolve(POL_CACHE.log)
        : fetch('data/politics.json', { cache: 'no-store' }).then(r => r.json()),
      POL_CACHE[scope]
        ? Promise.resolve(POL_CACHE[scope])
        : fetch(src.file, { cache: 'no-store' }).then(r => r.json()),
    ])
      .then(([logData, geoData]) => {
        POL_CACHE.log = logData;
        POL_CACHE[scope] = geoData;
        if (cancelled) return;
        setLog(logData);
        setGeo(geoData);
      })
      .catch(() => { if (!cancelled) setErr('map data unavailable'); });
    return () => { cancelled = true; };
  }, [scope]);

  // Entries are keyed by whatever's readable when hand-editing the JSON — the
  // feature's name or its numeric id — so resolve loosely and canonicalise the
  // display name off the geometry where one matches.
  const records = usePolMemo(() => {
    const raw = (log && log[scope]) || {};
    const byKey = new Map();
    Object.keys(raw).forEach(k => { if (!k.startsWith('_')) byKey.set(k.toLowerCase(), raw[k]); });

    const matched = new Set();
    const out = [];
    if (geo) {
      geo.features.forEach(f => {
        const hit = byKey.get(f.name.toLowerCase()) || byKey.get(String(f.id).toLowerCase());
        if (!hit) return;
        matched.add(byKey.has(f.name.toLowerCase()) ? f.name.toLowerCase() : String(f.id).toLowerCase());
        out.push({ name: f.name, entry: hit });
      });
    }
    // Keys that match no feature would otherwise vanish silently — a typo in
    // the JSON should be visible, not just absent from the map.
    const unmatched = [...byKey.keys()].filter(k => !matched.has(k));
    return { list: out, index: byKey, unmatched };
  }, [log, geo, scope]);

  // One row per contest, not per place. Soonest first, unscheduled parked at
  // the end — and where a ballot carries several races on one date, rank
  // decides: head of government, then legislature, then governor.
  // Held elections drop out on their own. Without this they not only linger,
  // they lead — the list sorts by date ascending, so a dead race would sit
  // above everything still to come.
  const upcoming = usePolMemo(() => {
    const rows = [];
    records.list.forEach(({ name, entry }) => {
      polRaces(entry).forEach(race => {
        if (!polPassed(race)) rows.push({ name, race });
      });
    });
    return rows.sort((a, b) => {
      const da = a.race.next, db = b.race.next;
      if (!da && !db) return a.name.localeCompare(b.name);
      if (!da) return 1;
      if (!db) return -1;
      if (da !== db) return da.localeCompare(db);
      const t = polRank(a.race, scope, a.name) - polRank(b.race, scope, b.name);
      if (t) return t;
      return a.name.localeCompare(b.name);
    });
  }, [records, scope]);

  // Past reads: grouped by place, most recent first within each — the same
  // direction polBucket already gives held races on the calendar. What I
  // thought last cycle is worth more than what I thought in 2008.
  const past = usePolMemo(() => {
    const rows = [];
    records.list.forEach(({ name, entry }) => {
      polPastRows(name, entry).forEach(p => rows.push(p));
    });
    return rows.sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      const d = String(b.date).localeCompare(String(a.date));
      // Same place, same day — fall back to the same rank the calendar uses.
      return d || polRank(a, scope, a.name) - polRank(b, scope, b.name);
    });
  }, [records, scope]);

  const selEntry = selected
    ? (records.list.find(r => r.name === selected) || {}).entry || null
    : null;

  if (err) return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ politics</div>
      <h2 className="sz-h2">{err}.</h2>
    </section>
  );

  return (
    <section className="pol-view">
      <div className="sz-surface sz-surface-raised pol-head">
        <div className="sz-kicker">◆ politics</div>
        <h2 className="sz-h2">ENDORSEMENTS.</h2>
        <p className="pol-lede">{(log && log.note) || 'Sympathies, not projections.'}</p>
        <div className="pol-controls">
          <div className="pol-scopes" role="tablist" aria-label="map scope">
            {POL_SCOPES.map(s => (
              <button
                key={s.id}
                role="tab"
                aria-selected={scope === s.id}
                className={`sz-btn pol-scope ${scope === s.id ? 'is-active' : ''}`}
                onClick={() => setScope(s.id)}
              >
                {scope === s.id && <span className="sz-nav-arrow">→ </span>}{s.label}
              </button>
            ))}
          </div>
          <div className="pol-legend">
            {POL_LEVELS.map(l => (
              <span key={l.id} className="pol-legend-item">
                <span className={`pol-swatch pol-sw-${l.id}`} aria-hidden />{l.label}
              </span>
            ))}
            <span className="pol-legend-item"><span className="pol-swatch pol-sw-none" aria-hidden />not logged</span>
          </div>
        </div>
      </div>

      <div className="sz-surface pol-panel pol-map-panel">
        {!geo
          ? <div className="pol-loading sz-dim">drawing<Cursor /></div>
          : <PolMap
              geo={geo}
              index={records.index}
              scope={scope}
              selected={selected}
              hovered={hovered}
              onSelect={setSelected}
              onHover={setHovered}
            />}
        {selected && (
          <PolOverlay name={selected} entry={selEntry} scope={scope} onClose={() => setSelected(null)} />
        )}
      </div>

      {upcoming.length > 0 && (
        <div className="sz-surface pol-panel pol-list-panel">
          <div className="pol-list-head">
            <span>upcoming · {upcoming.length}</span>
            {log && log.updated && <span className="pol-dim">updated {polFmtDate(log.updated)}</span>}
          </div>
          <ul className="pol-list">
            {upcoming.map(({ name, race }, i) => (
              <li key={`${name}-${race.office}-${race.next}-${i}`}>
                <button
                  className={`pol-row ${selected === name ? 'is-selected' : ''}`}
                  onClick={() => setSelected(selected === name ? null : name)}
                  onMouseEnter={() => setHovered(name)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <span className="pol-row-name">
                    <span className={`pol-swatch pol-sw-${polLevel(race)}`} aria-hidden />
                    {name}
                  </span>
                  <span className="pol-row-level">{polLevel(race)}</span>
                  <span className="pol-row-office sz-dim">{race.office || '—'}</span>
                  <span className="pol-row-pick">{race.pick || 'tbd'}</span>
                  <span className="pol-row-when sz-dim">{polFmtDate(race.next)}</span>
                  <span className="pol-row-out">{polCountdown(race.next) || '—'}</span>
                </button>
              </li>
            ))}
          </ul>
          {records.unmatched.length > 0 && (
            <div className="pol-unmatched">
              ▸ {records.unmatched.length} entr{records.unmatched.length === 1 ? 'y' : 'ies'} match no place on this map: {records.unmatched.join(', ')}
            </div>
          )}
        </div>
      )}

      {past.length > 0 && (
        <div className="sz-surface pol-panel pol-list-panel">
          <div className="pol-list-head">
            <span>past sympathies · {past.length}</span>
            <span className="pol-dim">by place, newest first</span>
          </div>
          <p className="pol-disclaimer">What I believed at the time, which may not be my politics now.</p>
          <ul className="pol-list">
            {past.map((p, i) => (
              <li key={`${p.name}-${p.date}-${i}`}>
                <div className="pol-row pol-row-past">
                  <span className="pol-row-name">
                    <span className={`pol-swatch pol-sw-${polLevel(p)}`} aria-hidden />
                    {p.name}
                  </span>
                  <span className="pol-row-level">{polLevel(p)}</span>
                  <span className="pol-row-office sz-dim">{p.office || '—'}</span>
                  <span className="pol-row-pick">{p.pick || '—'}</span>
                  <span className="pol-row-when sz-dim">{polFmtDate(p.date)}</span>
                  <span className="pol-row-out sz-dim">{p.note || ''}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

window.Politics = Politics;
