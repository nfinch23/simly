export function App(): JSX.Element {
  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        padding: 24,
        color: '#e8e8ec',
        background: '#1c1c20',
        minHeight: '100vh',
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ marginTop: 0, fontSize: 28 }}>Simly</h1>
      <p style={{ color: '#a0a0a8' }}>
        Local-only SimulationCraft companion for World of Warcraft.
      </p>

      <h2 style={{ fontSize: 16, marginTop: 32, color: '#ffd700' }}>Status</h2>
      <p>
        Live status appears in the <strong>title bar</strong> (and your taskbar):
      </p>
      <ul style={{ color: '#c8c8d0' }}>
        <li>
          <code style={code}>Simly — Up to date (&lt;character&gt;)</code> — last
          scan complete; safe to <code style={code}>/reload</code> in WoW.
        </li>
        <li>
          <code style={code}>Simly — Scan running for &lt;character&gt;…</code> —
          desktop is simming; wait for completion before{' '}
          <code style={code}>/reload</code>.
        </li>
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 32, color: '#ffd700' }}>
        How to use
      </h2>
      <ol style={{ color: '#c8c8d0' }}>
        <li>
          In WoW, type <code style={code}>/simly</code> to open the panel.
        </li>
        <li>
          Click <strong>Update sims</strong> — WoW auto-reloads and the desktop
          starts simming.
        </li>
        <li>
          Wait for the title bar to read &quot;Up to date,&quot; then{' '}
          <code style={code}>/reload</code> in WoW. The fresh-results popup will
          fire in chat with a sound.
        </li>
      </ol>

      <p style={{ color: '#5a5a64', marginTop: 48, fontSize: 12 }}>
        Phase 5 will replace this page with a live results pane mirroring the
        in-game panel. For now use the in-game <code style={code}>/simly</code>{' '}
        panel for everything.
      </p>
    </main>
  );
}

const code: React.CSSProperties = {
  background: '#2a2a30',
  padding: '1px 6px',
  borderRadius: 3,
  fontSize: '0.9em',
  fontFamily: 'Consolas, Monaco, monospace',
  color: '#e8e8ec',
};
