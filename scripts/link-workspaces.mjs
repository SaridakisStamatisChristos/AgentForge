import { mkdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const scope = resolve(root, 'node_modules/@agentforge');
await mkdir(scope, { recursive: true });
for (const name of ['contracts','core','workflows','runtime','queue','persistence','events','tools','providers','sdk','testing']) {
  const target = resolve(root, 'packages', name);
  const link = resolve(scope, name);
  await rm(link, { recursive: true, force: true });
  await symlink(target, link, 'dir');
}
