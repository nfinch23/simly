/**
 * Typed IPC channel definitions for renderer ↔ main communication.
 * Phase 5: desktop renderer UI.
 *
 * Push channels (main → renderer via webContents.send):
 *   IPC_QUEUE_STATE_CHANGED  — fired whenever queue state changes
 *
 * Invoke channels (renderer → main via ipcRenderer.invoke):
 *   IPC_QUEUE_GET_STATE      — get current queue state snapshot
 *   IPC_PROFILE_PASTE        — submit a pasted SimC profile string
 *   IPC_SETTINGS_GET         — read current settings
 *   IPC_SETTINGS_SET         — write one or more setting overrides
 *   IPC_IGNORE_LIST_LIST     — list ignore-list entries (optional filter)
 *   IPC_IGNORE_LIST_REMOVE   — mark one entry manually removed
 *   IPC_IGNORE_LIST_CLEAR    — clear all entries
 */

import type { SimlyResults } from '@simly/shared';

// ---------------------------------------------------------------------------
// Channel name constants
// ---------------------------------------------------------------------------

export const IPC_QUEUE_STATE_CHANGED = 'queue:state-changed';
export const IPC_QUEUE_GET_STATE = 'queue:get-state';
export const IPC_PROFILE_PASTE = 'profile:paste';
export const IPC_SETTINGS_GET = 'settings:get';
export const IPC_SETTINGS_SET = 'settings:set';
export const IPC_IGNORE_LIST_LIST = 'ignore-list:list';
export const IPC_IGNORE_LIST_REMOVE = 'ignore-list:remove';
export const IPC_IGNORE_LIST_CLEAR = 'ignore-list:clear';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** Snapshot of the scan queue's current state. Sent on every change. */
export interface QueueState {
  isRunning: boolean;
  /** Character key for the active or last-run character. */
  characterKey: string | null;
  /** Active scenario tag. */
  scenario: string | null;
  /** Unix seconds when the current (or most recent) run started. */
  runStartedAt: number | null;
  /** Unix seconds when the most recent run completed. */
  lastCompletedAt: number | null;
  /** Latest SimlyResults written to disk (null until first write). */
  results: SimlyResults | null;
}

export interface PasteProfileArgs {
  /** Raw SimC profile string (e.g. `warlock="Felfriend"\nlevel=80\n...`). */
  profileScript: string;
}

export interface IgnoreListFilter {
  characterKey?: string;
  scenario?: string;
}

export interface RemoveIgnoreEntryArgs {
  characterKey: string;
  scenario: string;
  itemIdentity: string;
}
