/**
 * Ambient type declarations for window.api.
 *
 * Mirrors the contextBridge surface defined in src/preload/preload.ts. Kept as
 * a .d.ts in the renderer tree so the renderer-only tsconfig can reach it
 * without pulling preload.ts (which is outside its rootDir).
 *
 * Update both files in lockstep when the API surface changes.
 */

export type ContentKind = 'post' | 'page' | 'article' | 'product' | `webflow:${string}`;

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
  /** OAuth broker origin; absent → hosted default. Set by self-hosters. */
  oauthBaseUrl?: string;
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
  platform: 'ghost' | 'shopify' | 'wordpress' | 'webflow';
  siteUrl: string;
  state: 'idle' | 'syncing' | 'conflict' | 'error' | 'disconnected';
  lastSyncedRelative?: string;
  summary: string;
  autoSync: boolean;
  conflictCount?: number;
  contentKinds: ContentKind[];
  availableKinds: ContentKind[];
}

export interface DashboardSnapshot {
  targets: DashboardTarget[];
}

export interface PendingConnect {
  platform: 'ghost' | 'wordpress' | 'webflow';
  handle?: string;
  label?: string;
  contentKinds?: ContentKind[];
  ghostUrl?: string;
  adminApiKey?: string;
  siteUrl?: string;
  username?: string;
  appPassword?: string;
  siteId?: string;
  apiToken?: string;
}

export interface SpecterApi {
  config: {
    read: () => Promise<AppConfig | null>;
    write: (cfg: AppConfig) => Promise<ApiResult>;
    writeGlobals: (patch: {
      vaultPath?: string;
      oauthBaseUrl?: string;
    }) => Promise<ApiResult>;
    exists: () => Promise<boolean>;
    setTargetSyncMode: (
      handle: string,
      mode: 'auto' | 'manual',
    ) => Promise<ApiResult>;
    removeTarget: (handle: string) => Promise<ApiResult>;
    editTarget: (handle: string) => Promise<ApiResult>;
    setTargetContentKinds: (
      handle: string,
      contentKinds: ContentKind[],
    ) => Promise<ApiResult>;
  };
  ghost: {
    test: (url: string, key: string) => Promise<ApiResult>;
    connect: (
      ghostUrl: string,
      adminApiKey: string,
      label?: string,
      contentKinds?: ContentKind[],
    ) => Promise<ApiResult>;
  };
  connect: {
    pending: () => Promise<PendingConnect | null>;
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
      label?: string,
      contentKinds?: ContentKind[],
    ) => Promise<ApiResult>;
  };
  webflow: {
    test: (siteId: string, apiToken: string) => Promise<ApiResult>;
    kinds: (
      siteId: string,
      apiToken: string,
    ) => Promise<{ ok: boolean; kinds?: ContentKind[]; error?: string }>;
    connect: (
      siteId: string,
      creds: { apiToken?: string; accessToken?: string },
      label?: string,
      contentKinds?: ContentKind[],
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
  autolaunch: {
    get: () => Promise<boolean>;
    set: (enabled: boolean) => Promise<ApiResult & { enabled?: boolean }>;
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
    openSyncFolder: () => Promise<ApiResult>;
    openLogs: () => Promise<ApiResult>;
  };
}

declare global {
  interface Window {
    api: SpecterApi;
  }
}
