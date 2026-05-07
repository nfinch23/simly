/**
 * Preload bridge — exposes a narrow IPC API to the renderer via
 * contextBridge. With sandbox:true (Phase 5), the renderer has no
 * direct access to Node.js or Electron internals; everything must go
 * through this surface.
 *
 * The exposed object lands at `window.simly` in the renderer.
 * Type declaration lives in `renderer/globals.d.ts`.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_QUEUE_STATE_CHANGED,
  IPC_QUEUE_GET_STATE,
  IPC_PROFILE_PASTE,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_SET,
  IPC_IGNORE_LIST_LIST,
  IPC_IGNORE_LIST_REMOVE,
  IPC_IGNORE_LIST_CLEAR,
  IPC_DEV_CLEAR_SIM_CACHE,
  type QueueState,
  type PasteProfileArgs,
  type IgnoreListFilter,
  type RemoveIgnoreEntryArgs,
  type ClearSimCacheResult,
} from '../main/ipc';
import type { SimlySettings } from '../main/settings';
import type { IgnoreEntry } from '../main/ignore-list';

const simlyBridge = {
  // -------------------------------------------------------------------------
  // Queue state
  // -------------------------------------------------------------------------
  getQueueState: (): Promise<QueueState> =>
    ipcRenderer.invoke(IPC_QUEUE_GET_STATE),

  onQueueStateChanged: (cb: (state: QueueState) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: QueueState) => cb(state);
    ipcRenderer.on(IPC_QUEUE_STATE_CHANGED, handler);
    return () => ipcRenderer.off(IPC_QUEUE_STATE_CHANGED, handler);
  },

  // -------------------------------------------------------------------------
  // Paste-profile trigger
  // -------------------------------------------------------------------------
  pasteProfile: (args: PasteProfileArgs): Promise<void> =>
    ipcRenderer.invoke(IPC_PROFILE_PASTE, args),

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  getSettings: (): Promise<SimlySettings> =>
    ipcRenderer.invoke(IPC_SETTINGS_GET),

  setSettings: (updates: Partial<SimlySettings>): Promise<SimlySettings> =>
    ipcRenderer.invoke(IPC_SETTINGS_SET, updates),

  // -------------------------------------------------------------------------
  // Ignore list
  // -------------------------------------------------------------------------
  listIgnoreEntries: (filter?: IgnoreListFilter): Promise<IgnoreEntry[]> =>
    ipcRenderer.invoke(IPC_IGNORE_LIST_LIST, filter),

  removeIgnoreEntry: (args: RemoveIgnoreEntryArgs): Promise<void> =>
    ipcRenderer.invoke(IPC_IGNORE_LIST_REMOVE, args),

  clearIgnoreList: (): Promise<void> =>
    ipcRenderer.invoke(IPC_IGNORE_LIST_CLEAR),

  // -------------------------------------------------------------------------
  // Dev tools
  // -------------------------------------------------------------------------
  clearSimCache: (): Promise<ClearSimCacheResult> =>
    ipcRenderer.invoke(IPC_DEV_CLEAR_SIM_CACHE),
};

contextBridge.exposeInMainWorld('simly', simlyBridge);

export type SimlyBridge = typeof simlyBridge;
