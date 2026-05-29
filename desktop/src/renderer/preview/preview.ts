/**
 * Preview Sync renderer.
 * Mirrors PreviewSyncView + PreviewController in PreviewSync.swift.
 * Shows a dry-run plan (creates, updates, deletes, conflicts, errors).
 */


const $ = (id: string) => document.getElementById(id)!;

const contentEl = $('p-content');
const summaryEl = $('p-summary');
const refreshBtn = $('p-refresh') as HTMLButtonElement;
const closeBtn = $('p-close') as HTMLButtonElement;
const runBtn = $('p-run') as HTMLButtonElement;

interface PlanEntry {
  side: 'local' | 'remote';
  title: string;
  ghostId?: string;
  localPath?: string;
  details?: string;
}

interface SyncPlan {
  direction: string;
  creates: PlanEntry[];
  updates: PlanEntry[];
  metadataUpdates: PlanEntry[];
  deletes: PlanEntry[];
  conflicts: PlanEntry[];
  skips: PlanEntry[];
  errors: PlanEntry[];
}

let currentPlan: SyncPlan | null = null;

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchPlan(): Promise<void> {
  refreshBtn.disabled = true;
  runBtn.disabled = true;
  summaryEl.textContent = '';
  showLoading();

  try {
    const result = await window.api.preview.fetch();
    if ('error' in result && result.error) {
      showError(result.error as string);
      currentPlan = null;
    } else {
      currentPlan = result as SyncPlan;
      renderPlan(currentPlan);
      renderSummary(currentPlan);
      updateRunButton(currentPlan);
    }
  } catch (e) {
    showError((e as Error).message);
    currentPlan = null;
  } finally {
    refreshBtn.disabled = false;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showLoading(): void {
  contentEl.innerHTML = `
    <div class="preview-loading">
      <span class="spinner"></span>
      <span class="caption">Computing plan…</span>
    </div>
  `;
}

function showError(msg: string): void {
  contentEl.innerHTML = `
    <div class="preview-error">
      <div class="inline-status status-error" style="font-size:14px;font-weight:600;margin-bottom:8px;">
        ✕ Couldn't compute plan
      </div>
      <div class="caption status-muted">${escHtml(msg)}</div>
    </div>
  `;
}

function renderPlan(plan: SyncPlan): void {
  const isEmpty =
    plan.creates.length === 0 &&
    plan.updates.length === 0 &&
    plan.deletes.length === 0 &&
    plan.conflicts.length === 0 &&
    plan.errors.length === 0;

  if (isEmpty) {
    contentEl.innerHTML = `
      <div class="preview-empty">
        <span class="check-icon">✓</span>
        <strong>Everything is in sync</strong>
        <span class="caption">No creates, updates, or conflicts pending.</span>
      </div>
    `;
    return;
  }

  const sections: { key: keyof SyncPlan; label: string; cssClass: string }[] = [
    { key: 'conflicts', label: 'Conflicts', cssClass: 'section-conflicts' },
    { key: 'creates',   label: 'Creates',   cssClass: 'section-creates'   },
    { key: 'updates',   label: 'Updates',   cssClass: 'section-updates'   },
    { key: 'deletes',   label: 'Deletes',   cssClass: 'section-deletes'   },
    { key: 'errors',    label: 'Errors',    cssClass: 'section-errors'    },
  ];

  let html = '';
  for (const { key, label, cssClass } of sections) {
    const entries = plan[key] as PlanEntry[];
    if (!entries || entries.length === 0) continue;
    html += `
      <div class="plan-section ${escHtml(cssClass)}">
        <div class="plan-section-header">${escHtml(label)} (${entries.length})</div>
        ${entries.map(renderEntry).join('')}
      </div>
    `;
  }

  contentEl.innerHTML = html;
}

function renderEntry(entry: PlanEntry): string {
  const title = entry.title.trim() || '(untitled)';
  const sideLabel = entry.side === 'remote' ? 'Ghost' : 'Local';
  const sideCls = entry.side === 'remote' ? 'remote' : 'local';
  const details = entry.details
    ? `<div class="caption status-muted">${escHtml(entry.details)}</div>`
    : '';
  const subline = entry.localPath
    ? `<div class="caption2 status-muted">${escHtml(entry.localPath)}</div>`
    : entry.ghostId
    ? `<div class="caption2 status-muted">Ghost id: ${escHtml(entry.ghostId)}</div>`
    : '';

  return `
    <div class="plan-entry">
      <div class="plan-entry-title-row">
        <span class="plan-entry-title">${escHtml(title)}</span>
        <span class="side-badge ${sideCls}">${sideLabel}</span>
      </div>
      ${details}
      ${subline}
    </div>
  `;
}

function renderSummary(plan: SyncPlan): void {
  const parts: string[] = [];
  if (plan.creates.length) parts.push(`${plan.creates.length} create`);
  if (plan.updates.length) parts.push(`${plan.updates.length} update`);
  if (plan.deletes.length) parts.push(`${plan.deletes.length} delete`);
  if (plan.conflicts.length) parts.push(`${plan.conflicts.length} conflict`);
  if (plan.errors.length) parts.push(`${plan.errors.length} error`);

  if (parts.length === 0) {
    summaryEl.textContent = plan.skips.length
      ? `${plan.skips.length} skip — already in sync.`
      : 'Nothing planned.';
  } else {
    const skip = plan.skips.length ? ` (${plan.skips.length} skip)` : '';
    summaryEl.textContent = parts.join(', ') + skip;
  }
}

function updateRunButton(plan: SyncPlan): void {
  const hasWork =
    plan.creates.length > 0 ||
    plan.updates.length > 0 ||
    plan.deletes.length > 0 ||
    plan.conflicts.length > 0;
  runBtn.disabled = !hasWork;
}

// ── Actions ───────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', fetchPlan);
closeBtn.addEventListener('click', () => window.close());
runBtn.addEventListener('click', async () => {
  // Trigger sync (fire-and-forget) then close. Tray notifies on finish.
  await window.api.daemon.runSync('sync');
  window.close();
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

fetchPlan();

// Make this file an ES module so its top-level identifiers don't pollute the global scope
export {};
