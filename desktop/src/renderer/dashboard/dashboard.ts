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

import type { DashboardSnapshot, DashboardTarget } from '../preload-types.js';

type Platform = DashboardTarget['platform'];
type State = DashboardTarget['state'];

const PLATFORM_LABEL: Record<Platform, string> = {
  ghost: 'Ghost',
  shopify: 'Shopify',
  wordpress: 'WordPress',
};

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
    btn.addEventListener('click', () => {
      const action = btn.dataset.action!;
      if (action === 'auto') {
        void onToggleAuto(t);
        return;
      }
      if (action === 'pull' || action === 'push' || action === 'sync' || action === 'dry-run') {
        void onRunCommand(t, action);
        return;
      }
      // `resolve` and `more` are out of scope for this slice — they remain
      // visual-only until the multi-platform conflict view ships (spec S5).
      // eslint-disable-next-line no-console
      console.log(`[dashboard] ${action} ${t.id}`);
    });
  });

  return card;
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
    return;
  }
  snapshot.targets.forEach((t) => list.appendChild(renderCard(t)));
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
        await window.api.windows.open('settings-or-onboarding');
      } else if (target === 'shopify') {
        await window.api.shell.openExternal('https://spectersync.com/connect-shopify');
      } else if (target === 'wordpress') {
        await window.api.windows.open('wordpress-connect');
      }
    });
  });
}

// Make this file an ES module so its top-level identifiers don't pollute the
// global scope across renderer windows.
export {};
