import React, { useState } from 'react';
import { Status } from './views/Status';
import { Scans } from './views/Scans';
import { Composed } from './views/Composed';
import { PasteInput } from './views/PasteInput';
import { Settings } from './views/Settings';
import { useQueueState } from './useQueueState';

type Tab = 'status' | 'scans' | 'composed' | 'paste' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'status', label: 'Status' },
  { id: 'scans', label: 'Scans' },
  { id: 'composed', label: 'Composed' },
  { id: 'paste', label: 'Paste' },
  { id: 'settings', label: 'Settings' },
];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('status');
  const state = useQueueState();

  return (
    <div style={root}>
      {/* Tab bar */}
      <nav style={navbar}>
        <span style={logo}>Simly</span>
        <div style={tabGroup}>
          {TABS.map((t) => (
            <button
              key={t.id}
              style={tabBtn(tab === t.id)}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Running indicator */}
        {state.isRunning && (
          <span style={{ color: '#ffb347', fontSize: 13, marginLeft: 'auto' }}>
            ● Simming {state.characterKey ?? '…'}
          </span>
        )}
      </nav>

      {/* Content */}
      <main style={content}>
        {tab === 'status' && <Status />}
        {tab === 'scans' && <Scans />}
        {tab === 'composed' && <Composed />}
        {tab === 'paste' && <PasteInput />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const root: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  color: '#e8e8ec',
  background: '#1c1c20',
  minHeight: '100vh',
  lineHeight: 1.5,
  display: 'flex',
  flexDirection: 'column',
};

const navbar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: '#12121580',
  borderBottom: '1px solid #2e2e36',
  padding: '0 24px',
  height: 48,
  flexShrink: 0,
};

const logo: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 18,
  color: '#ffd700',
  marginRight: 16,
};

const tabGroup: React.CSSProperties = {
  display: 'flex',
  gap: 2,
};

function tabBtn(active: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    color: active ? '#ffd700' : '#a0a0a8',
    border: 'none',
    borderBottom: active ? '2px solid #ffd700' : '2px solid transparent',
    padding: '12px 14px',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    transition: 'color 0.1s',
  };
}

const content: React.CSSProperties = {
  flex: 1,
  padding: '0 24px 24px',
  overflowY: 'auto',
};
