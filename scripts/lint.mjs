import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const sourceRoots = ['apps','packages','examples','benchmarks','scripts'];
const violations = [];
async function walk(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules','dist','.build'].includes(entry.name)) continue;
      await walk(full);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) {
      const text = await readFile(full, 'utf8');
      const checks = [
        [/\beval\s*\(/g, 'eval is forbidden'],
        [/catch\s*\([^)]*\)\s*\{\s*\}/g, 'empty catch is forbidden'],
        [/\bas\s+any\b|:\s*any\b/g, 'broad any is forbidden'],
      ];
      for (const [pattern, message] of checks) if (pattern.test(text)) violations.push(`${full.slice(root.length + 1)}: ${message}`);
    }
  }
}
for (const item of sourceRoots) await walk(resolve(root, item));
for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exitCode = 1;
