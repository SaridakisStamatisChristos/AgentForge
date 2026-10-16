import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  AGENTFORGE_API_PORT: process.env.AGENTFORGE_API_PORT ?? '8787',
};
const children = [
  spawn(process.execPath, ['--experimental-transform-types','--conditions=development','apps/api/src/index.ts'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['--experimental-transform-types','--conditions=development','apps/worker/src/index.ts'], { stdio: 'inherit', env }),
];
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
