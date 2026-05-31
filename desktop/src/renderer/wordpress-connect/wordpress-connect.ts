/**
 * WordPress add-target renderer.
 * Spec: tasks/spec-wordpress-adapter.md Phase 7.
 *
 * Mirrors the Mac WordPressConnect.swift form. Test Connection must succeed
 * before Connect is enabled. On Connect, IPC saves the target and the daemon
 * supervisor is restarted so the new target is picked up by the watcher.
 */

const $ = (id: string) => document.getElementById(id)!;

const siteUrlInput = $('wp-site-url') as HTMLInputElement;
const usernameInput = $('wp-username') as HTMLInputElement;
const appPasswordInput = $('wp-app-password') as HTMLInputElement;
const labelInput = document.getElementById('wp-label') as HTMLInputElement | null;
const testBtn = $('btn-test') as HTMLButtonElement;
const connectBtn = $('btn-connect') as HTMLButtonElement;
const cancelBtn = $('btn-cancel') as HTMLButtonElement;
const testSpinner = $('test-spinner');
const testResult = $('test-result');
const saveError = $('save-error');
const helpLink = $('wp-help-link') as HTMLAnchorElement;

let testPassed = false;
let editingHandle: string | null = null;

function updateButtons(): void {
  const hasFields =
    !!siteUrlInput.value.trim() &&
    !!usernameInput.value.trim() &&
    !!appPasswordInput.value.trim();
  testBtn.disabled = !hasFields;
  // In edit mode the existing connection is already known-good, so allow saving
  // (e.g. a label change) without re-running the connection test.
  connectBtn.disabled = !(testPassed || editingHandle !== null) || !hasFields;
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

[siteUrlInput, usernameInput, appPasswordInput].forEach((el) => {
  el.addEventListener('input', resetTestPassed);
});

// External help link — Electron will block the click without explicit handling
// because the renderer has `webContents.setWindowOpenHandler({ action: 'deny' })`.
// Use window.open via the contextBridge? We just open with shell via IPC: simpler
// is to mark target=_blank, but Electron's main process intercepts. As a pragmatic
// fallback, click to copy the URL into clipboard isn't ideal. Use plain anchor
// and rely on Electron's default open-link behaviour.
helpLink.addEventListener('click', (ev) => {
  ev.preventDefault();
  // The renderer can't directly call shell.openExternal; the user copies-and-pastes.
  // Tooltips and a small spec note would be added in a follow-up.
  const url = 'https://wordpress.org/documentation/article/application-passwords/';
  navigator.clipboard?.writeText(url).catch(() => { /* ignore */ });
  helpLink.textContent = 'Link copied to clipboard';
  setTimeout(() => {
    helpLink.textContent = 'How to create an Application Password';
  }, 2000);
});

testBtn.addEventListener('click', async () => {
  const siteUrl = siteUrlInput.value.trim();
  const username = usernameInput.value.trim();
  // Application Passwords are space-grouped in WP's display; strip before send.
  const appPassword = appPasswordInput.value.replace(/\s+/g, '');

  testBtn.disabled = true;
  testSpinner.classList.remove('hidden');
  clearTestResult();

  try {
    const result = await window.api.wordpress.test(siteUrl, username, appPassword);
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
  const siteUrl = siteUrlInput.value.trim();
  const username = usernameInput.value.trim();
  const appPassword = appPasswordInput.value.replace(/\s+/g, '');
  connectBtn.disabled = true;

  const label = labelInput?.value.trim() || undefined;
  try {
    const result = await window.api.wordpress.connect(siteUrl, username, appPassword, label);
    if (result.ok) {
      window.close();
    } else {
      saveError.textContent = result.error ?? 'Could not save WordPress target.';
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

// Pre-fill on load when editing an existing WordPress site.
async function init(): Promise<void> {
  try {
    const pending = await window.api.connect.pending();
    if (pending && pending.platform === 'wordpress') {
      editingHandle = pending.handle ?? null;
      if (pending.siteUrl) siteUrlInput.value = pending.siteUrl;
      if (pending.username) usernameInput.value = pending.username;
      if (pending.appPassword) appPasswordInput.value = pending.appPassword;
      if (labelInput && pending.label) labelInput.value = pending.label;
    }
  } catch {
    /* fresh add flow */
  }
  updateButtons();
}

void init();

export {};
