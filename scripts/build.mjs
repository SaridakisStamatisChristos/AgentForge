import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
await rm(resolve(root, '.build'), { recursive: true, force: true });
const compiler = spawnSync('tsc', ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (compiler.status !== 0) process.exitCode = compiler.status ?? 1;
else {
  const packages = ['contracts','core','workflows','runtime','queue','persistence','events','tools','providers','sdk','testing'];
  for (const name of packages) {
    const source = resolve(root, '.build/packages', name, 'src');
    const destination = resolve(root, 'packages', name, 'dist');
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  for (const name of ['api', 'worker']) {
    const source = resolve(root, '.build/apps', name, 'src');
    const destination = resolve(root, 'apps', name, 'dist');
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true });
  }
}
