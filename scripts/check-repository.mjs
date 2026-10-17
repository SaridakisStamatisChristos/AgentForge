import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';

const root = process.cwd();
const self = 'scripts/check-repository.mjs';
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', '.build', 'coverage']);
const textBasenames = new Set(['Dockerfile', 'LICENSE', '.dockerignore', '.gitignore']);
const textExtensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.md', '.sql', '.json', '.yaml', '.yml', '.toml']);

const pathRules = [
  ['numbered change-request filename', /(?:^|\/)pr(?:[1-9]|1[0-5])(?:[-_.]|$)/i],
  ['legacy implementation-run filename', /(?:^|\/)r7(?:[-_.]|$)/i],
  ['transfer-note filename', /(?:^|\/)handoff(?:[-_.]|$)/i],
  ['build-sequence filename', /(?:^|\/)(?:milestone|phase|temporary)(?:[-_.]|$)/i],
];

const contentRules = [
  ['legacy implementation-run marker', new RegExp('\\bR' + '7\\b')],
  ['transfer-note language', new RegExp('\\bhand' + 'off\\b', 'i')],
  ['milestone language', new RegExp('\\bmile' + 'stone\\b', 'i')],
  ['numbered change-request chronology', new RegExp('\\bP' + 'R\\s*#?\\s*(?:[1-9]|1[0-5])\\b', 'i')],
  ['stale implementation branch reference', new RegExp('\\br' + '7\\/[A-Za-z0-9._/-]+', 'i')],
];

const findings = [];

function isTextFile(path) {
  return textBasenames.has(basename(path)) || textExtensions.has(extname(path));
}

async function inspectFile(path) {
  const repoPath = relative(root, path).replaceAll('\\', '/');
  if (repoPath === self) return;

  for (const [label, pattern] of pathRules) {
    if (pattern.test(repoPath)) findings.push(`${label}: ${repoPath}`);
  }

  if (!isTextFile(path)) return;
  const text = await readFile(path, 'utf8');
  for (const [label, pattern] of contentRules) {
    if (pattern.test(text)) findings.push(`${label}: ${repoPath}`);
  }
}

async function walk(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    await inspectFile(path);
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    await walk(resolve(path, entry.name));
  }
}

await walk(root);

if (findings.length > 0) {
  console.error('Repository product-language residue detected:');
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
}
