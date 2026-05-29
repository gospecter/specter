/**
 * Pure config-shape types and the target-merge contract.
 * Lives separately from config.ts so it can be unit-tested without dragging
 * in Electron through the paths.ts import chain.
 */

export interface AdapterConfig {
  platform: 'ghost' | 'shopify' | 'wordpress';
  // Ghost-specific
  ghostUrl?: string;
  adminApiKey?: string;
  // Shopify-specific
  shop?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  apiVersion?: string;
  // WordPress-specific
  siteUrl?: string;
  username?: string;
  appPassword?: string;
}

export interface TargetConfig {
  handle: string;
  label: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  adapter: AdapterConfig;
}

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
  targets?: TargetConfig[];
}

/** Single-target case: regenerate targets[0] from legacy fields. Multi-target
 *  case: replace targets[0] from legacy fields, preserve targets[1..N]. */
export function mergeTargetsForConfig(
  existing: TargetConfig[] | undefined,
  legacy: AppConfig,
): TargetConfig[] {
  const synthesized: TargetConfig = {
    handle: 'ghost',
    label: 'Ghost',
    syncFolderPath: legacy.syncFolderPath,
    pullDrafts: legacy.pullDrafts,
    pullPublished: legacy.pullPublished,
    conflictStrategy: legacy.conflictStrategy,
    syncMode: legacy.syncMode,
    adapter: {
      platform: 'ghost',
      ghostUrl: legacy.ghostUrl,
      adminApiKey: legacy.adminApiKey,
    },
  };
  if (!existing || existing.length === 0) return [synthesized];
  const ghostIdx = existing.findIndex((target) => target.adapter.platform === 'ghost');
  if (ghostIdx >= 0) {
    const next = [...existing];
    next[ghostIdx] = synthesized;
    return next;
  }
  return [synthesized, ...existing];
}
