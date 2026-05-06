import React from 'react';
import { useQueueState } from '../useQueueState';
import type { ComposedLoadout } from '@simly/shared';

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

export function Composed(): JSX.Element {
  const state = useQueueState();
  const composed = state.results?.composed;

  return (
    <div>
      <h2 style={heading}>Composed loadout</h2>
      {composed ? (
        <>
          <p style={{ color: '#a0a0a8', fontSize: 13, marginBottom: 16 }}>{composed.label}</p>
          <LoadoutView composed={composed} />
        </>
      ) : (
        <p style={{ color: '#a0a0a8' }}>
          No loadout yet — run a full scan first.
        </p>
      )}
    </div>
  );
}

const heading: React.CSSProperties = { fontSize: 16, color: '#ffd700', marginTop: 24, marginBottom: 8 };
const subheading: React.CSSProperties = { fontSize: 14, color: '#ffd700', marginTop: 16, marginBottom: 6 };
const card: React.CSSProperties = { background: '#2a2a30', borderRadius: 6, padding: '8px 16px' };
