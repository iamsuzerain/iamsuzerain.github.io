// About.jsx
function About() {
  return (
    <section className="sz-prose">
      <div className="sz-kicker">◆ about</div>
      <h2 className="sz-h2">the morning will come when the world is mine</h2>
      <p>i work alone<br/>no god, no country, no king</p>
      <p>may fortune favor me</p>
      <h3 className="sz-h3">elsewhere</h3>
      <ul className="sz-links">
        <li><a href="#">↗ mastodon — @suzerain@tilde.zone</a></li>
        <li><a href="#">↗ github — github.com/suzerain</a></li>
        <li><a href="#">↗ rss — /feed.xml</a></li>
        <li><a href="#">↗ email — hello@suzerain.dev</a></li>
      </ul>
      <h3 className="sz-h3">colophon</h3>
      <p>
        typeset in <code>JetBrains Mono</code> and <code>Inter Tight</code>.
        built with <code>ginkgo</code>, my own static site generator. hosted
        on a small vm in frankfurt. the palette is violet by temperament,
        not by trend.
      </p>
      <p className="sz-meta">§ last updated 2026-04-23 · no analytics · no cookies</p>
    </section>
  );
}
window.About = About;
