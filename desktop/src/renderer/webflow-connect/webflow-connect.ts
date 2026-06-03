/**
 * Webflow add-target renderer.
 *
 * Mirrors the Mac WebflowConnect.swift form and the wordpress-connect page.
 * Differences from WordPress:
 *  - Auth is a single bearer token (a pasted Site API token, or an OAuth token
 *    pre-filled by the deep-link handler).
 *  - Content kinds are DYNAMIC — the site's CMS collections. They can't be
 *    hard-coded, so after a successful Test Connection we fetch them via
 *    `webflow.kinds(...)` and render a checkbox per collection.
 *
 * Test Connection must succeed before Connect is enabled (and before kinds can
 * load). On Connect, IPC saves the target and restarts the daemon supervisor.
 */

import type { ContentKind } from '../preload-types.js';

const $ = (id: string) => document.getElementById(id)!;

const labelInput = $('wf-label') as HTMLInputElement;
const siteIdInput = $('wf-site-id') as HTMLInputElement;
const apiTokenInput = $('wf-api-token') as HTMLInputElement;
const kindsGroup = $('wf-kinds');
const kindsHelp = document.querySelector('.kinds-help') as HTMLElement | null;
const testBtn = $('btn-test') as HTMLButtonElement;
const connectBtn = $('btn-connect') as HTMLButtonElement;
const cancelBtn = $('btn-cancel') as HTMLButtonElement;
const testSpinner = $('test-spinner');
const testResult = $('test-result');
const saveError = $('save-error');
const helpLink = $('wf-help-link') as HTMLAnchorElement;
const oauthBtn = $('btn-oauth') as HTMLButtonElement;
const oauthBlock = $('wf-oauth-block');

const DEFAULT_OAUTH_BASE_URL = 'https://spectersync.com';

/** Origin of the OAuth broker: configured `oauthBaseUrl`, else hosted default. */
async function oauthStartUrl(): Promise<string> {
  const cfg = await window.api.config.read().catch(() => null);
  const configured = cfg?.oauthBaseUrl?.trim();
  const base = configured
    ? (configured.endsWith('/') ? configured.slice(0, -1) : configured)
    : DEFAULT_OAUTH_BASE_URL;
  return `${base}/api/oauth/webflow/start`;
}

oauthBtn.addEventListener('click', async () => {
  oauthBtn.disabled = true;
  try {
    await window.api.shell.openExternal(await oauthStartUrl());
  } finally {
    oauthBtn.disabled = false;
  }
});

let testPassed = false;
let editingHandle: string | null = null;
// Collections discovered for the tested site. Each is a `webflow:<slug>` kind.
let availableKinds: ContentKind[] = [];
let preselectedKinds: ContentKind[] = [];

function kindLabel(kind: ContentKind): string {
  // 'webflow:blog-posts' → 'blog-posts'
  return String(kind).replace(/^webflow:/, '');
}

function renderKinds(): void {
  kindsGroup.innerHTML = '';
  if (availableKinds.length === 0) return;
  availableKinds.forEach((kind) => {
    const id = `wf-kind-${kindLabel(kind)}`;
    const wrap = document.createElement('label');
    wrap.className = 'kind-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.value = kind;
    cb.checked = preselectedKinds.includes(kind);
    const span = document.createElement('span');
    span.textContent = kindLabel(kind);
    wrap.append(cb, span);
    kindsGroup.appendChild(wrap);
  });
}

function selectedKinds(): ContentKind[] {
  return availableKinds.filter((kind) => {
    const cb = document.getElementById(`wf-kind-${kindLabel(kind)}`) as HTMLInputElement | null;
    return !!cb?.checked;
  });
}

function updateButtons(): void {
  const hasFields = !!siteIdInput.value.trim() && !!apiTokenInput.value.trim();
  testBtn.disabled = !hasFields;
  // In edit mode the connection is already known-good, so a label/kind change
  // can be saved without re-testing.
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

[siteIdInput, apiTokenInput].forEach((el) => {
  el.addEventListener('input', resetTestPassed);
});

helpLink.addEventListener('click', (ev) => {
  ev.preventDefault();
  const url = 'https://developers.webflow.com/data/reference/authentication';
  navigator.clipboard?.writeText(url).catch(() => { /* ignore */ });
  helpLink.textContent = 'Link copied to clipboard';
  setTimeout(() => {
    helpLink.textContent = 'How to create a Webflow Site API token';
  }, 2000);
});

async function loadKinds(siteId: string, apiToken: string): Promise<void> {
  try {
    const res = await window.api.webflow.kinds(siteId, apiToken);
    if (res.ok && res.kinds) {
      availableKinds = res.kinds;
      if (kindsHelp) {
        kindsHelp.textContent = availableKinds.length
          ? 'Choose which collections to sync.'
          : 'No CMS collections found on this site.';
      }
    }
  } catch {
    /* leave kinds empty; user can retry by testing again */
  }
  renderKinds();
}

testBtn.addEventListener('click', async () => {
  const siteId = siteIdInput.value.trim();
  const apiToken = apiTokenInput.value.trim();

  testBtn.disabled = true;
  testSpinner.classList.remove('hidden');
  clearTestResult();

  try {
    const result = await window.api.webflow.test(siteId, apiToken);
    testSpinner.classList.add('hidden');
    if (result.ok) {
      testPassed = true;
      testResult.textContent = result.message ?? 'Connected.';
      testResult.classList.add('ok');
      await loadKinds(siteId, apiToken);
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
  const siteId = siteIdInput.value.trim();
  const apiToken = apiTokenInput.value.trim();
  const label = labelInput.value.trim() || undefined;
  connectBtn.disabled = true;

  try {
    const result = await window.api.webflow.connect(
      siteId,
      { apiToken },
      label,
      selectedKinds(),
    );
    if (result.ok) {
      window.close();
    } else {
      saveError.textContent = result.error ?? 'Could not save Webflow target.';
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

// Pre-fill on load: editing an existing site, or completing an OAuth flow
// (the deep-link handler stashes the OAuth token in `apiToken`).
async function init(): Promise<void> {
  try {
    const pending = await window.api.connect.pending();
    if (pending && pending.platform === 'webflow') {
      editingHandle = pending.handle ?? null;
      if (pending.siteId) siteIdInput.value = pending.siteId;
      if (pending.apiToken) apiTokenInput.value = pending.apiToken;
      if (pending.label) labelInput.value = pending.label;
      if (pending.contentKinds) preselectedKinds = pending.contentKinds;
    }
    // The OAuth launcher only makes sense for a fresh add. When editing an
    // existing site (or finishing an OAuth flow that already filled the token),
    // hide it so it doesn't restart authorization.
    if (editingHandle !== null || apiTokenInput.value.trim()) {
      oauthBlock.classList.add('hidden');
    }
  } catch {
    /* fresh add flow */
  }
  updateButtons();
}

void init();

export {};
