import React, { useState } from 'react';

export function PasteInput(): JSX.Element {
  const [profile, setProfile] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = profile.trim();
    if (!trimmed) return;

    setStatus('running');
    setErrorMsg('');
    try {
      await window.simly.pasteProfile({ profileScript: trimmed });
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message ?? String(err));
    }
  }

  return (
    <div>
      <h2 style={heading}>Paste SimC profile</h2>
      <p style={{ color: '#a0a0a8', fontSize: 13, marginBottom: 16 }}>
        Paste a raw SimulationCraft profile string (e.g. from the SimC addon's export) to
        trigger a sim run without going through the SavedVariables flow.
      </p>

      <form onSubmit={(e) => void handleSubmit(e)}>
        <textarea
          style={textarea}
          value={profile}
          onChange={(e) => {
            setProfile(e.target.value);
            if (status !== 'idle') setStatus('idle');
          }}
          placeholder={'warlock="Felfriend"\nlevel=80\nrace=undead\n...'}
          rows={16}
          spellCheck={false}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
          <button
            type="submit"
            disabled={status === 'running' || !profile.trim()}
            style={btn(status === 'running' || !profile.trim())}
          >
            {status === 'running' ? 'Running…' : 'Run sim'}
          </button>

          {status === 'done' && (
            <span style={{ color: '#4caf50' }}>
              ✓ Sim queued — watch the title bar for progress.
            </span>
          )}
          {status === 'error' && (
            <span style={{ color: '#ef5350' }}>{errorMsg || 'Sim failed to start.'}</span>
          )}
        </div>
      </form>
    </div>
  );
}

const heading: React.CSSProperties = { fontSize: 16, color: '#ffd700', marginTop: 24, marginBottom: 8 };

const textarea: React.CSSProperties = {
  width: '100%',
  background: '#2a2a30',
  color: '#e8e8ec',
  border: '1px solid #3a3a42',
  borderRadius: 4,
  padding: '10px 12px',
  fontFamily: 'Consolas, Monaco, monospace',
  fontSize: 12,
  resize: 'vertical',
  boxSizing: 'border-box',
  outline: 'none',
};

function btn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? '#3a3a42' : '#ffd700',
    color: disabled ? '#5a5a64' : '#1c1c20',
    border: 'none',
    borderRadius: 4,
    padding: '8px 20px',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 14,
  };
}
