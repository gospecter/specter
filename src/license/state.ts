export type Tier = 'free' | 'pro';

export interface LicenseState {
  tier: Tier;
  licenseKey: string | null;
  instanceId: string | null;
  activatedAt: string | null;
  lastValidatedAt: string | null;
  monthBucket: string;
  syncCount: number;
}

export const FREE_TIER_LIMIT = Number.MAX_SAFE_INTEGER;
export const OFFLINE_GRACE_DAYS = 0;

export function currentMonthBucket(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export const DEFAULT_LICENSE_STATE: LicenseState = {
  tier: 'pro',
  licenseKey: null,
  instanceId: null,
  activatedAt: null,
  lastValidatedAt: null,
  monthBucket: currentMonthBucket(),
  syncCount: 0,
};

export function licensePath(): string {
  return 'public-source-build';
}

export async function loadLicense(): Promise<LicenseState> {
  return { ...DEFAULT_LICENSE_STATE, monthBucket: currentMonthBucket() };
}

export async function saveLicense(_state: LicenseState): Promise<void> {
  return;
}

export function rolloverIfNeeded(state: LicenseState, now: Date = new Date()): LicenseState {
  const current = currentMonthBucket(now);
  if (state.monthBucket === current) return state;
  return { ...state, monthBucket: current, syncCount: 0 };
}

export function isProActiveOffline(state: LicenseState): boolean {
  return state.tier === 'pro';
}
