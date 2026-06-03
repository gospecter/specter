/**
 * Window registry — breaks the circular dependency between main.ts and tray.ts.
 *
 * main.ts registers window openers here after creating them.
 * tray.ts calls these functions without importing main.ts directly.
 *
 * Also holds a one-shot "pending preview target" slot so the dashboard's
 * per-card dry-run button can hand off a target handle to the Preview window
 * without coupling the two renderers directly. The slot is consumed on the
 * next `preview:fetch` IPC call.
 */

type WindowOpener = () => void;

const registry = new Map<string, WindowOpener>();

export function registerWindowOpener(name: string, fn: WindowOpener): void {
  registry.set(name, fn);
}

export function openWindow(name: string): void {
  const fn = registry.get(name);
  if (fn) fn();
}

// ── Pending preview target (one-shot handoff from Dashboard → Preview) ──────

let pendingPreviewTarget: string | null = null;

export function setPendingPreviewTarget(handle: string | null): void {
  pendingPreviewTarget = handle && handle.length > 0 ? handle : null;
}

export function consumePendingPreviewTarget(): string | null {
  const t = pendingPreviewTarget;
  pendingPreviewTarget = null;
  return t;
}

// ── Pending connect prefill (Dashboard "Edit" → connect window) ─────────────
//
// When the dashboard's ⋯ → Edit action opens a per-platform connect window to
// edit an existing target, it stashes the target's current fields here. The
// connect renderer reads them on load (via `connect:pending`) to pre-fill the
// form. Unlike the preview slot this is NOT one-shot — the renderer may read it
// more than once during load — so it's cleared explicitly when the window
// finishes (or a fresh "Add" flow overwrites it with null).

export interface PendingConnect {
  platform: 'ghost' | 'wordpress' | 'webflow';
  /** Present only when editing an existing target. */
  handle?: string;
  label?: string;
  /** Pre-filled content-kind selection when editing; absent for a fresh add. */
  contentKinds?: string[];
  // Ghost
  ghostUrl?: string;
  adminApiKey?: string;
  // WordPress
  siteUrl?: string;
  username?: string;
  appPassword?: string;
  // Webflow
  siteId?: string;
  apiToken?: string;
}

let pendingConnect: PendingConnect | null = null;

export function setPendingConnect(payload: PendingConnect | null): void {
  pendingConnect = payload;
}

export function getPendingConnect(): PendingConnect | null {
  return pendingConnect;
}
