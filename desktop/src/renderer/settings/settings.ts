/**
 * Settings renderer.
 * Mirrors SettingsView + SettingsController in Settings.swift.
 * Sections: Ghost URL/Key, Local Folder, License (inline), Sync options.
 */


const $ = (id: string) => document.getElementById(id)!;

// ── Element refs ──────────────────────────────────────────────────────────────

const ghostUrlEl = $('s-ghost-url') as HTMLInputElement;
const adminKeyEl = $('s-admin-key') as HTMLInputElement;
const testBtn = $('s-test-btn') as HTMLButtonElement;
const testSpinner = $('s-test-spinner');
const testResult = $('s-test-result');

const folderPathEl = $('s-folder-path');
const pickFolderBtn = $('s-pick-folder') as HTMLButtonElement;
const legacyNote = $('s-legacy-note');

const licenseSection = $('s-license-section');

const syncModeEl = $('s-sync-mode') as HTMLSelectElement;
const syncModeHelp = $('s-sync-mode-help');
const pullDraftsEl = $('s-pull-drafts') as HTMLInputElement;
const pullPublishedEl = $('s-pull-published') as HTMLInputElement;
const conflictEl = $('s-conflict-strategy') as HTMLSelectElement;
const conflictHelp = $('s-conflict-help');

const saveErrorEl = $('s-save-error');
const cancelBtn = $('s-cancel') as HTMLButtonElement;
const saveBtn = $('s-save') as HTMLButtonElement;

// ── Draft state ───────────────────────────────────────────────────────────────

interface Draft {
  ghostUrl: string;
  adminApiKey: string;
  vaultPath: string;
  syncFolderPath: string;
  pullDrafts: boolean;
  pullPublished: boolean;
  conflictStrategy: 'ask' | 'keep_local' | 'keep_remote';
  syncMode: 'auto' | 'manual';
  watchDebounceMs: number;
}

let draft: Draft = {
  ghostUrl: '',
  adminApiKey: '',
  vaultPath: '',
  syncFolderPath: '',
  pullDrafts: true,
  pullPublished: true,
  conflictStrategy: 'ask',
  syncMode: 'auto',
  watchDebounceMs: 2000,
};
let testPassed = true; // settings are pre-existing, allow save without re-test

function canSave(): boolean {
  return (
    draft.ghostUrl.trim().length > 0 &&
    draft.adminApiKey.trim().length > 0 &&
    draft.vaultPath.trim().length > 0
  );
}

function updateSaveEnabled(): void {
  saveBtn.disabled = !canSave();
}

// ── Ghost section ─────────────────────────────────────────────────────────────

ghostUrlEl.addEventListener('input', () => {
  draft.ghostUrl = ghostUrlEl.value;
  testPassed = false;
  clearTestResult();
  updateTestBtnState();
  updateSaveEnabled();
});

adminKeyEl.addEventListener('input', () => {
  draft.adminApiKey = adminKeyEl.value;
  testPassed = false;
  clearTestResult();
  updateTestBtnState();
  updateSaveEnabled();
});

function updateTestBtnState(): void {
  testBtn.disabled = !draft.ghostUrl.trim() || !draft.adminApiKey.trim();
}

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testSpinner.classList.remove('hidden');
  clearTestResult();
  try {
    const res = await window.api.ghost.test(
      draft.ghostUrl.trim(),
      draft.adminApiKey.trim(),
    );
    if (res.ok) {
      testPassed = true;
      showTestResult('ok', res.message ?? 'Connected');
    } else {
      testPassed = false;
      showTestResult('error', res.error ?? 'Connection failed');
    }
  } catch (e) {
    testPassed = false;
    showTestResult('error', (e as Error).message);
  } finally {
    testSpinner.classList.add('hidden');
    testBtn.disabled = false;
  }
});

function showTestResult(type: 'ok' | 'error', msg: string): void {
  testResult.className = `inline-status status-${type === 'ok' ? 'ok' : 'error'}`;
  testResult.textContent = type === 'ok' ? `✓ ${msg}` : `✕ ${msg}`;
}

function clearTestResult(): void {
  testResult.className = 'inline-status';
  testResult.textContent = '';
}

// ── Folder section ────────────────────────────────────────────────────────────

pickFolderBtn.addEventListener('click', async () => {
  const picked = await window.api.dialog.pickFolder();
  if (picked) {
    draft.vaultPath = picked;
    draft.syncFolderPath = '';
    renderFolderDisplay();
    updateSaveEnabled();
  }
});

function renderFolderDisplay(): void {
  if (!draft.vaultPath) {
    folderPathEl.textContent = 'No folder chosen';
    folderPathEl.classList.add('empty');
    legacyNote.classList.add('hidden');
    return;
  }
  folderPathEl.classList.remove('empty');
  if (draft.syncFolderPath) {
    folderPathEl.textContent = `${draft.vaultPath}/${draft.syncFolderPath}`;
    legacyNote.textContent = `Using legacy vault layout: ${draft.syncFolderPath}`;
    legacyNote.classList.remove('hidden');
  } else {
    folderPathEl.textContent = draft.vaultPath;
    legacyNote.classList.add('hidden');
  }
}

// ── Sync section ──────────────────────────────────────────────────────────────

syncModeEl.addEventListener('change', () => {
  draft.syncMode = syncModeEl.value as 'auto' | 'manual';
  updateSyncModeHelp();
});

function updateSyncModeHelp(): void {
  if (draft.syncMode === 'manual') {
    syncModeHelp.textContent =
      'Specter watches for remote changes but never pushes on its own. Use Sync Now / Push when you\'re ready.';
  } else {
    syncModeHelp.textContent =
      'Saves to your local markdown push to Ghost automatically (after a short debounce).';
  }
}

pullDraftsEl.addEventListener('change', () => {
  draft.pullDrafts = pullDraftsEl.checked;
});

pullPublishedEl.addEventListener('change', () => {
  draft.pullPublished = pullPublishedEl.checked;
});

conflictEl.addEventListener('change', () => {
  draft.conflictStrategy = conflictEl.value as Draft['conflictStrategy'];
  updateConflictHelp();
});

function updateConflictHelp(): void {
  switch (draft.conflictStrategy) {
    case 'keep_local':
      conflictHelp.textContent =
        'When both sides changed, local markdown wins automatically.';
      break;
    case 'keep_remote':
      conflictHelp.textContent =
        'When both sides changed, Ghost wins automatically.';
      break;
    default:
      conflictHelp.textContent =
        'When both sides changed, Specter asks before overwriting either side.';
  }
}

// ── License section ───────────────────────────────────────────────────────────

async function loadLicenseSection(): Promise<void> {
  licenseSection.innerHTML = `
    <div class="row">
      <span class="spinner"></span>
      <span class="caption" style="margin-left:8px;">Loading license…</span>
    </div>
  `;

  try {
    const res = await window.api.license.status();
    const status = res as Parameters<typeof renderLicenseSection>[0];
    renderLicenseSection(status);
  } catch {
    licenseSection.innerHTML = `<span class="inline-status status-error">✕ Failed to load license status.</span>`;
  }
}

interface LicenseStatus {
  tier?: string;
  key?: string;
  syncCount?: number;
  freeLimit?: number;
  lastValidatedAt?: string;
  error?: string;
}

function renderLicenseSection(status: LicenseStatus): void {
  if (status.error || status.tier === undefined) {
    licenseSection.innerHTML = `<span class="inline-status status-error">✕ ${status.error ?? 'Unknown error'}</span>`;
    return;
  }

  if (status.tier === 'pro') {
    licenseSection.innerHTML = `
      <div class="license-pro">
        <div class="row row-gap-sm">
          <span class="inline-status status-ok">✓ Specter Pro</span>
          <div class="spacer"></div>
          <button class="btn btn-link" id="s-contact-support">Contact Support</button>
        </div>
        <div class="caption">Key: ${status.key ?? '—'}</div>
        ${status.lastValidatedAt ? `<div class="caption2">Last validated: ${status.lastValidatedAt}</div>` : ''}
        <div class="row" style="margin-top:6px;">
          <span class="caption">${status.syncCount ?? 0} uploads this month (no limit)</span>
          <div class="spacer"></div>
          <button class="btn btn-danger" id="s-deactivate">Deactivate on this device</button>
        </div>
      </div>
    `;
    document.getElementById('s-contact-support')?.addEventListener('click', () => {
      // Open support mailto via shell (ipcRenderer→main won't help here, but
      // contextBridge only exposes our api object — use a link instead).
      const a = document.createElement('a');
      a.href = 'mailto:support@spectersync.com';
      a.click();
    });
    document.getElementById('s-deactivate')?.addEventListener('click', async () => {
      const btn = document.getElementById('s-deactivate') as HTMLButtonElement;
      btn.disabled = true;
      const res = await window.api.license.deactivate();
      if (res.ok) {
        await loadLicenseSection();
      } else {
        btn.disabled = false;
        alert(res.error ?? 'Deactivation failed.');
      }
    });
  } else {
    // Free tier
    const used = status.syncCount ?? 0;
    const limit = status.freeLimit ?? 200;
    const atLimit = used >= limit;
    licenseSection.innerHTML = `
      <div class="license-free">
        <div class="row row-gap-sm">
          <span class="caption ${atLimit ? 'status-error' : 'status-muted'}">${used} of ${limit} uploads used this month</span>
          <div class="spacer"></div>
          <a href="https://spectersync.com/#buy" target="_blank" class="btn btn-primary" style="text-decoration:none;">Buy Specter Pro — $49</a>
        </div>
        <div>
          <div class="caption" style="margin-bottom:6px;">Have a license key? Paste it here:</div>
          <div class="license-key-row">
            <input type="password" id="s-license-key" placeholder="XXXX-XXXX-XXXX-XXXX" />
            <button class="btn btn-primary" id="s-activate-btn" disabled>Activate</button>
          </div>
          <div id="s-activate-error" class="inline-status status-error" style="margin-top:4px;display:none;"></div>
        </div>
      </div>
    `;
    const keyInput = document.getElementById('s-license-key') as HTMLInputElement;
    const activateBtn = document.getElementById('s-activate-btn') as HTMLButtonElement;
    const activateErr = document.getElementById('s-activate-error')!;

    keyInput.addEventListener('input', () => {
      activateBtn.disabled = !keyInput.value.trim();
    });

    activateBtn.addEventListener('click', async () => {
      activateBtn.disabled = true;
      activateErr.style.display = 'none';
      const res = await window.api.license.activate(keyInput.value.trim());
      if (res.ok) {
        await loadLicenseSection();
      } else {
        activateErr.textContent = `✕ ${res.error ?? 'Activation failed.'}`;
        activateErr.style.display = 'flex';
        activateBtn.disabled = false;
      }
    });
  }
}

// ── Save / Cancel ─���───────────────────────────────────────────────────────────

cancelBtn.addEventListener('click', () => window.close());

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveErrorEl.classList.add('hidden');

  try {
    const res = await window.api.config.write(draft as Parameters<typeof window.api.config.write>[0]);
    if (res.ok) {
      await window.api.daemon.restart();
      window.close();
    } else {
      saveErrorEl.textContent = `✕ ${res.error ?? 'Save failed.'}`;
      saveErrorEl.classList.remove('hidden');
    }
  } catch (e) {
    saveErrorEl.textContent = `✕ ${(e as Error).message}`;
    saveErrorEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
  }
});

// ── Init ──────────────────────────────────���───────────────────────────────────

async function init(): Promise<void> {
  const cfg = await window.api.config.read();
  if (cfg) {
    draft = { ...draft, ...cfg };
    ghostUrlEl.value = cfg.ghostUrl;
    adminKeyEl.value = cfg.adminApiKey;
    syncModeEl.value = cfg.syncMode;
    pullDraftsEl.checked = cfg.pullDrafts;
    pullPublishedEl.checked = cfg.pullPublished;
    conflictEl.value = cfg.conflictStrategy;
    renderFolderDisplay();
    updateSyncModeHelp();
    updateConflictHelp();
    updateTestBtnState();
    updateSaveEnabled();
  }

  await loadLicenseSection();
}

init();

// Make this file an ES module so its top-level identifiers don't pollute the global scope
export {};
