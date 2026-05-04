// Projects.jsx
const { useState: useProjState } = React;

const FILTERS = ['all','rust','typescript','c','python'];

function Projects() {
  const [filter, setFilter] = useProjState('all');
  const projects = window.CONTENT.projects;
  const visible = projects.filter(p => filter === 'all' || p.tags.includes(filter));

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
