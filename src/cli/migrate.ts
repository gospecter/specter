import { loadConfig, requireConfig } from '../config.js';
import { migrateVaultLayout } from '../sync/migrate.js';

interface MigrateCommandOptions {
  dryRun?: boolean;
  json?: boolean;
}

/**
 * `ghost-sync migrate` — bring a legacy vault up to the namespaced layout.
 *
 * Normally runs automatically on `watch` startup; this surfaces it for manual
 * use and for previewing with `--dry-run`. Idempotent: a no-op once the config
 * is stamped `vaultLayout: 'namespaced'`.
 */
export async function migrateCommand(options: MigrateCommandOptions): Promise<void> {
  const config = requireConfig(await loadConfig());
  const result = await migrateVaultLayout(config, {
    dryRun: options.dryRun ?? false,
    log: (m) => {
      if (!options.json) console.log(`[ghost-sync] ${m}`);
    },
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (result.moves.length === 0) {
    console.log('Nothing to migrate — vault layout is already namespaced.');
    return;
  }
  const verb = options.dryRun ? 'Would move' : 'Moved';
  console.log(`${verb} ${result.moves.length} file(s) into handle folder(s).`);
  if (result.skipped.length > 0) {
    console.log(`Left ${result.skipped.length} unmanaged root file(s) in place.`);
  }
  if (result.backupDir) {
    console.log(`Backup: ${result.backupDir}`);
  }
}
