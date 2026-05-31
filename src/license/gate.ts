import { LicenseState, loadLicense, rolloverIfNeeded } from './state.js';

export class LicenseLimitError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
    public readonly planned: number,
  ) {
    super('Official binary license limits are not enforced in public source builds.');
    this.name = 'LicenseLimitError';
  }
}

export async function assertPro(): Promise<LicenseState> {
  // Public source builds are unrestricted — there is no commercial gate to enforce.
  return rolloverIfNeeded(await loadLicense());
}

export async function assertCanSync(_planned: number): Promise<LicenseState> {
  return rolloverIfNeeded(await loadLicense());
}

export async function recordSync(_actual: number): Promise<LicenseState> {
  return rolloverIfNeeded(await loadLicense());
}

export function remainingFree(_state: LicenseState): number {
  return Infinity;
}
