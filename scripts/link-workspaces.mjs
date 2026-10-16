import { mkdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const scope = resolve(root, 'node_modules/@agentforge');
await mkdir(scope, { recursive: true });

const workspaces = [
  ['api', resolve(root, 'apps', 'api')],
  ...['contracts','core','workflows','runtime','queue','persistence','events','tools','providers','sdk','testing']
    .map((name) => [name, resolve(root, 'packages', name)]),
];

for (const [name, target] of workspaces) {
  const link = resolve(scope, name);
  await rm(link, { recursive: true, force: true });
  await symlink(target, link, 'dir');
}
