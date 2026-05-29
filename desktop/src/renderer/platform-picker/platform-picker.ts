/**
 * platform-picker.ts
 * Spec: tasks/spec-multi-cms-ui.md — S1 First-run platform picker.
 *
 * Stub: emits the selected platform via console / window.postMessage.
 * Wiring into the multi-platform onboarding flow lives in a follow-up.
 */

type Platform = 'ghost' | 'shopify' | 'wordpress';

const tiles = document.querySelectorAll<HTMLButtonElement>('.tile');

tiles.forEach((tile) => {
  tile.addEventListener('click', () => {
    if (tile.classList.contains('locked')) return;

    const platform = tile.dataset.platform as Platform | undefined;
    if (!platform) return;

    tiles.forEach((t) => t.setAttribute('aria-checked', 'false'));
    tile.setAttribute('aria-checked', 'true');

    // Stub hand-off — replaced when wired into the connect router.
    // eslint-disable-next-line no-console
    console.log('[platform-picker] selected:', platform);
    window.postMessage({ type: 'platform-selected', platform }, '*');
  });
});

/**
 * Lock the given platforms (Pro upsell). Adds `locked` class which dims the
 * tile and rejects clicks. A `🔒 Pro` pill can be rendered on top by adding
 * a child element — kept simple for the stub.
 */
export function lockPlatforms(locked: Platform[]): void {
  tiles.forEach((tile) => {
    const platform = tile.dataset.platform as Platform | undefined;
    if (platform && locked.includes(platform)) {
      tile.classList.add('locked');
    } else {
      tile.classList.remove('locked');
    }
  });
}

// Expose for dev console testing while we stub the flow.
(window as unknown as { lockPlatforms: typeof lockPlatforms }).lockPlatforms =
  lockPlatforms;
