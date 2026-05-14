import React, { useEffect, useState } from 'react';
import type {
  ContentPrefs,
  RaidId,
  SimlySettings,
} from '../../main/settings';

// ---------------------------------------------------------------------------
// Static catalog — Midnight (12.0) Season 1
//
// Mirrors live Blizzard structure: 3 raids × 4 difficulties, M+ keys 1..10
// (cap is user-driven per the picker spec, not the live ceiling), Delves 1..11,
// Ritual Sites 1..5. Update when a new tier ships.
// ---------------------------------------------------------------------------

const RAID_CATALOG: Array<{ id: RaidId; name: string; bosses: number }> = [
  { id: 'voidspire', name: 'The Voidspire', bosses: 6 },
  { id: 'dreamrift', name: 'The Dreamrift', bosses: 1 },
  { id: 'march_on_queldanas', name: "March on Quel'Danas", bosses: 2 },
];

const DIFFICULTIES: Array<{ key: keyof ContentPrefs['raids'][RaidId]; label: string }> = [
  { key: 'lfr', label: 'LFR' },
  { key: 'normal', label: 'Normal' },
  { key: 'heroic', label: 'Heroic' },
  { key: 'mythic', label: 'Mythic' },
];

const MPLUS_LEVELS = Array.from({ length: 10 }, (_, i) => i + 1);
const DELVE_TIERS = Array.from({ length: 11 }, (_, i) => i + 1);
const RITUAL_TIERS = Array.from({ length: 5 }, (_, i) => i + 1);

// ---------------------------------------------------------------------------

export function Content(): JSX.Element {
  const [settings, setSettings] = useState<SimlySettings | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    void window.simly.getSettings().then(setSettings);
  }, []);

  async function patch(next: ContentPrefs): Promise<void> {
    try {
      const updated = await window.simly.setSettings({ contentPrefs: next });
      setSettings(updated);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    } catch {
      setSaveStatus('error');
    }
  }

  if (!settings) return <p style={{ color: '#a0a0a8' }}>Loading content preferences…</p>;
  const prefs = settings.contentPrefs;

  function setRaidDifficulty(raid: RaidId, diff: keyof RaidDiff, value: boolean): void {
    void patch({
      ...prefs,
      raids: {
        ...prefs.raids,
        [raid]: { ...prefs.raids[raid], [diff]: value },
      },
    });
  }

  function setAllForRaid(raid: RaidId, value: boolean): void {
    void patch({
      ...prefs,
      raids: {
        ...prefs.raids,
        [raid]: { lfr: value, normal: value, heroic: value, mythic: value },
      },
    });
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={heading}>Content</h2>
        {saveStatus === 'saved' && <span style={{ color: '#4caf50', fontSize: 13 }}>✓ Saved</span>}
        {saveStatus === 'error' && <span style={{ color: '#ef5350', fontSize: 13 }}>Save failed</span>}
      </div>

      <p style={{ color: '#a0a0a8', fontSize: 13, marginBottom: 16 }}>
        Tell Simly which content you're willing to run. The upcoming content recommender uses
        this to scope its loot pool — uncheck anything you won't actually do.
      </p>

      {/* ---- Raids -------------------------------------------------------- */}
      <h3 style={subheading}>Raids</h3>
      <div style={card}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#a0a0a8', borderBottom: '1px solid #3a3a42' }}>
              <th style={{ ...th, textAlign: 'left' }}>Raid</th>
              {DIFFICULTIES.map((d) => (
                <th key={d.key} style={th}>{d.label}</th>
              ))}
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {RAID_CATALOG.map((raid) => {
              const row = prefs.raids[raid.id];
              const allOn = row.lfr && row.normal && row.heroic && row.mythic;
              const allOff = !row.lfr && !row.normal && !row.heroic && !row.mythic;
              return (
                <tr key={raid.id} style={{ borderBottom: '1px solid #2e2e36' }}>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <strong>{raid.name}</strong>
                    <span style={{ color: '#5a5a64', marginLeft: 6, fontSize: 11 }}>
                      ({raid.bosses} {raid.bosses === 1 ? 'boss' : 'bosses'})
                    </span>
                  </td>
                  {DIFFICULTIES.map((d) => (
                    <td key={d.key} style={td}>
                      <input
                        type="checkbox"
                        checked={row[d.key]}
                        onChange={(e) => setRaidDifficulty(raid.id, d.key, e.target.checked)}
                        style={checkboxStyle}
                      />
                    </td>
                  ))}
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button
                      style={smallBtn}
                      disabled={allOn}
                      onClick={() => setAllForRaid(raid.id, true)}
                      title="Check every difficulty"
                    >
                      All
                    </button>
                    <button
                      style={{ ...smallBtn, marginLeft: 4 }}
                      disabled={allOff}
                      onClick={() => setAllForRaid(raid.id, false)}
                      title="Uncheck every difficulty"
                    >
                      None
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---- Mythic+ ------------------------------------------------------ */}
      <h3 style={subheading}>Mythic+ Dungeons</h3>
      <div style={card}>
        <div style={row}>
          <label style={labelText}>
            <input
              type="checkbox"
              checked={prefs.mplus.enabled}
              onChange={(e) =>
                void patch({ ...prefs, mplus: { ...prefs.mplus, enabled: e.target.checked } })
              }
              style={checkboxStyle}
            />
            <span style={{ marginLeft: 8 }}>Include Mythic+ loot</span>
          </label>
        </div>
        <div style={row}>
          <span style={{ ...labelText, opacity: prefs.mplus.enabled ? 1 : 0.45 }}>
            Highest key level I'll run
          </span>
          <select
            value={prefs.mplus.max_level}
            disabled={!prefs.mplus.enabled}
            onChange={(e) =>
              void patch({
                ...prefs,
                mplus: { ...prefs.mplus, max_level: parseInt(e.target.value, 10) },
              })
            }
            style={selectStyle(prefs.mplus.enabled)}
          >
            {MPLUS_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>+{lvl}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- World content ----------------------------------------------- */}
      <h3 style={subheading}>World Content</h3>
      <div style={card}>
        <div style={row}>
          <label style={labelText}>
            <input
              type="checkbox"
              checked={prefs.world.enabled}
              onChange={(e) =>
                void patch({
                  ...prefs,
                  world: { ...prefs.world, enabled: e.target.checked },
                })
              }
              style={checkboxStyle}
            />
            <span style={{ marginLeft: 8 }}>
              Include world loot
              <span style={{ color: '#5a5a64', fontSize: 11, marginLeft: 8 }}>
                (Delves + Ritual Sites — usually weaker than instanced loot)
              </span>
            </span>
          </label>
        </div>
        <div style={row}>
          <span style={{ ...labelText, opacity: prefs.world.enabled ? 1 : 0.45 }}>
            Max Delve Tier
          </span>
          <select
            value={prefs.world.max_delve_tier}
            disabled={!prefs.world.enabled}
            onChange={(e) =>
              void patch({
                ...prefs,
                world: { ...prefs.world, max_delve_tier: parseInt(e.target.value, 10) },
              })
            }
            style={selectStyle(prefs.world.enabled)}
          >
            {DELVE_TIERS.map((t) => (
              <option key={t} value={t}>Tier {t}</option>
            ))}
          </select>
        </div>
        <div style={row}>
          <span style={{ ...labelText, opacity: prefs.world.enabled ? 1 : 0.45 }}>
            Max Ritual Site Tier
          </span>
          <select
            value={prefs.world.max_ritual_tier}
            disabled={!prefs.world.enabled}
            onChange={(e) =>
              void patch({
                ...prefs,
                world: { ...prefs.world, max_ritual_tier: parseInt(e.target.value, 10) },
              })
            }
            style={selectStyle(prefs.world.enabled)}
          >
            {RITUAL_TIERS.map((t) => (
              <option key={t} value={t}>Tier {t}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local types + styles
// ---------------------------------------------------------------------------

type RaidDiff = ContentPrefs['raids'][RaidId];

const heading: React.CSSProperties = {
  fontSize: 16,
  color: '#ffd700',
  marginTop: 24,
  marginBottom: 8,
};
const subheading: React.CSSProperties = {
  fontSize: 14,
  color: '#ffd700',
  marginTop: 16,
  marginBottom: 6,
};
const card: React.CSSProperties = {
  background: '#2a2a30',
  borderRadius: 6,
  padding: '6px 16px',
};

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid #2e2e36',
};

const labelText: React.CSSProperties = {
  color: '#e8e8ec',
  minWidth: 240,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
};

const th: React.CSSProperties = {
  textAlign: 'center',
  padding: '6px 12px',
  fontWeight: 500,
  fontSize: 12,
};

const td: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'center',
  color: '#e8e8ec',
};

const checkboxStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  accentColor: '#ffd700',
  cursor: 'pointer',
};

function selectStyle(enabled: boolean): React.CSSProperties {
  return {
    background: '#1c1c20',
    color: enabled ? '#e8e8ec' : '#5a5a64',
    border: '1px solid #3a3a42',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 13,
    fontFamily: 'Consolas, Monaco, monospace',
    outline: 'none',
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

const smallBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#ffd700',
  border: '1px solid #ffd700',
  borderRadius: 3,
  padding: '2px 10px',
  cursor: 'pointer',
  fontSize: 11,
};
