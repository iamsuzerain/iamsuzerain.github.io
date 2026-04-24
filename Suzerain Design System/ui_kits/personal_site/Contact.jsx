// Contact.jsx
const { useState: useContactState } = React;

function Contact() {
  const [msg, setMsg] = useContactState('hello — i wanted to ask about ');
  const [sent, setSent] = useContactState(false);

  return (
    <section className="sz-contact">
      <div className="sz-kicker">◆ contact</div>
      <h2 className="sz-h2">ways to reach me.</h2>
      <div className="sz-contact-grid">
        <div className="sz-terminal">
          <div className="sz-term-head">
            <span className="sz-term-dot" style={{background:'#ff4fd8'}}/>
            <span className="sz-term-dot" style={{background:'#a78bfa'}}/>
            <span className="sz-term-dot" style={{background:'#7dd3a8'}}/>
            <span className="sz-term-title">suzerain ~/contact</span>
          </div>
          <div className="sz-term-body">
            <div><span className="sz-term-prompt">▸</span> cat message.txt</div>
            {!sent ? (
              <>
                <textarea
                  className="sz-term-input"
                  value={msg}
                  onChange={(e)=>setMsg(e.target.value)}
                  spellCheck={false}
                  rows={5}
                />
                <div><span className="sz-term-prompt">▸</span> send --to hello@suzerain.dev</div>
                <button className="sz-btn sz-btn-primary" onClick={()=>setSent(true)}>▸ transmit</button>
              </>
            ) : (
              <>
                <div className="sz-term-ok">◆ transmitted · response within 72h</div>
                <div><span className="sz-term-prompt">▸</span> <Cursor /></div>
              </>
            )}
          </div>
        </div>
        <div className="sz-contact-links">
          <h3 className="sz-h3">or elsewhere</h3>
          <ul className="sz-links">
            <li><a href="#">↗ email · hello@suzerain.dev</a></li>
            <li><a href="#">↗ mastodon · @suzerain@tilde.zone</a></li>
            <li><a href="#">↗ github · github.com/suzerain</a></li>
            <li><a href="#">↗ signal · on request</a></li>
          </ul>
          <h3 className="sz-h3">office hours</h3>
          <p className="sz-dim">
            i answer on tuesdays and thursdays. anything urgent — signal. anything interesting — email. anything else — it can wait.
          </p>
          <p className="sz-meta">§ pgp fingerprint available on request</p>
        </div>
      </div>
    </section>
  );
}
window.Contact = Contact;
