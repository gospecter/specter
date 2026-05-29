import { createAdapter } from '../cms/index.js';
import { SyncEngine } from '../sync/engine.js';
import { Vault } from '../vault.js';
import { DryRunAdapter, DryRunVault, emptyPlan, formatPlan, planSummary } from '../sync/dryrun.js';
import {
  DaemonConfig,
  DaemonState,
  QueuedConflict,
  TargetConfig,
  TargetSyncState,
  loadConfig,
  loadState,
  requireConfig,
  saveConfig,
  saveState,
  setTargetState,
} from '../config.js';
import { CmsApiError } from '../cms/types.js';
import { notify } from '../notify.js';
import { ConflictItem, PlanEntry, SyncPlan } from '../types.js';
import { recordSync, remainingFree } from '../license/gate.js';
import { FREE_TIER_LIMIT, loadLicense, rolloverIfNeeded } from '../license/state.js';
import { targetSyncSettings } from '../sync/targets.js';
import { refreshShopifyAccessToken, shopifyTokenNeedsRefresh } from '../shopify/oauth.js';

export type SyncMode = 'pull' | 'push' | 'sync';

export interface RunOutcome {
  pulled: number;
  pushed: number;
  conflicts: number;
  errors: number;
  errorMessages: string[];
}

export interface RunOptions {
  silent?: boolean;
  /** Plan instead of executing. Returns the plan; nothing is written. */
  dryRun?: boolean;
  /** Emit JSON instead of human-readable plan text. Only meaningful with dryRun. */
  json?: boolean;
  /** Limit the operation to one target by handle. Throws if no target matches. */
  target?: string;
}

/**
 * Filter `config.targets` to just the one matching `handle`, throwing if no
 * match exists. Returns the full list untouched when `handle` is undefined.
 *
 * Exported so test code can assert the selection contract without spinning
 * up the whole runOnce path.
 */
export function selectTargets(
  targets: TargetConfig[],
  handle: string | undefined,
): TargetConfig[] {
  if (!handle) return targets;
  const match = targets.find((t) => t.handle === handle);
  if (!match) throw new Error(`no target with handle "${handle}"`);
  return [match];
}

export async function runOnce(
  mode: SyncMode,
  options: RunOptions | boolean = {},
): Promise<RunOutcome | SyncPlan> {
  // Back-compat: callers used to pass a boolean for `silent`.
  const opts: RunOptions = typeof options === 'boolean' ? { silent: options } : options;

  const config = requireConfig(await loadConfig());
  // Throws "no target with handle ..." before any work happens.
  const selected = selectTargets(config.targets, opts.target);

  if (opts.dryRun) {
    const silentPlanLogs = opts.silent ?? opts.json ?? false;
    const plan = await planRun(mode, config, selected, silentPlanLogs);
    if (!opts.silent) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      } else {
        console.log(formatPlan(plan));
        console.log(`\nSummary: ${planSummary(plan)}`);
      }
    }
    return plan;
  }

  return executeRun(mode, config, selected, opts.silent ?? false);
}

async function planRun(
  mode: SyncMode,
  config: DaemonConfig,
  selected: TargetConfig[] = config.targets,
  silent: boolean = false,
): Promise<SyncPlan> {
  const plan = emptyPlan(mode);
  // Routing/folder layout reflects the FULL config — picking one target via
  // `--target` doesn't collapse a multi-target vault to flat layout.
  const isMulti = config.targets.length > 1;
  const skippedHandles = config.targets
    .filter((t) => !selected.includes(t))
    .map((t) => t.handle);
  if (skippedHandles.length > 0 && !silent) {
    console.log(`[ghost-sync] skipping targets: ${skippedHandles.join(', ')}`);
  }

  for (const target of selected) {
    const activeTarget = await refreshShopifyTargetIfNeeded(config, target);
    const settings = targetSyncSettings(activeTarget, isMulti);
    const vault = new DryRunVault(config.vaultPath, plan);
    const realAdapter = createAdapter(activeTarget.adapter);
    const adapter = new DryRunAdapter(realAdapter, plan);
    const engine = new SyncEngine(vault, adapter, settings);

    try {
      if (mode === 'pull' || mode === 'sync') {
        const r = await engine.pull();
        mergeNonMutating(plan, 'pull', r.skipped, r.conflicts, r.errors.map((e) => ({
          title: e.post.title,
          details: e.error,
          ghostId: e.post.id,
        })));
      }
      if (mode === 'push' || mode === 'sync') {
        const r = await engine.push();
        mergeNonMutating(plan, 'push', r.skipped, r.conflicts, r.errors.map((e) => ({
          title: e.file.basename,
          details: e.error,
          localPath: e.file.path,
        })));
      }
    } catch (err) {
      plan.errors.push({
        side: 'remote',
        title: isMulti ? `[${target.handle}]` : '',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return plan;
}

/** Merge engine-decided categories (skips/conflicts/errors) into the plan.
 *  Creates/updates/deletes come from the proxy adapters and are already in `plan`. */
function mergeNonMutating(
  plan: SyncPlan,
  direction: 'pull' | 'push',
  skipped: string[],
  conflicts: ConflictItem[],
  errors: Array<{ title: string; details: string; ghostId?: string; localPath?: string }>,
): void {
  for (const title of skipped) {
    plan.skips.push({ side: direction === 'pull' ? 'remote' : 'local', title });
  }
  for (const c of conflicts) {
    const entry: PlanEntry = {
      side: direction === 'pull' ? 'local' : 'remote',
      title: c.localPost.title || c.localPost.file.basename,
      localPath: c.localPost.file.path,
      details: `conflict: ${c.type}`,
    };
    if (c.ghostPost?.id) entry.ghostId = c.ghostPost.id;
    plan.conflicts.push(entry);
  }
  for (const e of errors) {
    const entry: PlanEntry = {
      side: direction === 'pull' ? 'remote' : 'local',
      title: e.title,
      details: e.details,
    };
    if (e.ghostId) entry.ghostId = e.ghostId;
    if (e.localPath) entry.localPath = e.localPath;
    plan.errors.push(entry);
  }
}

interface TargetOutcome {
  target: TargetConfig;
  pulled: number;
  pushed: number;
  deferred: number;
  conflicts: ConflictItem[];
  errorMessages: string[];
}

function emptyTargetOutcome(target: TargetConfig): TargetOutcome {
  return {
    target,
    pulled: 0,
    pushed: 0,
    deferred: 0,
    conflicts: [],
    errorMessages: [],
  };
}

function recordTargetError(
  outcome: TargetOutcome,
  err: unknown,
  mode: SyncMode,
  isMulti: boolean,
): void {
  const message = err instanceof Error ? err.message : String(err);
  outcome.errorMessages.push(
    `${isMulti ? `[${outcome.target.handle}] ` : ''}${mode}: ${message}`,
  );
}

function canRetryShopifyAuth(
  err: unknown,
  target: TargetConfig,
  outcome: TargetOutcome,
): boolean {
  if (target.adapter.platform !== 'shopify') return false;
  if (!target.adapter.refreshToken) return false;
  if (!(err instanceof CmsApiError) || !err.isAuthError()) return false;
  // Retrying a target that already mutated local/remote state would make the
  // counters misleading. Shopify auth failures happen before mutations in
  // normal use, so keep the retry conservative.
  return (
    outcome.pulled === 0 &&
    outcome.pushed === 0 &&
    outcome.deferred === 0 &&
    outcome.conflicts.length === 0 &&
    outcome.errorMessages.length === 0
  );
}

async function refreshShopifyTargetIfNeeded(
  config: DaemonConfig,
  target: TargetConfig,
): Promise<TargetConfig> {
  if (target.adapter.platform !== 'shopify') return target;
  if (!shopifyTokenNeedsRefresh(target.adapter)) return target;
  return refreshShopifyTarget(config, target);
}

async function refreshShopifyTarget(
  config: DaemonConfig,
  target: TargetConfig,
): Promise<TargetConfig> {
  if (target.adapter.platform !== 'shopify') return target;
  const adapter = await refreshShopifyAccessToken(target.adapter);
  const refreshedTarget: TargetConfig = { ...target, adapter };
  const targets = config.targets.map((candidate) =>
    candidate.handle === target.handle ? refreshedTarget : candidate,
  );
  config.targets = targets;
  await saveConfig({ ...config, targets });
  return refreshedTarget;
}

async function executeRun(
  mode: SyncMode,
  config: DaemonConfig,
  selected: TargetConfig[],
  silent: boolean,
): Promise<RunOutcome> {
  const isMulti = config.targets.length > 1;
  const skippedHandles = config.targets
    .filter((t) => !selected.includes(t))
    .map((t) => t.handle);
  if (skippedHandles.length > 0 && !silent) {
    console.log(`[ghost-sync] skipping targets: ${skippedHandles.join(', ')}`);
  }
  const license = rolloverIfNeeded(await loadLicense());
  const isPro = license.tier === 'pro';

  let pulled = 0;
  let pushed = 0;
  let deferred = 0;
  const conflicts: ConflictItem[] = [];
  const errorMessages: string[] = [];
  const perTarget: TargetOutcome[] = [];
  let limitMessage: string | null = null;

  // No-headroom short-circuit: free user with cap=0 wants to push. Compute
  // the would-be push across all targets in one go via the existing planner,
  // then short-circuit without ever invoking engine.push().
  if (!isPro && (mode === 'push' || mode === 'sync') && remainingFree(license) === 0) {
    try {
      const pushPlan = await planRun('push', config, selected, true);
      const wouldUpload = pushPlan.creates.length + pushPlan.updates.length;
      if (wouldUpload > 0) {
        limitMessage = freeLimitMessage(license.syncCount, wouldUpload);
        deferred = wouldUpload;
      }
    } catch {
      // If even planning fails, fall through — we'll surface the underlying
      // error from the normal path below.
    }
  }

  try {
    for (const target of selected) {
      let activeTarget = target;
      let settings = targetSyncSettings(activeTarget, isMulti);
      let adapter = createAdapter(activeTarget.adapter);
      let engine = new SyncEngine(new Vault(config.vaultPath), adapter, settings);
      let outcome = emptyTargetOutcome(activeTarget);

      async function rebuildAfterShopifyRefresh(): Promise<void> {
        activeTarget = await refreshShopifyTarget(config, activeTarget);
        settings = targetSyncSettings(activeTarget, isMulti);
        adapter = createAdapter(activeTarget.adapter);
        engine = new SyncEngine(new Vault(config.vaultPath), adapter, settings);
        outcome = emptyTargetOutcome(activeTarget);
      }

      async function runTargetOperations(): Promise<void> {
        if (activeTarget.adapter.platform === 'shopify' && shopifyTokenNeedsRefresh(activeTarget.adapter)) {
          await rebuildAfterShopifyRefresh();
        }

        // Pull is unlimited on every tier.
        if (mode === 'pull' || mode === 'sync') {
          const r = await engine.pull();
          outcome.pulled = r.created.length + r.updated.length;
          outcome.conflicts.push(...r.conflicts);
          for (const e of r.errors) {
            outcome.errorMessages.push(
              `${isMulti ? `[${target.handle}] ` : ''}pull: ${e.post.title}: ${e.error}`,
            );
          }
        }

        // Push is gated by the shared free-tier cap. Compute headroom on each
        // pass so earlier targets don't starve later ones — the cap is shared.
        if ((mode === 'push' || mode === 'sync') && !limitMessage) {
          const cap = isPro
            ? undefined
            : Math.max(0, remainingFree(license) - pushed);
          if (cap === 0 && !isPro) {
            // Plan just this target to know how many would have been deferred.
            // Cheap because planning reuses live reads.
            const pp = emptyPlan('push');
            const dryAdapter = new DryRunAdapter(adapter, pp);
            const dryEngine = new SyncEngine(new DryRunVault(config.vaultPath, pp), dryAdapter, settings);
            await dryEngine.push();
            outcome.deferred = pp.creates.length + pp.updates.length;
          } else {
            const r = await engine.push(cap);
            outcome.pushed = r.created.length + r.updated.length;
            outcome.deferred = r.deferred.length;
            outcome.conflicts.push(...r.conflicts);
            for (const e of r.errors) {
              outcome.errorMessages.push(
                `${isMulti ? `[${target.handle}] ` : ''}push: ${e.file.path}: ${e.error}`,
              );
            }
          }
        }
      }

      // Per-target try/catch is what makes failed targets surface in the
      // Dashboard's per-card state. Without it, a thrown auth error (e.g.
      // Shopify HTTP 403) aborts the loop before `writeTargetState` fires
      // for the failing target AND prevents subsequent targets from
      // running at all. Catch here, record the error into outcome +
      // global errorMessages, and continue with remaining targets so
      // Ghost still syncs even if Shopify is down.
      try {
        await runTargetOperations();
      } catch (err) {
        if (canRetryShopifyAuth(err, activeTarget, outcome)) {
          try {
            await rebuildAfterShopifyRefresh();
            await runTargetOperations();
          } catch (retryErr) {
            recordTargetError(outcome, retryErr, mode, isMulti);
          }
        } else {
          // Capture the thrown error into the per-target outcome so the
          // Dashboard card surfaces `status: 'error'` + `lastError` instead
          // of staying blank. Don't re-throw — let other targets continue.
          recordTargetError(outcome, err, mode, isMulti);
        }
      }

      perTarget.push(outcome);
      pulled += outcome.pulled;
      pushed += outcome.pushed;
      deferred += outcome.deferred;
      conflicts.push(...outcome.conflicts);
      errorMessages.push(...outcome.errorMessages);

      // Per-target state.json write — happens after each target's ops finish
      // (success OR failure) so the Dashboard's 5s poll sees per-card
      // progress live across a multi-target run, rather than only seeing
      // the final aggregate.
      await writeTargetState(activeTarget.handle, outcome, mode);
    }

    if (!isPro && deferred > 0 && !limitMessage) {
      limitMessage = freeLimitMessage(license.syncCount + pushed, deferred);
    }

    // Counter increment AFTER the operation succeeded. Only uploads (pushes)
    // count against the free-tier cap — pulls are unlimited.
    if (pushed > 0) {
      await recordSync(pushed);
    }

    // Pure-push no-headroom: surface as a thrown error so the menu bar app
    // shows the upgrade prompt instead of an "ok" silent no-op.
    if (mode === 'push' && limitMessage && pushed === 0 && deferred > 0) {
      throw new Error(limitMessage);
    }

    const status: DaemonState['lastSyncStatus'] =
      errorMessages.length > 0 || limitMessage
        ? 'error'
        : conflicts.length > 0
          ? 'conflict'
          : 'ok';

    let message = summary(pulled, pushed, conflicts.length, errorMessages.length, deferred);
    if (limitMessage) message += ` — ${limitMessage}`;
    const prior = await loadState();
    const queuedConflicts = queueConflicts(prior.conflicts, perTarget);
    await saveState({
      ...prior,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: status,
      lastSyncMessage: message,
      lastPulled: pulled,
      lastPushed: pushed,
      lastConflicts: conflicts.length,
      lastErrors: errorMessages.length,
      conflicts: queuedConflicts,
    });

    if (!silent) {
      console.log(`[ghost-sync] ${message}`);
      if (errorMessages.length > 0) {
        for (const m of errorMessages) console.error(`  ! ${m}`);
      }
    }
    if (
      !silent &&
      (pulled > 0 || pushed > 0 || errorMessages.length > 0 || conflicts.length > 0 || limitMessage)
    ) {
      notify('Specter', message, mode);
    }

    return {
      pulled,
      pushed,
      conflicts: conflicts.length,
      errors: errorMessages.length,
      errorMessages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prior = await loadState();
    await saveState({
      ...prior,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'error',
      lastSyncMessage: message,
    });
    notify('Specter failed', message);
    if (!silent) console.error(`[ghost-sync] failed: ${message}`);
    throw err;
  }
}

function summary(
  pulled: number,
  pushed: number,
  conflicts: number,
  errors: number,
  deferred: number = 0,
): string {
  const parts: string[] = [];
  parts.push(`pulled ${pulled}`);
  parts.push(`pushed ${pushed}`);
  if (deferred > 0) parts.push(`deferred ${deferred}`);
  if (conflicts > 0) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function freeLimitMessage(used: number, deferredCount: number): string {
  return (
    `Free tier upload limit reached (${used}/${FREE_TIER_LIMIT} this month). ` +
    `${deferredCount} post${deferredCount === 1 ? '' : 's'} deferred. ` +
    `Upgrade to Specter Pro for unlimited uploads.`
  );
}

function queueConflicts(
  existing: QueuedConflict[],
  perTarget: TargetOutcome[],
): QueuedConflict[] {
  const queued = [...existing];
  const seen = new Set(queued.map(conflictKey));
  for (const { target, conflicts } of perTarget) {
    for (const conflict of conflicts) {
      const id = conflictKey(conflict);
      if (seen.has(id)) continue;
      queued.push({
        ...conflict,
        id,
        createdAt: new Date().toISOString(),
        targetHandle: target.handle,
      });
      seen.add(id);
    }
  }
  return queued;
}

function conflictKey(conflict: ConflictItem): string {
  return conflict.localPost.frontmatter.ghost_id || conflict.ghostPost?.id || conflict.localPost.file.path;
}

/**
 * Derive the per-target outcome status from raw counts: `error` if any error
 * or unresolved conflict, `partial` if it was a `sync` run that had at least
 * one direction succeed alongside an error/conflict, otherwise `ok`. Always
 * returns a concrete status (never `null`) because we only call this after a
 * per-target operation has run.
 */
function deriveTargetStatus(outcome: TargetOutcome, mode: SyncMode): TargetSyncState['lastSyncStatus'] {
  const hadFailure = outcome.errorMessages.length > 0 || outcome.conflicts.length > 0;
  if (!hadFailure) return 'ok';
  // For a full sync, a mix of success on one side and failure on the other
  // is partial rather than total error.
  if (mode === 'sync' && (outcome.pulled > 0 || outcome.pushed > 0)) return 'partial';
  return 'error';
}

/** Write the per-target slice into `state.targets[handle]`. Reads → mutates →
 *  saves; safe under repeated calls because writes are sequential within one
 *  run. */
async function writeTargetState(
  handle: string,
  outcome: TargetOutcome,
  mode: SyncMode,
): Promise<void> {
  const prior = await loadState();
  const entry: TargetSyncState = {
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: deriveTargetStatus(outcome, mode),
    lastPullCount: outcome.pulled,
    lastPushCount: outcome.pushed,
    lastConflicts: outcome.conflicts.length,
    lastError: outcome.errorMessages[0] ?? null,
  };
  await saveState(setTargetState(prior, handle, entry));
}
