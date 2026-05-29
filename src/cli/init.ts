import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEFAULT_SETTINGS } from '../types.js';
import { DaemonConfig, configPath, loadConfig, saveConfig, synthesizeLegacyTarget } from '../config.js';

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

function defaultVaultGuess(syncFolder: string): string {
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

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, fallback: string): Promise<string> => {
    const suffix = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${q}${suffix}: `)).trim();
    return answer || fallback;
  };

  try {
    const platformInput = await ask(
      'Platform to configure (ghost | wordpress | shopify)',
      existing?.targets?.[0]?.adapter?.platform || 'ghost',
    );
    const platform = platformInput.toLowerCase() as 'ghost' | 'wordpress' | 'shopify';
    if (!['ghost', 'wordpress', 'shopify'].includes(platform)) {
      console.error(`Error: Unknown platform '${platform}'. Supported platforms: ghost, wordpress, shopify`);
      process.exit(1);
    }

    let adapter: any;
    if (platform === 'ghost') {
      const ghostUrl = await ask(
        'Ghost URL (e.g. https://yourblog.ghost.io)',
        existing?.ghostUrl || imported?.ghostUrl || '',
      );
      const adminApiKey = await ask(
        'Admin API Key (id:secret)',
        existing?.adminApiKey || imported?.adminApiKey || '',
      );
      adapter = { platform: 'ghost', ghostUrl, adminApiKey };
    } else if (platform === 'wordpress') {
      const siteUrl = await ask(
        'WordPress site URL (e.g. https://yourblog.com)',
        (existing?.targets?.[0]?.adapter?.platform === 'wordpress' && (existing.targets[0].adapter as any).siteUrl) || '',
      );
      const username = await ask(
        'WordPress username',
        (existing?.targets?.[0]?.adapter?.platform === 'wordpress' && (existing.targets[0].adapter as any).username) || '',
      );
      const appPasswordRaw = await ask(
        'WordPress Application Password (24 chars)',
        (existing?.targets?.[0]?.adapter?.platform === 'wordpress' && (existing.targets[0].adapter as any).appPassword) || '',
      );
      adapter = {
        platform: 'wordpress',
        siteUrl,
        username,
        appPassword: appPasswordRaw.replace(/\s+/g, ''),
      };
    } else {
      // shopify
      const shop = await ask(
        'Shopify shop domain (e.g. your-store.myshopify.com)',
        (existing?.targets?.[0]?.adapter?.platform === 'shopify' && (existing.targets[0].adapter as any).shop) || '',
      );
      const accessToken = await ask(
        'Shopify Admin Access Token (shpat_...)',
        (existing?.targets?.[0]?.adapter?.platform === 'shopify' && (existing.targets[0].adapter as any).accessToken) || '',
      );
      const apiVersion = await ask(
        'Shopify API Version (e.g. 2024-04)',
        (existing?.targets?.[0]?.adapter?.platform === 'shopify' && (existing.targets[0].adapter as any).apiVersion) || '2024-04',
      );
      adapter = {
        platform: 'shopify',
        shop,
        accessToken,
        apiVersion,
      };
    }

    const vaultPath = await ask(
      'Vault root (absolute path)',
      existing?.vaultPath || options.vault || defaultVaultGuess(DEFAULT_SETTINGS.syncFolderPath),
    );
    const syncFolderPath = await ask(
      'Sync folder (relative to vault root)',
      existing?.syncFolderPath || imported?.syncFolderPath || DEFAULT_SETTINGS.syncFolderPath,
    );
    const conflictStrategy = (await ask(
      'Conflict strategy (ask | keep_local | keep_remote)',
      existing?.conflictStrategy || imported?.conflictStrategy || 'ask',
    )) as DaemonConfig['conflictStrategy'];

    const baseSettings = {
      ghostUrl: platform === 'ghost' ? adapter.ghostUrl : '',
      adminApiKey: platform === 'ghost' ? adapter.adminApiKey : '',
      syncFolderPath,
      pullDrafts: existing?.pullDrafts ?? imported?.pullDrafts ?? true,
      pullPublished: existing?.pullPublished ?? imported?.pullPublished ?? true,
      conflictStrategy,
      syncMode: existing?.syncMode ?? DEFAULT_SETTINGS.syncMode,
    };

    const target: any = {
      handle: platform,
      label: platform.charAt(0).toUpperCase() + platform.slice(1),
      syncFolderPath,
      pullDrafts: baseSettings.pullDrafts,
      pullPublished: baseSettings.pullPublished,
      conflictStrategy,
      syncMode: baseSettings.syncMode,
      adapter,
    };

    const config: DaemonConfig = {
      ...baseSettings,
      vaultPath,
      watchDebounceMs: existing?.watchDebounceMs ?? 2000,
      targets: [target],
    };

    await saveConfig(config);
    console.log(`\nWrote config to ${configPath()}`);
    console.log('Next: run `ghost-sync sync` to verify, then `ghost-sync install` for background watch.');
  } finally {
    rl.close();
  }
}
