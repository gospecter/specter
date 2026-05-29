/**
 * Preload — exposes a typed IPC API to all renderer windows via contextBridge.
 *
 * window.api mirrors the methods a renderer needs; it maps to ipcMain.handle
 * channels registered in ipc.ts.
 *
 * Keep this file lean — no business logic, only bridge calls.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface AppConfig {
  ghostUrl: string;
  adminApiKey: string;
  vaultPath: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  watchDebounceMs: number;
}

export interface ApiResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface LicenseStatus {
  tier: 'free' | 'pro';
  key?: string;
  activatedAt?: string;
  lastValidatedAt?: string;
  monthBucket: string;
  syncCount: number;
  freeLimit: number;
  remainingFree?: number;
  proActiveOffline?: boolean;
}

export type DaemonStatus = 'running' | 'stopped' | 'crashed';

export interface DaemonStatusResult {
  status: DaemonStatus;
  lastError: string | null;
}

export interface SyncPlan {
  direction: string;
  creates: PlanEntry[];
  updates: PlanEntry[];
  metadataUpdates: PlanEntry[];
  deletes: PlanEntry[];
  conflicts: PlanEntry[];
  skips: PlanEntry[];
  errors: PlanEntry[];
}

export interface PlanEntry {
  side: 'local' | 'remote';
  title: string;
  ghostId?: string;
  localPath?: string;
  details?: string;
}

/** One row in the Dashboard's Targets list. Shape mirrors `SyncTarget` in
 *  mac/Sources/Specter/SyncCard.swift so the two surfaces render the same
 *  view-model. Built by the main process in `dashboard:fetch` from
 *  `config.targets[]` + `state.json`. */
export interface DashboardTarget {
  id: string;
  platform: 'ghost' | 'shopify' | 'wordpress';
  siteUrl: string;
  state: 'idle' | 'syncing' | 'conflict' | 'error' | 'disconnected';
  lastSyncedRelative?: string;
  summary: string;
  autoSync: boolean;
  conflictCount?: number;
}

export interface DashboardSnapshot {
  targets: DashboardTarget[];
}

const api = {
  config: {
    read: (): Promise<AppConfig | null> =>
      ipcRenderer.invoke('config:read'),
    write: (cfg: AppConfig): Promise<ApiResult> =>
      ipcRenderer.invoke('config:write', cfg),
    exists: (): Promise<boolean> =>
      ipcRenderer.invoke('config:exists'),
    setTargetSyncMode: (
      handle: string,
      mode: 'auto' | 'manual',
    ): Promise<ApiResult> =>
      ipcRenderer.invoke('config:set-target-sync-mode', { handle, mode }),
  },
  ghost: {
    test: (url: string, key: string): Promise<ApiResult> =>
      ipcRenderer.invoke('ghost:test', url, key),
  },
  wordpress: {
    test: (siteUrl: string, username: string, appPassword: string): Promise<ApiResult> =>
      ipcRenderer.invoke('wordpress:test', siteUrl, username, appPassword),
    connect: (
      siteUrl: string,
      username: string,
      appPassword: string,
    ): Promise<ApiResult> =>
      ipcRenderer.invoke('wordpress:connect', { siteUrl, username, appPassword }),
  },
  daemon: {
    status: (): Promise<DaemonStatusResult> =>
      ipcRenderer.invoke('daemon:status'),
    start: (): Promise<void> =>
      ipcRenderer.invoke('daemon:start'),
    stop: (): Promise<void> =>
      ipcRenderer.invoke('daemon:stop'),
    restart: (): Promise<void> =>
      ipcRenderer.invoke('daemon:restart'),
    runSync: (cmd: 'sync' | 'pull' | 'push' = 'sync'): Promise<ApiResult> =>
      ipcRenderer.invoke('daemon:run-sync', cmd),
  },
  license: {
    status: (): Promise<LicenseStatus | ApiResult> =>
      ipcRenderer.invoke('license:status'),
    activate: (key: string): Promise<ApiResult> =>
      ipcRenderer.invoke('license:activate', key),
    deactivate: (): Promise<ApiResult> =>
      ipcRenderer.invoke('license:deactivate'),
  },
  dialog: {
    pickFolder: (): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickFolder'),
  },
  preview: {
    fetch: (): Promise<SyncPlan | { error: string }> =>
      ipcRenderer.invoke('preview:fetch'),
  },
  dashboard: {
    fetch: (): Promise<DashboardSnapshot> =>
      ipcRenderer.invoke('dashboard:fetch'),
    runCommand: (
      command: 'pull' | 'push' | 'sync' | 'dry-run',
      handle: string,
    ): Promise<ApiResult> =>
      ipcRenderer.invoke('dashboard:run-command', { command, handle }),
  },
  windows: {
    open: (name: string): Promise<ApiResult> =>
      ipcRenderer.invoke('windows:open', name),
  },
  shell: {
    openExternal: (url: string): Promise<ApiResult> =>
      ipcRenderer.invoke('shell:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('api', api);

// Type declaration so TypeScript renderers can use window.api without casting.
declare global {
  interface Window {
    api: typeof api;
  }
}
