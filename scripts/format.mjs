import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const mode = process.argv.includes('--write') ? 'write' : 'check';
const root = process.cwd();
const roots = ['apps','packages','examples','benchmarks','docs','scripts','tests','integration','.github'];
const extensions = new Set(['.ts','.mjs','.json','.yaml','.yml','.md','.sql']);
const files = [];
async function walk(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules','dist','.build'].includes(entry.name)) continue;
      await walk(full);
    } else {
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0 && extensions.has(entry.name.slice(dot))) files.push(full);
    }
  }
}
for (const item of roots) await walk(resolve(root, item));
let failed = false;
for (const file of files) {
  const original = await readFile(file, 'utf8');
  const normalized = original.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/g, '')).join('\n').replace(/\n*$/, '\n');
  if (original !== normalized) {
    if (mode === 'write') await writeFile(file, normalized);
    else { console.error(`format drift: ${file.slice(root.length + 1)}`); failed = true; }
  }
}
if (failed) process.exitCode = 1;
