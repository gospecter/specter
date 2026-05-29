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
