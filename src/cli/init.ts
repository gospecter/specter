import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEFAULT_SETTINGS } from '../types.js';
import {
  DaemonConfig,
  TargetConfig,
  configPath,
  defaultHandleBase,
  ensureUniqueHandle,
  loadConfig,
  saveConfig,
  upsertTarget,
} from '../config.js';
import {
  Ask,
  availableContentKinds,
  promptAdapter,
  promptContentKinds,
  promptPlatform,
} from './target-prompt.js';

interface InitOptions {
  fromObsidian?: string;
  vault?: string;
}

interface ObsidianData {
  ghostUrl?: string;
  adminApiKey?: string;
  syncFolderPath?: string;
  pullDrafts?: boolean;
  pullPublished?: boolean;
  conflictStrategy?: 'ask' | 'keep_local' | 'keep_remote';
}

async function readObsidianData(filePath: string): Promise<ObsidianData | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as ObsidianData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function defaultVaultGuess(_syncFolder: string): string {
  // The user's existing setup stores the sync folder under the Obsidian vault
  // at /Users/<name>/Documents/OS. We don't hardcode that here — we just pick
  // it as the most likely root and let the user override.
  return path.join(process.env.HOME || '', 'Documents', 'OS');
}

export async function initCommand(options: InitOptions): Promise<void> {
  const existing = await loadConfig();
  let imported: ObsidianData | null = null;

  if (options.fromObsidian) {
    imported = await readObsidianData(path.resolve(options.fromObsidian));
    if (!imported) {
      console.error(`No Obsidian data.json found at ${options.fromObsidian}`);
      process.exit(1);
    }
  } else if (!existing) {
    // Try the standard Obsidian plugin location relative to a guessed vault.
    const guessVault = options.vault || defaultVaultGuess(DEFAULT_SETTINGS.syncFolderPath);
    const candidate = path.join(guessVault, '.obsidian/plugins/ghost-sync/data.json');
    imported = await readObsidianData(candidate);
    if (imported) {
      console.log(`Imported settings from ${candidate}`);
    }
  }

  // init edits the PRIMARY target (targets[0]) when one exists, leaving any
  // additional targets untouched. To add more connections, use `target add`.
  const primary: TargetConfig | undefined = existing?.targets?.[0];

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask: Ask = async (q, fallback) => {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${q}${suffix}: `)).trim();
    return answer || fallback;
  };

  try {
    const platform = await promptPlatform(ask, primary?.adapter.platform ?? 'ghost');
    let adapter = await promptAdapter(
      ask,
      platform,
      primary?.adapter.platform === platform ? primary.adapter : undefined,
    );
    // For a brand-new Ghost target, seed defaults from the imported Obsidian
    // data when the user left the fields blank.
    if (
      adapter.platform === 'ghost' &&
      !primary &&
      imported &&
      (!adapter.ghostUrl || !adapter.adminApiKey)
    ) {
      adapter = {
        platform: 'ghost',
        ghostUrl: adapter.ghostUrl || imported.ghostUrl || '',
        adminApiKey: adapter.adminApiKey || imported.adminApiKey || '',
      };
    }

    const vaultPath = await ask(
      'Vault root (absolute path)',
      existing?.vaultPath || options.vault || defaultVaultGuess(DEFAULT_SETTINGS.syncFolderPath),
    );
    const syncFolderPath = await ask(
      'Sync folder (relative to vault root)',
      primary?.syncFolderPath || existing?.syncFolderPath || imported?.syncFolderPath || DEFAULT_SETTINGS.syncFolderPath,
    );
    const conflictStrategy = (await ask(
      'Conflict strategy (ask | keep_local | keep_remote)',
      primary?.conflictStrategy || existing?.conflictStrategy || imported?.conflictStrategy || 'ask',
    )) as DaemonConfig['conflictStrategy'];

    const pullDrafts = primary?.pullDrafts ?? existing?.pullDrafts ?? imported?.pullDrafts ?? true;
    const pullPublished =
      primary?.pullPublished ?? existing?.pullPublished ?? imported?.pullPublished ?? true;
    const syncMode = primary?.syncMode ?? existing?.syncMode ?? DEFAULT_SETTINGS.syncMode;
    const available = await availableContentKinds(adapter);
    const contentKinds = await promptContentKinds(
      ask,
      platform,
      primary?.contentKinds ?? [],
      available,
    );

    // Reuse the primary target's handle when editing; otherwise derive a
    // unique, host-based handle so a future `target add` of the same platform
    // never collides.
    const existingTargets = existing?.targets ?? [];
    const handle =
      primary?.handle ??
      ensureUniqueHandle(defaultHandleBase(adapter), existingTargets.map((t) => t.handle));

    const target: TargetConfig = {
      handle,
      label: primary?.label || platform.charAt(0).toUpperCase() + platform.slice(1),
      syncFolderPath,
      pullDrafts,
      pullPublished,
      conflictStrategy,
      syncMode,
      contentKinds,
      adapter,
    };

    const baseSettings = {
      // Legacy flat fields kept for one downgrade window; only meaningful for a
      // single Ghost primary target.
      ghostUrl: adapter.platform === 'ghost' ? adapter.ghostUrl : '',
      adminApiKey: adapter.platform === 'ghost' ? adapter.adminApiKey : '',
      syncFolderPath,
      pullDrafts,
      pullPublished,
      conflictStrategy,
      syncMode,
      contentKinds,
    };

    const config: DaemonConfig = {
      ...baseSettings,
      vaultPath,
      watchDebounceMs: existing?.watchDebounceMs ?? 2000,
      targets: upsertTarget(existingTargets, target),
    };

    await saveConfig(config);
    console.log(`\nWrote config to ${configPath()}`);
    if (config.targets.length > 1) {
      console.log(`This config has ${config.targets.length} targets. Use \`ghost-sync target list\` to see them.`);
    }
    console.log('Next: run `ghost-sync sync` to verify, then `ghost-sync install` for background watch.');
    console.log('Add more connections any time with `ghost-sync target add`.');
  } finally {
    rl.close();
  }
}
