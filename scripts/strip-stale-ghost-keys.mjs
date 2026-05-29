#!/usr/bin/env node
// One-off helper for demo / migration scenarios.
// Strips ghost_id, ghost_slug, ghost_updated_at, local_updated_at from every
// .md file in the given folder so Specter treats them as new posts on push.
// Keeps title, tags, excerpt, feature_image, ghost_status (status maps to
// draft/published on the new Ghost).
//
// Usage: node scripts/strip-stale-ghost-keys.mjs <folder>
// Writes a sibling <file>.bak for every file modified.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: node strip-stale-ghost-keys.mjs <folder>');
  process.exit(1);
}

const STALE_KEYS = new Set([
  'ghost_id',
  'ghost_slug',
  'ghost_updated_at',
  'local_updated_at',
]);

const entries = await fs.readdir(folder, { withFileTypes: true });
const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));

let touched = 0;
let skipped = 0;

for (const e of mdFiles) {
  const full = path.join(folder, e.name);
  const raw = await fs.readFile(full, 'utf8');

  if (!raw.startsWith('---\n')) {
    skipped++;
    continue;
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    skipped++;
    continue;
  }

  const fm = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n/, '');

  const kept = [];
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_]+):/);
    if (m && STALE_KEYS.has(m[1])) continue;
    kept.push(line);
  }
  const newFm = kept.join('\n').replace(/^\n+|\n+$/g, '');
  const next = newFm.length > 0 ? `---\n${newFm}\n---\n\n${body}` : body;

  if (next === raw) {
    skipped++;
    continue;
  }

  await fs.writeFile(full + '.bak', raw);
  await fs.writeFile(full, next);
  touched++;
}

console.log(`stripped: ${touched}, unchanged: ${skipped}, total: ${mdFiles.length}`);
console.log('backups written next to each modified file as <name>.md.bak');
