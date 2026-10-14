#!/usr/bin/env node
// Kept apart from the program so that an older Node is told what is wrong, instead of failing
// on the first thing it does not have.
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`Opsidian needs Node 24 or later. This is Node ${process.versions.node}.`);
  process.exit(1);
}
await import('../dist/opsidian.mjs');
