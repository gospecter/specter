/**
 * Build the Dashboard view-model from on-disk config + state.
 *
 * Mirrors `DashboardController.buildTargets` in mac/Sources/Specter/Dashboard.swift —
 * keep the two derivations aligned so Mac + Electron Dashboards render
 * identically when given the same config.json + state.json.
 *
 * Pure module: no fs, no electron. Tested via direct calls.
 */

import type { AppConfig, TargetConfig, AdapterConfig } from './config-merge.js';
import type { DaemonState, TargetSyncState } from './state.js';
import { lastSyncRelative } from './state.js';

export type DashboardPlatform = 'ghost' | 'shopify' | 'wordpress';
export type DashboardState =
  | 'idle'
  | 'syncing'
  | 'conflict'
  | 'error'
  | 'disconnected';

export interface DashboardTarget {
  id: string;
  platform: DashboardPlatform;
  siteUrl: string;
  state: DashboardState;
  lastSyncedRelative?: string;
  summary: string;
  autoSync: boolean;
  conflictCount?: number;
}

export interface DashboardSnapshot {
  targets: DashboardTarget[];
}

/** Derive one Dashboard row per `TargetConfig`. Returns an empty list when
 *  there is no config or no targets (clean install before onboarding). */
export function buildDashboardSnapshot(
  config: AppConfig | null,
  state: DaemonState | null,
): DashboardSnapshot {
  if (!config || !config.targets || config.targets.length === 0) {
    return { targets: [] };
  }
  const isMulti = config.targets.length > 1;
  return {
    targets: config.targets.map((t) => buildTarget(t, state, isMulti)),
  };
}

function buildTarget(
  target: TargetConfig,
  state: DaemonState | null,
  isMulti: boolean,
): DashboardTarget {
  const platform = platformOf(target.adapter);
  const connected = hasCredentials(target.adapter);
  const siteUrl = siteUrlOf(target.adapter);
  const summary = summaryFor(target, isMulti);

  let derivedState: DashboardState;
  let conflictCount: number;
  let lastSyncedRelativeStr: string | undefined;

  // Prefer per-target metrics the daemon now writes to state.targets[handle]
  // (v0.5.1+). They drive each card's status/last-sync/conflict count
  // independently. Fall back to the global counters only for a lone
  // single-target config whose handle the daemon hasn't keyed yet (e.g. a
  // state.json written before per-target metrics existed).
  const perTarget = state?.targets?.[target.handle];

  if (!connected) {
    derivedState = 'disconnected';
    conflictCount = 0;
    lastSyncedRelativeStr = undefined;
  } else if (perTarget) {
    conflictCount = perTarget.lastConflicts ?? 0;
    derivedState = stateFromTarget(perTarget, conflictCount);
    const rel = perTarget.lastSyncAt ? lastSyncRelative(perTarget.lastSyncAt) : 'never';
    lastSyncedRelativeStr = rel === 'never' ? undefined : rel;
  } else if (!isMulti) {
    conflictCount = state?.lastConflicts ?? 0;
    derivedState = stateFromGlobal(state, conflictCount);
    const rel = state?.lastSyncAt ? lastSyncRelative(state.lastSyncAt) : 'never';
    // `lastSyncRelative` returns "never" when the timestamp is missing; the
    // card's "Synced · {rel}" copy only makes sense once a sync has run.
    lastSyncedRelativeStr = rel === 'never' ? undefined : rel;
  } else {
    // Multi-target with no per-target metrics yet → "not synced yet".
    derivedState = 'idle';
    conflictCount = 0;
    lastSyncedRelativeStr = undefined;
  }

  return {
    id: target.handle,
    platform,
    siteUrl,
    state: derivedState,
    lastSyncedRelative: lastSyncedRelativeStr,
    summary,
    autoSync: target.syncMode === 'auto',
    conflictCount,
  };
}

function platformOf(adapter: AdapterConfig): DashboardPlatform {
  return adapter.platform;
}

function hasCredentials(adapter: AdapterConfig): boolean {
  if (adapter.platform === 'ghost') {
    return !!(adapter.ghostUrl && adapter.adminApiKey);
  }
  if (adapter.platform === 'shopify') {
    return !!(adapter.shop && adapter.accessToken);
  }
  return false;
}

function siteUrlOf(adapter: AdapterConfig): string {
  if (adapter.platform === 'ghost') {
    return displayHost(adapter.ghostUrl ?? '');
  }
  if (adapter.platform === 'shopify') {
    return adapter.shop && adapter.shop.length > 0 ? adapter.shop : '—';
  }
  return '—';
}

function displayHost(raw: string): string {
  if (!raw) return '—';
  let s = raw;
  const schemeIdx = s.indexOf('://');
  if (schemeIdx >= 0) s = s.slice(schemeIdx + 3);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function summaryFor(target: TargetConfig, isMulti: boolean): string {
  if (isMulti) return `vault/${target.handle}`;
  if (target.syncFolderPath) return `vault/${target.syncFolderPath}`;
  return 'vault root';
}

/** Derive a card state from one target's own metrics (state.targets[handle]).
 *  Conflicts win over everything; an error status renders as 'error'; a
 *  'partial' sync (some items failed) also surfaces as 'error' so the user
 *  notices; otherwise 'idle'. */
function stateFromTarget(
  metrics: TargetSyncState,
  conflictCount: number,
): DashboardState {
  if (conflictCount > 0) return 'conflict';
  if (metrics.lastSyncStatus === 'error' || metrics.lastSyncStatus === 'partial') {
    return 'error';
  }
  return 'idle';
}

function stateFromGlobal(
  state: DaemonState | null,
  conflictCount: number,
): DashboardState {
  if (conflictCount > 0) return 'conflict';
  const raw = state?.lastSyncStatus;
  if (raw === 'error') return 'error';
  if (raw === 'conflict') return 'conflict';
  // 'ok' / 'never' / null all render as idle — the lastSyncedRelative string
  // distinguishes "just synced" from "never synced" for the user.
  return 'idle';
}
