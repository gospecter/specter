import { Command } from 'commander';
import { initCommand } from './init.js';
import { runOnce } from './run.js';
import { watchCommand } from './watch.js';
import { statusCommand } from './status.js';
import { installCommand, uninstallCommand } from './install.js';
import { resolveCommand } from './resolve.js';
import { testCommand } from './test.js';
import { kindsCommand } from './kinds.js';
import { registerTargetCommands } from './target.js';
import {
  activateCommand as licenseActivate,
  deactivateCommand as licenseDeactivate,
  statusCommand as licenseStatus,
} from './license.js';
import { recordBinaryPaths } from '../config.js';

export async function main(): Promise<void> {
  await recordBinaryPaths();
  const program = new Command();

  program
    .name('ghost-sync')
    .description('Standalone Ghost ↔ local markdown sync daemon')
    .version('0.2.0');

  program
    .command('init')
    .description('Create or update the config file (carries over the Obsidian plugin settings)')
    .option('--from-obsidian <path>', 'Path to an existing Obsidian plugin data.json to import')
    .option('--vault <path>', 'Absolute path to the vault root')
    .action(initCommand);

  // Shared sync flags — pull/push/sync all support dry-run with optional JSON
  // plus an optional `--target <handle>` to scope the operation to one target.
  const syncOpts = (cmd: Command) =>
    cmd
      .option('--dry-run', 'Plan changes without touching disk or Ghost')
      .option('--json', 'Emit machine-readable JSON (only with --dry-run)')
      .option(
        '--target <handle>',
        'Operate only on the target with this handle (default: all targets)',
      );

  syncOpts(
    program
      .command('pull')
      .description('Pull all posts from Ghost into the sync folder'),
  ).action(async (options) => {
    await runOnce('pull', {
      dryRun: options.dryRun,
      json: options.json,
      target: options.target,
    });
  });

  syncOpts(
    program
      .command('push')
      .description('Push local changes to Ghost'),
  ).action(async (options) => {
    await runOnce('push', {
      dryRun: options.dryRun,
      json: options.json,
      target: options.target,
    });
  });

  syncOpts(
    program
      .command('sync')
      .description('Full bi-directional sync'),
  ).action(async (options) => {
    await runOnce('sync', {
      dryRun: options.dryRun,
      json: options.json,
      target: options.target,
    });
  });

  program
    .command('watch')
    .description('Watch the sync folder and push changes; runs a periodic full sync')
    .option('--interval <minutes>', 'Periodic full-sync interval in minutes', '10')
    .action(watchCommand);

  program
    .command('status')
    .description('Show last sync time, status, and config path')
    .action(statusCommand);

  registerTargetCommands(program);

  program
    .command('test')
    .description('Test connection to a CMS (Ghost, Shopify, WordPress, Webflow)')
    .option('--platform <platform>', 'Platform for ad-hoc check: ghost | wordpress | shopify | webflow')
    .option('--url <url>', 'Ghost URL to test')
    .option('--key <key>', 'Ghost Admin API key to test')
    .option('--site-url <url>', 'WordPress site URL (with --platform wordpress)')
    .option('--username <username>', 'WordPress username (with --platform wordpress)')
    .option('--app-password <password>', 'WordPress Application Password (with --platform wordpress)')
    .option('--shop <shop>', 'Shopify store domain (with --platform shopify)')
    .option('--access-token <token>', 'Shopify Admin Access Token (with --platform shopify)')
    .option('--api-version <version>', 'Shopify API Version (with --platform shopify)')
    .option('--site-id <id>', 'Webflow site ID (with --platform webflow)')
    .option('--api-token <token>', 'Webflow site API token or OAuth token (with --platform webflow)')
    .option('--target <handle>', 'Test a specific saved target by handle')
    .option('--json', 'Emit JSON result for machine consumption')
    .action(testCommand);

  program
    .command('kinds')
    .description('List content kinds for a platform (Webflow: live CMS collections)')
    .option('--platform <platform>', 'Platform: ghost | wordpress | shopify | webflow')
    .option('--site-id <id>', 'Webflow site ID (with --platform webflow)')
    .option('--api-token <token>', 'Webflow site API token or OAuth token (with --platform webflow)')
    .option('--json', 'Emit JSON result for machine consumption')
    .action(kindsCommand);

  program
    .command('resolve')
    .description('Resolve a queued conflict')
    .requiredOption('--id <conflict_id>', 'Queued conflict id from state.json')
    .requiredOption('--keep <local|remote>', 'Which side should win')
    .action(resolveCommand);

  const license = program.command('license').description('Manage the Specter Pro license');
  license
    .command('activate [key]')
    .description('Activate a SpecterSync Pro license key on this machine')
    .option('--key <key>', 'License key (alternative to positional arg)')
    .option('--json', 'Emit machine-readable JSON')
    .action(licenseActivate);
  license
    .command('status')
    .description('Show current license tier + monthly sync usage')
    .option('--json', 'Emit machine-readable JSON')
    .action(licenseStatus);
  license
    .command('deactivate')
    .description('Release this machine\'s activation slot')
    .option('--json', 'Emit machine-readable JSON')
    .action(licenseDeactivate);

  program
    .command('install')
    .description('Install the launchd LaunchAgent so the watcher runs in the background')
    .action(installCommand);

  program
    .command('uninstall')
    .description('Remove the launchd LaunchAgent')
    .action(uninstallCommand);

  await program.parseAsync(process.argv);
}
