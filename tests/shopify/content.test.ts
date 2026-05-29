import { describe, expect, it } from 'vitest';
import { ShopifyAdapter } from '../../src/shopify/adapter.js';
import { FakeShopifyApi } from '../fakes/FakeShopifyApi.js';

describe('Shopify content API', () => {
  it('creates, lists, updates, and deletes pages as content kind page', async () => {
    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');

    const created = await adapter.createContent({
      kind: 'page',
      title: 'About',
      body: 'Page **body**',
      status: 'draft',
      slug: 'about',
    });
    expect(created.kind).toBe('page');
    expect(created.slug).toBe('about');
    expect(created.body).toContain('body');

    const pages = await adapter.listContent({ kinds: ['page'] });
    expect(pages).toEqual([
      expect.objectContaining({ id: created.id, kind: 'page', title: 'About' }),
    ]);

    const updated = await adapter.updateContent('page', created.id, {
      title: 'About us',
      body: 'Updated page',
      status: 'published',
    });
    expect(updated.kind).toBe('page');
    expect(updated.title).toBe('About us');
    expect(updated.status).toBe('published');
    expect(updated.url).toBe('https://fake.myshopify.com/pages/about');

    await adapter.deleteContent('page', created.id);
    await expect(adapter.getContent('page', created.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('lists articles and pages together by default', async () => {
    const api = new FakeShopifyApi();
    const blog = api.seedDefaultBlog();
    api.seedArticle({
      title: 'Article',
      handle: 'article',
      blog: { id: blog.id, handle: blog.handle, title: blog.title },
    });
    api.seedPage({ title: 'Page', handle: 'page' });
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');

    const content = await adapter.listContent();

    expect(content.map((item) => item.kind).sort()).toEqual(['article', 'page']);
  });

  it('creates, lists, updates, and deletes products without touching variants', async () => {
    const api = new FakeShopifyApi();
    api.seedDefaultBlog();
    const adapter = new ShopifyAdapter(api, 'fake.myshopify.com');

    const created = await adapter.createContent({
      kind: 'product',
      title: 'Coffee Mug',
      slug: 'coffee-mug',
      body: 'A **sturdy** mug.',
      status: 'draft',
      tags: ['merch'],
    });

    expect(created.kind).toBe('product');
    expect(created.slug).toBe('coffee-mug');
    expect(created.body).toContain('sturdy');
    const variantsBefore = api.productVariants.get(created.id);

    const products = await adapter.listContent({ kinds: ['product'] });
    expect(products).toEqual([
      expect.objectContaining({ id: created.id, kind: 'product', title: 'Coffee Mug' }),
    ]);

    const updated = await adapter.updateContent('product', created.id, {
      title: 'Large Coffee Mug',
      body: 'Updated description.',
      status: 'published',
      tags: ['merch', 'ceramic'],
    });

    expect(updated.kind).toBe('product');
    expect(updated.status).toBe('published');
    expect(updated.url).toBe('https://fake.myshopify.com/products/coffee-mug');
    expect(api.products.get(created.id)?.tags).toEqual(['merch', 'ceramic']);
    expect(api.productVariants.get(created.id)).toBe(variantsBefore);

    await adapter.deleteContent('product', created.id);
    await expect(adapter.getContent('product', created.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
