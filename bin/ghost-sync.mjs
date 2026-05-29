#!/usr/bin/env node
import('../dist/cli/index.js').then(({ main }) => main()).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
