/**
 * Platform dispatcher for autostart install/uninstall/status.
 *
 * All three functions are async and return `{ ok: boolean; message: string }`.
 * Callers (the CLI router and tests) import from here; the platform-specific
 * modules are never imported directly by callers.
 */

export interface InstallResult {
  ok: boolean;
  message: string;
}

async function getPlatformModule(): Promise<{
  install: () => Promise<InstallResult>;
  uninstall: () => Promise<InstallResult>;
  status: () => Promise<InstallResult>;
}> {
  const platform = process.platform;
  if (platform === 'darwin') {
    return import('./darwin.js');
  }
  if (platform === 'linux') {
    return import('./linux.js');
  }
  if (platform === 'win32') {
    return import('./win32.js');
  }
  throw new Error(`Unsupported platform for autostart: ${platform}`);
}

export async function install(): Promise<InstallResult> {
  const mod = await getPlatformModule();
  return mod.install();
}

export async function uninstall(): Promise<InstallResult> {
  const mod = await getPlatformModule();
  return mod.uninstall();
}

export async function status(): Promise<InstallResult> {
  const mod = await getPlatformModule();
  return mod.status();
}
