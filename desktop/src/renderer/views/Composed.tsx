import React from 'react';
import { useQueueState } from '../useQueueState';
import type {
  BestContentResult,
  ComposedLoadout,
  UpgradePriorityResult,
} from '@simly/shared';

// WoW's character screen slot order
const GEAR_SLOTS = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'wrist',
  'hands', 'waist', 'legs', 'feet',
  'finger1', 'finger2',
  'trinket1', 'trinket2',
  'main_hand', 'off_hand',
];

const SLOT_LABELS: Record<string, string> = {
  head: 'Head', neck: 'Neck', shoulder: 'Shoulder', back: 'Back',
  chest: 'Chest', wrist: 'Wrist', hands: 'Hands', waist: 'Waist',
  legs: 'Legs', feet: 'Feet',
  finger1: 'Ring 1', finger2: 'Ring 2',
  trinket1: 'Trinket 1', trinket2: 'Trinket 2',
  main_hand: 'Main Hand', off_hand: 'Off Hand',
};

function GearSlotRow({ slot, item }: {
  slot: string;
  item: { item_id: number; name: string; ilvl?: number } | undefined;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0', borderBottom: '1px solid #2e2e36' }}>
      <span style={{ color: '#a0a0a8', minWidth: 100, flexShrink: 0 }}>
        {SLOT_LABELS[slot] ?? slot}
      </span>
      {item ? (
        <span style={{ color: '#e8e8ec' }}>
          {item.name}
          {item.ilvl ? <span style={{ color: '#5a5a64', marginLeft: 8, fontSize: 12 }}>ilvl {item.ilvl}</span> : null}
        </span>
      ) : (
        <span style={{ color: '#5a5a64', fontStyle: 'italic' }}>—</span>
      )}
    </div>
  );
}

function ConsumableRow({ label, item }: {
  label: string;
  item: { item_id: number; name: string } | undefined;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0', borderBottom: '1px solid #2e2e36' }}>
      <span style={{ color: '#a0a0a8', minWidth: 100, flexShrink: 0 }}>{label}</span>
      {item ? (
        <span style={{ color: '#e8e8ec' }}>{item.name}</span>
      ) : (
        <span style={{ color: '#5a5a64', fontStyle: 'italic' }}>—</span>
      )}
    </div>
  );
}

function LoadoutView({ composed }: { composed: ComposedLoadout }): JSX.Element {
  const gear = composed.gear ?? {};
  const is2H = gear.main_hand !== undefined && gear.off_hand === undefined;

  const slotsToShow = is2H
    ? GEAR_SLOTS.filter((s) => s !== 'off_hand')
    : GEAR_SLOTS;

  const hasConsumables =
    composed.flask || composed.food || composed.potion || composed.augment_rune;

  return (
    <>
      {composed.expected_dps && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ color: '#a0a0a8' }}>Expected DPS: </span>
          <span style={{ color: '#ffd700', fontWeight: 600 }}>
            {Math.round(composed.expected_dps).toLocaleString()}
          </span>
        </div>
      )}

      <h3 style={subheading}>Gear</h3>
      <div style={card}>
        {slotsToShow.map((slot) => (
          <GearSlotRow key={slot} slot={slot} item={gear[slot]} />
        ))}
      </div>

      {hasConsumables && (
        <>
          <h3 style={subheading}>Consumables</h3>
          <div style={card}>
            <ConsumableRow label="Flask" item={composed.flask} />
            <ConsumableRow label="Food" item={composed.food} />
            <ConsumableRow label="Potion" item={composed.potion} />
            <ConsumableRow label="Augment Rune" item={composed.augment_rune} />
          </div>
        </>
      )}
    </>
  );
}

function UpgradePriorityView({ data }: { data: UpgradePriorityResult }): JSX.Element {
  if (data.opportunities.length === 0) {
    return (
      <p style={{ color: '#5a5a64', fontSize: 13, padding: '6px 16px' }}>
        Every simmed slot is at the ilvl ceiling — nothing to upgrade.
      </p>
    );
  }
  return (
    <div style={{ ...card, padding: 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: '#a0a0a8', borderBottom: '1px solid #3a3a42' }}>
            <th style={th}>Slot</th>
            <th style={th}>Item</th>
            <th style={th}>ilvl</th>
            <th style={th}>Δ DPS</th>
            <th style={th}>Δ %</th>
          </tr>
        </thead>
        <tbody>
          {data.opportunities.map((o) => (
            <tr key={`${o.slot}-${o.item_id}`} style={{ borderBottom: '1px solid #2e2e36' }}>
              <td style={td}>{SLOT_LABELS[o.slot] ?? o.slot}</td>
              <td style={td}>{o.name}</td>
              <td style={{ ...td, color: '#a0a0a8' }}>
                {o.current_ilvl} → <span style={{ color: '#e8e8ec' }}>{o.next_ilvl}</span>
              </td>
              <td style={{ ...td, color: o.delta_dps > 0 ? '#66bb6a' : '#a0a0a8' }}>
                +{o.delta_dps.toLocaleString()}
              </td>
              <td style={{ ...td, color: o.delta_pct > 0 ? '#66bb6a' : '#a0a0a8' }}>
                +{o.delta_pct.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BestContentView({ data }: { data: BestContentResult }): JSX.Element {
  if (data.opportunities.length === 0) {
    return (
      <p style={{ color: '#5a5a64', fontSize: 13, padding: '6px 16px' }}>
        Nothing in your enabled content beats what you're already wearing.
        Either tighten your content prefs or upgrade what you have.
      </p>
    );
  }
  return (
    <div style={{ ...card, padding: 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: '#a0a0a8', borderBottom: '1px solid #3a3a42' }}>
            <th style={th}>Slot</th>
            <th style={th}>Item ID</th>
            <th style={th}>Source</th>
            <th style={th}>ilvl</th>
            <th style={th}>Δ DPS</th>
            <th style={th}>Δ %</th>
          </tr>
        </thead>
        <tbody>
          {data.opportunities.slice(0, 25).map((o) => {
            const color = o.delta_dps > 0 ? '#66bb6a' : '#a0a0a8';
            return (
              <tr key={`${o.slot}-${o.item_id}`} style={{ borderBottom: '1px solid #2e2e36' }}>
                <td style={td}>{SLOT_LABELS[o.slot] ?? o.slot}</td>
                <td style={{ ...td, color: '#5a5a64', fontFamily: 'Consolas, monospace' }}>
                  {o.item_id}
                </td>
                <td style={td}>
                  <span style={{ color: o.source_category === 'raid' ? '#ce93d8' : '#90caf9' }}>
                    {o.source_label}
                  </span>
                </td>
                <td style={td}>{o.target_ilvl}</td>
                <td style={{ ...td, color }}>
                  {o.delta_dps > 0 ? '+' : ''}{o.delta_dps.toLocaleString()}
                </td>
                <td style={{ ...td, color }}>
                  {o.delta_pct > 0 ? '+' : ''}{o.delta_pct.toFixed(2)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.opportunities.length > 25 && (
        <p style={{ color: '#5a5a64', fontSize: 11, padding: '6px 12px' }}>
          {data.opportunities.length - 25} more not shown.
        </p>
      )}
    </div>
  );
}

export function Composed(): JSX.Element {
  const state = useQueueState();
  const activeScenario = state.scenario ?? 'single_target_patchwerk';
  const scenarioData = (state.results?.scenarios as any)?.[activeScenario];
  const composed = scenarioData?.composed ?? state.results?.composed; // v2 fallback
  const upgradePriority = scenarioData?.scans?.upgrade_priority?.data as
    | UpgradePriorityResult
    | undefined;
  const bestContent = scenarioData?.scans?.best_content?.data as
    | BestContentResult
    | undefined;

  return (
    <div>
      <h2 style={heading}>Composed loadout</h2>
      {composed ? (
        <>
          <p style={{ color: '#a0a0a8', fontSize: 13, marginBottom: 16 }}>{composed.label}</p>
          <LoadoutView composed={composed} />
          {upgradePriority && (
            <>
              <h3 style={subheading}>Upgrade priority</h3>
              <p style={{ color: '#5a5a64', fontSize: 11, margin: '0 0 6px 0' }}>
                Each slot simmed at +{upgradePriority.ilvl_per_tier} ilvl (one tier).
                Approximate — actual gain depends on the upgrade track.
              </p>
              <UpgradePriorityView data={upgradePriority} />
            </>
          )}
          {bestContent && (
            <>
              <h3 style={subheading}>Best content to chase</h3>
              <p style={{ color: '#5a5a64', fontSize: 11, margin: '0 0 6px 0' }}>
                For each item the content you enabled could drop, simmed at its track's
                max-upgrade ilvl. {bestContent.candidates_evaluated} candidates considered;
                shown sorted by DPS gain.
              </p>
              <BestContentView data={bestContent} />
            </>
          )}
        </>
      ) : (
        <p style={{ color: '#a0a0a8' }}>
          No loadout yet — run a full scan first.
        </p>
      )}
    </div>
  );
}

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

const heading: React.CSSProperties = { fontSize: 16, color: '#ffd700', marginTop: 24, marginBottom: 8 };
const subheading: React.CSSProperties = { fontSize: 14, color: '#ffd700', marginTop: 16, marginBottom: 6 };
const card: React.CSSProperties = { background: '#2a2a30', borderRadius: 6, padding: '8px 16px' };
