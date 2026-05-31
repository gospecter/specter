/**
 * copy-renderer.cjs
 *
 * Copies renderer HTML, CSS, and any other static assets from src/renderer/
 * to build/renderer/ after tsc compiles the .ts → .js files.
 *
 * Why not just put HTML in build/ directly?
 * tsc only copies .ts → .js; it ignores everything else. We keep all renderer
 * source in src/ (single source of truth) and copy the static files here.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const DST = path.join(__dirname, '..', 'build', 'renderer');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else if (entry.name.endsWith('.html') || entry.name.endsWith('.css')) {
      fs.copyFileSync(srcPath, dstPath);
      console.log(`  copied ${path.relative(process.cwd(), srcPath)}`);
    }
    // .ts files are compiled by tsc; we skip them here.
  }
}

console.log('Copying renderer static assets…');
copyDir(SRC, DST);
console.log('Done.');
