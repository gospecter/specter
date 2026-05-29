/**
 * Reads the daemon's state.json synchronously.
 * Used to populate the tray menu and status display.
 * The daemon writes this file; the Electron app only reads it.
 */

import fs from 'fs';
import { stateFilePath } from './paths.js';

export interface DaemonState {
  lastSyncAt: string | null;
  lastSyncStatus: 'ok' | 'error' | 'conflict' | 'never' | null;
  lastSyncMessage: string | null;
  lastPulled: number;
  lastPushed: number;
  lastConflicts: number;
  lastErrors: number;
  binaryPath: string | null;
  nodePath: string | null;
  conflicts: QueuedConflict[];
  /** Per-target last-sync metrics keyed by handle (v0.5.1+). Optional so old
   *  state.json files still deserialize against this shape. Dashboard cards
   *  read from here without recomputing from global counters. */
  targets?: Record<string, TargetSyncState>;
}

/** Mirror of the daemon's TargetSyncState (src/config.ts). Kept in lockstep
 *  by hand because the Electron app doesn't run the TS source-of-truth. */
export interface TargetSyncState {
  lastSyncAt: string | null;
  lastSyncStatus: 'ok' | 'error' | 'partial' | null;
  lastPullCount: number;
  lastPushCount: number;
  lastConflicts: number;
  lastError: string | null;
}

export interface QueuedConflict {
  id: string;
  createdAt: string;
  type: string;
  localPost: {
    title: string;
    file: { path: string; basename: string };
  };
  ghostPost?: { title?: string };
}

export const DEFAULT_STATE: DaemonState = {
  lastSyncAt: null,
  lastSyncStatus: 'never',
  lastSyncMessage: null,
  lastPulled: 0,
  lastPushed: 0,
  lastConflicts: 0,
  lastErrors: 0,
  binaryPath: null,
  nodePath: null,
  conflicts: [],
};

export function readState(): DaemonState {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<DaemonState>) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function lastSyncRelative(isoDate: string | null): string {
  if (!isoDate) return 'never';
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return 'never';
  const diff = Math.round((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
