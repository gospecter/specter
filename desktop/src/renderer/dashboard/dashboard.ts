/**
 * dashboard.ts
 * Spec: tasks/spec-multi-cms-ui.md — S3 Dashboard.
 *
 * Renders the Targets list from a daemon-backed snapshot built by the main
 * process from `config.targets[]` + `state.json`. Polls every 5 seconds —
 * matches the StatusStore timer on Mac so the two surfaces stay coherent.
 *
 * Per-card buttons (Pull / Push / Sync / Dry-run) route through
 * `dashboard:run-command` IPC. The Auto toggle persists via
 * `config:set-target-sync-mode`. After any successful action we immediately
 * trigger a fresh `dashboard:fetch` so the renderer reflects daemon truth
 * instead of waiting on the next 5s tick.
 */

import type { ContentKind, DashboardSnapshot, DashboardTarget } from '../preload-types.js';

type Platform = DashboardTarget['platform'];
type State = DashboardTarget['state'];

const PLATFORM_LABEL: Record<Platform, string> = {
  ghost: 'Ghost',
  shopify: 'Shopify',
  wordpress: 'WordPress',
  webflow: 'Webflow',
};

// Pluralised human labels for the "Syncs: …" caption. Only the fixed kinds are
// listed; dynamic Webflow kinds (`webflow:<slug>`) fall back to their slug.
const KIND_LABEL: Partial<Record<ContentKind, string>> = {
  post: 'posts',
  page: 'pages',
  article: 'articles',
  product: 'products',
};

/** Human label for a content kind — fixed kinds use KIND_LABEL; dynamic
 *  Webflow kinds render their collection slug. */
function kindLabel(kind: ContentKind): string {
  return KIND_LABEL[kind] ?? String(kind).replace(/^webflow:/, '');
}

/** "Syncs: posts, pages" — or "Syncs: nothing" for an empty opt-in selection. */
function kindsSummary(kinds: ContentKind[]): string {
  if (!kinds || kinds.length === 0) return 'Syncs: nothing';
  return `Syncs: ${kinds.map((k) => kindLabel(k)).join(', ')}`;
}

// ── Section switching ─────────────────────────────────────────────────────

const navRows = document.querySelectorAll<HTMLButtonElement>('.nav-row');
const panes = document.querySelectorAll<HTMLElement>('.pane');

navRows.forEach((row) => {
  row.addEventListener('click', () => {
    const section = row.dataset.section;
    navRows.forEach((r) => r.classList.toggle('is-active', r === row));
    panes.forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== section));
  });
});

// ── Card rendering ────────────────────────────────────────────────────────

function dotClass(state: State): string {
  if (state === 'conflict') return 'warning';
  if (state === 'error') return 'error';
  if (state === 'disconnected') return 'idle';
  return 'success';
}

function statusLine(t: DashboardTarget): { text: string; tone: '' | 'warning' | 'error' } {
  switch (t.state) {
    case 'idle': {
      const last = t.lastSyncedRelative ? ` · ${t.lastSyncedRelative}` : '';
      return { text: t.lastSyncedRelative ? `Synced${last}` : 'Not synced yet', tone: '' };
    }
    case 'syncing':
      return { text: 'Syncing…', tone: '' };
    case 'conflict': {
      const n = t.conflictCount ?? 1;
      return { text: `${n} conflict${n === 1 ? '' : 's'} · resolve to continue`, tone: 'warning' };
    }
    case 'error':
      return { text: 'Sync failed', tone: 'error' };
    case 'disconnected':
      return { text: 'Not connected', tone: '' };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Per-card transient-status overlay ────────────────────────────────────
//
// While a command is in flight we disable the card's action buttons and
// surface a "Pull…" / "Sync…" / "Saving…" line. On completion we either
// swap to a one-tick "Done" message (cleared by the next dashboard refresh)
// or surface the daemon's error string.

type ActionTone = '' | 'warning' | 'error';

const inFlight = new Set<string>(); // target handles currently mid-command
const transientMessage = new Map<string, { text: string; tone: ActionTone }>();

function setTransient(handle: string, text: string, tone: ActionTone = ''): void {
  transientMessage.set(handle, { text, tone });
}

function clearTransient(handle: string): void {
  transientMessage.delete(handle);
}

function renderCard(t: DashboardTarget): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sync-card';
  card.dataset.id = t.id;

  const status = statusLine(t);
  const transient = transientMessage.get(t.id);
  const effectiveStatus = transient ?? status;
  const isConflict = t.state === 'conflict';
  const busy = inFlight.has(t.id);

  card.innerHTML = `
    <div class="card-top">
      <span class="status-dot ${dotClass(t.state)}"></span>
      <span class="card-platform">${escapeHtml(PLATFORM_LABEL[t.platform])}</span>
      <span class="card-url">${escapeHtml(t.siteUrl)}</span>
      <div class="card-top-right">
        <button class="auto-toggle ${t.autoSync ? 'on' : ''}" data-action="auto" ${busy ? 'disabled' : ''}>
          <span class="label">Auto</span>
          <span class="switch"></span>
        </button>
      </div>
    </div>
    <div class="card-status-line ${effectiveStatus.tone}">${escapeHtml(effectiveStatus.text)}</div>
    <div class="card-summary">${escapeHtml(t.summary)}</div>
    <div class="card-kinds">${escapeHtml(kindsSummary(t.contentKinds))}</div>
    <div class="card-actions">
      ${
        isConflict
          ? `<button class="btn-ghost warning" data-action="resolve" ${busy ? 'disabled' : ''}>Resolve conflict</button>`
          : `
            <button class="btn-ghost" data-action="pull" ${busy ? 'disabled' : ''}>Pull</button>
            <button class="btn-ghost" data-action="push" ${busy ? 'disabled' : ''}>Push</button>
            <button class="btn-ghost dashed" data-action="dry-run" ${busy ? 'disabled' : ''}>Dry-run</button>
          `
      }
      <span class="spacer"></span>
      <button class="btn-ghost" data-action="more" ${busy ? 'disabled' : ''}>⋯</button>
    </div>
  `;

  card.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const action = btn.dataset.action!;
      if (action === 'auto') {
        void onToggleAuto(t);
        return;
      }
      if (action === 'pull' || action === 'push' || action === 'sync' || action === 'dry-run') {
        void onRunCommand(t, action);
        return;
      }
      if (action === 'resolve') {
        // The Preview (dry-run) window is the conflict surface today (spec S5
        // ships the dedicated resolver later). Route there scoped to this target.
        void onRunCommand(t, 'dry-run');
        return;
      }
      if (action === 'more') {
        ev.stopPropagation();
        openCardMenu(t, btn);
        return;
      }
    });
  });

  return card;
}

// ── Per-card ⋯ menu (Edit / Remove) ────────────────────────────────────────

let openMenuEl: HTMLElement | null = null;

function closeCardMenu(): void {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

document.addEventListener('click', closeCardMenu);

function openCardMenu(t: DashboardTarget, anchor: HTMLElement): void {
  closeCardMenu();
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  // Shopify is connected through the hosted OAuth funnel, not an in-app form,
  // so its credentials can't be edited here (Edit opens the connect window for
  // Ghost/WordPress). Its content-kind selection IS editable in-app, though, so
  // every platform gets a "Choose content…" item.
  const canEdit = t.platform !== 'shopify';
  menu.innerHTML = `
    ${canEdit ? '<button type="button" data-menu="edit">Edit…</button>' : ''}
    <button type="button" data-menu="kinds">Choose content…</button>
    <button type="button" data-menu="remove" class="danger">Remove…</button>
  `;
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - 160)}px`;
  document.body.appendChild(menu);
  openMenuEl = menu;

  menu.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeCardMenu();
      if (b.dataset.menu === 'edit') void onEditTarget(t);
      else if (b.dataset.menu === 'kinds') void onEditKinds(t);
      else if (b.dataset.menu === 'remove') void onRemoveTarget(t);
    });
  });
}

// ── Per-target content-kind editor ─────────────────────────────────────────
//
// A small checkbox popover so any target (notably Shopify, which has no connect
// form) can change which content kinds it syncs. Pre-checked from the target's
// current selection; an empty selection ("sync nothing") is allowed. Persists
// via `config:set-target-content-kinds`, which restarts the watcher.

const KIND_OPTION_LABEL: Record<ContentKind, string> = {
  post: 'Posts',
  page: 'Pages',
  article: 'Articles',
  product: 'Products',
};

async function onEditKinds(t: DashboardTarget): Promise<void> {
  closeCardMenu();
  const picker = document.createElement('div');
  picker.className = 'card-menu kinds-popover';
  const checks = t.availableKinds
    .map((kind) => {
      const checked = t.contentKinds.includes(kind) ? 'checked' : '';
      return `<label class="kind-option"><input type="checkbox" value="${kind}" ${checked}/><span>${escapeHtml(
        KIND_OPTION_LABEL[kind] ?? kind,
      )}</span></label>`;
    })
    .join('');
  picker.innerHTML = `
    <div class="kinds-popover-title">Sync for ${escapeHtml(PLATFORM_LABEL[t.platform])}</div>
    <div class="kinds-popover-help">Choose what to sync</div>
    <div class="kinds-popover-list">${checks}</div>
    <div class="kinds-popover-actions">
      <button type="button" data-k="cancel" class="btn-ghost">Cancel</button>
      <button type="button" data-k="save" class="btn-ghost">Save</button>
    </div>
  `;
  picker.style.position = 'fixed';
  picker.style.top = '80px';
  picker.style.left = '50%';
  picker.style.transform = 'translateX(-50%)';
  picker.style.zIndex = '1000';
  document.body.appendChild(picker);
  openMenuEl = picker;
  // Keep the popover open when interacting with it.
  picker.addEventListener('click', (ev) => ev.stopPropagation());

  picker.querySelector<HTMLButtonElement>('[data-k="cancel"]')!.addEventListener('click', () => {
    closeCardMenu();
  });
  picker.querySelector<HTMLButtonElement>('[data-k="save"]')!.addEventListener('click', async () => {
    const selected = Array.from(
      picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
    ).map((cb) => cb.value as ContentKind);
    closeCardMenu();
    inFlight.add(t.id);
    setTransient(t.id, 'Saving…');
    await refresh();
    try {
      const result = await window.api.config.setTargetContentKinds(t.id, selected);
      if (!result.ok) {
        setTransient(t.id, result.error ?? 'Failed to save', 'error');
      } else {
        clearTransient(t.id);
      }
    } catch (err) {
      setTransient(t.id, (err as Error).message, 'error');
    } finally {
      inFlight.delete(t.id);
      await refresh();
    }
  });
}

async function onEditTarget(t: DashboardTarget): Promise<void> {
  const result = await window.api.config.editTarget(t.id);
  if (!result.ok) {
    setTransient(t.id, result.error ?? 'Cannot edit this target', 'error');
    await refresh();
  }
}

async function onRemoveTarget(t: DashboardTarget): Promise<void> {
  const ok = window.confirm(
    `Remove "${PLATFORM_LABEL[t.platform]} · ${t.siteUrl}"? Local files in its sync folder are kept; only the connection is removed.`,
  );
  if (!ok) return;
  if (inFlight.has(t.id)) return;
  inFlight.add(t.id);
  setTransient(t.id, 'Removing…');
  await refresh();
  try {
    const result = await window.api.config.removeTarget(t.id);
    if (!result.ok) {
      setTransient(t.id, result.error ?? 'Failed to remove', 'error');
    } else {
      clearTransient(t.id);
    }
  } catch (err) {
    setTransient(t.id, (err as Error).message, 'error');
  } finally {
    inFlight.delete(t.id);
    await refresh();
  }
}

function renderEmpty(): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'sync-card empty-state';
  empty.innerHTML = `
    <div class="empty-title">No connected sites yet</div>
    <div class="empty-body">Use the menu bar to set up your first sync.</div>
  `;
  return empty;
}

// ── Live data: poll dashboard:fetch every 5s ──────────────────────────────

const list = document.getElementById('card-list')!;
const targetsTable = document.getElementById('targets-table');

async function refresh(): Promise<void> {
  let snapshot: DashboardSnapshot;
  try {
    snapshot = await window.api.dashboard.fetch();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[dashboard] fetch failed', e);
    return;
  }
  list.innerHTML = '';
  if (snapshot.targets.length === 0) {
    list.appendChild(renderEmpty());
  } else {
    snapshot.targets.forEach((t) => list.appendChild(renderCard(t)));
  }
  renderTargetsTable(snapshot.targets);
}

// ── Settings pane: Targets list (spec S6) ──────────────────────────────────
//
// A flat list of every connection with Edit/Remove, so target management is
// reachable outside the per-card ⋯ menu. Shares the IPC paths the cards use.

function renderTargetsTable(targets: DashboardTarget[]): void {
  if (!targetsTable) return;
  targetsTable.innerHTML = '';
  if (targets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ds-muted';
    empty.textContent = 'No connected sites yet.';
    targetsTable.appendChild(empty);
    return;
  }
  targets.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'target-row';
    const canEdit = t.platform !== 'shopify';
    row.innerHTML = `
      <span class="status-dot ${dotClass(t.state)}"></span>
      <span class="tr-platform">${escapeHtml(PLATFORM_LABEL[t.platform])}</span>
      <span class="tr-url">${escapeHtml(t.siteUrl)}</span>
      <span class="tr-folder">${escapeHtml(t.summary)}</span>
      <span class="tr-kinds">${escapeHtml(kindsSummary(t.contentKinds))}</span>
      <span class="tr-actions">
        ${canEdit ? '<button type="button" class="btn-ghost" data-row="edit">Edit</button>' : ''}
        <button type="button" class="btn-ghost" data-row="kinds">Content</button>
        <button type="button" class="btn-ghost danger" data-row="remove">Remove</button>
      </span>
    `;
    row.querySelectorAll<HTMLButtonElement>('[data-row]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (b.dataset.row === 'edit') void onEditTarget(t);
        else if (b.dataset.row === 'kinds') void onEditKinds(t);
        else if (b.dataset.row === 'remove') void onRemoveTarget(t);
      });
    });
    targetsTable.appendChild(row);
  });
}

// ── Action handlers ───────────────────────────────────────────────────────
//
// Each handler marks the card as busy, runs the IPC, surfaces the result as
// a transient status line, and triggers a fresh `dashboard:fetch` on success
// so the renderer reflects the daemon's view of "lastSyncAt" / conflict
// count rather than the user's optimistic flip.

const VERB: Record<'pull' | 'push' | 'sync' | 'dry-run', string> = {
  pull: 'Pulling…',
  push: 'Pushing…',
  sync: 'Syncing…',
  'dry-run': 'Computing plan…',
};

async function onRunCommand(
  target: DashboardTarget,
  command: 'pull' | 'push' | 'sync' | 'dry-run',
): Promise<void> {
  if (inFlight.has(target.id)) return;
  inFlight.add(target.id);
  setTransient(target.id, VERB[command]);
  await refresh();

  try {
    const result = await window.api.dashboard.runCommand(command, target.id);
    if (result.ok) {
      // Dry-run hands off to the Preview window — leave no lingering message.
      if (command === 'dry-run') {
        clearTransient(target.id);
      } else {
        setTransient(target.id, 'Done');
        // Auto-clear the "Done" pill after a brief moment so the card returns
        // to its normal lastSync-relative caption.
        setTimeout(() => {
          clearTransient(target.id);
          void refresh();
        }, 1500);
      }
    } else {
      setTransient(target.id, result.error ?? 'Failed', 'error');
    }
  } catch (err) {
    setTransient(target.id, (err as Error).message, 'error');
  } finally {
    inFlight.delete(target.id);
    await refresh();
  }
}

async function onToggleAuto(target: DashboardTarget): Promise<void> {
  if (inFlight.has(target.id)) return;
  const nextMode: 'auto' | 'manual' = target.autoSync ? 'manual' : 'auto';
  inFlight.add(target.id);
  setTransient(target.id, 'Saving…');
  await refresh();

  try {
    const result = await window.api.config.setTargetSyncMode(target.id, nextMode);
    if (result.ok) {
      setTransient(target.id, nextMode === 'auto' ? 'Auto sync on' : 'Auto sync off');
      setTimeout(() => {
        clearTransient(target.id);
        void refresh();
      }, 1500);
    } else {
      setTransient(target.id, result.error ?? 'Failed to save', 'error');
    }
  } catch (err) {
    setTransient(target.id, (err as Error).message, 'error');
  } finally {
    inFlight.delete(target.id);
    await refresh();
  }
}

void refresh();
const refreshTimer = setInterval(() => {
  void refresh();
}, 5000);

window.addEventListener('beforeunload', () => {
  clearInterval(refreshTimer);
});

// ── "+ Add target" dropdown ──────────────────────────────────────────────
//
// The dropdown surfaces a per-platform router: Ghost opens the legacy
// Settings (or onboarding when no config exists), Shopify shells out to the
// public connect funnel, WordPress opens the local connect window.

const addBtn = document.getElementById('btn-add-target') as HTMLButtonElement | null;
const addMenu = document.getElementById('add-target-menu') as HTMLElement | null;

if (addBtn && addMenu) {
  addBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    addMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    addMenu.classList.add('hidden');
  });

  addMenu.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      addMenu.classList.add('hidden');
      const target = btn.dataset.add;
      if (target === 'ghost') {
        // Multi-target: open the dedicated Ghost connect window so each blog
        // gets its own handle + folder, instead of the legacy single-Ghost
        // Settings/onboarding that overwrote targets[0].
        await window.api.windows.open('ghost-connect');
      } else if (target === 'shopify') {
        await window.api.shell.openExternal('https://spectersync.com/connect-shopify');
      } else if (target === 'wordpress') {
        await window.api.windows.open('wordpress-connect');
      } else if (target === 'webflow') {
        await window.api.windows.open('webflow-connect');
      }
    });
  });
}

// Make this file an ES module so its top-level identifiers don't pollute the
// global scope across renderer windows.
export {};
