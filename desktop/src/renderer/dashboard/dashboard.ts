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

// ── Status pills (dark-dashboard mockup) ──────────────────────────────────
//
// Maps a target's snapshot state → the labelled, dotted, tinted pill from the
// redesign spec §5. Precedence:
//   error           → ERROR
//   conflict (>0)    → CONFLICT
//   syncing          → INITIALIZING  (transient "Syncing…", no ETA)
//   disconnected     → DISCONNECTED  (no live connection)
//   manual mode      → PAUSED        (autoSync off — not auto-syncing)
//   auto + ok        → ACTIVE SYNCING (accent/blue)
// `tone` selects the pill colour family (success/warning/error/neutral/accent).

type PillTone = 'success' | 'warning' | 'error' | 'neutral' | 'accent';

function statusPill(t: DashboardTarget): { label: string; tone: PillTone } {
  if (t.state === 'error') return { label: 'Error', tone: 'error' };
  if (t.state === 'conflict' && (t.conflictCount ?? 1) > 0) {
    return { label: 'Conflict', tone: 'warning' };
  }
  if (t.state === 'syncing') return { label: 'Initializing', tone: 'accent' };
  if (t.state === 'disconnected') return { label: 'Disconnected', tone: 'neutral' };
  if (!t.autoSync) return { label: 'Paused', tone: 'neutral' };
  // ACTIVE SYNCING is the mockup's blue accent pill (not green).
  return { label: 'Active Syncing', tone: 'accent' };
}

function pillHtml(t: DashboardTarget): string {
  const pill = statusPill(t);
  return `<span class="status-pill tone-${pill.tone}"><span class="pill-dot"></span>${escapeHtml(
    pill.label,
  )}</span>`;
}

/** "Last sync: 5m ago" line for the card body / list row. */
function lastSyncText(t: DashboardTarget): string {
  if (t.state === 'syncing') return 'Last sync: syncing now…';
  return t.lastSyncedRelative ? `Last sync: ${t.lastSyncedRelative}` : 'Last sync: never';
}

/** First letter of the platform name for the icon tile. */
function platformGlyph(platform: Platform): string {
  return PLATFORM_LABEL[platform].charAt(0);
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

/** Wire the shared [data-action] click handlers used by both card layouts. */
function wireCardActions(root: HTMLElement, t: DashboardTarget): void {
  root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
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
    <div class="card-head">
      <span class="platform-tile" data-platform="${t.platform}">${escapeHtml(platformGlyph(t.platform))}</span>
      ${pillHtml(t)}
    </div>
    <div class="card-identity">
      <div class="card-platform">${escapeHtml(PLATFORM_LABEL[t.platform])}</div>
      <div class="card-url">${escapeHtml(t.siteUrl)}</div>
    </div>
    <div class="card-divider"></div>
    <div class="card-status-line ${effectiveStatus.tone}">${
      transient ? escapeHtml(effectiveStatus.text) : escapeHtml(lastSyncText(t))
    }</div>
    <div class="card-actions">
      ${
        isConflict
          ? `<button class="btn-ghost warning" data-action="resolve" ${busy ? 'disabled' : ''}>Resolve conflict</button>`
          : `
            <button class="btn-ghost" data-action="pull" ${busy ? 'disabled' : ''}>Pull now</button>
            <button class="btn-ghost" data-action="push" ${busy ? 'disabled' : ''}>Push now</button>
          `
      }
      <span class="spacer"></span>
      <button class="auto-toggle ${t.autoSync ? 'on' : ''}" data-action="auto" ${busy ? 'disabled' : ''} title="Auto-sync">
        <span class="label">Auto</span>
        <span class="switch"></span>
      </button>
      <button class="btn-ghost icon-btn" data-action="more" ${busy ? 'disabled' : ''}>⋯</button>
    </div>
  `;

  wireCardActions(card, t);
  return card;
}

/** Compact one-line list row used by the Connections list view. */
function renderListRow(t: DashboardTarget): HTMLElement {
  const row = document.createElement('div');
  row.className = 'conn-row';
  row.dataset.id = t.id;

  const transient = transientMessage.get(t.id);
  const busy = inFlight.has(t.id);
  const isConflict = t.state === 'conflict';

  row.innerHTML = `
    <span class="platform-tile sm" data-platform="${t.platform}">${escapeHtml(platformGlyph(t.platform))}</span>
    <span class="conn-name">${escapeHtml(PLATFORM_LABEL[t.platform])}</span>
    <span class="conn-url">${escapeHtml(t.siteUrl)}</span>
    ${pillHtml(t)}
    <span class="conn-last">${
      transient ? escapeHtml(transient.text) : escapeHtml(lastSyncText(t))
    }</span>
    <span class="conn-actions">
      ${
        isConflict
          ? `<button class="btn-ghost warning" data-action="resolve" ${busy ? 'disabled' : ''}>Resolve</button>`
          : `
            <button class="btn-ghost" data-action="pull" ${busy ? 'disabled' : ''}>Pull now</button>
            <button class="btn-ghost" data-action="push" ${busy ? 'disabled' : ''}>Push now</button>
          `
      }
      <button class="auto-toggle ${t.autoSync ? 'on' : ''}" data-action="auto" ${busy ? 'disabled' : ''} title="Auto-sync">
        <span class="switch"></span>
      </button>
      <button class="btn-ghost icon-btn" data-action="more" ${busy ? 'disabled' : ''}>⋯</button>
    </span>
  `;

  wireCardActions(row, t);
  return row;
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
    <button type="button" data-menu="dry-run">Dry-run…</button>
    ${canEdit ? '<button type="button" data-menu="edit">Edit…</button>' : ''}
    <button type="button" data-menu="test">Test</button>
    <button type="button" data-menu="kinds">Choose content…</button>
    <button type="button" data-menu="remove" class="danger">Disconnect…</button>
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
      else if (b.dataset.menu === 'dry-run') void onRunCommand(t, 'dry-run');
      else if (b.dataset.menu === 'test') void onTestTarget(t);
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

// Test a connection without writing anything. The daemon's only per-handle
// no-write check reachable from the renderer is the dry-run (it computes the
// sync plan and surfaces connectivity/auth errors in the Preview window without
// pulling or pushing). Reuses the existing `dashboard:run-command` dry-run path
// — no new IPC. See spec §5: Dry-run / Test share the no-write surface.
async function onTestTarget(t: DashboardTarget): Promise<void> {
  await onRunCommand(t, 'dry-run');
}

async function onRemoveTarget(t: DashboardTarget): Promise<void> {
  const ok = window.confirm(
    `Disconnect "${PLATFORM_LABEL[t.platform]} · ${t.siteUrl}"? Local files in its sync folder are kept; only the connection is removed.`,
  );
  if (!ok) return;
  if (inFlight.has(t.id)) return;
  inFlight.add(t.id);
  setTransient(t.id, 'Disconnecting…');
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
    <div class="empty-body">Use “Add connection” above to connect your first site.</div>
  `;
  return empty;
}

// ── Connections view mode (grid / list), persisted to localStorage ─────────

type ViewMode = 'grid' | 'list';
const VIEW_MODE_KEY = 'specter.connections.viewMode';

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

let viewMode: ViewMode = readViewMode();

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch { /* private mode / quota — fall back to in-memory only */ }
  list.dataset.view = mode;
  viewToggleBtns.forEach((b) => {
    const active = b.dataset.view === mode;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  void refresh();
}

// ── Live data: poll dashboard:fetch every 5s ──────────────────────────────

const list = document.getElementById('card-list')!;
const targetsTable = document.getElementById('targets-table');
const viewToggleBtns = document.querySelectorAll<HTMLButtonElement>('.view-toggle-btn');

// Keep the latest snapshot so the Sync Logs view (and re-renders triggered by
// filter/search changes) can repaint without re-fetching.
let lastTargets: DashboardTarget[] = [];

async function refresh(): Promise<void> {
  let snapshot: DashboardSnapshot;
  try {
    snapshot = await window.api.dashboard.fetch();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[dashboard] fetch failed', e);
    return;
  }
  lastTargets = snapshot.targets;
  list.dataset.view = viewMode;
  list.innerHTML = '';
  if (snapshot.targets.length === 0) {
    list.appendChild(renderEmpty());
  } else if (viewMode === 'list') {
    snapshot.targets.forEach((t) => list.appendChild(renderListRow(t)));
  } else {
    snapshot.targets.forEach((t) => list.appendChild(renderCard(t)));
  }
  renderTargetsTable(snapshot.targets);
  renderSyncLogs(snapshot.targets);
}

viewToggleBtns.forEach((b) => {
  b.addEventListener('click', () => setViewMode(b.dataset.view === 'list' ? 'list' : 'grid'));
});
// Apply persisted choice to the DOM on load (before first refresh paints).
list.dataset.view = viewMode;
viewToggleBtns.forEach((b) => {
  const active = b.dataset.view === viewMode;
  b.classList.toggle('is-active', active);
  b.setAttribute('aria-pressed', String(active));
});

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
        <button type="button" class="btn-ghost" data-row="test">Test</button>
        <button type="button" class="btn-ghost" data-row="kinds">Content</button>
        <button type="button" class="btn-ghost danger" data-row="remove">Disconnect</button>
      </span>
    `;
    row.querySelectorAll<HTMLButtonElement>('[data-row]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (b.dataset.row === 'edit') void onEditTarget(t);
        else if (b.dataset.row === 'test') void onTestTarget(t);
        else if (b.dataset.row === 'kinds') void onEditKinds(t);
        else if (b.dataset.row === 'remove') void onRemoveTarget(t);
      });
    });
    targetsTable.appendChild(row);
  });
}

// ── Sync Logs view (formerly Activity) ─────────────────────────────────────
//
// Spec §5 / §10: render per-target last-sync state in the mockup's event-table
// shape — Platform · Status · Description · Timestamp — with platform filter
// chips + a client-side search box. This is NOT a rolling event feed (deferred
// to its own spec); it's one row per target's current last-sync snapshot.

const logsTable = document.getElementById('logs-table');
const logsSearchEl = document.getElementById('logs-search') as HTMLInputElement | null;
const logsFilterBtns = document.querySelectorAll<HTMLButtonElement>('.filter-chip');

let logsPlatformFilter: 'all' | Platform = 'all';
let logsSearch = '';

/** Human description of a target's current sync state, for the log row. */
function logDescription(t: DashboardTarget): string {
  switch (t.state) {
    case 'syncing':
      return 'Sync in progress';
    case 'conflict': {
      const n = t.conflictCount ?? 1;
      return `${n} conflict${n === 1 ? '' : 's'} — resolve to continue`;
    }
    case 'error':
      return 'Last sync failed';
    case 'disconnected':
      return 'Not connected';
    case 'idle':
      return t.lastSyncedRelative ? 'Synced successfully' : 'No sync yet';
  }
}

function logsEmpty(message: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'logs-empty';
  empty.textContent = message;
  return empty;
}

function renderSyncLogs(targets: DashboardTarget[]): void {
  if (!logsTable) return;
  logsTable.innerHTML = '';

  if (targets.length === 0) {
    logsTable.appendChild(logsEmpty('No sync activity yet. Connect a site to see its sync log here.'));
    return;
  }

  const needle = logsSearch.trim().toLowerCase();
  const rows = targets.filter((t) => {
    if (logsPlatformFilter !== 'all' && t.platform !== logsPlatformFilter) return false;
    if (!needle) return true;
    const hay = `${PLATFORM_LABEL[t.platform]} ${t.siteUrl} ${logDescription(t)} ${statusPill(t).label}`.toLowerCase();
    return hay.includes(needle);
  });

  // Column headers (uppercase, letter-spaced).
  const header = document.createElement('div');
  header.className = 'logs-row logs-head';
  header.innerHTML = `
    <span>Platform</span>
    <span>Status</span>
    <span>Description</span>
    <span>Timestamp</span>
  `;
  logsTable.appendChild(header);

  if (rows.length === 0) {
    logsTable.appendChild(logsEmpty('No logs match the current filter.'));
    return;
  }

  rows.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'logs-row';
    const ts = t.state === 'syncing' ? 'now' : (t.lastSyncedRelative ?? '—');
    row.innerHTML = `
      <span class="logs-platform">
        <span class="platform-tile sm" data-platform="${t.platform}">${escapeHtml(platformGlyph(t.platform))}</span>
        ${escapeHtml(PLATFORM_LABEL[t.platform])}
      </span>
      <span>${pillHtml(t)}</span>
      <span class="logs-desc">${escapeHtml(logDescription(t))} · ${escapeHtml(t.siteUrl)}</span>
      <span class="logs-ts">${escapeHtml(ts)}</span>
    `;
    logsTable.appendChild(row);
  });
}

logsFilterBtns.forEach((b) => {
  b.addEventListener('click', () => {
    logsPlatformFilter = (b.dataset.platform as 'all' | Platform) ?? 'all';
    logsFilterBtns.forEach((x) => {
      const active = x === b;
      x.classList.toggle('is-active', active);
      x.setAttribute('aria-pressed', String(active));
    });
    renderSyncLogs(lastTargets);
  });
});

logsSearchEl?.addEventListener('input', () => {
  logsSearch = logsSearchEl.value;
  renderSyncLogs(lastTargets);
});

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
// The dropdown surfaces a per-platform router: Ghost/WordPress/Webflow open
// their dedicated connect windows (each new site gets its own handle + folder),
// Shopify shells out to the hosted connect funnel.

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

// ── Settings pane: global preferences ──────────────────────────────────────
//
// The dashboard Settings pane is the single home for global prefs (spec
// tasks/spec-app-redesign-ux-overhaul.md §5), folded out of the retired
// standalone Settings window. Per-connection sync settings live on the cards,
// NOT here — nothing in this pane names a specific connection.

const setFolderPathEl = document.getElementById('set-folder-path');
const setPickFolderBtn = document.getElementById('set-pick-folder') as HTMLButtonElement | null;
const setAutolaunchBtn = document.getElementById('set-autolaunch') as HTMLButtonElement | null;
const setGlobalsStatusEl = document.getElementById('set-globals-status');
const setLicenseSection = document.getElementById('set-license-section');
const setOauthBaseEl = document.getElementById('set-oauth-base') as HTMLInputElement | null;
const setOauthSaveBtn = document.getElementById('set-oauth-save') as HTMLButtonElement | null;
const setOpenFolderBtn = document.getElementById('set-open-folder') as HTMLButtonElement | null;
const setViewLogsBtn = document.getElementById('set-view-logs') as HTMLButtonElement | null;

function showGlobalsStatus(text: string, tone: 'ok' | 'error' = 'ok'): void {
  if (!setGlobalsStatusEl) return;
  setGlobalsStatusEl.textContent = text;
  setGlobalsStatusEl.className = `settings-status ${tone}`;
  setTimeout(() => {
    setGlobalsStatusEl.className = 'settings-status hidden';
  }, 2500);
}

async function loadSettingsGlobals(): Promise<void> {
  const cfg = await window.api.config.read();
  if (setFolderPathEl) {
    const folder = cfg?.vaultPath
      ? cfg.syncFolderPath
        ? `${cfg.vaultPath}/${cfg.syncFolderPath}`
        : cfg.vaultPath
      : 'No folder chosen';
    setFolderPathEl.textContent = folder;
  }
  if (setOauthBaseEl) setOauthBaseEl.value = cfg?.oauthBaseUrl ?? '';

  // Launch-at-login reflects the OS login-item state, not config.
  if (setAutolaunchBtn) {
    try {
      const enabled = await window.api.autolaunch.get();
      setAutolaunchBtn.classList.toggle('on', enabled);
      setAutolaunchBtn.setAttribute('aria-pressed', String(enabled));
    } catch { /* leave default off */ }
  }
}

setPickFolderBtn?.addEventListener('click', async () => {
  const picked = await window.api.dialog.pickFolder();
  if (!picked) return;
  setPickFolderBtn.disabled = true;
  try {
    // Picking a new vault root resets the legacy syncFolderPath implicitly —
    // writeGlobals only touches vaultPath, and per-connection folders are
    // derived from each target's handle.
    const res = await window.api.config.writeGlobals({ vaultPath: picked });
    if (res.ok) {
      showGlobalsStatus('Folder updated');
      await loadSettingsGlobals();
      await refresh();
    } else {
      showGlobalsStatus(res.error ?? 'Failed to save folder', 'error');
    }
  } finally {
    setPickFolderBtn.disabled = false;
  }
});

setAutolaunchBtn?.addEventListener('click', async () => {
  const next = !setAutolaunchBtn.classList.contains('on');
  setAutolaunchBtn.classList.toggle('on', next);
  setAutolaunchBtn.setAttribute('aria-pressed', String(next));
  const res = await window.api.autolaunch.set(next);
  if (!res.ok) {
    // Revert the optimistic flip on failure.
    setAutolaunchBtn.classList.toggle('on', !next);
    setAutolaunchBtn.setAttribute('aria-pressed', String(!next));
    showGlobalsStatus(res.error ?? 'Failed to update launch setting', 'error');
  }
});

setOauthSaveBtn?.addEventListener('click', async () => {
  if (!setOauthBaseEl) return;
  setOauthSaveBtn.disabled = true;
  try {
    const res = await window.api.config.writeGlobals({ oauthBaseUrl: setOauthBaseEl.value });
    showGlobalsStatus(res.ok ? 'OAuth server saved' : (res.error ?? 'Failed to save'), res.ok ? 'ok' : 'error');
  } finally {
    setOauthSaveBtn.disabled = false;
  }
});

setOpenFolderBtn?.addEventListener('click', () => {
  void window.api.shell.openSyncFolder();
});

setViewLogsBtn?.addEventListener('click', () => {
  void window.api.shell.openLogs();
});

// ── Settings pane: License (moved from the standalone settings renderer) ────

interface SettingsLicenseStatus {
  tier?: string;
  key?: string;
  syncCount?: number;
  freeLimit?: number;
  lastValidatedAt?: string;
  error?: string;
}

async function loadLicenseSection(): Promise<void> {
  if (!setLicenseSection) return;
  setLicenseSection.innerHTML = `<p class="ds-muted">Loading license…</p>`;
  try {
    const res = (await window.api.license.status()) as unknown as SettingsLicenseStatus;
    renderLicenseSection(res);
  } catch {
    setLicenseSection.innerHTML = `<p class="settings-status error">Failed to load license status.</p>`;
  }
}

function renderLicenseSection(status: SettingsLicenseStatus): void {
  if (!setLicenseSection) return;
  if (status.error || status.tier === undefined) {
    setLicenseSection.innerHTML = `<p class="settings-status error">${escapeHtml(status.error ?? 'Unknown error')}</p>`;
    return;
  }

  if (status.tier === 'pro') {
    setLicenseSection.innerHTML = `
      <div class="license-pro">
        <div class="settings-row">
          <div class="settings-row-label">
            <div class="settings-row-name">Specter Pro active</div>
            <div class="settings-row-help">Key: ${escapeHtml(status.key ?? '—')}${
              status.lastValidatedAt ? ` · validated ${escapeHtml(status.lastValidatedAt)}` : ''
            }</div>
            <div class="settings-row-help">${status.syncCount ?? 0} uploads this month (no limit)</div>
          </div>
          <button class="btn-ghost danger" id="set-deactivate">Deactivate</button>
        </div>
      </div>
    `;
    document.getElementById('set-deactivate')?.addEventListener('click', async () => {
      const btn = document.getElementById('set-deactivate') as HTMLButtonElement;
      btn.disabled = true;
      const res = await window.api.license.deactivate();
      if (res.ok) {
        await loadLicenseSection();
      } else {
        btn.disabled = false;
        showGlobalsStatus(res.error ?? 'Deactivation failed', 'error');
      }
    });
  } else {
    setLicenseSection.innerHTML = `
      <div class="license-free">
        <p class="ds-muted">Activate Specter Pro to upload changes.</p>
        <div class="settings-field-row">
          <input type="password" id="set-license-key" placeholder="XXXX-XXXX-XXXX-XXXX" />
          <button class="btn-primary" id="set-activate-btn" disabled>Activate</button>
        </div>
        <div id="set-activate-error" class="settings-status error hidden"></div>
        <p class="settings-row-help">
          <a href="https://spectersync.com/#buy" data-external class="ds-link">Subscribe — $99/year</a>
        </p>
      </div>
    `;
    const keyInput = document.getElementById('set-license-key') as HTMLInputElement;
    const activateBtn = document.getElementById('set-activate-btn') as HTMLButtonElement;
    const activateErr = document.getElementById('set-activate-error')!;

    keyInput.addEventListener('input', () => {
      activateBtn.disabled = !keyInput.value.trim();
    });
    activateBtn.addEventListener('click', async () => {
      activateBtn.disabled = true;
      activateErr.className = 'settings-status error hidden';
      const res = await window.api.license.activate(keyInput.value.trim());
      if (res.ok) {
        await loadLicenseSection();
      } else {
        activateErr.textContent = res.error ?? 'Activation failed.';
        activateErr.className = 'settings-status error';
        activateBtn.disabled = false;
      }
    });
    setLicenseSection
      .querySelector<HTMLAnchorElement>('a[data-external]')
      ?.addEventListener('click', (ev) => {
        ev.preventDefault();
        void window.api.shell.openExternal('https://spectersync.com/#buy');
      });
  }
}

void loadSettingsGlobals();
void loadLicenseSection();

// Make this file an ES module so its top-level identifiers don't pollute the
// global scope across renderer windows.
export {};
