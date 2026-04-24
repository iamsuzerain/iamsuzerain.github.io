// Projects.jsx
const { useState: useProjState } = React;

const PROJECTS = [
  { id: 'ginkgo', name: 'ginkgo', version: 'v0.3', date: '2025-11', status: 'active',
    tags: ['rust','cli','ssg'],
    desc: "a tiny static site generator. built because hugo's mental model never stuck. v0.3 ships when it ships." },
  { id: 'lattice', name: 'lattice', version: 'v1.2', date: '2024-09', status: 'shipped',
    tags: ['typescript','editor','wasm'],
    desc: 'a visual grid editor for musical polyrhythms. used in two installations.' },
  { id: 'mora', name: 'mora', version: 'v0.1', date: '2025-06', status: 'draft',
    tags: ['c','synth','dsp'],
    desc: 'a wavetable synth in ~800 lines of c. pairs with a small osc controller.' },
  { id: 'rind', name: 'rind', version: '—', date: '2023-02', status: 'archived',
    tags: ['python','scraping'],
    desc: 'a citrus-themed rss reader. replaced by a shell alias.' },
  { id: 'atlas', name: 'atlas', version: 'v0.7', date: '2026-01', status: 'active',
    tags: ['rust','compiler','wip'],
    desc: 'the compiler that currently takes most of my evenings. not ready to talk about.' },
];
const FILTERS = ['all','rust','typescript','c','python'];

function Projects() {
  const [filter, setFilter] = useProjState('all');
  const visible = PROJECTS.filter(p => filter === 'all' || p.tags.includes(filter));

  const statusColor = {
    active: 'var(--violet-300)',
    shipped: '#7dd3a8',
    draft: 'var(--fg-3)',
    archived: 'var(--fg-4)',
  };

  return (
    <section className="sz-wide">
      <div className="sz-kicker">◆ projects / {visible.length.toString().padStart(2,'0')}</div>
      <h2 className="sz-h2">things i build.</h2>
      <div className="sz-filters">
        <span className="sz-filter-label">▸ filter</span>
        {FILTERS.map(f => (
          <button key={f} className={`sz-filter ${filter===f?'active':''}`} onClick={()=>setFilter(f)}>
            {filter===f && '◆ '}{f}
          </button>
        ))}
      </div>
      <div className="sz-proj-list">
        {visible.map(p => (
          <article key={p.id} className="sz-proj-card">
            <div className="sz-proj-head">
              <div className="sz-proj-meta">
                <span style={{color: statusColor[p.status]}}>◆ {p.status}</span>
                <span className="sz-sep">·</span>
                <span>{p.version}</span>
                <span className="sz-sep">·</span>
                <span>{p.date}</span>
              </div>
              <button className="sz-proj-open">open →</button>
            </div>
            <h3 className="sz-proj-name">{p.name}</h3>
            <p className="sz-proj-desc">{p.desc}</p>
            <div className="sz-proj-tags">
              {p.tags.map(t => <span key={t} className="sz-tag">{t}</span>)}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
window.Projects = Projects;
