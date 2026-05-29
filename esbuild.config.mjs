// Bundles the daemon into a single ESM file shipped inside the .app.
//
// fsevents is left external because it's a native .node binding — chokidar
// loads it via require() and the native binary has to live on disk. We copy
// node_modules/fsevents into the app bundle's Resources directory.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(__dirname, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(__dirname, 'dist/daemon.bundle.js'),
  external: ['fsevents'],
  banner: {
    // ESM bundles need this shim for the CommonJS-flavored require() calls
    // that chokidar and a few transitive deps still make.
    js: `import { createRequire as __cr } from 'node:module';
const require = __cr(import.meta.url);
import { fileURLToPath as __ftu } from 'node:url';
import { dirname as __dn } from 'node:path';
const __filename = __ftu(import.meta.url);
const __dirname = __dn(__filename);`,
  },
  logLevel: 'info',
});

// Tiny ESM launcher: import the bundle and call main().
import { writeFile } from 'node:fs/promises';
await writeFile(
  path.join(__dirname, 'dist/daemon.mjs'),
  `import { main } from './daemon.bundle.js';
main().catch((err) => { console.error(err?.stack ?? err); process.exit(1); });
`,
  'utf8',
);
