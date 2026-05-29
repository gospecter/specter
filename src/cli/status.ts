import { configPath, loadConfig, loadState, logPath, statePath } from '../config.js';

export async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  const state = await loadState();

  console.log('Specter');
  console.log('----------');
  console.log(`Config:   ${configPath()}`);
  console.log(`State:    ${statePath()}`);
  console.log(`Log:      ${logPath()}`);

  if (!config) {
    console.log('\nNo config yet. Run: ghost-sync init');
    return;
  }

  console.log('');
  console.log(`Ghost URL:     ${config.ghostUrl}`);
  console.log(`Vault root:    ${config.vaultPath}`);
  console.log(`Sync folder:   ${config.syncFolderPath}`);
  console.log(`Conflict:      ${config.conflictStrategy}`);
  console.log(`Pull drafts:   ${config.pullDrafts}`);
  console.log(`Pull pub'd:    ${config.pullPublished}`);

  console.log('');
  console.log(`Last sync:     ${state.lastSyncAt ?? 'never'}`);
  console.log(`Status:        ${state.lastSyncStatus}`);
  if (state.lastSyncMessage) {
    console.log(`Message:       ${state.lastSyncMessage}`);
  }
}
