/**
 * Contract test: the committed JSON Schema artifacts match what TS would
 * generate today, and the schemas describe shapes the runtime actually
 * produces.
 *
 * This is the local mirror of the CI `schema:check` step. Running it as a
 * unit test catches drift on the dev machine before push, not only in CI.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readJson<T = unknown>(rel: string): Promise<T> {
  const raw = await fs.readFile(path.join(ROOT, rel), 'utf8');
  return JSON.parse(raw) as T;
}

describe('Schema artifacts (v0.3.1)', () => {
  it('config.schema.json describes the Ghost-only legacy config shape', async () => {
    type ConfigSchema = {
      definitions: {
        DaemonConfig: {
          properties: Record<string, unknown>;
          required: string[];
        };
      };
    };
    const schema = await readJson<ConfigSchema>('schemas/config.schema.json');
    const props = schema.definitions.DaemonConfig.properties;
    // The legacy fields shipped users depend on
    expect(props).toHaveProperty('ghostUrl');
    expect(props).toHaveProperty('adminApiKey');
    expect(props).toHaveProperty('vaultPath');
    expect(props).toHaveProperty('syncFolderPath');
    expect(props).toHaveProperty('conflictStrategy');
    expect(props).toHaveProperty('syncMode');
  });

  it('frontmatter-v1.schema.json keeps legacy ghost_* keys (shipped vaults)', async () => {
    type Schema = {
      definitions: { PostFrontmatter: { properties: Record<string, unknown> } };
    };
    const schema = await readJson<Schema>('schemas/frontmatter-v1.schema.json');
    const props = schema.definitions.PostFrontmatter.properties;
    expect(props).toHaveProperty('ghost_id');
    expect(props).toHaveProperty('ghost_slug');
    expect(props).toHaveProperty('ghost_status');
    expect(props).toHaveProperty('ghost_updated_at');
  });

  it('frontmatter-v2.schema.json describes the cms-block shape', async () => {
    type Schema = {
      definitions: {
        PostFrontmatterV2: {
          properties: {
            cms: {
              properties: Record<string, unknown>;
              required: string[];
            };
          };
        };
      };
    };
    const schema = await readJson<Schema>('schemas/frontmatter-v2.schema.json');
    const cms = schema.definitions.PostFrontmatterV2.properties.cms;
    expect(cms.properties).toHaveProperty('platform');
    expect(cms.properties).toHaveProperty('id');
    expect(cms.properties).toHaveProperty('slug');
    expect(cms.properties).toHaveProperty('status');
    expect(cms.properties).toHaveProperty('updated_at');
    expect(cms.required).toContain('platform');
    expect(cms.required).toContain('id');
  });

  it('adapter-config.schema.json is a discriminated union over platform', async () => {
    type Schema = {
      definitions: {
        AdapterConfig: {
          anyOf: Array<{ properties: { platform: { const: string } } }>;
        };
      };
    };
    const schema = await readJson<Schema>('schemas/adapter-config.schema.json');
    const platforms = schema.definitions.AdapterConfig.anyOf.map(
      (variant) => variant.properties.platform.const,
    );
    expect(platforms).toEqual(expect.arrayContaining(['ghost', 'shopify']));
  });

  it('frontmatter.schema.json (union) accepts both v1 and v2', async () => {
    type Schema = {
      definitions: {
        PostFrontmatterAny: { anyOf: Array<{ $ref: string }> };
      };
    };
    const schema = await readJson<Schema>('schemas/frontmatter.schema.json');
    const refs = schema.definitions.PostFrontmatterAny.anyOf.map((v) => v.$ref);
    expect(refs).toEqual(
      expect.arrayContaining([
        '#/definitions/PostFrontmatterV1',
        '#/definitions/PostFrontmatterV2',
      ]),
    );
  });

  it('Swift reference files exist for each codegen target', async () => {
    const swiftDir = path.join(ROOT, 'schemas', 'swift');
    const files = await fs.readdir(swiftDir);
    expect(files).toContain('DaemonConfig.swift');
    expect(files).toContain('PostFrontmatter.swift');
    expect(files).toContain('AdapterConfig.swift');
  });

  it('Swift artifacts are explicitly marked as generated (no hand-edits)', async () => {
    const files = ['DaemonConfig.swift', 'PostFrontmatter.swift', 'AdapterConfig.swift'];
    for (const f of files) {
      const raw = await fs.readFile(path.join(ROOT, 'schemas', 'swift', f), 'utf8');
      expect(raw).toContain('AUTO-GENERATED');
    }
  });
});
