import { describe, it, expect } from 'vitest';
import { createAdapter } from '../../src/cms/index.js';
import { WordPressAdapter } from '../../src/wordpress/adapter.js';

describe('createAdapter — wordpress', () => {
  it('returns a WordPressAdapter with platform === "wordpress"', () => {
    const adapter = createAdapter({
      platform: 'wordpress',
      siteUrl: 'https://example.com',
      username: 'user',
      appPassword: 'abcd efgh ijkl mnop qrst uvwx',
    });
    expect(adapter).toBeInstanceOf(WordPressAdapter);
    expect(adapter.platform).toBe('wordpress');
  });
});
