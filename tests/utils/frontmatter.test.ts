import { describe, expect, it } from 'vitest';
import { titleToFilename } from '../../src/utils/frontmatter.js';

describe('titleToFilename', () => {
  it('slugifies a plain ASCII title', () => {
    expect(titleToFilename('Hello World')).toBe('hello-world');
  });

  // Regression for gospecter/specter#3: accented Latin letters must be
  // transliterated to their ASCII base (the way Ghost derives slugs), not
  // deleted. Before the fix "Un Été à Paris" became "un-t-paris".
  it.each([
    ['Un Été à Paris', 'un-ete-a-paris'],
    ['déjà vu', 'deja-vu'],
    ['crème brûlée', 'creme-brulee'],
    ['garçon', 'garcon'],
    ['français', 'francais'],
  ])('transliterates accented characters: %s -> %s', (input, expected) => {
    expect(titleToFilename(input)).toBe(expected);
  });

  it('falls back to "untitled" when nothing printable remains', () => {
    expect(titleToFilename('')).toBe('untitled');
    expect(titleToFilename('—')).toBe('untitled');
  });
});
