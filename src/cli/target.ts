/**
 * `ghost-sync target …` — manage the list of sync targets (CMS connections).
 *
 * The engine has always been multi-target; this is the user-facing surface for
 * it. Each subcommand mutates `config.targets[]` non-destructively and re-saves
 * (saveConfig validates handle uniqueness + folder isolation):
 *
 *   target add      interactively add a new connection (any platform, repeatable)
 *   target list     show every configured target + its handle/platform/folder
 *   target remove   delete a target by handle
 *   target edit     update an existing target's credentials/settings
 */

import { Command } from 'commander';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  TargetConfig,
  configPath,
  defaultHandleBase,
  ensureUniqueHandle,
  loadConfig,
  removeTarget,
  saveConfig,
  slugifyHandle,
  upsertTarget,
} from '../config.js';
import { effectiveRoot } from '../sync/targets.js';
import {
  Ask,
  availableContentKinds,
  promptAdapter,
  promptContentKinds,
  promptPlatform,
  promptTargetSettings,
} from './target-prompt.js';

function makeAsk(rl: readline.Interface): Ask {
  return async (question: string, fallback: string): Promise<string> => {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  };
}

export async function targetAddCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('No config yet. Run `ghost-sync init` first to set up your vault.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = makeAsk(rl);
  try {
    const platform = await promptPlatform(ask);
    const adapter = await promptAdapter(ask, platform);

    const existingHandles = config.targets.map((t) => t.handle);
    const labelDefault = platform.charAt(0).toUpperCase() + platform.slice(1);
    const willBeMulti = config.targets.length + 1 > 1;
    const settings = await promptTargetSettings(
      ask,
      {
        label: labelDefault,
        syncFolderPath: '',
        pullDrafts: true,
        pullPublished: true,
        conflictStrategy: 'ask',
        syncMode: 'auto',
      },
      willBeMulti,
    );

    // Prefer a handle derived from the host/shop (distinguishes two blogs of
    // the same platform), but let the user override. Always uniquified.
    const handleBase = await ask(
      'Handle (URL-safe id + folder name)',
      slugifyHandle(settings.label || defaultHandleBase(adapter)),
    );
    const handle = ensureUniqueHandle(handleBase, existingHandles);

    const available = await availableContentKinds(adapter);
    const contentKinds = await promptContentKinds(ask, platform, [], available);

    const target: TargetConfig = { handle, ...settings, contentKinds, adapter };
    config.targets = upsertTarget(config.targets, target);
    await saveConfig(config);

    console.log(`\nAdded target "${handle}" (${platform}).`);
    console.log(`Folder: ${effectiveRoot(target, config.targets.length > 1) || '<vault root>'}`);
    console.log(`Run \`ghost-sync sync --target ${handle}\` to verify.`);
  } finally {
    rl.close();
  }
}

export async function targetListCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config || config.targets.length === 0) {
    console.log('No targets configured. Run `ghost-sync init` or `ghost-sync target add`.');
    return;
  }
  const isMulti = config.targets.length > 1;
  console.log(`Targets (${config.targets.length}):`);
  for (const t of config.targets) {
    const root = effectiveRoot(t, isMulti) || '<vault root>';
    console.log(`  • ${t.handle}  [${t.adapter.platform}]  "${t.label}"`);
    console.log(`      folder: ${root}   mode: ${t.syncMode}`);
  }
}

export async function targetRemoveCommand(handle: string): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('No config yet.');
    process.exit(1);
  }
  try {
    config.targets = removeTarget(config.targets, handle);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  await saveConfig(config);
  console.log(`Removed target "${handle}".`);
  console.log('Note: its files in the vault are left in place; delete them manually if you want them gone.');
}

export async function targetEditCommand(handle: string): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('No config yet.');
    process.exit(1);
  }
  const current = config.targets.find((t) => t.handle === handle);
  if (!current) {
    console.error(`No target with handle "${handle}".`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = makeAsk(rl);
  try {
    const adapter = await promptAdapter(ask, current.adapter.platform, current.adapter);
    const settings = await promptTargetSettings(
      ask,
      {
        label: current.label,
        syncFolderPath: current.syncFolderPath,
        pullDrafts: current.pullDrafts,
        pullPublished: current.pullPublished,
        conflictStrategy: current.conflictStrategy,
        syncMode: current.syncMode,
      },
      config.targets.length > 1,
    );
    const available = await availableContentKinds(adapter);
    const contentKinds = await promptContentKinds(
      ask,
      current.adapter.platform,
      current.contentKinds,
      available,
    );
    const updated: TargetConfig = { handle, ...settings, contentKinds, adapter };
    config.targets = upsertTarget(config.targets, updated);
    await saveConfig(config);
    console.log(`\nUpdated target "${handle}".`);
  } finally {
    rl.close();
  }
}

/** Register the `target` command group on the root program. */
export function registerTargetCommands(program: Command): void {
  const target = program
    .command('target')
    .description('Manage sync targets (add as many CMS connections as you like)');
  target
    .command('add')
    .description('Add a new sync target (Ghost, WordPress, or Shopify)')
    .action(targetAddCommand);
  target
    .command('list')
    .description('List all configured targets')
    .action(targetListCommand);
  target
    .command('remove <handle>')
    .description('Remove a target by handle')
    .action(targetRemoveCommand);
  target
    .command('edit <handle>')
    .description('Edit an existing target by handle')
    .action(targetEditCommand);
}
