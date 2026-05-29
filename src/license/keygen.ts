export class KeygenError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'KeygenError';
  }
}

function unavailable(): never {
  throw new KeygenError(
    'Official SpecterSync license activation is only available in official paid binaries.',
    'PUBLIC_SOURCE_BUILD',
  );
}

export async function activate(_licenseKey: string): Promise<never> {
  unavailable();
}

export async function deactivate(_licenseKey: string, _machineId: string): Promise<never> {
  unavailable();
}

export async function validate(_licenseKey: string, _machineId?: string): Promise<never> {
  unavailable();
}
