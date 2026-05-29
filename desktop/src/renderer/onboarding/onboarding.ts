/**
 * Onboarding renderer.
 * Steps: welcome → credentials → folder → done
 * Mirrors OnboardingController + OnboardingView in Onboarding.swift.
 */


type Step = 'welcome' | 'credentials' | 'folder' | 'done';

const STEPS: Step[] = ['welcome', 'credentials', 'folder', 'done'];

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

let currentStep: Step = 'welcome';
let testPassed = false;
const draft: Draft = {
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

// ── Elements ──────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

const progressSegments = document.querySelectorAll<HTMLElement>('.progress-bar-segment');

const welcomeNext = $('btn-welcome-next') as HTMLButtonElement;

const ghostUrlInput = $('ghost-url') as HTMLInputElement;
const adminKeyInput = $('admin-key') as HTMLInputElement;
const testBtn = $('btn-test-credentials') as HTMLButtonElement;
const testSpinner = $('test-spinner');
const testResult = $('test-result');
const credentialsBack = $('btn-credentials-back') as HTMLButtonElement;
const credentialsNext = $('btn-credentials-next') as HTMLButtonElement;

const folderPath = $('folder-path');
const pickFolderBtn = $('btn-pick-folder') as HTMLButtonElement;
const folderBack = $('btn-folder-back') as HTMLButtonElement;
const folderNext = $('btn-folder-next') as HTMLButtonElement;

const saveError = $('save-error');
const finishBtn = $('btn-finish') as HTMLButtonElement;

// ── Navigation ────────────────────────────────────────────────────────────────

function goTo(step: Step): void {
  // Hide all panels.
  document.querySelectorAll('.step-panel').forEach((el) =>
    el.classList.add('hidden'),
  );
  $(`step-${step}`).classList.remove('hidden');
  currentStep = step;

  // Update progress bar.
  const idx = STEPS.indexOf(step);
  progressSegments.forEach((seg, i) => {
    seg.classList.toggle('active', i <= idx);
  });
}

// ── Welcome ───────────────────────────────────────────────────────────────────

welcomeNext.addEventListener('click', () => goTo('credentials'));

// ── Credentials ───────────────────────────────────────────────────────────────

function updateCredentialsContinue(): void {
  credentialsNext.disabled = !testPassed;
  testBtn.disabled =
    !ghostUrlInput.value.trim() || !adminKeyInput.value.trim();
}

ghostUrlInput.addEventListener('input', () => {
  draft.ghostUrl = ghostUrlInput.value;
  testPassed = false;
  clearTestResult();
  updateCredentialsContinue();
});

adminKeyInput.addEventListener('input', () => {
  draft.adminApiKey = adminKeyInput.value;
  testPassed = false;
  clearTestResult();
  updateCredentialsContinue();
});

testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testSpinner.classList.remove('hidden');
  clearTestResult();

  try {
    const result = await window.api.ghost.test(
      draft.ghostUrl.trim(),
      draft.adminApiKey.trim(),
    );
    if (result.ok) {
      testPassed = true;
      showTestResult('ok', result.message ?? 'Connected');
    } else {
      testPassed = false;
      showTestResult('error', result.error ?? 'Connection failed');
    }
  } catch (e) {
    testPassed = false;
    showTestResult('error', (e as Error).message);
  } finally {
    testSpinner.classList.add('hidden');
    testBtn.disabled = false;
    updateCredentialsContinue();
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

credentialsBack.addEventListener('click', () => goTo('welcome'));
credentialsNext.addEventListener('click', () => goTo('folder'));

// ── Folder ────────────────────────────────────────────────────────────────────

pickFolderBtn.addEventListener('click', async () => {
  const picked = await window.api.dialog.pickFolder();
  if (picked) {
    draft.vaultPath = picked;
    draft.syncFolderPath = '';
    folderPath.textContent = picked;
    folderPath.classList.remove('empty');
    folderNext.disabled = false;
  }
});

folderBack.addEventListener('click', () => goTo('credentials'));
folderNext.addEventListener('click', () => goTo('done'));

// ── Done ──────────────────────────────────────────────────────────────────────

finishBtn.addEventListener('click', async () => {
  finishBtn.disabled = true;
  saveError.classList.add('hidden');

  try {
    const result = await window.api.config.write(draft as Parameters<typeof window.api.config.write>[0]);
    if (result.ok) {
      // Start the daemon, then close this window.
      await window.api.daemon.restart();
      window.close();
    } else {
      showSaveError(result.error ?? 'Save failed.');
    }
  } catch (e) {
    showSaveError((e as Error).message);
  } finally {
    finishBtn.disabled = false;
  }
});

function showSaveError(msg: string): void {
  saveError.textContent = `✕ ${msg}`;
  saveError.classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Pre-fill from existing config so re-running onboarding doesn't lose data.
  const existing = await window.api.config.read();
  if (existing) {
    draft.ghostUrl = existing.ghostUrl;
    draft.adminApiKey = existing.adminApiKey;
    draft.vaultPath = existing.vaultPath;
    draft.syncFolderPath = existing.syncFolderPath;
    ghostUrlInput.value = existing.ghostUrl;
    adminKeyInput.value = existing.adminApiKey;
    if (existing.vaultPath) {
      folderPath.textContent = existing.vaultPath;
      folderPath.classList.remove('empty');
      folderNext.disabled = false;
    }
  }
  goTo('welcome');
}

init();

// Make this file an ES module so its top-level identifiers don't pollute the global scope
export {};
