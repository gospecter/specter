/**
 * Config + state file handling.
 *
 * Config lives at $XDG_CONFIG_HOME/ghost-sync/config.json (default
 *   ~/.config/ghost-sync/config.json) and holds the user-visible settings.
 *
 * State lives at $XDG_STATE_HOME/ghost-sync/state.json (default
 *   ~/.local/state/ghost-sync/state.json) and tracks last sync time + counters.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdapterConfig } from './cms/types.js';
import { ConflictItem, DEFAULT_SETTINGS, GhostSyncSettings } from './types.js';

/**
 * Per-target configuration: one CMS connection + the engine-visible sync
 * settings that govern how its content lives in the vault.
 *
 * v0.4.0 Phase B introduces this as the canonical unit; legacy single-Ghost
 * configs (every shipped user) auto-synthesize a single `targets[0]` on load
 * via `synthesizeLegacyTarget`. The writer still emits the legacy flat fields
 * alongside `targets[]` for one release window so a downgrade is non-fatal.
 */
export interface TargetConfig {
  /** URL-safe handle — also the folder name when multiple targets are configured. */
  handle: string;
  /** Display label, e.g. "My Ghost Blog". */
  label: string;
  /** Subfolder under the target's effective root. Empty means the effective
   *  root itself is used. In single-target configs, this collapses to the
   *  legacy `syncFolderPath` behavior. */
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  /** CMS credentials. Discriminated by `platform`. */
  adapter: AdapterConfig;
}

export interface DaemonConfig extends GhostSyncSettings {
  /** Absolute path to the vault root. */
  vaultPath: string;
  /** Debounce window (ms) for the file watcher before flushing changes. */
  watchDebounceMs: number;
  /**
   * Multi-target list. Always present after `loadConfig()` (synthesized from
   * legacy fields if absent on disk). Always written to disk by `saveConfig`.
   */
  targets: TargetConfig[];
}

export interface DaemonState {
  lastSyncAt: string | null;
  lastSyncStatus: 'ok' | 'error' | 'conflict' | 'never';
  lastSyncMessage: string | null;
  lastPulled: number;
  lastPushed: number;
  lastConflicts: number;
  lastErrors: number;
  /** Absolute path to the ghost-sync CLI; written so GUI apps can find it
   *  without relying on the shell PATH. Updated on every CLI invocation. */
  binaryPath: string | null;
  /** Absolute path to the node binary that ran the CLI. */
  nodePath: string | null;
  conflicts: QueuedConflict[];
  /**
   * Per-target last-sync metrics, keyed by `TargetConfig.handle`. Optional so
   * pre-v0.5.1 state.json files still deserialize. Populated by the engine on
   * every per-target pull/push — not synthesized from global counters, so the
   * Dashboard's per-card "Last sync" / "Push count" / etc. read straight from
   * here without recomputing.
   */
  targets?: Record<string, TargetSyncState>;
}

/** Per-target metrics written after each per-target sync operation. */
export interface TargetSyncState {
  /** ISO timestamp of the last sync that touched this target. */
  lastSyncAt: string | null;
  /** Outcome of the last sync for this target. `partial` indicates a mix
   *  (e.g. pulled OK but push had a conflict). */
  lastSyncStatus: 'ok' | 'error' | 'partial' | null;
  /** Number of posts pulled in the last sync. */
  lastPullCount: number;
  /** Number of posts pushed in the last sync. */
  lastPushCount: number;
  /** Number of conflicts produced by the last sync. */
  lastConflicts: number;
  /** First error message from the last sync, if any. Full list lives in the
   *  global `lastSyncMessage`. */
  lastError: string | null;
}

export interface QueuedConflict extends ConflictItem {
  id: string;
  createdAt: string;
  /** Handle of the `TargetConfig` this conflict belongs to. Optional so old
   *  state.json entries (pre-v0.4.0) still deserialize; resolve.ts falls back
   *  to `targets[0]` when missing. */
  targetHandle?: string;
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

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ghost-sync');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'ghost-sync');
}

export function statePath(): string {
  return path.join(stateDir(), 'state.json');
}

export function logPath(): string {
  const platform = process.platform;
  if (platform === 'linux') {
    const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    return path.join(base, 'ghost-sync', 'logs', 'ghost-sync.log');
  }
  if (platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ghost-sync', 'logs', 'ghost-sync.log');
  }
  // darwin (and any unrecognised POSIX platform)
  return path.join(os.homedir(), 'Library', 'Logs', 'ghost-sync.log');
}

export async function loadConfig(): Promise<DaemonConfig | null> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    const merged: DaemonConfig = {
      ...DEFAULT_SETTINGS,
      vaultPath: parsed.vaultPath ?? '',
      watchDebounceMs: parsed.watchDebounceMs ?? 2000,
      ...parsed,
      targets: [],
    } as DaemonConfig;
    merged.targets = normalizeTargets(parsed.targets, merged);
    return merged;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Return a populated `targets[]`. If the config on disk has no targets
 * (every shipped v0.3.x user), synthesize a single Ghost target from the
 * legacy flat fields. Returns an empty list if neither targets nor legacy
 * Ghost credentials are present — caller decides whether that's fatal.
 */
function normalizeTargets(
  raw: TargetConfig[] | undefined,
  fallback: GhostSyncSettings,
): TargetConfig[] {
  if (raw && raw.length > 0) return raw;
  if (!fallback.ghostUrl || !fallback.adminApiKey) return [];
  return [synthesizeLegacyTarget(fallback)];
}

/** Build a single Ghost target from legacy flat settings.
 *  Exported for the schema-codegen entry and for tests. */
export function synthesizeLegacyTarget(settings: GhostSyncSettings): TargetConfig {
  return {
    handle: 'ghost',
    label: 'Ghost',
    syncFolderPath: settings.syncFolderPath,
    pullDrafts: settings.pullDrafts,
    pullPublished: settings.pullPublished,
    conflictStrategy: settings.conflictStrategy,
    syncMode: settings.syncMode,
    adapter: {
      platform: 'ghost',
      ghostUrl: settings.ghostUrl,
      adminApiKey: settings.adminApiKey,
    },
  };
}

export async function saveConfig(config: DaemonConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
  // Windows uses NTFS ACLs; user-profile directory is already user-private.
  if (process.platform !== 'win32') await fs.chmod(configPath(), 0o600);
}

export async function loadState(): Promise<DaemonState> {
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<DaemonState>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_STATE };
    throw err;
  }
}

export async function saveState(state: DaemonState): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Update one target's entry in `state.targets` immutably. Used by the engine
 *  to record per-target metrics after each pull/push without clobbering other
 *  targets' entries. */
export function setTargetState(
  state: DaemonState,
  handle: string,
  entry: TargetSyncState,
): DaemonState {
  return {
    ...state,
    targets: {
      ...(state.targets ?? {}),
      [handle]: entry,
    },
  };
}

/** Record the absolute paths to this process's node + ghost-sync binary.
 *  Idempotent — only writes when the values change. */
export async function recordBinaryPaths(): Promise<void> {
  const prior = await loadState();
  const node = process.execPath;
  const bin = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (prior.binaryPath === bin && prior.nodePath === node) return;
  await saveState({ ...prior, binaryPath: bin, nodePath: node });
}

export function requireConfig(config: DaemonConfig | null): DaemonConfig {
  if (!config) {
    throw new Error(
      `No config found at ${configPath()}. Run 'ghost-sync init' to create one.`,
    );
  }
  if (config.targets.length === 0) {
    throw new Error('Config has no sync targets. Run `ghost-sync init` to add one.');
  }
  if (!config.vaultPath) {
    throw new Error('Config is missing vaultPath. Run `ghost-sync init`.');
  }
  return config;
}
