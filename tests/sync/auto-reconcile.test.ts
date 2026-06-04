import { describe, it, expect } from 'vitest';
import { autoReconcileHandles } from '../../src/sync/targets.js';

/**
 * Mission-critical invariant: the `watch` daemon must NEVER auto-reconcile a
 * `manual` target. If a manual target leaks into this list, the "Manual" sync
 * control silently does nothing — the exact regression we shipped once (manual
 * connections were being auto-synced by a stale daemon). Locked here.
 */
describe('autoReconcileHandles', () => {
  it('includes only auto targets and excludes every manual one', () => {
    const handles = autoReconcileHandles([
      { handle: 'ghost', syncMode: 'manual' },
      { handle: 'shopify', syncMode: 'auto' },
      { handle: 'wordpress', syncMode: 'manual' },
      { handle: 'webflow', syncMode: 'auto' },
    ]);
    expect(handles).toEqual(['shopify', 'webflow']);
  });

  it('returns empty when all targets are manual (no surprise syncs)', () => {
    expect(
      autoReconcileHandles([
        { handle: 'a', syncMode: 'manual' },
        { handle: 'b', syncMode: 'manual' },
      ]),
    ).toEqual([]);
  });

  it('returns empty for no targets', () => {
    expect(autoReconcileHandles([])).toEqual([]);
  });
});
