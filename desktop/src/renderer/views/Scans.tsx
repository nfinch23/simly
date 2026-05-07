import React, { useState } from 'react';
import type {
  ScanRecord,
  StatWeights,
  TrinketPreScanResult,
  GearScanResult,
  BestConsumableResult,
} from '@simly/shared';
import { useQueueState } from '../useQueueState';

function formatTs(unix: number | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString();
}

function durationStr(rec: ScanRecord): string {
  const start = rec.started_at;
  const end = rec.finished_at;
  if (start == null || end == null) return '';
  const secs = end - start;
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const STATUS_COLOR: Record<string, string> = {
  done: '#4caf50',
  running: '#ffb347',
  failed: '#ef5350',
  pending: '#a0a0a8',
};

function StatusBadge({ status }: { status: string }): JSX.Element {
  return <span style={{ color: STATUS_COLOR[status] ?? '#e8e8ec' }}>● {status}</span>;
}

// ---------------------------------------------------------------------------
// Scan-specific data renderers
// ---------------------------------------------------------------------------

function StatWeightsData({ data }: { data: StatWeights }): JSX.Element {
  const sorted = (Object.entries(data) as Array<[string, number | undefined]>)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort(([, a], [, b]) => b - a);
  return (
    <table style={table}>
      <tbody>
        {sorted.map(([stat, val]) => (
          <tr key={stat}>
            <td style={tdLabel}>{stat}</td>
            <td style={tdVal}>{val.toFixed(4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrinketData({ data }: { data: TrinketPreScanResult }): JSX.Element {
  return (
    <>
      {data.pairs.slice(0, 10).map((p: TrinketPreScanResult['pairs'][number], i: number) => (
        <div key={p.pair_id} style={{ padding: '3px 0', borderBottom: '1px solid #2e2e36' }}>
          <span style={{ color: i === 0 ? '#ffd700' : '#e8e8ec' }}>
            {i + 1}. {p.trinket1.name} + {p.trinket2.name}
          </span>
          <span style={{ color: '#a0a0a8', marginLeft: 12 }}>
            {Math.round(p.mean_dps).toLocaleString()} dps
            {i > 0 && ` (${p.delta_pct.toFixed(2)}%)`}
          </span>
        </div>
      ))}
      {data.pairs.length > 10 && (
        <p style={{ color: '#5a5a64', fontSize: 12, marginTop: 4 }}>
          +{data.pairs.length - 10} more pairs
        </p>
      )}
    </>
  );
}

function GearData({ data }: { data: GearScanResult }): JSX.Element {
  return (
    <>
      <p style={{ color: '#a0a0a8', fontSize: 12, marginBottom: 4 }}>
        {data.total_combos} combos × {data.iterations} iter
      </p>
      {data.combos.slice(0, 10).map((combo: GearScanResult['combos'][number], i: number) => (
        <div key={combo.combo_id} style={{ padding: '3px 0', borderBottom: '1px solid #2e2e36' }}>
          <span style={{ color: i === 0 ? '#ffd700' : '#e8e8ec' }}>
            {i + 1}. {Math.round(combo.mean_dps).toLocaleString()} dps
            {i > 0 && <span style={{ color: '#a0a0a8' }}> ({combo.delta_pct.toFixed(2)}%)</span>}
          </span>
          <div style={{ color: '#5a5a64', fontSize: 11, marginTop: 2 }}>
            {combo.items.map((ref: GearScanResult['combos'][number]['items'][number]) => `${ref.slot}: ${ref.item.name}`).join(' · ')}
          </div>
        </div>
      ))}
      {data.combos.length > 10 && (
        <p style={{ color: '#5a5a64', fontSize: 12, marginTop: 4 }}>
          +{data.combos.length - 10} more combos
        </p>
      )}
    </>
  );
}

function ConsumableData({ data }: { data: BestConsumableResult }): JSX.Element {
  return (
    <>
      <div style={{ color: '#ffd700' }}>
        {data.best.name} — {Math.round(data.best.dps).toLocaleString()} dps
      </div>
      {data.alternatives.slice(0, 5).map((alt: BestConsumableResult['alternatives'][number]) => (
        <div key={alt.item_id} style={{ color: '#a0a0a8', fontSize: 12, padding: '2px 0' }}>
          {alt.name} ({alt.delta_pct.toFixed(2)}%)
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Single scan row with collapsible data
// ---------------------------------------------------------------------------

function ScanRow({ id, rec }: { id: string; rec: ScanRecord }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ borderBottom: '1px solid #2e2e36' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 0',
          cursor: rec.data ? 'pointer' : 'default',
        }}
        onClick={() => rec.data && setOpen((v) => !v)}
      >
        <span style={{ minWidth: 220, color: '#e8e8ec', fontFamily: 'Consolas, Monaco, monospace', fontSize: 13 }}>
          {id}
        </span>
        <StatusBadge status={rec.status} />
        {rec.started_at && (
          <span style={{ color: '#5a5a64', fontSize: 12 }}>
            started {formatTs(rec.started_at)}
            {rec.finished_at && ` · ${durationStr(rec)}`}
          </span>
        )}
        {rec.data != null && (
          <span style={{ color: '#5a5a64', fontSize: 11, marginLeft: 'auto' }}>
            {open ? '▲ hide' : '▼ show'}
          </span>
        )}
        {rec.error && <span style={{ color: '#ef5350', fontSize: 12 }}>{rec.error}</span>}
      </div>
      {open && rec.data != null && (
        <div style={{ paddingBottom: 12, paddingLeft: 8 }}>
          <ScanData id={id} data={rec.data} />
        </div>
      )}
    </div>
  );
}

function ScanData({ id, data }: { id: string; data: unknown }): JSX.Element {
  if (id === 'stat_weights') return <StatWeightsData data={data as StatWeights} />;
  if (id === 'trinket_pre_scan') return <TrinketData data={data as TrinketPreScanResult} />;
  if (id === 'gear_coarse' || id === 'gear_refined' || id === 'gear_final')
    return <GearData data={data as GearScanResult} />;
  if (id === 'best_flask' || id === 'best_food')
    return <ConsumableData data={data as BestConsumableResult} />;
  return (
    <pre style={{ color: '#a0a0a8', fontSize: 11, overflow: 'auto', maxHeight: 200 }}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

const SCAN_ORDER = [
  'stat_weights',
  'trinket_pre_scan',
  'gear_coarse',
  'gear_refined',
  'gear_final',
  'best_flask',
  'best_food',
  'consumables_gems_enchants',
];

export function Scans(): JSX.Element {
  const state = useQueueState();
  const activeScenario = state.scenario ?? 'single_target_patchwerk';
  const scans = (state.results?.scenarios as any)?.[activeScenario]?.scans
    ?? state.results?.scans  // v2 fallback
    ?? {};

  const allIds = [
    ...SCAN_ORDER.filter((id) => id in scans),
    ...Object.keys(scans).filter((id) => !SCAN_ORDER.includes(id)),
  ];

  return (
    <div>
      <h2 style={heading}>Scans</h2>
      {allIds.length === 0 ? (
        <p style={{ color: '#a0a0a8' }}>No scan results yet.</p>
      ) : (
        <div style={{ background: '#2a2a30', borderRadius: 6, padding: '0 16px' }}>
          {allIds.map((id) => {
            const rec = scans[id];
            return rec ? <ScanRow key={id} id={id} rec={rec} /> : null;
          })}
        </div>
      )}
    </div>
  );
}

const heading: React.CSSProperties = {
  fontSize: 16,
  color: '#ffd700',
  marginTop: 24,
  marginBottom: 8,
};

const table: React.CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: 13,
};

const tdLabel: React.CSSProperties = {
  color: '#a0a0a8',
  padding: '2px 16px 2px 0',
  minWidth: 120,
};

const tdVal: React.CSSProperties = {
  color: '#e8e8ec',
  padding: '2px 0',
};
