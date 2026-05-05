import React from 'react';
import { useQueueState } from '../useQueueState';

function formatTs(unix: number | null): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString();
}

function elapsed(startUnix: number | null): string {
  if (!startUnix) return '';
  const secs = Math.floor(Date.now() / 1000) - startUnix;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function Status(): JSX.Element {
  const state = useQueueState();
  const [, tick] = React.useReducer((n: number) => n + 1, 0);

  // Re-render every second while running so the elapsed timer ticks
  React.useEffect(() => {
    if (!state.isRunning) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state.isRunning]);

  return (
    <div>
      <h2 style={heading}>Queue status</h2>

      <div style={card}>
        <Row label="State">
          {state.isRunning ? (
            <span style={{ color: '#ffb347' }}>● Running</span>
          ) : (
            <span style={{ color: '#4caf50' }}>● Idle</span>
          )}
        </Row>
        {state.characterKey && (
          <Row label="Character">{state.characterKey}</Row>
        )}
        {state.scenario && (
          <Row label="Scenario">{SCENARIO_LABELS[state.scenario] ?? state.scenario}</Row>
        )}
        {state.isRunning && state.runStartedAt && (
          <Row label="Running for">{elapsed(state.runStartedAt)}</Row>
        )}
        <Row label="Last completed">{formatTs(state.lastCompletedAt)}</Row>
      </div>

      {state.results && (
        <>
          <h2 style={heading}>Last results</h2>
          <div style={card}>
            <Row label="Character">{state.results.character_key}</Row>
            <Row label="Generated">{formatTs(state.results.generated_at)}</Row>
            <Row label="SimC version">{state.results.simc_version}</Row>
            <Row label="Scenario">
              {SCENARIO_LABELS[state.results.active_scenario] ?? state.results.active_scenario}
            </Row>
            <Row label="Scans">
              {Object.entries(state.results.scans)
                .map(([id, rec]) => `${id}: ${rec?.status ?? '?'}`)
                .join(' · ')}
            </Row>
          </div>
        </>
      )}

      {!state.results && !state.isRunning && (
        <p style={{ color: '#a0a0a8', marginTop: 24 }}>
          No results yet. In WoW, type <code style={code}>/simly</code> and click{' '}
          <strong>Update sims</strong>, then <code style={code}>/reload</code>.
        </p>
      )}
    </div>
  );
}

const SCENARIO_LABELS: Record<string, string> = {
  single_target_patchwerk: 'Single-target (Patchwerk)',
  m_plus: 'Mythic+ (DungeonSlice)',
  aoe_cleave: 'AoE cleave (3-target)',
  aoe_funnel: 'AoE funnel (5-target)',
};

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0', borderBottom: '1px solid #2e2e36' }}>
      <span style={{ color: '#a0a0a8', minWidth: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#e8e8ec' }}>{children}</span>
    </div>
  );
}

const heading: React.CSSProperties = {
  fontSize: 16,
  color: '#ffd700',
  marginTop: 24,
  marginBottom: 8,
};

const card: React.CSSProperties = {
  background: '#2a2a30',
  borderRadius: 6,
  padding: '8px 16px',
};

const code: React.CSSProperties = {
  background: '#2a2a30',
  padding: '1px 6px',
  borderRadius: 3,
  fontSize: '0.9em',
  fontFamily: 'Consolas, Monaco, monospace',
};
