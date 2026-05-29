/**
 * Ambient type declarations for window.api.
 *
 * Mirrors the contextBridge surface defined in src/preload/preload.ts. Kept as
 * a .d.ts in the renderer tree so the renderer-only tsconfig can reach it
 * without pulling preload.ts (which is outside its rootDir).
 *
 * Update both files in lockstep when the API surface changes.
 */

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

export interface PlanEntry {
  side: 'local' | 'remote';
  title: string;
  ghostId?: string;
  localPath?: string;
  details?: string;
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

export interface SpecterApi {
  config: {
    read: () => Promise<AppConfig | null>;
    write: (cfg: AppConfig) => Promise<ApiResult>;
    exists: () => Promise<boolean>;
    setTargetSyncMode: (
      handle: string,
      mode: 'auto' | 'manual',
    ) => Promise<ApiResult>;
  };
  ghost: {
    test: (url: string, key: string) => Promise<ApiResult>;
  };
  wordpress: {
    test: (
      siteUrl: string,
      username: string,
      appPassword: string,
    ) => Promise<ApiResult>;
    connect: (
      siteUrl: string,
      username: string,
      appPassword: string,
    ) => Promise<ApiResult>;
  };
  daemon: {
    status: () => Promise<DaemonStatusResult>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    runSync: (cmd?: 'sync' | 'pull' | 'push') => Promise<ApiResult>;
  };
  license: {
    status: () => Promise<LicenseStatus | ApiResult>;
    activate: (key: string) => Promise<ApiResult>;
    deactivate: () => Promise<ApiResult>;
  };
  dialog: {
    pickFolder: () => Promise<string | null>;
  };
  preview: {
    fetch: () => Promise<SyncPlan | { error: string }>;
  };
  dashboard: {
    fetch: () => Promise<DashboardSnapshot>;
    runCommand: (
      command: 'pull' | 'push' | 'sync' | 'dry-run',
      handle: string,
    ) => Promise<ApiResult>;
  };
  windows: {
    open: (name: string) => Promise<ApiResult>;
  };
  shell: {
    openExternal: (url: string) => Promise<ApiResult>;
  };
}

declare global {
  interface Window {
    api: SpecterApi;
  }
}
