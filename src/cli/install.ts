// Re-export the cross-platform install dispatcher.
// Named adapters keep the CLI router imports unchanged.
export * from './install/index.js';

import { install, uninstall } from './install/index.js';

/** Adapter so `src/cli/index.ts` can keep its existing import names. */
export async function installCommand(): Promise<void> {
  const result = await install();
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}

export async function uninstallCommand(): Promise<void> {
  const result = await uninstall();
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}
