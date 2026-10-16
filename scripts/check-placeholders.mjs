import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd();
const hits = [];
async function walk(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules','dist','.build'].includes(entry.name)) continue;
      await walk(full);
    } else if (/\.(ts|mjs|md|sql|json|ya?ml)$/.test(entry.name)) {
      if (full === resolve(root, 'scripts/check-placeholders.mjs')) continue;
      const text = await readFile(full, 'utf8');
      const marker = new RegExp('\\b(' + ['TO' + 'DO', 'FIX' + 'ME', 'PLACE' + 'HOLDER'].join('|') + ')\\b');
      if (marker.test(text)) hits.push(full.slice(root.length + 1));
    }
  }
}
for (const item of ['apps','packages','examples','benchmarks','docs','scripts','tests','integration']) await walk(resolve(root,item));
if (hits.length) { for (const hit of hits) console.error(`unfinished marker: ${hit}`); process.exitCode = 1; }
