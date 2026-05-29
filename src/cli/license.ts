import { FREE_TIER_LIMIT, LicenseState, loadLicense } from '../license/state.js';

interface CommonOpts {
  json?: boolean;
}

interface ActivateOpts extends CommonOpts {
  key?: string;
}

function emit(opts: CommonOpts, payload: Record<string, unknown>, exitCode = 0): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    for (const [k, v] of Object.entries(payload)) console.log(`${k}: ${v}`);
  }
  process.exit(exitCode);
}

export async function activateCommand(_keyArg: string | undefined, options: ActivateOpts): Promise<void> {
  emit(options, {
    ok: false,
    error: 'Official license activation is only available in official paid SpecterSync binaries.',
  }, 1);
}

export async function statusCommand(options: CommonOpts): Promise<void> {
  const state = await loadLicense();
  emit(options, {
    ok: true,
    tier: 'source',
    key: null,
    activatedAt: null,
    lastValidatedAt: null,
    proActiveOffline: true,
    monthBucket: state.monthBucket,
    syncCount: 0,
    freeLimit: FREE_TIER_LIMIT,
    remainingFree: null,
    message: 'Public AGPL source build: official binary activation is not included.',
  });
}

export async function deactivateCommand(options: CommonOpts): Promise<void> {
  emit(options, { ok: true, tier: 'source' });
}

export async function revalidateInternal(): Promise<LicenseState> {
  return loadLicense();
}
