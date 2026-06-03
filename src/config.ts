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
import { AdapterConfig, ContentKind, Platform } from './cms/types.js';
import { effectiveRoot } from './sync/targets.js';
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
  /** Which content kinds this target syncs (both directions). Opt-in: nothing
   *  syncs unless listed. Pull lists only these kinds; push skips local files
   *  whose `cms_kind` is not enabled. Legacy configs (no field) migrate to the
   *  platform's base post kind on load so existing post sync is preserved. */
  contentKinds: ContentKind[];
  /** CMS credentials. Discriminated by `platform`. */
  adapter: AdapterConfig;
}

export interface DaemonConfig extends GhostSyncSettings {
  /** Absolute path to the vault root. */
  vaultPath: string;
  /** Debounce window (ms) for the file watcher before flushing changes. */
  watchDebounceMs: number;
  /**
   * Origin of the OAuth broker the desktop shells use to run hosted OAuth
   * flows (start → callback → token exchange). Read ONLY by the shells, never
   * by the daemon — the daemon consumes the resulting token like any other.
   *
   * PRO ships pointing at the hosted broker (`https://spectersync.com`) so
   * OAuth is turnkey. DIY users who want OAuth must register their own provider
   * app and stand up their own broker, then set this to its origin; absent, the
   * shells fall back to the hosted default. Optional so existing configs and
   * pasted-token users need no migration.
   */
  oauthBaseUrl?: string;
  /**
   * Multi-target list. Always present after `loadConfig()` (synthesized from
   * legacy fields if absent on disk). Always written to disk by `saveConfig`.
   */
  targets: TargetConfig[];
  /**
   * Vault folder layout marker. `'namespaced'` means every target's files
   * already live under its handle folder (the only layout written since v0.6).
   * Absent (or `'flat'`) marks a pre-v0.6 config whose single target may still
   * have files at the bare `syncFolderPath` — `migrateVaultLayout` checks and
   * relocates them once, then stamps `'namespaced'`. Optional so existing
   * on-disk configs load unchanged and trigger exactly one migration pass.
   */
  vaultLayout?: 'flat' | 'namespaced';
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

/** The content kinds a platform can sync, in the order the UI should offer
 *  them. The first entry is the base post kind (the conservative default for
 *  legacy-config migration). */
export const PLATFORM_KINDS: Record<Platform, ContentKind[]> = {
  ghost: ['post', 'page'],
  wordpress: ['post', 'page'],
  shopify: ['article', 'page', 'product'],
  // Webflow content kinds are dynamic — one `webflow:<collectionSlug>` kind per
  // CMS collection on the site, enumerated at connect time (Phase 2). The static
  // `post` base keeps `basePostKind('webflow')` and legacy-config migration sane
  // until collection-driven kinds land.
  webflow: ['post'],
};

/** The base post kind for a platform — what a legacy target (no explicit
 *  `contentKinds`) migrates to so existing post sync keeps working. */
export function basePostKind(platform: Platform): ContentKind {
  return PLATFORM_KINDS[platform][0];
}

/** Whether a content kind is valid for a platform. Platforms with a fixed kind
 *  set match against `PLATFORM_KINDS`; platforms with dynamic kinds (Webflow —
 *  one `webflow:<collectionSlug>` per CMS collection) accept any kind carrying
 *  their prefix, since the real set is the live site's collections and can't be
 *  enumerated statically. Without this, dynamic kinds would be filtered out on
 *  config load and the target would silently sync nothing. */
export function isContentKindAllowed(platform: Platform, kind: ContentKind): boolean {
  if ((PLATFORM_KINDS[platform] ?? []).includes(kind)) return true;
  if (platform === 'webflow') return String(kind).startsWith('webflow:');
  return false;
}

/** Normalize a target's `contentKinds`:
 *  - present (incl. empty `[]`, meaning "sync nothing") → kept as-is, filtered
 *    to kinds the platform actually supports;
 *  - absent (legacy config) → migrated to the platform's base post kind so a
 *    pre-existing target keeps syncing posts and never silently goes dark.
 *  Brand-new targets are created with an explicit list by the add/connect
 *  flows, so they never hit the legacy branch. */
function normalizeContentKinds(target: TargetConfig): ContentKind[] {
  const platform = target.adapter.platform;
  if (Array.isArray(target.contentKinds)) {
    return target.contentKinds.filter((k) => isContentKindAllowed(platform, k));
  }
  return [basePostKind(platform)];
}

/**
 * Return a populated `targets[]`. If the config on disk has no targets
 * (every shipped v0.3.x user), synthesize a single Ghost target from the
 * legacy flat fields. Returns an empty list if neither targets nor legacy
 * Ghost credentials are present — caller decides whether that's fatal.
 *
 * Also backfills each target's `contentKinds` (legacy targets → base post
 * kind) so the engine always sees an explicit per-target kind list.
 */
function normalizeTargets(
  raw: TargetConfig[] | undefined,
  fallback: GhostSyncSettings,
): TargetConfig[] {
  const targets = raw && raw.length > 0 ? raw : [];
  if (targets.length === 0) {
    if (!fallback.ghostUrl || !fallback.adminApiKey) return [];
    return [synthesizeLegacyTarget(fallback)];
  }
  return targets.map((t) => ({ ...t, contentKinds: normalizeContentKinds(t) }));
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
    // Legacy single-Ghost installs synced posts — preserve exactly that.
    contentKinds: ['post'],
    adapter: {
      platform: 'ghost',
      ghostUrl: settings.ghostUrl,
      adminApiKey: settings.adminApiKey,
    },
  };
}

/**
 * Allowed handle format: starts with a lowercase letter or digit, then
 * lowercase letters, digits, and hyphens. A target's handle is also its folder
 * name in multi-target vaults, so it must be URL- and path-safe (no slashes,
 * dots, spaces, or `..`).
 */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Turn an arbitrary string (a label, host, or shop domain) into a handle that
 * satisfies `HANDLE_RE`. Strips any URL scheme, lowercases, collapses runs of
 * non-alphanumerics to single hyphens, and trims leading/trailing hyphens.
 * Falls back to `'target'` if nothing usable remains.
 */
export function slugifyHandle(input: string): string {
  const noProto = input.replace(/^[a-z]+:\/\//i, '');
  const slug = noProto
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'target';
}

/**
 * Return a handle based on `base` that does not collide with any in `taken`.
 * Appends `-2`, `-3`, … until unique. `base` is slugified first so callers can
 * pass a raw label/host.
 */
export function ensureUniqueHandle(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const root = slugifyHandle(base);
  let candidate = root;
  let n = 2;
  while (set.has(candidate)) {
    candidate = `${root}-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * Derive a sensible default handle base for a target from its adapter — the
 * CMS host/shop is more recognisable than the platform name and naturally
 * distinguishes two blogs of the same platform.
 */
export function defaultHandleBase(adapter: AdapterConfig): string {
  switch (adapter.platform) {
    case 'ghost':
      return adapter.ghostUrl || 'ghost';
    case 'wordpress':
      return adapter.siteUrl || 'wordpress';
    case 'shopify':
      return adapter.shop || 'shopify';
    case 'webflow':
      return adapter.siteId || 'webflow';
    default:
      return 'target';
  }
}

/**
 * Validate the multi-target invariants the engine relies on. Throws a
 * descriptive Error on the first violation. Enforced by `saveConfig` (never
 * write a broken config) and `requireConfig` (never run against one):
 *  - every handle matches `HANDLE_RE`,
 *  - handles are unique,
 *  - no two targets resolve to the same effective sync folder.
 */
export function validateTargets(targets: TargetConfig[]): void {
  const seenHandles = new Set<string>();
  const rootOwner = new Map<string, string>();
  for (const t of targets) {
    if (!t.handle || !HANDLE_RE.test(t.handle)) {
      throw new Error(
        `Invalid target handle ${JSON.stringify(t.handle)}. Handles must be lowercase letters, digits, and hyphens (e.g. "my-blog").`,
      );
    }
    if (seenHandles.has(t.handle)) {
      throw new Error(
        `Duplicate target handle "${t.handle}". Each target needs a unique handle.`,
      );
    }
    seenHandles.add(t.handle);
    const root = effectiveRoot(t);
    const prior = rootOwner.get(root);
    if (prior !== undefined) {
      throw new Error(
        `Targets "${prior}" and "${t.handle}" both resolve to the same sync folder ${JSON.stringify(root || '<vault root>')}. Give them distinct handles or syncFolderPaths.`,
      );
    }
    rootOwner.set(root, t.handle);
  }
}

/**
 * Insert or replace a target in `targets` by handle, returning a new array
 * (does not mutate the input). If a target with the same handle exists it is
 * replaced in place; otherwise the target is appended. Validates the result so
 * callers can't produce a colliding list.
 */
export function upsertTarget(
  targets: TargetConfig[],
  target: TargetConfig,
): TargetConfig[] {
  const idx = targets.findIndex((t) => t.handle === target.handle);
  const next =
    idx === -1
      ? [...targets, target]
      : targets.map((t, i) => (i === idx ? target : t));
  validateTargets(next);
  return next;
}

/** Remove the target with `handle`, returning a new array. Throws if no
 *  target matches so callers surface a clear "no such target" error. */
export function removeTarget(
  targets: TargetConfig[],
  handle: string,
): TargetConfig[] {
  const next = targets.filter((t) => t.handle !== handle);
  if (next.length === targets.length) {
    throw new Error(`No target with handle "${handle}".`);
  }
  return next;
}

export async function saveConfig(config: DaemonConfig): Promise<void> {
  validateTargets(config.targets);
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
  // Catches hand-edited configs with duplicate/invalid handles or colliding
  // folders before any sync work touches disk.
  validateTargets(config.targets);
  return config;
}
