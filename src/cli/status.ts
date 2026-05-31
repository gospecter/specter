import { configPath, loadConfig, loadState, logPath, statePath } from '../config.js';
import { effectiveRoot } from '../sync/targets.js';

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
  console.log(`Vault root:    ${config.vaultPath}`);
  console.log(`Targets:       ${config.targets.length}`);

  const isMulti = config.targets.length > 1;
  for (const t of config.targets) {
    const ts = state.targets?.[t.handle];
    const root = effectiveRoot(t, isMulti) || '<vault root>';
    console.log('');
    console.log(`▸ ${t.handle}  [${t.adapter.platform}]  "${t.label}"`);
    console.log(`    Folder:      ${root}`);
    console.log(`    Conflict:    ${t.conflictStrategy}   Mode: ${t.syncMode}`);
    console.log(`    Syncs:       ${t.contentKinds.length ? t.contentKinds.join(', ') : '(nothing — no content kinds enabled)'}`);
    console.log(`    Pull:        drafts=${t.pullDrafts} published=${t.pullPublished}`);
    if (ts) {
      console.log(`    Last sync:   ${ts.lastSyncAt ?? 'never'}  (${ts.lastSyncStatus ?? 'never'})`);
      console.log(`    Last counts: pulled=${ts.lastPullCount} pushed=${ts.lastPushCount} conflicts=${ts.lastConflicts}`);
      if (ts.lastError) console.log(`    Last error:  ${ts.lastError}`);
    } else {
      console.log(`    Last sync:   never`);
    }
  }

  console.log('');
  console.log('Overall');
  console.log(`    Last sync:   ${state.lastSyncAt ?? 'never'}`);
  console.log(`    Status:      ${state.lastSyncStatus}`);
  if (state.lastSyncMessage) {
    console.log(`    Message:     ${state.lastSyncMessage}`);
  }
  if (state.conflicts.length > 0) {
    console.log(`    Conflicts:   ${state.conflicts.length} queued (run \`ghost-sync resolve\`)`);
  }
}
