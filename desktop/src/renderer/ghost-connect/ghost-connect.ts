/**
 * Ghost add/edit-target renderer.
 * Spec: tasks/spec-multi-cms-ui.md — multi-target Ghost.
 *
 * Parallels wordpress-connect.ts. Captures a per-blog label + Ghost URL +
 * Admin API key. Test Connection must succeed before Connect is enabled (skip
 * when editing with an unchanged key — see below). On Connect, IPC upserts a
 * Ghost target with a unique slugified handle and its own folder, then the
 * daemon supervisor restarts so the watcher picks up the new/edited target.
 *
 * Edit mode: when the window was opened to edit an existing blog, the main
 * process stashes its current fields; we read them via `connect.pending` and
 * pre-fill the form. The same handle is reused on save.
 */

const $ = (id: string) => document.getElementById(id)!;

const labelInput = $('gh-label') as HTMLInputElement;
const urlInput = $('gh-url') as HTMLInputElement;
const keyInput = $('gh-key') as HTMLInputElement;
const titleEl = $('gh-title');
const testBtn = $('btn-test') as HTMLButtonElement;
const connectBtn = $('btn-connect') as HTMLButtonElement;
const cancelBtn = $('btn-cancel') as HTMLButtonElement;
const testSpinner = $('test-spinner');
const testResult = $('test-result');
const saveError = $('save-error');

let testPassed = false;
let editingHandle: string | null = null;

function updateButtons(): void {
  const hasCreds = !!urlInput.value.trim() && !!keyInput.value.trim();
  testBtn.disabled = !hasCreds;
  // In edit mode the existing connection is already known-good, so allow
  // saving label-only changes without a fresh test.
  connectBtn.disabled = !(testPassed || editingHandle !== null) || !hasCreds;
}

function clearTestResult(): void {
  testResult.textContent = '';
  testResult.classList.remove('ok', 'fail');
}

function resetTestPassed(): void {
  testPassed = false;
  clearTestResult();
  updateButtons();
}

[urlInput, keyInput].forEach((el) => el.addEventListener('input', resetTestPassed));
labelInput.addEventListener('input', updateButtons);

testBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();

  testBtn.disabled = true;
  testSpinner.classList.remove('hidden');
  clearTestResult();

  try {
    const result = await window.api.ghost.test(url, key);
    testSpinner.classList.add('hidden');
    if (result.ok) {
      testPassed = true;
      testResult.textContent = result.message ?? 'Connected.';
      testResult.classList.add('ok');
    } else {
      testPassed = false;
      testResult.textContent = result.error ?? result.message ?? 'Connection failed.';
      testResult.classList.add('fail');
    }
  } catch (err) {
    testSpinner.classList.add('hidden');
    testPassed = false;
    testResult.textContent = (err as Error).message;
    testResult.classList.add('fail');
  } finally {
    updateButtons();
  }
});

connectBtn.addEventListener('click', async () => {
  saveError.classList.add('hidden');
  saveError.textContent = '';
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();
  const label = labelInput.value.trim();
  connectBtn.disabled = true;

  try {
    const result = await window.api.ghost.connect(url, key, label);
    if (result.ok) {
      window.close();
    } else {
      saveError.textContent = result.error ?? 'Could not save Ghost blog.';
      saveError.classList.remove('hidden');
      connectBtn.disabled = false;
    }
  } catch (err) {
    saveError.textContent = (err as Error).message;
    saveError.classList.remove('hidden');
    connectBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', () => {
  window.close();
});

// Pre-fill on load when editing an existing blog.
async function init(): Promise<void> {
  try {
    const pending = await window.api.connect.pending();
    if (pending && pending.platform === 'ghost') {
      editingHandle = pending.handle ?? null;
      if (pending.label) labelInput.value = pending.label;
      if (pending.ghostUrl) urlInput.value = pending.ghostUrl;
      if (pending.adminApiKey) keyInput.value = pending.adminApiKey;
      if (editingHandle) {
        titleEl.textContent = 'Edit Ghost blog';
        connectBtn.textContent = 'Save';
      }
    }
  } catch {
    /* fresh add flow */
  }
  updateButtons();
}

void init();

export {};
