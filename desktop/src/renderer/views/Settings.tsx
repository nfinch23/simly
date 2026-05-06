import React, { useEffect, useState } from 'react';
import type { SimlySettings } from '../../main/settings';
import type { IgnoreEntry } from '../../main/ignore-list';
import { useQueueState } from '../useQueueState';

// ---------------------------------------------------------------------------
// Number field
// ---------------------------------------------------------------------------

function NumberField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  description?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const [raw, setRaw] = useState(String(value));
  useEffect(() => setRaw(String(value)), [value]);

  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid #2e2e36' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ color: '#a0a0a8', minWidth: 240, flexShrink: 0 }}>{label}</span>
        <input
          type="number"
          value={raw}
          min={min}
          max={max}
          step={step ?? 'any'}
          style={inputStyle}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => {
            const n = parseFloat(raw);
            if (!isNaN(n)) {
              onChange(n);
            } else {
              setRaw(String(value));
            }
          }}
        />
      </div>
      {description && (
        <p style={{ color: '#5a5a64', fontSize: 11, margin: '2px 0 0 252px' }}>{description}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ignore list table
// ---------------------------------------------------------------------------

function IgnoreListPanel({ characterKey }: { characterKey: string | null }): JSX.Element {
  const [entries, setEntries] = useState<IgnoreEntry[]>([]);
  const [loading, setLoading] = useState(true);

  function load(): void {
    setLoading(true);
    void window.simly
      .listIgnoreEntries(characterKey ? { characterKey } : undefined)
      .then((e) => {
        setEntries(e);
        setLoading(false);
      });
  }

  useEffect(load, [characterKey]);

  async function remove(entry: IgnoreEntry): Promise<void> {
    await window.simly.removeIgnoreEntry({
      characterKey: entry.character_key,
      scenario: entry.scenario,
      itemIdentity: entry.item_identity,
    });
    load();
  }

  async function clearAll(): Promise<void> {
    if (!confirm('Clear all ignore-list entries? They will be re-evaluated on the next sim.')) return;
    await window.simly.clearIgnoreList();
    load();
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={subheading}>Ignore list ({entries.length})</h3>
        {entries.length > 0 && (
          <button style={dangerBtn} onClick={() => void clearAll()}>
            Clear all
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ color: '#a0a0a8' }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: '#5a5a64', fontSize: 13 }}>
          No ignored items yet. Items that consistently lose by more than the trash threshold
          are added automatically after each scan.
        </p>
      ) : (
        <div style={{ ...card, padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#a0a0a8', borderBottom: '1px solid #3a3a42' }}>
                <th style={th}>Item</th>
                <th style={th}>Slot</th>
                <th style={th}>Scenario</th>
                <th style={th}>Best Δ%</th>
                <th style={th}>Simmed</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.item_identity}
                  style={{ borderBottom: '1px solid #2e2e36', opacity: e.manually_removed ? 0.5 : 1 }}
                >
                  <td style={td}>{e.name}</td>
                  <td style={td}>{e.slot}</td>
                  <td style={td}>{e.scenario}</td>
                  <td style={{ ...td, color: '#ef5350' }}>{e.best_delta_pct.toFixed(2)}%</td>
                  <td style={td}>{e.times_simmed}×</td>
                  <td style={td}>
                    {!e.manually_removed && (
                      <button style={smallBtn} onClick={() => void remove(e)}>
                        Re-include
                      </button>
                    )}
                    {e.manually_removed && (
                      <span style={{ color: '#5a5a64' }}>re-included</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Settings view
// ---------------------------------------------------------------------------

export function Settings(): JSX.Element {
  const state = useQueueState();
  const [settings, setLocalSettings] = useState<SimlySettings | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    void window.simly.getSettings().then(setLocalSettings);
  }, []);

  async function update(key: keyof SimlySettings, value: number | string | undefined): Promise<void> {
    if (!settings) return;
    try {
      const updated = await window.simly.setSettings({ [key]: value });
      setLocalSettings(updated);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    } catch {
      setSaveStatus('error');
    }
  }

  if (!settings) return <p style={{ color: '#a0a0a8' }}>Loading settings…</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={heading}>Settings</h2>
        {saveStatus === 'saved' && <span style={{ color: '#4caf50', fontSize: 13 }}>✓ Saved</span>}
        {saveStatus === 'error' && <span style={{ color: '#ef5350', fontSize: 13 }}>Save failed</span>}
      </div>

      <p style={{ color: '#a0a0a8', fontSize: 13, marginBottom: 16 }}>
        Changes apply on the next <strong>Update sims</strong> click.
      </p>

      <h3 style={subheading}>Gear pruner</h3>
      <div style={card}>
        <NumberField
          label="Pruner multiplier"
          description="Items survive coarse stage when score × multiplier ≥ slot max. Lower = fewer combos = faster."
          value={settings.prunerMultiplier}
          onChange={(v) => void update('prunerMultiplier', v)}
          min={1.0}
          max={2.0}
          step={0.05}
        />
        <NumberField
          label="Max combos"
          description="Hard cap on gear cartesian. Runs over this limit throw."
          value={settings.maxCombos}
          onChange={(v) => void update('maxCombos', v)}
          min={100}
          max={50000}
          step={500}
        />
      </div>

      <h3 style={subheading}>Catalog classification</h3>
      <div style={card}>
        <NumberField
          label="Tie window (%)"
          description="Items within ± this % of winner are 'sidegrade'."
          value={settings.tieWindowPct}
          onChange={(v) => void update('tieWindowPct', v)}
          min={0}
          max={5}
          step={0.1}
        />
        <NumberField
          label="Good threshold (%)"
          description="Items within this % of winner are 'good' — re-eligible next run."
          value={settings.goodThresholdPct}
          onChange={(v) => void update('goodThresholdPct', v)}
          min={0}
          max={10}
          step={0.5}
        />
        <NumberField
          label="Trash threshold (%)"
          description="Items losing by more than this are 'trash' — excluded from future cartesians."
          value={settings.trashThresholdPct}
          onChange={(v) => void update('trashThresholdPct', v)}
          min={1}
          max={20}
          step={0.5}
        />
      </div>

      <h3 style={subheading}>Gear ladder keep thresholds</h3>
      <div style={card}>
        <NumberField
          label="Coarse → refined keep (%)"
          description="Combos within this % of the coarse winner are re-simmed at refined."
          value={settings.coarseKeepThresholdPct}
          onChange={(v) => void update('coarseKeepThresholdPct', v)}
          min={0.1}
          max={5}
          step={0.1}
        />
        <NumberField
          label="Refined → final keep (%)"
          description="Combos within this % of the refined winner are re-simmed at final."
          value={settings.refinedKeepThresholdPct}
          onChange={(v) => void update('refinedKeepThresholdPct', v)}
          min={0.1}
          max={5}
          step={0.1}
        />
      </div>

      <h3 style={subheading}>Iteration counts</h3>
      <div style={card}>
        <NumberField
          label="Coarse iterations"
          value={settings.coarseIterations}
          onChange={(v) => void update('coarseIterations', v)}
          min={100}
          max={10000}
          step={100}
        />
        <NumberField
          label="Refined iterations"
          value={settings.refinedIterations}
          onChange={(v) => void update('refinedIterations', v)}
          min={100}
          max={10000}
          step={100}
        />
        <NumberField
          label="Final iterations"
          value={settings.finalIterations}
          onChange={(v) => void update('finalIterations', v)}
          min={100}
          max={20000}
          step={500}
        />
        <NumberField
          label="Trinket iterations"
          value={settings.trinketIterations}
          onChange={(v) => void update('trinketIterations', v)}
          min={100}
          max={10000}
          step={100}
        />
        <NumberField
          label="Swap-test iterations"
          value={settings.swapTestIterations}
          onChange={(v) => void update('swapTestIterations', v)}
          min={100}
          max={10000}
          step={100}
        />
        <NumberField
          label="Top trinkets to keep"
          description="Number of leading trinkets carried forward from pre-scan to gear ladder."
          value={settings.topTrinketsToKeep}
          onChange={(v) => void update('topTrinketsToKeep', Math.round(v))}
          min={1}
          max={10}
          step={1}
        />
      </div>

      <h2 style={{ ...heading, marginTop: 32 }}>Ignore list</h2>
      <IgnoreListPanel characterKey={state.characterKey} />
    </div>
  );
}

const heading: React.CSSProperties = { fontSize: 16, color: '#ffd700', marginTop: 24, marginBottom: 8 };
const subheading: React.CSSProperties = { fontSize: 14, color: '#ffd700', marginTop: 16, marginBottom: 6 };
const card: React.CSSProperties = { background: '#2a2a30', borderRadius: 6, padding: '0 16px 4px' };

const inputStyle: React.CSSProperties = {
  background: '#1c1c20',
  color: '#e8e8ec',
  border: '1px solid #3a3a42',
  borderRadius: 4,
  padding: '3px 8px',
  width: 90,
  fontSize: 13,
  fontFamily: 'Consolas, Monaco, monospace',
  outline: 'none',
};

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 12px',
  fontWeight: 500,
  fontSize: 11,
};

const td: React.CSSProperties = {
  padding: '5px 12px',
  color: '#e8e8ec',
};

const smallBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#ffd700',
  border: '1px solid #ffd700',
  borderRadius: 3,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 11,
};

const dangerBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#ef5350',
  border: '1px solid #ef5350',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 13,
};
