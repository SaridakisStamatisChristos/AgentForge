import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--experimental-transform-types','--conditions=development','apps/api/src/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--experimental-transform-types','--conditions=development','apps/worker/src/index.ts'], { stdio: 'inherit' }),
];
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
