// About.jsx
function About() {
  const c = window.CONTENT.about;
  return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ about</div>
      <h2 className="sz-h2">{c.headline}</h2>
      <p>{c.bio}</p>
      <h3 className="sz-h3">elsewhere</h3>
      <ul className="sz-links">
        {c.links.map((l, i) =>
          l.href
            ? <li key={i}><a href={l.href}>↗ {l.label}</a></li>
            : <li key={i}><span>↗ {l.label}</span></li>
        )}
      </ul>
    </section>
  );
}
window.About = About;
