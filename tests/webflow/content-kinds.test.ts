import { describe, it, expect } from 'vitest';
import { isContentKindAllowed } from '../../src/config.js';
import { ContentKind } from '../../src/cms/types.js';

describe('isContentKindAllowed — dynamic Webflow kinds', () => {
  it('accepts any webflow:<slug> kind for the webflow platform', () => {
    expect(isContentKindAllowed('webflow', 'webflow:blog-posts' as ContentKind)).toBe(true);
    expect(isContentKindAllowed('webflow', 'webflow:guides' as ContentKind)).toBe(true);
    // The static base post kind also passes (legacy-migration safety).
    expect(isContentKindAllowed('webflow', 'post')).toBe(true);
  });

  it('rejects a webflow:<slug> kind for a static platform', () => {
    expect(isContentKindAllowed('ghost', 'webflow:blog-posts' as ContentKind)).toBe(false);
    expect(isContentKindAllowed('wordpress', 'webflow:guides' as ContentKind)).toBe(false);
  });

  it('still enforces the static table for fixed-kind platforms', () => {
    expect(isContentKindAllowed('ghost', 'post')).toBe(true);
    expect(isContentKindAllowed('ghost', 'page')).toBe(true);
    expect(isContentKindAllowed('shopify', 'article')).toBe(true);
    expect(isContentKindAllowed('shopify', 'product')).toBe(true);
    expect(isContentKindAllowed('ghost', 'product')).toBe(false);
  });
});
